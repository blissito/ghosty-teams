// Humo del camino REAL (guard de red + transporte + traducción) contra un Odoo vivo.
import { assertPublicOrigin, guardedFetch } from "../src/server/connectors/net-guard.server";
import { verifyCredentials } from "../src/server/connectors/odoo.server";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

// 1) El guard acepta un Odoo público real y devuelve el origin limpio.
const origin = await assertPublicOrigin("https://www.odoo.com/web/login?x=1");
ok(origin === "https://www.odoo.com", `guard normaliza el origin → ${origin}`);

// 2) El guard rechaza la red interna, resolviendo de verdad (no mock).
for (const malo of ["http://172.20.0.1:8080", "http://169.254.169.254/", "https://localhost"]) {
  let rechazado = false;
  try { await assertPublicOrigin(malo); } catch { rechazado = true; }
  ok(rechazado, `guard rechaza ${malo}`);
}

// 3) guardedFetch habla JSON-RPC con un Odoo de verdad.
const r = await guardedFetch(origin, "/jsonrpc", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { service: "common", method: "version", args: [] } }),
});
const version = JSON.parse(r.body)?.result?.server_version;
ok(r.status === 200 && !!version, `guardedFetch → Odoo ${version}`);

// 4) verifyCredentials con credenciales falsas: tiene que fallar LIMPIO y en español,
//    apuntando a la base de datos (que es donde más se falla), no con un stacktrace.
const bad = await verifyCredentials({ url: "https://www.odoo.com", db: "no-existe-esta-db", login: "nadie@example.com", apiKey: "xxx" });
ok(bad.ok === false, "credenciales falsas → rechazadas");
if (!bad.ok) {
  console.log(`  mensaje: ${bad.error}`);
  ok(!/stack|Error:|undefined/i.test(bad.error), "el mensaje no filtra detalle técnico");
  // Odoo deja salir el error crudo de su Postgres, con la IP y el puerto internos dentro.
  ok(!/\d+\.\d+\.\d+\.\d+|port \d+|FATAL/i.test(bad.error), "el mensaje no filtra la infraestructura de Odoo");
  ok(/base de datos/i.test(bad.error), "el mensaje dice qué corregir");
  ok(!bad.error.includes("xxx"), "el mensaje no filtra la API key");
}

// 5) Una URL que responde pero no es Odoo.
const noOdoo = await verifyCredentials({ url: "https://example.com", db: "x", login: "a@b.com", apiKey: "k" });
ok(noOdoo.ok === false, "un host que no es Odoo → rechazado");
if (!noOdoo.ok) {
  console.log(`  mensaje: ${noOdoo.error}`);
  ok(!/<html|<!doctype|<style/i.test(noOdoo.error), "no le vuelca HTML crudo al modelo");
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTodo verde");
process.exit(fallos ? 1 : 0);
