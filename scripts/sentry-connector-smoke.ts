/**
 * Smoke del conector Sentry, lado Teams.
 * Uso: npx tsx scripts/sentry-connector-smoke.ts <accessTokenDeSentry>
 *
 * El token puede ser uno de OAuth (el flujo real) o un User Auth Token
 * (sentry.io → Settings → Account → API → Auth Tokens) con org:read,
 * project:read y event:read: para lo que se verifica aquí son equivalentes.
 *
 * Verifica que `parseUserInfo` del registry traduzca /api/0/organizations/ al
 * meta que consumen `ambientContext` y `tools`, que las 7 tools estén bien
 * declaradas, y que sus handlers construyan URLs que Sentry acepta.
 *
 * No toca sqld: se levanta un stub del protocolo y se apunta SQLD_URL ahí, así
 * que se ejercita el camino REAL dbq → store → readMeta desde la laptop.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getConnector } from "../src/server/connectors/registry";

const TOKEN = process.argv[2];
const BASE = (process.env.SENTRY_BASE_URL ?? "https://sentry.io").replace(/\/$/, "");

let failures = 0;
let stub: ReturnType<typeof startSqldStub>;
const check = (label: string, pass: boolean, extra: unknown = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

async function main() {
  if (!TOKEN) {
    console.error("Falta el access token de Sentry");
    process.exit(1);
  }

  // 1 ── Entrada del registry
  console.log("1. Entrada en el registro");
  const def = getConnector("sentry");
  check("existe y está disponible", def?.status === "available");
  check("exige PKCE", def?.oauth?.pkce === true);
  check("pide los 6 scopes", def?.oauth?.scopes?.split(" ").length === 6, def?.oauth?.scopes);
  check(
    "event:write presente (resolver/asignar)",
    def?.oauth?.scopes?.includes("event:write") === true,
  );
  // La trampa que motivó esta línea: /oauth/userinfo/ devuelve 403 sin el scope
  // `openid`, que NO pedimos. El meta sale de /api/0/organizations/.
  check(
    "el userinfo NO es /oauth/userinfo/",
    def?.oauth?.userInfoUrl?.endsWith("/api/0/organizations/") === true,
    def?.oauth?.userInfoUrl,
  );
  check("apunta a la instancia esperada", def?.oauth?.authUrl?.startsWith(BASE) === true, def?.oauth?.authUrl);

  // 1b ── El authorization server de Sentry sigue diciendo lo que asumimos.
  // Si Sentry moviera estos endpoints o quitara S256, el conector se rompería en
  // silencio hasta que alguien intentara conectar.
  console.log("\n1b. /.well-known/oauth-authorization-server");
  try {
    const wk = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
    check("authorization_endpoint coincide", wk.authorization_endpoint === def?.oauth?.authUrl, wk.authorization_endpoint);
    check("token_endpoint coincide", wk.token_endpoint === def?.oauth?.tokenUrl, wk.token_endpoint);
    check("soporta S256", wk.code_challenge_methods_supported?.includes("S256") === true);
    check("soporta refresh_token", wk.grant_types_supported?.includes("refresh_token") === true);
    const unknown = (def?.oauth?.scopes ?? "").split(" ").filter((s) => !wk.scopes_supported?.includes(s));
    check("todos nuestros scopes son válidos", unknown.length === 0, unknown.join(", "));
  } catch (e) {
    check("well-known alcanzable", false, String(e));
  }

  // 2 ── parseUserInfo contra la respuesta REAL
  console.log("\n2. parseUserInfo sobre /api/0/organizations/ real");
  const res = await fetch(`${BASE}/api/0/organizations/`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check("Sentry responde 200", res.status === 200, `${res.status}`);
  const json = await res.json();
  const parsed = def!.oauth!.parseUserInfo!(json);
  const meta = parsed.meta as any;
  check("meta.orgs es lista no vacía", Array.isArray(meta.orgs) && meta.orgs.length > 0, meta.orgs?.length);
  check(
    "cada org trae slug",
    (meta.orgs ?? []).every((o: any) => typeof o.slug === "string" && o.slug),
    meta.orgs?.map((o: any) => o.slug).join(", "),
  );
  check("externalId = id de la primera org", parsed.externalId === String(json[0]?.id), parsed.externalId ?? "null");

  // 3 ── Tools: declaración
  console.log("\n3. Declaración de tools");
  // El stub debe existir ANTES de importar el módulo: dbq.server.ts lee SQLD_URL
  // al cargarse, así que fijarlo después no tendría efecto.
  stub = startSqldStub({ meta, token: TOKEN });
  const port = await stub.listen();
  process.env.SQLD_URL = `http://127.0.0.1:${port}`;
  process.env.SQLD_NAMESPACE = "smoke";
  const mod: any = await import("../src/server/connectors/sentry.server");
  check("exporta ambientContext", typeof mod.ambientContext === "function");
  check("exporta tools como lista", Array.isArray(mod.tools));

  const tools = mod.tools as any[];
  check(`declara ${tools.length} tools`, tools.length === 7, `${tools.length}`);
  check("todos los nombres con prefijo sentry_", tools.every((t) => t.name.startsWith("sentry_")));
  check("nombres únicos", new Set(tools.map((t) => t.name)).size === tools.length);
  check(
    "todas traen descripción e inputSchema objeto",
    tools.every((t) => t.description?.length > 20 && t.inputSchema?.type === "object"),
  );
  const required = tools.filter((t) => t.inputSchema.required?.length);
  check(
    `los required existen en properties (${required.length} tools)`,
    required.every((t) => t.inputSchema.required.every((r: string) => r in (t.inputSchema.properties ?? {}))),
  );

  // El ambientContext tiene que NOMBRAR la organización: sin eso el modelo lee
  // "no existe ese proyecto" cuando la verdad es "está en otra org".
  const ctx: string = await mod.ambientContext("x", "Ana", "¿qué errores tengo?");
  check("ambientContext nombra la org", ctx?.includes(meta.orgs[0].slug), meta.orgs[0].slug);
  check("ambientContext lista las tools", tools.every((t) => ctx.includes(t.name)));

  // 4 ── Handlers contra Sentry de verdad
  console.log("\n4. Handlers contra Sentry");
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (!t) return { error: `tool ${name} no existe` };
    return await t.handler("x", args);
  };

  const projects = (await call("sentry_list_projects")) as any;
  check(
    `sentry_list_projects (${Array.isArray(projects) ? projects.length : "?"})`,
    Array.isArray(projects),
    (projects as any)?.error,
  );

  const slug = Array.isArray(projects) ? projects[0]?.slug : null;
  if (!slug) {
    console.log("  ⚠ sin proyectos en la org: se saltan las tools que dependen de uno");
  } else {
    const issues = (await call("sentry_list_issues", { project: slug, limit: 3 })) as any;
    check(
      `sentry_list_issues (${Array.isArray(issues) ? issues.length : "?"})`,
      Array.isArray(issues),
      issues?.error,
    );

    const stats = (await call("sentry_project_stats", { project: slug })) as any;
    check(
      "sentry_project_stats devuelve serie etiquetada",
      Array.isArray(stats) && (stats.length === 0 || typeof stats[0]?.at === "string"),
      stats?.error,
    );

    const issueId = Array.isArray(issues) ? issues[0]?.id : null;
    if (issueId) {
      const issue = (await call("sentry_get_issue", { issueId })) as any;
      check("sentry_get_issue", !issue.error && !!issue.title, issue.error ?? issue.title);

      const ev = (await call("sentry_issue_latest_event", { issueId })) as any;
      check("sentry_issue_latest_event trae excepciones", !ev.error && Array.isArray(ev.exceptions), ev.error);
      // La poda es la razón de existir de trimEvent: sin ella un solo evento se
      // come la ventana de contexto del turno.
      const size = JSON.stringify(ev).length;
      check(`el evento podado pesa ${size} bytes (< 20k)`, size < 20_000, `${size}`);
      check(
        "ningún stacktrace pasa de 25 marcos",
        (ev.exceptions ?? []).every((x: any) => (x.frames?.length ?? 0) <= 25),
      );
    } else {
      console.log("  ⚠ sin issues: se saltan get_issue / latest_event");
    }
  }

  const releases = (await call("sentry_list_releases", { limit: 3 })) as any;
  check(
    `sentry_list_releases (${Array.isArray(releases) ? releases.length : "?"})`,
    Array.isArray(releases),
    releases?.error,
  );

  // 5 ── Errores traducidos
  console.log("\n5. Errores en español accionable");
  stub.setToken("sntryu_invalido");
  const bad = (await call("sentry_list_projects")) as any;
  stub.setToken(TOKEN);
  check(
    "token inválido → mensaje que dice qué hacer",
    typeof bad.error === "string" && /reconecte|conect/i.test(bad.error),
    bad.error,
  );

  // Sin org resoluble no se debe construir una URL con "undefined" dentro.
  stub.setMeta({ orgs: [] });
  const noOrg = (await call("sentry_list_projects")) as any;
  stub.setMeta(meta);
  check("sin org → error legible, no una URL rota", typeof noOrg.error === "string", noOrg.error);

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
        provider: "sentry",
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
        }),
      );
    });
  });
  return {
    listen: () =>
      new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))),
    setMeta: (m: unknown) => (state.meta = m),
    setToken: (t: string) => (state.token = t),
    close: () => server.close(),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
