/**
 * Smoke de los dos prompts del agente: escribir vs averiguar.
 * Uso: npx tsx scripts/prospeccion-ai-smoke.ts
 *
 * No llama a ningún modelo: comprueba el CONTRATO del prompt, que es lo que decide si un
 * teléfono inventado acaba en la tabla de alguien.
 */
import { buildPromptForTest as buildPrompt, cleanCellValue } from "../src/server/prospeccion/write.server";

let f = 0;
const c = (l: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`);
  if (!ok) f++;
};

const ctx = "Negocio: Salón Bonito\nGiro: Salón de belleza\nSitio: https://salonbonito.mx";

console.log("\n── Buscar un dato: lo que impide inventar ──");
const buscar = buildPrompt("su teléfono", ctx, "research");
c("le dice que lo busque DE VERDAD", /sitio web|internet|redes/i.test(buscar));
c("le dice que calle si no lo encuentra", /Si NO lo encuentras.*—/s.test(buscar));
c("prohíbe deducir y aproximar", /NUNCA.*deduzcas|aproximes|inventes/is.test(buscar));
c("explica POR QUÉ (no basta prohibir)", /no parece.*inventado|peor que una celda vacía/is.test(buscar));
c("cubre el homónimo", /PARECIDO|no estás seguro/i.test(buscar), "otro negocio del mismo nombre");
c("le pasa el contexto para desambiguar", buscar.includes("Salón Bonito"));

console.log("\n── Escribir un texto: generativo, sin esas ataduras ──");
const escribir = buildPrompt("una primera línea", ctx, "write");
c("NO le prohíbe inventar", !/NUNCA.*inventes/is.test(escribir), "aquí inventar ES el trabajo");
c("pero sí exige una sola línea", /Una sola línea/.test(escribir));

console.log("\n── Los dos: la celda tiene que quedar limpia ──");
c("una línea sola", !buscar.includes("```") && !escribir.includes("```"));
c("nada de markdown ni comillas", /Nada de preámbulos, comillas ni markdown/.test(buscar));

console.log("\n── Limpieza de lo que devuelve el modelo ──");
c("el guion largo = vacío", cleanCellValue("—") === null, "es como dice «no lo encontré»");
c("el guion corto también", cleanCellValue("-") === null);
c("quita comillas envolventes", cleanCellValue('"55 1234 5678"') === "55 1234 5678");
c("quita bloques de código", cleanCellValue("```\nhola\n```") === null || !cleanCellValue("```js\nx\n```")?.includes("```"));
c("aplana saltos de línea", cleanCellValue("uno\ndos") === "uno dos");

console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
process.exit(f ? 1 : 0);
