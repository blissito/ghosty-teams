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
    expect(ps).toEqual([{ nodeId: "a17", html: '<div data-id="a17">x</div>', closed: true, op: "replace" }]);
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

// Las tres operaciones de árbol (reemplazar / quitar / agregar) — genéricas, sin nada
// específico de un artefacto concreto.
describe("extractEbPatches — remove e insert", () => {
  it("eb-remove marca el nodo para borrarse, sin HTML", () => {
    const ps = extractEbPatches("Quito esa:\n```eb-remove a17\n```");
    expect(ps).toEqual([{ nodeId: "a17", html: "", closed: true, op: "remove", remove: true }]);
  });

  it("eb-insert trae ancla, posición y el HTML del nodo nuevo", () => {
    const ps = extractEbPatches("```eb-insert a12 append\n<div>nueva</div>\n```");
    expect(ps[0]).toMatchObject({ nodeId: "a12", op: "insert", pos: "append", closed: true });
    expect(ps[0].html).toBe("<div>nueva</div>");
  });

  it("posición ausente o inválida → append", () => {
    expect(extractEbPatches("```eb-insert a12\n<p>x</p>\n```")[0].pos).toBe("append");
    expect(extractEbPatches("```eb-insert a12 encima\n<p>x</p>\n```")[0].pos).toBe("append");
  });

  it("el bubble tampoco muestra el HTML de un insert", () => {
    const bubble = bubbleWithoutEbDoc("Va una más:\n```eb-insert a12 append\n<div>nueva</div>\n```");
    expect(bubble).not.toContain("<div");
    expect(bubble).toContain("Va una más:");
  });
});

// El bubble NUNCA debe decir dos cosas contradictorias ("✅ actualizado" + "⚠️ no pude"):
// el server le pasa el resultado real de aplicar.
describe("bubbleWithoutEbDoc — resultado real del patch", () => {
  const body = "Listo:\n```eb-patch a17\n<div data-id=\"a17\">x</div>\n```";

  it("sin resultado (cliente, aún sin aplicar) → cuenta los pedidos", () => {
    expect(bubbleWithoutEbDoc(body)).toContain("1 ajuste");
  });

  it("nada aplicado → solo el aviso, sin '✅ actualizado'", () => {
    const out = bubbleWithoutEbDoc(body, { applied: 0, failed: ["a17: missing"] });
    expect(out).toContain("No pude aplicar");
    expect(out).not.toContain("✅");
  });

  it("parcial → lo dice con números y los ids que fallaron", () => {
    const out = bubbleWithoutEbDoc(body, { applied: 2, failed: ["a47: unparseable"] });
    expect(out).toContain("2 de 3 ajustes");
    expect(out).toContain("a47");
  });
});

describe("marcas de la cabecera del fence", () => {
  const abre = (header: string) => `texto\n\`\`\`eb-doc${header}\n# Hola\n\`\`\`\n`;

  it("sin marcas, toda la cabecera es el título", () => {
    const d = extractEbDoc(abre(" Acta de la sesión"))!;
    expect(d.fenceTitle).toBe("Acta de la sesión");
    expect(d.isNew).toBe(false);
    expect(d.unbranded).toBeUndefined();
  });

  it("«sin membrete» marca el documento y NO se cuela en el título", () => {
    // ⚠️ Lo que hay que evitar: la cabecera se toma entera como título si no se reconoce
    // la marca, así que un token mal parseado bautiza al documento «sin-membrete Acta…».
    for (const h of [" sin-membrete Acta", " sin membrete: Acta", " sin-marca Acta", " unbranded Acta"]) {
      const d = extractEbDoc(abre(h))!;
      expect(d.unbranded, h).toBe(true);
      expect(d.fenceTitle, h).toBe("Acta");
    }
  });

  it("las marcas se combinan en cualquier orden", () => {
    for (const h of [" nuevo sin-membrete Oficio 12", " sin-membrete nuevo Oficio 12"]) {
      const d = extractEbDoc(abre(h))!;
      expect(d.isNew, h).toBe(true);
      expect(d.unbranded, h).toBe(true);
      expect(d.fenceTitle, h).toBe("Oficio 12");
    }
  });

  it("una marca sola deja el documento sin título", () => {
    const d = extractEbDoc(abre(" sin-membrete"))!;
    expect(d.unbranded).toBe(true);
    expect(d.fenceTitle).toBeUndefined();
  });

  it("🔴 no dice nada ≠ dice que SÍ lleva marca", () => {
    // `undefined` significa "el agente no se pronunció", y entonces manda lo que ya dijera
    // el documento. Si esto fuera `false`, re-emitir un oficio sin repetir la marca le
    // devolvería el membrete que alguien pidió quitar.
    expect(extractEbDoc(abre(" Acta"))!.unbranded).toBeUndefined();
  });

  it("una palabra que sólo EMPIEZA como la marca es título, no marca", () => {
    const d = extractEbDoc(abre(" Sinaloa en cifras"))!;
    expect(d.unbranded).toBeUndefined();
    expect(d.fenceTitle).toBe("Sinaloa en cifras");
  });
});
