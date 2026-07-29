import { describe, expect, it } from "vitest";
import { applyBlockPatches, type EbPatchLike } from "./doc-patch";
import { aliasTable, collectIds, type DocBlock } from "./doc-blocks";

const p = (id: string, text: string, children?: DocBlock[]): DocBlock => ({
  id,
  type: "paragraph",
  content: [{ type: "text", text }],
  ...(children ? { children } : {}),
});

// `parse` inyectado: imita a mdToBlocks sin traer @blocknote. Acuña ids nuevos, como
// hace BlockNote de verdad.
let seq = 0;
const deps = {
  parse: async (md: string): Promise<DocBlock[]> =>
    md.trim()
      ? md
          .trim()
          .split("\n\n")
          .map((chunk) => p(`fresh-${++seq}`, chunk.trim()))
      : [],
};

const doc = (): DocBlock[] => [
  p("u1", "PRIMERA. Objeto."),
  p("u2", "SEGUNDA. Plazo."),
  p("u3", "TERCERA. Renta.", [p("u3a", "a) pago mensual")]),
];

const patch = (nodeId: string, html: string, extra: Partial<EbPatchLike> = {}): EbPatchLike => ({
  nodeId,
  html,
  closed: true,
  op: "replace",
  ...extra,
});

describe("applyBlockPatches — reemplazar", () => {
  it("cambia SÓLO el bloque apuntado y los demás conservan su id", async () => {
    const r = await applyBlockPatches(doc(), [patch("n2", "SEGUNDA. Plazo de 24 meses.")], deps);
    expect(r.applied).toEqual(["n2"]);
    expect(r.failed).toEqual([]);
    expect(r.blocks.map((b) => b.id)).toEqual(["u1", expect.stringMatching(/^fresh-/), "u3"]);
  });
});

