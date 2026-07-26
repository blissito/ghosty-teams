/**
 * Smoke del refresco de `meta` de conectores.
 * Uso: npx tsx scripts/connector-meta-smoke.ts <accessTokenDeDenik>
 *
 * Levanta un sqld falso (protocolo pipeline) con una fila de gc_user_connectors
 * en memoria y ejercita el camino REAL store → meta.server → registry, contra
 * una instancia de Deník de verdad. Verifica lo que el diseño promete:
 *
 *  - meta_at NULL (conexión vieja) → refresca Y ESPERA, así se auto-repara sin
 *    que el usuario reconecte.
 *  - meta_at fresco → no-op, sin pegarle al proveedor.
 *  - meta_at vencido → refresca sin bloquear el turno.
 *  - userinfo caído → NO pisa el meta bueno, pero sí avanza meta_at para no
 *    reintentar en cada turno.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN = process.argv[2];
const BASE = (process.env.DENIK_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
const check = (label: string, pass: boolean, extra = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

/** sqld falso: una sola fila, con SELECT/UPDATE suficientes para este flujo. */
function startSqldStub(row: Record<string, string | null>) {
  const cols = [
    "user_sub",
    "provider",
    "access_token",
    "refresh_token",
    "expires_at",
    "external_id",
    "meta",
    "meta_at",
  ];
  let hits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const stmt = JSON.parse(body || "{}")?.requests?.[0]?.stmt ?? {};
      const sql = String(stmt.sql ?? "");
      const args = (stmt.args ?? []).map((a: any) => (a.type === "null" ? null : a.value));
      let rows: any[] = [];

      if (/^\s*SELECT/i.test(sql) && sql.includes("gc_user_connectors")) {
        rows = [cols.map((c) => ({ value: row[c] }))];
      } else if (/^\s*UPDATE/i.test(sql) && sql.includes("gc_user_connectors")) {
        hits++;
        if (sql.includes("meta = COALESCE")) {
          if (args[0] != null) row.meta = args[0];
          if (args[1] != null) row.external_id = args[1];
          row.meta_at = String(Math.floor(Date.now() / 1000));
        } else if (sql.includes("meta_at=0")) {
          row.meta_at = "0";
        } else {
          row.meta_at = String(Math.floor(Date.now() / 1000));
        }
      }

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
      new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))),
    row,
    writes: () => hits,
    close: () => server.close(),
  };
}

async function main() {
  if (!TOKEN) {
    console.error("Falta el access token de Deník");
    process.exit(1);
  }

  // Simula una conexión hecha ANTES de que existiera meta_at, con un meta viejo
  // al que le falta el campo que agregamos después.
  const viejo = JSON.stringify({ email: "x@y.com", orgs: [{ id: "A", name: "Vieja" }] });
  const stub = startSqldStub({
    user_sub: "u1",
    provider: "denik",
    access_token: TOKEN,
    refresh_token: null,
    expires_at: String(Math.floor(Date.now() / 1000) + 86_400),
    external_id: "viejo",
    meta: viejo,
    meta_at: null, // ← nunca refrescada
  });
  const port = await stub.listen();
  process.env.SQLD_URL = `http://127.0.0.1:${port}`;
  process.env.SQLD_NAMESPACE = "smoke";
  process.env.DENIK_BASE_URL = BASE;

  const { refreshConnectorMetaIfStale, invalidateConnectorMeta } = await import(
    "../src/server/connectors/meta.server"
  );

  // 1 ── meta_at NULL → refresca y ESPERA (auto-reparación sin reconectar)
  console.log("1. Conexión vieja (meta_at NULL)");
  const t0 = Date.now();
  await refreshConnectorMetaIfStale("u1", "denik");
  const ms = Date.now() - t0;
  const nuevo = JSON.parse(stub.row.meta!);
  check("el meta cambió", stub.row.meta !== viejo);
  check("meta_at quedó puesto", stub.row.meta_at != null, stub.row.meta_at ?? "null");
  check("trae los orgs reales", Array.isArray(nuevo.orgs) && nuevo.orgs[0]?.name !== "Vieja", nuevo.orgs?.map((o: any) => o.name).join(", "));
  check(
    "trae isPlatformAdmin",
    typeof nuevo.isPlatformAdmin === "boolean",
    String(nuevo.isPlatformAdmin)
  );
  check(
    "y el campo nuevo orgsTotalInPlatform",
    nuevo.orgsTotalInPlatform != null,
    String(nuevo.orgsTotalInPlatform)
  );
  check("external_id actualizado", stub.row.external_id !== "viejo", stub.row.external_id ?? "");
  console.log(`    (esperó ${ms}ms — sólo ocurre una vez por conexión)`);

  // 2 ── fresco → no-op
  console.log("\n2. meta_at fresco");
  const antes = stub.writes();
  await refreshConnectorMetaIfStale("u1", "denik");
  check("no le pega al proveedor ni escribe", stub.writes() === antes, `writes ${antes}→${stub.writes()}`);

  // 3 ── vencido → refresca SIN bloquear
  console.log("\n3. meta_at vencido (hace 20 min)");
  stub.row.meta_at = String(Math.floor(Date.now() / 1000) - 20 * 60);
  const t1 = Date.now();
  await refreshConnectorMetaIfStale("u1", "denik");
  const ms1 = Date.now() - t1;
  check("no bloquea el turno (<50ms)", ms1 < 50, `${ms1}ms`);
  await new Promise((r) => setTimeout(r, 1500)); // dejar aterrizar el fire-and-forget
  check("igual se refrescó en segundo plano", Number(stub.row.meta_at) > Math.floor(Date.now() / 1000) - 60);

  // 4 ── invalidate deja vencido, NO "primera vez"
  console.log("\n4. invalidateConnectorMeta (tras renovar token)");
  await invalidateConnectorMeta("u1", "denik");
  check("meta_at = 0, no NULL", stub.row.meta_at === "0", String(stub.row.meta_at));
  const t2 = Date.now();
  await refreshConnectorMetaIfStale("u1", "denik");
  check("⇒ no vuelve a bloquear", Date.now() - t2 < 50, `${Date.now() - t2}ms`);
  await new Promise((r) => setTimeout(r, 1500));

  // 5 ── proveedor caído → conserva el meta bueno pero avanza meta_at
  console.log("\n5. Proveedor caído");
  const bueno = stub.row.meta;
  process.env.DENIK_BASE_URL = "http://127.0.0.1:9"; // puerto muerto
  const { getConnector } = await import("../src/server/connectors/registry");
  // El registry ya resolvió su URL al importarse; se fuerza a mano para el caso.
  const def = getConnector("denik")!;
  const urlBueno = def.oauth!.userInfoUrl;
  (def.oauth as any).userInfoUrl = "http://127.0.0.1:9/api/agenda/me";
  stub.row.meta_at = String(Math.floor(Date.now() / 1000) - 20 * 60);
  await refreshConnectorMetaIfStale("u1", "denik");
  await new Promise((r) => setTimeout(r, 4000)); // timeout del fetch + margen
  check("NO pisa el meta bueno", stub.row.meta === bueno);
  check(
    "pero avanza meta_at (no reintenta cada turno)",
    Number(stub.row.meta_at) > Math.floor(Date.now() / 1000) - 60,
    stub.row.meta_at ?? ""
  );
  (def.oauth as any).userInfoUrl = urlBueno;

  stub.close();
  console.log(failures === 0 ? "\n✅ Todo verde." : `\n❌ ${failures} fallaron.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
