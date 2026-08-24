import { describe, expect, it } from "vitest";
import {
  aliasTable,
  blockIndex,
  blockSignature,
  blockText,
  collectIds,
  containerAt,
  findBlockPath,
  isDocEnvelope,
  parseDocEnvelope,
  resolveBlockId,
  serializeDocEnvelope,
  type DocBlock,
} from "./doc-blocks";

// Forma real de los bloques, tomada de lo que devuelve `tryParseMarkdownToBlocks`
// contra el @blocknote instalado (no inventada): párrafo con marcas, tabla con
// `content.rows[].cells[]`, y anidamiento por `children`.
const doc: DocBlock[] = [
  { id: "u-h", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Contrato" }] },
  {
    id: "u-p1",
    type: "paragraph",
    content: [
      { type: "text", text: "PRIMERA. El " },
      { type: "text", text: "arrendatario", styles: { bold: true } },
      { type: "text", text: " pagará $5,000." },
    ],
  },
  {
    id: "u-li",
    type: "bulletListItem",
    content: [{ type: "text", text: "SEGUNDA. Objeto" }],
    children: [
      { id: "u-li-a", type: "bulletListItem", content: [{ type: "text", text: "a) inciso uno" }] },
      { id: "u-li-b", type: "bulletListItem", content: [{ type: "text", text: "b) inciso dos" }] },
    ],
  },
  {
    id: "u-t",
    type: "table",
    content: {
      type: "tableContent",
      rows: [
        { cells: [[{ type: "text", text: "Concepto" }], [{ type: "text", text: "Monto" }]] },
        { cells: [[{ type: "text", text: "Renta" }], [{ type: "text", text: "5000" }]] },
      ],
    },
  },
];

describe("blockText", () => {
  it("junta el inline content con sus marcas", () => {
    expect(blockText(doc[1])).toBe("PRIMERA. El arrendatario pagará $5,000.");
  });

  // Sin este caso una tabla firma como vacía y el reconciliador la cree igual a
  // cualquier otra tabla: dos tablas distintas se leerían como "sin cambios".
  it("saca el texto de una tabla (content.rows[].cells[])", () => {
    expect(blockText(doc[3])).toBe("Concepto Monto Renta 5000");
  });

  it("no incluye a los hijos", () => {
    expect(blockText(doc[2])).toBe("SEGUNDA. Objeto");
  });
});

describe("blockSignature", () => {
  it("IGNORA el id — es lo que permite reconocer el prefijo entre ticks", () => {
    const a = { ...doc[1] };
    const b = { ...doc[1], id: "otro-uuid-completamente-distinto" };
    expect(blockSignature(a)).toBe(blockSignature(b));
  });

  it("distingue por texto, por tipo y por props", () => {
    const base = blockSignature(doc[0]);
    expect(base).not.toBe(blockSignature({ ...doc[0], content: [{ type: "text", text: "Otro" }] }));
    expect(base).not.toBe(blockSignature({ ...doc[0], type: "paragraph" }));
    expect(base).not.toBe(blockSignature({ ...doc[0], props: { level: 2 } }));
  });

  it("distingue por los hijos (cambiar un inciso cambia la cláusula)", () => {
    const mutado: DocBlock = {
      ...doc[2],
      children: [doc[2].children![0], { ...doc[2].children![1], content: [{ type: "text", text: "b) OTRO" }] }],
    };
    expect(blockSignature(doc[2])).not.toBe(blockSignature(mutado));
  });
});

describe("aliasTable / resolveBlockId", () => {
  it("numera en profundidad primero, incluyendo hijos", () => {
    expect([...aliasTable(doc).entries()]).toEqual([
      ["n1", "u-h"],
      ["n2", "u-p1"],
      ["n3", "u-li"],
      ["n4", "u-li-a"],
      ["n5", "u-li-b"],
      ["n6", "u-t"],
    ]);
  });

  it("resuelve por alias y TAMBIÉN por uuid literal", () => {
    expect(resolveBlockId(doc, "n4")).toBe("u-li-a");
    expect(resolveBlockId(doc, "u-li-a")).toBe("u-li-a");
    expect(resolveBlockId(doc, "n99")).toBeNull();
    expect(resolveBlockId(doc, "")).toBeNull();
  });
});

describe("blockIndex", () => {
  it("da una línea por bloque, con alias y tipo", () => {
    const idx = blockIndex(doc);
    expect(idx).toContain("n1 heading: Contrato");
    expect(idx).toContain("n4 bulletListItem: a) inciso uno");
    expect(idx).toContain("n6 table: Concepto Monto Renta 5000");
  });

  it("recorta el texto largo y avisa cuántos bloques quedaron fuera", () => {
    const largo: DocBlock[] = Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`,
      type: "paragraph",
      content: [{ type: "text", text: "x".repeat(200) }],
    }));
    const idx = blockIndex(largo, 3, 10);
    expect(idx).toContain("xxxxxxxxxx…");
    expect(idx).toContain("y 2 bloques más");
    expect(idx.split("\n")).toHaveLength(4);
  });
});

describe("sobre (envelope)", () => {
  it("round-trip", () => {
    const md = serializeDocEnvelope({ blocks: doc, sourceMd: "# Contrato\n" });
    expect(isDocEnvelope(md)).toBe(true);
    const back = parseDocEnvelope(md);
    expect(back?.blocks).toHaveLength(4);
    expect(back?.sourceMd).toBe("# Contrato\n");
    expect(back?.humanEdited).toBeUndefined();
  });

  it("omite los campos vacíos (la columna se guarda 20 veces por doc)", () => {
    expect(serializeDocEnvelope({ blocks: [] })).toBe('{"v":1,"blocks":[]}');
  });

  // Back-compat: las filas `doc` de antes de este cambio son markdown pelado y
  // tienen que seguir abriendo.
  it("el markdown legacy NO es un sobre", () => {
    expect(isDocEnvelope("# Contrato\n\nPRIMERA…")).toBe(false);
    expect(parseDocEnvelope("# Contrato")).toBeNull();
  });

  it("un sobre corrupto cae a legacy en vez de reventar", () => {
    expect(parseDocEnvelope('{"v":1,"blocks":')).toBeNull();
    expect(parseDocEnvelope('{"v":1,"blocks":"no soy un array"}')).toBeNull();
  });
});

describe("navegación del árbol", () => {
  it("findBlockPath llega a un hijo anidado", () => {
    expect(findBlockPath(doc, "u-h")).toEqual([0]);
    expect(findBlockPath(doc, "u-li-b")).toEqual([2, 1]);
    expect(findBlockPath(doc, "no-existe")).toBeNull();
  });

  it("containerAt devuelve el array que contiene al bloque, para el splice", () => {
    const c = containerAt(doc, [2, 1])!;
    expect(c.index).toBe(1);
    expect(c.list[c.index].id).toBe("u-li-b");
    expect(c.list).toHaveLength(2); // los children de u-li, no la raíz
  });

  it("containerAt no revienta con una ruta inválida", () => {
    expect(containerAt(doc, [])).toBeNull();
    expect(containerAt(doc, [99])).toBeNull();
    expect(containerAt(doc, [0, 0])).toBeNull(); // el heading no tiene children
  });

  it("collectIds recorre los hijos", () => {
    expect(collectIds(doc).size).toBe(6);
  });
});

describe("🔴 el sobre HEREDA lo que es del documento", () => {
  const bloques = [{ id: "b1", type: "paragraph", props: {}, content: [], children: [] }] as any;
  const sobre = (o: any) => parseDocEnvelope(serializeDocEnvelope(o))!;

  it("lo que el llamador no menciona se arrastra de la versión anterior", () => {
    // El caso real que fallaba: publicas un oficio sin membrete, alguien le corrige una
    // coma en el editor, y el guardado reescribía el sobre DESDE CERO. Volvía el membrete
    // y se perdía el `sourceMd` — y nadie se enteraba hasta abrir el .docx.
    const previo = sobre({ blocks: bloques, sourceMd: "# Oficio", unbranded: true });
    const nuevo = sobre({ blocks: bloques, humanEdited: true, previo });
    expect(nuevo.unbranded).toBe(true);
    expect(nuevo.sourceMd).toBe("# Oficio");
  });

  it("lo que el llamador SÍ dice gana sobre lo heredado, incluso para apagarlo", () => {
    const previo = sobre({ blocks: bloques, unbranded: true });
    // `false` tiene que poder apagar la marca; con `||` en vez de `??` esto heredaría
    // `true` y el interruptor del panel no serviría para volver atrás.
    expect(sobre({ blocks: bloques, unbranded: false, previo }).unbranded).toBeUndefined();
  });

  it("NO se hereda el estado de la VERSIÓN, sólo lo del documento", () => {
    // `humanEdited` marca "esta versión la tocó una persona" y `changedIds` "estos bloques
    // cambiaron AQUÍ". Arrastrarlos marcaría como editada a mano una versión que escribió
    // el agente, y pintaría el resaltado de un cambio viejo sobre un documento intacto.
    const previo = sobre({ blocks: bloques, humanEdited: true, changedIds: ["b1"] });
    const nuevo = sobre({ blocks: bloques, previo });
    expect(nuevo.humanEdited).toBeUndefined();
    expect(nuevo.changedIds).toBeUndefined();
  });

  it("sin `previo` no hereda nada — un documento nuevo nace limpio", () => {
    const previo = sobre({ blocks: bloques, unbranded: true, sourceMd: "viejo" });
    expect(previo.unbranded).toBe(true);
    expect(sobre({ blocks: bloques }).unbranded).toBeUndefined();
    expect(sobre({ blocks: bloques }).sourceMd).toBeUndefined();
  });

  it("un sobre sin marca no engorda con `false`", () => {
    // Se guardan hasta 20 versiones por documento: un `"unbranded":false` en cada una es
    // peso muerto, y es el mismo criterio que ya seguían `humanEdited` y `sourceMd`.
    expect(serializeDocEnvelope({ blocks: bloques })).not.toContain("unbranded");
  });
});
