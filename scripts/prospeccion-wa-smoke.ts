import { normalizeWaPhone, prettyWaPhone } from "../src/lib/prospeccion-wa-phone";
let f = 0;
const c = (raw: string, esperado: string | null, nota = "") => {
  const r = normalizeWaPhone(raw);
  const ok = r === esperado;
  console.log(`  ${ok ? "✓" : "✗"} ${raw.padEnd(22)} → ${String(r).padEnd(14)} ${r ? prettyWaPhone(r) : ""} ${nota}`);
  if (!ok) { console.log(`      esperaba ${esperado}`); f++; }
};
console.log("\n── El número que pasó Brenda ──");
c("7714460521", "527714460521", "10 dígitos → se le pone el 52");
console.log("\n── Otras formas del mismo número ──");
c("771 446 0521", "527714460521", "con espacios");
c("+52 771 446 0521", "527714460521", "ya con lada");
c("527714460521", "527714460521", "pelado");
c("5217714460521", "527714460521", "⚠️ con el 1 de móvil → SE QUITA");
c("+52 1 771 446 0521", "527714460521", "el 1 escrito aparte");
console.log("\n── Basura ──");
c("no es un número", null);
c("123", null, "muy corto");
c("", null, "vacío");
console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
process.exit(f ? 1 : 0);
