/**
 * Smoke del verificador de correos, contra DNS real.
 * Uso: npx tsx scripts/prospeccion-email-smoke.ts
 */
import { verifyEmail } from "../src/server/prospeccion/verify-email.server";

let f = 0;
const check = async (email: string, esperado: string, nota = "") => {
  const r = await verifyEmail(email);
  const ok = r.verdict === esperado;
  console.log(`  ${ok ? "✓" : "✗"} ${email.padEnd(34)} → ${r.verdict.padEnd(13)} ${nota}`);
  if (!ok) { console.log(`      esperaba ${esperado}`); f++; }
};

console.log("\n── Sintaxis ──");
await check("no-es-un-correo", "sintaxis");
await check("dos@@arrobas.com", "sintaxis");
await check("sin punto@dominio", "sintaxis");
await check("con espacio @gmail.com", "sintaxis");

console.log("\n── Desechables ──");
await check("alguien@mailinator.com", "desechable");
await check("x@yopmail.com", "desechable");

console.log("\n── Dominios REALES (consulta DNS) ──");
await check("hola@gmail.com", "ok", "Gmail sí recibe");
// ✅ ghosty.studio YA tiene MX (se le puso el 2026-08-22, junto con SPF y DMARC). Antes
// daba `sin_mx`: mandaba correo y no podía recibirlo, así que quien respondía escribía al
// vacío. Este caso es la red que avisa si alguien vuelve a quitarle el MX.
await check("contacto@ghosty.studio", "ok", "✅ ya recibe: el MX se puso el 22-ago");
await check("alguien@denik.me", "ok");

console.log("\n── Dominios que NO reciben correo ──");
await check("x@este-dominio-no-existe-jamas-12345.mx", "sin_dominio", "el caso más común de una lista scrapeada");
await check("x@example.com", "sin_mx", "null MX (RFC 7505): rechaza correo a propósito");

console.log("\n── Buzones de rol: se MARCAN, no se descartan ──");
await check("noreply@gmail.com", "rol", "no contesta jamás");
await check("contacto@gmail.com", "ok", "⚠️ contacto@ NO es rol: es a quien hay que escribir");

console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
process.exit(f ? 1 : 0);
