import { describe, expect, it } from "vitest";
import { docEnvelopeFromMd, docMarkdown, mdToBlocks } from "./doc-blocks.server";
import { applyBlockPatches } from "../lib/doc-patch";
import { aliasTable, blockIndex, parseDocEnvelope } from "../lib/doc-blocks";

// Integración con el @blocknote REAL (ServerBlockNoteEditor + su jsdom), no con mocks.
// Es la cadena que corre en un turno: markdown del agente → sobre → índice para el
// modelo → patch por dirección → markdown para el .docx.
describe("cadena real de un documento", () => {
  const contrato = [
    "# CONTRATO INDIVIDUAL DE TRABAJO",
    "",
    "PRIMERA. El **patrón** contrata a ALEXANDRA MORALES JUAREZ.",
    "",
    "SEGUNDA. El salario será de $8,000.00 mensuales.",
    "",
    "TERCERA. La jornada es de 48 horas.",
    "",
    "| Concepto | Monto |",
    "| --- | --- |",
    "| Sueldo | 8000 |",
    "| Aguinaldo | 15 días |",
    "",
  ].join("\n");

  it("markdown → sobre con bloques, y el markdown vuelve intacto", async () => {
    const stored = await docEnvelopeFromMd(contrato);
    const env = parseDocEnvelope(stored)!;
    expect(env.v).toBe(1);
    expect(env.blocks.length).toBeGreaterThan(3);
    expect(env.sourceMd).toBe(contrato);
    // Mientras nadie lo edite a mano, al agente se le devuelve su propio texto: cero deriva.
    expect(await docMarkdown(stored)).toBe(contrato);
  });

  it("la TABLA sobrevive el round-trip (es lo que mammoth perdía)", async () => {
    const blocks = await mdToBlocks(contrato);
    expect(blocks.some((b) => b.type === "table")).toBe(true);
    const { blocksToMd } = await import("./doc-blocks.server");
    const back = await blocksToMd(blocks);
    expect(back).toContain("Aguinaldo");
    expect(back).toContain("15 días");
    expect(back).toMatch(/\|/);
  });

  it("el índice que ve el modelo nombra las cláusulas", async () => {
    const blocks = await mdToBlocks(contrato);
    const idx = blockIndex(blocks, 80);
    expect(idx).toContain("PRIMERA");
    expect(idx).toContain("SEGUNDA");
    expect(idx).toMatch(/n1 heading/);
  });

  // EL caso del usuario: cambiar UNA cláusula sin tocar el resto.
  it("un eb-patch cambia SÓLO la segunda cláusula y los demás bloques conservan su uuid", async () => {
    const blocks = await mdToBlocks(contrato);
    const alias = aliasTable(blocks);
    // n3 = la SEGUNDA cláusula (n1 heading, n2 PRIMERA, n3 SEGUNDA).
    const antes = blocks.map((b) => b.id);
    const res = await applyBlockPatches(
      blocks,
      [{ nodeId: "n3", html: "SEGUNDA. El salario será de $12,500.00 mensuales.", closed: true, op: "replace" }],
      { parse: mdToBlocks },
    );
    expect(res.applied).toEqual(["n3"]);
    expect(res.failed).toEqual([]);
    const despues = res.blocks.map((b) => b.id);
    // Todos iguales menos el parcheado.
    expect(despues[0]).toBe(antes[0]);
    expect(despues[1]).toBe(antes[1]);
    expect(despues[2]).not.toBe(antes[2]);
    expect(despues[3]).toBe(antes[3]);
    expect(alias.get("n3")).toBe(antes[2]);

    const { blocksToMd } = await import("./doc-blocks.server");
    const md = await blocksToMd(res.blocks);
    expect(md).toContain("$12,500.00");
    expect(md).not.toContain("$8,000.00");
    expect(md).toContain("TERCERA. La jornada es de 48 horas."); // el resto intacto
    expect(md).toContain("Aguinaldo"); // y la tabla también
  });

  it("una fila LEGACY (markdown pelado) se sigue leyendo", async () => {
    expect(await docMarkdown("# Viejo\n\nsin sobre")).toBe("# Viejo\n\nsin sobre");
  });

  it("un documento con un fence dentro no rompe el sobre", async () => {
    const conFence = "# Guía\n\n```bash\nls -la\n```\n\nFin.\n";
    const stored = await docEnvelopeFromMd(conFence);
    expect(parseDocEnvelope(stored)).not.toBeNull();
    expect(await docMarkdown(stored)).toBe(conFence);
  });
});
