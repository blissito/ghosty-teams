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
// Todas firman el cuerpo crudo en headers (`${ts}.${rawBody}`, un GET firma `GET <ruta>`), con
// UNA función compartida (`server/partner-sig.server`). ⚠️ Transición (26-oct): members,
// announcements y prospeccion-run aceptan aún el literal viejo en la query; se mandan los dos
// formatos en cada petición para que la prueba no dependa de cuál usa cada ruta.

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
  const path = `/${file.replace(/\.ts$/, "").replace(/\./g, "/")}`;
  // Un GET firma `GET <ruta>` (no tiene cuerpo).
  const signedText = method === "GET" ? `GET ${path}` : raw;
  const bodySig = opts.key !== null ? hmac(opts.key, `${ts}.${signedText}`) : "";
  const lit = LITERAL[file];
  const qsSig = opts.key !== null && lit ? hmac(opts.key, `${ts}.${lit}`) : "";
  const url = `http://x${path}?ts=${ts}&sig=${qsSig}`;
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
          expect(res.status, `${method} ${file}`).toBe(403);
        }
      });
    });
  }
});

// Las tres rutas que firmaban un literal: el formato nuevo pasa y la misma firma con otro cuerpo no.
vi.mock("../server/schema.server", () => ({ ensureSchema: async () => {} }));
vi.mock("../users.server", () => ({
  listAllMembers: async () => [],
  preapprovedEmails: async () => [],
  restoreMember: async () => {},
}));
const published: unknown[] = [];
vi.mock("../server/bus.server", () => ({ publish: (_c: unknown, e: unknown) => void published.push(e), ch: { user: () => "u" } }));

describe("members y prospeccion-run firman el cuerpo", () => {
  const ts = () => String(Math.floor(Date.now() / 1000));
  const post = (path: string, raw: string, signedRaw = raw) => {
    const t = ts();
    return new Request(`http://x${path}`, { method: "POST", headers: { "x-ghosty-ts": t, "x-ghosty-sig": hmac(SECRET, `${t}.${signedRaw}`) }, body: raw });
  };

  it("members: GET firmado con su ruta pasa; POST con su cuerpo pasa, con otro cuerpo no", async () => {
    process.env.GHOSTY_PARTNER_SECRET = SECRET;
    const h = Object.fromEntries(await handlersOf("api.internal.members.ts"));
    const t = ts();
    const get = new Request("http://x/api/internal/members", { headers: { "x-ghosty-ts": t, "x-ghosty-sig": hmac(SECRET, `${t}.GET /api/internal/members`) } });
    expect((await h.GET({ request: get })).status).toBe(200);
    const ok = '{"action":"restore","sub":"u1"}';
    expect((await h.POST({ request: post("/api/internal/members", ok) })).status).toBe(200);
    expect((await h.POST({ request: post("/api/internal/members", '{"action":"restore","sub":"u2"}', ok) })).status).toBe(403);
  });

  it("prospeccion-run: la firma cubre el ns del cuerpo", async () => {
    process.env.GHOSTY_PARTNER_SECRET = SECRET;
    const h = Object.fromEntries(await handlersOf("api.internal.prospeccion-run.ts"));
    const ok = '{"ns":"acme","sub":"u1","listId":3,"key":"msg"}';
    expect((await h.POST({ request: post("/api/internal/prospeccion-run", ok) })).status).toBe(200);
    expect((await h.POST({ request: post("/api/internal/prospeccion-run", ok.replace("acme", "otro"), ok) })).status).toBe(403);
    expect(published).toHaveLength(1);
  });
});

// ⚠️ Transición (26-oct): mientras gs firma el literal viejo, members sigue aceptándolo. Se borra
// con `legacyLiteralOk`.
describe("transición: formato viejo todavía aceptado", () => {
  it("members GET con ?ts&sig sobre ts.members-admin", async () => {
    process.env.GHOSTY_PARTNER_SECRET = SECRET;
    const h = Object.fromEntries(await handlersOf("api.internal.members.ts"));
    const t = String(Math.floor(Date.now() / 1000));
    const res = await h.GET({ request: new Request(`http://x/api/internal/members?ts=${t}&sig=${hmac(SECRET, `${t}.members-admin`)}`) });
    expect(res.status).toBe(200);
  });
});
