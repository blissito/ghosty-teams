import { describe, expect, it } from "vitest";
import { extractEbDoc } from "./ebdoc";

// El fence del protocolo solo cuenta cuando ABRE una línea. Si no, el agente hablando
// DE el protocolo abría el panel con su propia charla adentro (2026-07-25).
describe("extractEbDoc — fence real vs mención en prosa", () => {
  it("ignora la mención inline del fence en prosa", () => {
    const body =
      "Lo escribo dentro de un bloque ```eb-artifact`, la plataforma lo va renderizando en vivo\ndentro del iframe a medida que lo genero.\n";
    expect(extractEbDoc(body)).toBeNull();
  });

  it("detecta el fence al abrir línea (aún sin cerrar)", () => {
    const body = "Va el hero:\n```eb-artifact\n<!doctype html><html><head>";
    const doc = extractEbDoc(body);
    expect(doc?.kind).toBe("artifact");
    expect(doc?.closed).toBe(false);
    expect(doc?.md).toContain("<!doctype html>");
    expect(doc?.before.trim()).toBe("Va el hero:");
  });

  it("detecta el fence al inicio absoluto del body", () => {
    const doc = extractEbDoc("```eb-doc\n# Título\n```\nlisto");
    expect(doc?.kind).toBe("doc");
    expect(doc?.closed).toBe(true);
    expect(doc?.md).toContain("# Título");
    expect(doc?.after.trim()).toBe("listo");
  });

  it("conserva el título del fence", () => {
    const doc = extractEbDoc("```eb-sheet Ventas Q3\na,b\n1,2\n```");
    expect(doc?.fenceTitle).toBe("Ventas Q3");
  });
});
