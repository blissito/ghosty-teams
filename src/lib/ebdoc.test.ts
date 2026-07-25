import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, extractEbDoc, extractEbPatches } from "./ebdoc";

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

// eb-patch — edición quirúrgica. Mismas trampas que eb-artifact: fence que abre línea,
// tolerancia al streaming y re-parseo idempotente del body acumulado.
describe("extractEbPatches", () => {
  const open = (id: string, html: string) => "```eb-patch " + id + "\n" + html;
  const closed = (id: string, html: string) => open(id, html) + "\n```";

  it("extrae un patch cerrado con su nodeId", () => {
    const ps = extractEbPatches("Quito la tarjeta:\n" + closed("a17", '<div data-id="a17">x</div>'));
    expect(ps).toEqual([{ nodeId: "a17", html: '<div data-id="a17">x</div>', closed: true }]);
  });

  it("es idempotente sobre el mismo body", () => {
    const body = closed("a1", "<p>uno</p>") + "\n" + closed("a2", "<p>dos</p>");
    expect(extractEbPatches(body)).toEqual(extractEbPatches(body));
  });

  it("tolera el fence abierto y el html va creciendo", () => {
    const a = extractEbPatches(open("a5", '<div class="ca'));
    expect(a[0].closed).toBe(false);
    const b = extractEbPatches(open("a5", '<div class="card">hola'));
    expect(b[0].closed).toBe(false);
    expect(b[0].html.length).toBeGreaterThan(a[0].html.length);
  });

  it("varios patches en un turno; solo el último puede estar abierto", () => {
    const body = closed("a1", "<p>1</p>") + "\n" + closed("a2", "<p>2</p>") + "\n" + open("a3", "<p>3");
    const ps = extractEbPatches(body);
    expect(ps.map((p) => p.nodeId)).toEqual(["a1", "a2", "a3"]);
    expect(ps.map((p) => p.closed)).toEqual([true, true, false]);
  });

  it("ignora la mención en prosa (no abre línea)", () => {
    expect(extractEbPatches("te mando un bloque ```eb-patch a17` con el nodo")).toEqual([]);
  });

  it("descarta el patch sin id o sin cuerpo", () => {
    expect(extractEbPatches("```eb-patch\n<div>x</div>\n```")).toEqual([]);
    expect(extractEbPatches(closed("a7", "   "))).toEqual([]);
  });

  it("el bubble no muestra HTML crudo", () => {
    const body = "Listo:\n" + closed("a17", '<div data-id="a17">x</div>');
    const bubble = bubbleWithoutEbDoc(body);
    expect(bubble).not.toContain("<div");
    expect(bubble).toContain("Listo:");
    expect(bubble).toContain("Artefacto actualizado");
  });

  it("mientras streamea el bubble dice que está ajustando", () => {
    expect(bubbleWithoutEbDoc(open("a17", "<div"))).toContain("Ajustando");
  });
});
