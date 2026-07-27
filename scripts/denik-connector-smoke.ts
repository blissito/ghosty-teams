/**
 * Smoke del conector Deník, lado Teams.
 * Uso: npx tsx scripts/denik-connector-smoke.ts <accessTokenDeDenik>
 *
 * Verifica el pegamento que NO cubre el smoke de Deník: que `parseUserInfo` del
 * registry traduzca /api/agenda/me al meta que consumen `ambientContext` y
 * `tools`, que las 23 tools estén bien declaradas, y que sus handlers construyan
 * URLs que Deník acepta.
 *
 * No toca sqld: el token se inyecta a mano en vez de leerlo de
 * gc_user_connectors, así que corre desde la laptop sin la DB de Teams.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getConnector } from "../src/server/connectors/registry";

const TOKEN = process.argv[2];
const BASE = (process.env.DENIK_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
let stub: ReturnType<typeof startSqldStub>;
const check = (label: string, pass: boolean, extra = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

async function main() {
  if (!TOKEN) {
    console.error("Falta el access token de Deník");
    process.exit(1);
  }

  // 1 ── Entrada del registry
  console.log("1. Entrada en el registro");
  const def = getConnector("denik");
  check("existe y está disponible", def?.status === "available");
  check("exige PKCE", def?.oauth?.pkce === true);
  check("declara revokeUrl", !!def?.oauth?.revokeUrl, def?.oauth?.revokeUrl);
  check(
    "pide los 8 scopes",
    def?.oauth?.scopes?.split(" ").length === 8,
    def?.oauth?.scopes,
  );
  check("apunta a la instancia esperada", def?.oauth?.authUrl?.startsWith(BASE) === true, def?.oauth?.authUrl);

  // 2 ── parseUserInfo contra la respuesta REAL
  console.log("\n2. parseUserInfo sobre /api/agenda/me real");
  const res = await fetch(`${BASE}/api/agenda/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check("Deník responde 200", res.status === 200, `${res.status}`);
  const json = await res.json();
  const parsed = def!.oauth!.parseUserInfo!(json);
  const meta = parsed.meta as any;
  check("externalId = userId", parsed.externalId === json.userId, parsed.externalId ?? "null");
  check("meta.email", meta.email === json.email, meta.email);
  check(
    `meta.orgs (${meta.orgs?.length})`,
    Array.isArray(meta.orgs) && meta.orgs.length > 0,
    meta.orgs?.map((o: any) => `${o.name}:${o.role}`).join(", "),
  );
  check("meta.activeOrgId", !!meta.activeOrgId);
  check(
    `meta.isPlatformAdmin=${meta.isPlatformAdmin}`,
    typeof meta.isPlatformAdmin === "boolean",
  );

  // 3 ── Tools: declaración
  //
  // El módulo lee el token de la DB de Teams (sqld), que no corre en la laptop.
  // Se parchea `readMeta`/`getValidToken` por la vía más simple: importar el
  // módulo y ejercitar las tools con un fetch equivalente al que hace `api()`.
  console.log("\n3. Declaración de tools");
  // El stub debe existir ANTES de importar el módulo: dbq.server.ts lee SQLD_URL
  // al cargarse, así que fijarlo después no tendría efecto.
  stub = startSqldStub({ meta, token: TOKEN });
  const port = await stub.listen();
  process.env.SQLD_URL = `http://127.0.0.1:${port}`;
  process.env.SQLD_NAMESPACE = "smoke";
  const mod: any = await import("../src/server/connectors/denik.server");
  check("exporta ambientContext", typeof mod.ambientContext === "function");
  check("exporta tools como función del sub", typeof mod.tools === "function");

  // Se reconstruyen las listas leyendo el módulo con un meta simulado.
  const asAdmin = await mod.tools("x");                       // stub → isPlatformAdmin: true
  stub.setMeta({ ...meta, isPlatformAdmin: false });
  const asUser = await mod.tools("x");
  stub.setMeta({ ...meta, isPlatformAdmin: true });

  check(`admin ve ${asAdmin.length} tools`, asAdmin.length === 23, `${asAdmin.length}`);
  check(`no-admin ve ${asUser.length} tools`, asUser.length === 16, `${asUser.length}`);
  check(
    "las denik_admin_* SOLO para admin",
    asUser.every((t: any) => !t.name.startsWith("denik_admin_")) &&
      asAdmin.filter((t: any) => t.name.startsWith("denik_admin_")).length === 7,
  );
  check(
    "todos los nombres con prefijo denik_",
    asAdmin.every((t: any) => t.name.startsWith("denik_")),
  );
  check("nombres únicos", new Set(asAdmin.map((t: any) => t.name)).size === asAdmin.length);
  check(
    "todas traen descripción e inputSchema objeto",
    asAdmin.every(
      (t: any) => t.description?.length > 20 && t.inputSchema?.type === "object",
    ),
  );
  const required = asAdmin.filter((t: any) => t.inputSchema.required?.length);
  check(
    `los required existen en properties (${required.length} tools)`,
    required.every((t: any) =>
      t.inputSchema.required.every((r: string) => r in (t.inputSchema.properties ?? {})),
    ),
  );

  // 4 ── Handlers contra Deník de verdad
  console.log("\n4. Handlers contra Deník");
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = asAdmin.find((x: any) => x.name === name);
    if (!t) return { error: `tool ${name} no existe` };
    return await t.handler("x", args);
  };

  const orgs = (await call("denik_my_orgs")) as any;
  check("denik_my_orgs", !orgs.error && !!orgs.userId, orgs.error ?? orgs.email);

  const up = (await call("denik_upcoming_appointments", { limit: 3 })) as any;
  check(
    `denik_upcoming_appointments (${up.events?.length ?? "?"} citas)`,
    !up.error && Array.isArray(up.events),
    up.error,
  );

  const svc = (await call("denik_services")) as any;
  check(
    `denik_services (${svc.services?.length ?? "?"})`,
    !svc.error && Array.isArray(svc.services),
    svc.error,
  );

  const sid = svc.services?.[0]?.id;
  if (sid) {
    const av = (await call("denik_availability", { serviceId: sid, days: 3 })) as any;
    check(
      `denik_availability (${av.days?.length} días)`,
      !av.error && av.days?.length === 3,
      av.error,
    );
  }

  const sum = (await call("denik_org_summary")) as any;
  check("denik_org_summary sin rango → hoy", !sum.error && sum.total !== undefined, sum.error);

  const search = (await call("denik_search_appointments", { from: "2026-01-01", to: "2026-12-31" })) as any;
  check(
    `denik_search_appointments (${search.events?.length ?? "?"})`,
    !search.error && Array.isArray(search.events),
    search.error,
  );

  const adminOrgs = (await call("denik_admin_list_orgs", { limit: 3 })) as any;
  check(
    `denik_admin_list_orgs (${adminOrgs.orgs?.length ?? "?"} de ${adminOrgs.total ?? "?"})`,
    !adminOrgs.error,
    adminOrgs.error,
  );

  const adminEv = (await call("denik_admin_events", {})) as any;
  check(
    "denik_admin_events sin rango → error legible, no crash",
    typeof adminEv.error === "string" || adminEv.count !== undefined,
    adminEv.error,
  );

  // 5 ── Errores traducidos
  console.log("\n5. Errores en español accionable");
  stub.setToken("dnk_at_invalido");
  const bad = (await asAdmin.find((t: any) => t.name === "denik_my_orgs")!.handler("x", {})) as any;
  stub.setToken(TOKEN);
  check(
    "token inválido → mensaje que dice qué hacer",
    typeof bad.error === "string" && bad.error.includes("reconecte"),
    bad.error,
  );

  stub.close();
  console.log(failures === 0 ? "\n✅ Todo verde." : `\n❌ ${failures} fallaron.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Stub del protocolo sqld (POST /v2/pipeline).
 *
 * Los módulos ES son inmutables, así que no se puede parchear `getConnectorRow`.
 * En vez de eso se levanta un sqld falso y se apunta SQLD_URL ahí: se ejercita
 * el camino REAL dbq → store → readMeta en lugar de saltárselo.
 */
