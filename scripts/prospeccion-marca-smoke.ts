/**
 * Smoke del SOBRE con marca: quién habla en el correo.
 * Uso: npx tsx scripts/prospeccion-marca-smoke.ts
 *
 * Lo importante no es que se vea bonito: es que SIN marca el correo salga EXACTAMENTE igual
 * que siempre. Esta plantilla la usan también las notificaciones del producto, que sí son
 * Ghosty hablando.
 */
import { ghostyEmail } from "../src/server/email-template.server";

let f = 0;
const c = (l: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`);
  if (!ok) f++;
};

const base = { head: "Hola", body: "Un mensaje", cta: { label: "Escríbenos", url: "https://wa.me/52771" } };

console.log("\n── SIN marca: nada cambia ──");
const sin = ghostyEmail({ ...base });
c("sigue el mascot", sin.html.includes("cid:mascot") || sin.html.includes("mascot-mail.png"));
c("y se adjunta", sin.inline.length === 1, "va incrustado, sin petición de red al abrir");
c("sigue el globo de cómic", sin.html.includes("border-right:10px solid #ffffff"));
c("dice Ghosty Studio", sin.html.includes("Ghosty Studio"));
c("el botón, negro de siempre", sin.html.includes("background:#16161a"));

console.log("\n── CON marca: habla el cliente ──");
const con = ghostyEmail({
  ...base,
  brand: { name: "Deník", logoUrl: "https://cdn.x/denik.png", accent: "#0ea5e9", fontFamily: "Inter" },
});
c("el logo sustituye al mascot", con.html.includes("https://cdn.x/denik.png") && !con.html.includes("cid:mascot"));
c("NO adjunta el mascot", con.inline.length === 0, "no aparece en el HTML: adjuntarlo sería peso muerto");
c("se va el globo", !con.html.includes("border-right:10px solid #ffffff"), "un globo sin quien lo diga no significa nada");
c("el botón toma el color", con.html.includes("background:#0ea5e9"));
c("y la tipografía", con.html.includes('"Inter", system-ui'));
c("con respaldo del sistema", con.html.includes("system-ui,-apple-system"), "⚠️ un cliente de correo no carga fuentes web");

console.log("\n── Marca sin logo: sin globo huérfano ──");
const soloNombre = ghostyEmail({ ...base, brand: { name: "Deník", accent: "#0ea5e9" } });
c("pone el nombre", soloNombre.html.includes("Deník"));
c("y tampoco el mascot", !soloNombre.html.includes("cid:mascot"));

console.log("\n── Defensas ──");
const malColor = ghostyEmail({ ...base, brand: { name: "X", accent: "rojo" } });
c("un color inválido no rompe", malColor.html.includes("background:#16161a"), "cae al negro de siempre");
const inyeccion = ghostyEmail({ ...base, brand: { name: '"><script>alert(1)</script>', accent: "#000000" } });
c("escapa el nombre de marca", !/<script/i.test(inyeccion.html));

console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
process.exit(f ? 1 : 0);
