import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Las rutas `api/internal/*` son la puerta de gs (y de la operación) hacia Teams: publican en
// rooms, despiertan agentes, mueven pedidos de la fábrica. Cada una trae su PROPIA copia de
// `verify` (16 copias), así que una que se rompa o se quede sin comprobar el reloj no la ve
// nadie. Aquí se prueban todas a la vez desde fuera: sin firma, con firma de otro secreto, con
// firma buena pero vieja (> 300 s) y sin secreto configurado, ninguna contesta 2xx.
//
// Dos esquemas de firma conviven: el cuerpo crudo en headers (`${ts}.${rawBody}`) y un literal
// por recurso en la query (`${ts}.members-admin`). Se mandan los dos en cada petición para que
// la prueba no dependa de saber cuál usa cada ruta.

const here = dirname(fileURLToPath(import.meta.url));
const routes = readdirSync(here)
  .filter((f) => /^api\.internal\..+\.ts$/.test(f) && !f.includes(".test."))
  .sort();

const LITERAL: Record<string, string> = {
  "api.internal.members.ts": "members-admin",
  "api.internal.announcements.ts": "announcement-admin",
  "api.internal.prospeccion-run.ts": "prospeccion-run",
};

const SECRET = "s3cr3t-de-prueba";
const hmac = (key: string, msg: string) => crypto.createHmac("sha256", key).update(msg).digest("hex");

type Handler = (c: { request: Request; params?: Record<string, string> }) => Promise<Response>;

async function handlersOf(file: string): Promise<[string, Handler][]> {
  const mod = (await import(`./${file}`)) as { Route: { options: { server?: { handlers?: Record<string, Handler> } } } };
  return Object.entries(mod.Route.options.server?.handlers ?? {});
}

function request(file: string, method: string, opts: { ts: number; key: string | null }) {
  const raw = JSON.stringify({ ns: "otro-tenant", sub: "u1", channelId: 1, text: "hola", repo: "o/r", delivery: "d1" });
  const ts = String(opts.ts);
  const bodySig = opts.key !== null ? hmac(opts.key, `${ts}.${raw}`) : "";
  const lit = LITERAL[file];
  const qsSig = opts.key !== null && lit ? hmac(opts.key, `${ts}.${lit}`) : "";
  const url = `http://x/${file.replace(/\.ts$/, "").replace(/\./g, "/")}?ts=${ts}&sig=${qsSig}`;
  return new Request(url, {
    method,
    headers: { "x-ghosty-ts": ts, "x-ghosty-sig": bodySig, "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: raw }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.GHOSTY_PARTNER_SECRET;
});

describe("firma de partner en api/internal/*", () => {
  it("hay rutas que probar (si cambia el nombre de archivo, esta prueba no puede quedarse vacía)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of routes) {
    describe(file, () => {
      const now = () => Math.floor(Date.now() / 1000);
      const cases: [string, () => { ts: number; key: string | null }][] = [
        ["sin firma", () => ({ ts: now(), key: null })],
        ["firmada con otro secreto", () => ({ ts: now(), key: "otro-secreto" })],
        ["firma buena pero de hace 10 min", () => ({ ts: now() - 600, key: SECRET })],
        ["firma buena pero del futuro (+10 min)", () => ({ ts: now() + 600, key: SECRET })],
      ];
      for (const [name, mk] of cases) {
        it(`${name}: no pasa`, async () => {
          process.env.GHOSTY_PARTNER_SECRET = SECRET;
          for (const [method, h] of await handlersOf(file)) {
            const res = await h({ request: request(file, method, mk()), params: {} });
            // 403 exacto: un 400 querría decir que la firma PASÓ y lo frenó la validación del cuerpo.
            expect(res.status, `${method} ${file}`).toBe(403);
          }
        });
      }
      it("sin GHOSTY_PARTNER_SECRET en el entorno nada pasa (ni firmando con cadena vacía)", async () => {
        for (const [method, h] of await handlersOf(file)) {
          const res = await h({ request: request(file, method, { ts: now(), key: "" }), params: {} });
          // prospeccion-run contesta 500 «no secret»; las demás, 403.
          expect([403, 500], `${method} ${file}`).toContain(res.status);
        }
      });
    });
  }
});