function startSqldStub(initial: { meta: unknown; token: string }) {
  const state = { ...initial };
  const cols = ["user_sub", "provider", "access_token", "refresh_token", "expires_at", "external_id", "meta"];
  const server = createServer((req: any, res: any) => {
    let body = "";
    req.on("data", (c: any) => (body += c));
    req.on("end", () => {
      const sql = String(JSON.parse(body || "{}")?.requests?.[0]?.stmt?.sql ?? "");
      const row: Record<string, string | null> = {
        user_sub: "x",
        provider: "denik",
        access_token: state.token,
        refresh_token: null,
        // Lejos en el futuro → getValidToken no intenta refrescar.
        expires_at: String(Math.floor(Date.now() / 1000) + 86_400),
        external_id: "x",
        meta: JSON.stringify(state.meta),
      };
      const rows =
        sql.includes("gc_user_connectors") && sql.trim().toUpperCase().startsWith("SELECT")
          ? [cols.map((c) => ({ value: row[c] }))]
          : [];
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            { type: "ok", response: { result: { cols: cols.map((name) => ({ name })), rows } } },
            { type: "ok" },
          ],
        })
      );
    });
  });
  return {
    listen: () =>
      new Promise<number>((r) =>
        server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))
      ),
    setMeta: (m: unknown) => (state.meta = m),
    setToken: (t: string) => (state.token = t),
    close: () => server.close(),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