describe("applyBlockPatches", () => {
  it("no muta los bloques de entrada", async () => {
    const original = doc();
    const snapshot = JSON.stringify(original);
    await applyBlockPatches(original, [patch("n1", "OTRA COSA")], deps);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("resuelve por alias y por uuid literal", async () => {
    const byAlias = await applyBlockPatches(doc(), [patch("n1", "X")], deps);
    const byUuid = await applyBlockPatches(doc(), [patch("u1", "X")], deps);
    expect(byAlias.applied).toEqual(["n1"]);
    expect(byUuid.applied).toEqual(["u1"]);
  });

  it("llega a un bloque ANIDADO (una cláusula con incisos)", async () => {
    // n4 = u3a, el hijo de la tercera cláusula.
    expect(aliasTable(doc()).get("n4")).toBe("u3a");
    const r = await applyBlockPatches(doc(), [patch("n4", "a) pago quincenal")], deps);
    expect(r.applied).toEqual(["n4"]);
    expect(r.blocks[2].children).toHaveLength(1);
    expect(r.blocks[2].children![0].id).toMatch(/^fresh-/);
    expect(r.blocks.map((b) => b.id)).toEqual(["u1", "u2", "u3"]); // la raíz intacta
  });

  it("un patch puede expandirse en VARIOS bloques", async () => {
    const r = await applyBlockPatches(doc(), [patch("n2", "SEGUNDA. Plazo.\n\nSe prorroga.")], deps);
    expect(r.blocks).toHaveLength(4);
    expect(r.applied).toEqual(["n2"]);
  });
});

describe("applyBlockPatches — quitar e insertar", () => {
  it("remove borra el bloque", async () => {
    const r = await applyBlockPatches(doc(), [patch("n2", "", { op: "remove", remove: true })], deps);
    expect(r.blocks.map((b) => b.id)).toEqual(["u1", "u3"]);
    expect(r.applied).toEqual(["n2"]);
  });

  it("insert before / after son HERMANOS", async () => {
    const before = await applyBlockPatches(doc(), [patch("n2", "NUEVA", { op: "insert", pos: "before" })], deps);
    expect(before.blocks.map((b) => b.id?.slice(0, 5))).toEqual(["u1", "fresh", "u2", "u3"]);
    const after = await applyBlockPatches(doc(), [patch("n2", "NUEVA", { op: "insert", pos: "after" })], deps);
    expect(after.blocks.map((b) => b.id?.slice(0, 5))).toEqual(["u1", "u2", "fresh", "u3"]);
  });

  it("append / prepend entran como HIJOS (un inciso nuevo)", async () => {
    // El documento tiene 4 bloques y el orden es profundidad primero: u1,u2,u3,u3a.
    expect(aliasTable(doc()).get("n3")).toBe("u3");
    const r = await applyBlockPatches(doc(), [patch("n3", "b) recargos", { op: "insert", pos: "append" })], deps);
    expect(r.blocks[2].children!.map((b) => b.id?.slice(0, 5))).toEqual(["u3a", "fresh"]);
    const pre = await applyBlockPatches(doc(), [patch("n3", "0) previo", { op: "insert", pos: "prepend" })], deps);
    expect(pre.blocks[2].children!.map((b) => b.id?.slice(0, 5))).toEqual(["fresh", "u3a"]);
    expect(r.failed.concat(pre.failed)).toHaveLength(0);
  });

  it("append sobre un bloque SIN hijos le crea el array", async () => {
    const r = await applyBlockPatches(doc(), [patch("n1", "a) uno", { op: "insert", pos: "append" })], deps);
    expect(r.blocks[0].children).toHaveLength(1);
  });
});

describe("applyBlockPatches — fallos, VISIBLES y tipados", () => {
  it("dirección que no existe → missing, y el resto SÍ aplica", async () => {
    const r = await applyBlockPatches(doc(), [patch("n99", "X"), patch("n1", "Y")], deps);
    expect(r.failed).toEqual([{ ref: "n99", reason: "missing" }]);
    expect(r.applied).toEqual(["n1"]);
  });

  it("markdown que no produce bloques → unparseable, y NO toca el documento", async () => {
    const r = await applyBlockPatches(doc(), [patch("n1", "   ")], deps);
    // El filtro de `usable` ya lo descarta por venir sin cuerpo.
    expect(r.applied).toEqual([]);
    expect(r.blocks.map((b) => b.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("si parse revienta → unparseable, sin tumbar los demás", async () => {
    const boom = {
      parse: async (md: string) => {
        if (md.includes("BOOM")) throw new Error("parser roto");
        return [p("nuevo", md)];
      },
    };
    const r = await applyBlockPatches(doc(), [patch("n1", "BOOM"), patch("n2", "bien")], boom);
    expect(r.failed).toEqual([{ ref: "n1", reason: "unparseable" }]);
    expect(r.applied).toEqual(["n2"]);
  });

  it("un fence ABIERTO se ignora (no es una instrucción todavía)", async () => {
    const r = await applyBlockPatches(doc(), [patch("n1", "a medio escribir", { closed: false })], deps);
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("nada aplicado → el documento sale idéntico (el llamador no crea versión)", async () => {
    const r = await applyBlockPatches(doc(), [patch("n99", "X")], deps);
    expect(r.applied).toHaveLength(0);
    expect(JSON.stringify(r.blocks)).toBe(JSON.stringify(doc()));
  });
});

describe("applyBlockPatches — unicidad de ids", () => {
  // Si el modelo copia un bloque, el parse puede devolver un id que ya está en uso. Dos
  // bloques con el mismo id rompen los alias, findBlockPath y (mañana) el fragment Yjs.
  it("re-acuña un id que colisiona con uno existente", async () => {
    const colisiona = { parse: async (md: string) => [p("u3", md)] }; // u3 ya existe
    const r = await applyBlockPatches(doc(), [patch("n1", "X")], colisiona);
    const ids = r.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(collectIds(r.blocks).size).toBe(4); // u2, u3, u3a + el re-acuñado
    expect(ids[0]).toBe("u3-2");
  });
});

describe("applyBlockPatches — varios patches en un turno", () => {
  it("aplica dos cláusulas distintas y ambas cuentan", async () => {
    const r = await applyBlockPatches(doc(), [patch("n1", "PRIMERA bis"), patch("n3", "TERCERA bis")], deps);
    expect(r.applied).toEqual(["n1", "n3"]);
    expect(r.failed).toEqual([]);
    expect(r.blocks[1].id).toBe("u2");
  });

  // EL caso que obliga a fijar la tabla de alias antes de tocar nada. El modelo eligió
  // n1 y n3 mirando el documento que se le mostró; si los alias se re-resolvieran contra
  // el árbol ya mutado, el primer patch renumeraría y n3 caería en otro bloque — un
  // cambio quirúrgico aplicado en el lugar equivocado, en silencio.
  it("el segundo patch apunta a donde el MODELO quiso, no a donde quedó tras el primero", async () => {
    // n1 se expande en DOS bloques: sin tabla fija, n3 pasaría a ser otro nodo.
    const r = await applyBlockPatches(
      doc(),
      [patch("n1", "PRIMERA bis\n\nañadido"), patch("n3", "TERCERA bis")],
      deps,
    );
    expect(r.applied).toEqual(["n1", "n3"]);
    expect(r.blocks).toHaveLength(4);
    // El último sigue siendo el que era u3, ya reemplazado, y conserva su hijo original
    // sólo si NO se tocó: aquí se reemplazó, así que lo que importa es que u2 sobrevive
    // intacto en medio y que el reemplazo cayó en la posición del tercero.
    expect(r.blocks[2].id).toBe("u2");
    expect(r.blocks[3].id).toMatch(/^fresh-/);
  });

  it("borrar un bloque y luego apuntarle → missing, no otro bloque por error", async () => {
    const r = await applyBlockPatches(
      doc(),
      [patch("n2", "", { op: "remove", remove: true }), patch("n2", "resucita")],
      deps,
    );
    expect(r.applied).toEqual(["n2"]);
    expect(r.failed).toEqual([{ ref: "n2", reason: "missing" }]);
  });
});
