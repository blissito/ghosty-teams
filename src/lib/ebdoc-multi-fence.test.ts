// ── UN bloque por mensaje: la verdad de la plataforma y la regla que la describe ────────
//
// El guardrail llegó a decir dos cosas incompatibles: «UN SOLO documento por mensaje…
// DESCARTA los demás» (2026-08-03) y, en otra regla anterior, «si piden prosa y tabla,
// emite AMBOS bloques». Obedecer la segunda perdía el segundo bloque SIN RASTRO — no se
// publicaba y tampoco quedaba visible en la burbuja, así que la persona creía tener su
// tabla. No fue descuido: se descubrió la limitación y nadie volvió sobre la regla vieja.
//
// De ahí las dos capas de aquí. La de COMPORTAMIENTO ancla el límite real: el día que la
// plataforma publique N bloques, se pone roja y obliga a revisar el guardrail — que es
// exactamente el eslabón que faltó. La de TEXTO cuida que las dos reglas no vuelvan a
// divergir. Un test de texto solo comprobaría lo que yo escribí; por eso no va solo.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractEbDoc, bubbleWithoutEbDoc } from "./ebdoc";

/** Lo que emitiría el agente al obedecer la regla vieja: prosa Y tabla en un mensaje. */
const DOS_BLOQUES = [
  "Va la carta y la tabla de clientes.",
  "",
  "```eb-doc Carta de presentación",
  "Tijuana, Baja California, a 10 de agosto de 2026.",
  "```",
  "",
  "```eb-sheet Clientes",
  "nombre,ciudad",
  "Abigail,Monterrey",
  "```",
].join("\n");

describe("un mensaje con dos fences", () => {
  it("sólo el PRIMER bloque llega al camino que publica", () => {
    const doc = extractEbDoc(DOS_BLOQUES);
    expect(doc?.kind).toBe("doc");
    expect(doc?.closed).toBe(true);
    expect(doc?.fenceTitle).toBe("Carta de presentación");
  });

  it("la hoja queda en `after`, y nadie vuelve a analizar `after`", () => {
    // chat.ts llama a extractEbDoc UNA vez y publica ese resultado: lo que caiga aquí se
    // pierde. El test lo deja escrito para que no haya que re-derivarlo leyendo el flujo.
    const doc = extractEbDoc(DOS_BLOQUES);
    expect(doc?.after).toContain("```eb-sheet");
    expect(extractEbDoc(doc?.after ?? "")?.kind).toBe("sheet");
  });

  it("y en la burbuja no sobrevive ninguno: la pérdida es INVISIBLE", () => {
    // bubbleWithoutEbDoc sí es N-aware (itera todos los fences), así que el segundo
    // bloque desaparece también de la pantalla. Publicador y limpiador no van al mismo
    // paso: ésa es la razón de que el fallo no se note.
    const burbuja = bubbleWithoutEbDoc(DOS_BLOQUES);
    expect(burbuja).not.toContain("eb-doc");
    expect(burbuja).not.toContain("eb-sheet");
    expect(burbuja).not.toContain("Abigail");
  });
});

/** El array del guardrail, tal cual está en el fuente. */
function guardrailRules(): string[] {
  const src = readFileSync(new URL("../agents.server.ts", import.meta.url), "utf8");
  const block = /const EB_DOC_STREAM_GUARDRAIL = \[([\s\S]*?)\n\]\.join/.exec(src);
  if (!block) throw new Error("no encontré EB_DOC_STREAM_GUARDRAIL");
  return [...block[1].matchAll(/^ {2}"((?:[^"\\]|\\.)*)",?$/gm)].map((m) => m[1]);
}

describe("coherencia interna del guardrail", () => {
  it("sigue declarando el límite de un documento por mensaje", () => {
    const rules = guardrailRules();
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.some((r) => /UN SOLO documento por mensaje/.test(r))).toBe(true);
  });

  it("ninguna regla manda emitir dos bloques de artefacto en el mismo mensaje", () => {
    const ofensivas = guardrailRules().filter((r) => /emite\s+(ambos|los dos)\s+bloques/i.test(r));
    expect(ofensivas).toEqual([]);
  });
});
