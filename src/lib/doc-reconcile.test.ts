import { describe, expect, it, vi } from "vitest";
import { reconcile, type ReconcilableEditor } from "./doc-reconcile";
import type { DocBlock } from "./doc-blocks";

// Editor de mentira que aplica los splices de verdad sobre un array. Así el test mide
// el RESULTADO (qué quedó en el documento y con qué ids), no sólo qué método se llamó.
function fakeEditor(initial: DocBlock[]) {
  let docu = [...initial];
  const calls: string[] = [];
  const ed: ReconcilableEditor & { blocks: () => DocBlock[]; calls: string[] } = {
    get document() {
      return docu;
    },
    replaceBlocks(target, blocks) {
      calls.push("replace");
      const t = target as DocBlock[];
      const b = blocks as DocBlock[];
      const from = docu.findIndex((x) => x === t[0]);
      if (from < 0) throw new Error("target no está en el documento");
      docu = [...docu.slice(0, from), ...b, ...docu.slice(from + t.length)];
    },
    insertBlocks(blocks, reference, placement) {
      calls.push(`insert:${placement}`);
      const at = docu.findIndex((x) => x === reference);
      if (at < 0) throw new Error("referencia no está en el documento");
      const pos = placement === "after" ? at + 1 : at;
      docu = [...docu.slice(0, pos), ...(blocks as DocBlock[]), ...docu.slice(pos)];
    },
    removeBlocks(target) {
      calls.push("remove");
      const t = new Set(target as DocBlock[]);
      docu = docu.filter((x) => !t.has(x));
    },
    blocks: () => docu,
    calls,
  };
  return ed;
}

const p = (id: string, text: string): DocBlock => ({
  id,
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("reconcile — el prefijo estable conserva sus ids", () => {
  // EL invariante del streaming. Cada tick re-parsea el markdown y acuña uuids nuevos;
  // si esto falla, el documento se remonta entero en cada tick (parpadeo, scroll y
  // cursor) y los alias que el modelo vio en el turno anterior dejan de resolver.
  it("un tick que sólo agrega un párrafo NO toca los bloques anteriores", () => {
    const ed = fakeEditor([p("viejo-1", "uno"), p("viejo-2", "dos")]);
    // Lo que devolvería tryParseMarkdownToBlocks: MISMO texto, ids NUEVOS.
    reconcile(ed, [p("nuevo-a", "uno"), p("nuevo-b", "dos"), p("nuevo-c", "tres")]);

    expect(ed.blocks().map((b) => b.id)).toEqual(["viejo-1", "viejo-2", "nuevo-c"]);
    expect(ed.calls).toEqual(["insert:after"]);
  });

  it("no hace nada si el documento entrante es idéntico (aunque cambien los ids)", () => {
    const ed = fakeEditor([p("v1", "uno"), p("v2", "dos")]);
    reconcile(ed, [p("otro-1", "uno"), p("otro-2", "dos")]);
    expect(ed.calls).toEqual([]);
    expect(ed.blocks().map((b) => b.id)).toEqual(["v1", "v2"]);
  });

  it("editar el ÚLTIMO bloque sólo reemplaza ese (el caso normal del stream)", () => {
    const ed = fakeEditor([p("v1", "uno"), p("v2", "dos")]);
    reconcile(ed, [p("n1", "uno"), p("n2", "dos y medio")]);
    expect(ed.calls).toEqual(["replace"]);
    expect(ed.blocks().map((b) => b.id)).toEqual(["v1", "n2"]);
  });

  it("editar el PRIMER bloque reemplaza desde ahí (no puede conservar la cola)", () => {
    const ed = fakeEditor([p("v1", "uno"), p("v2", "dos")]);
    reconcile(ed, [p("n1", "UNO!"), p("n2", "dos")]);
    expect(ed.blocks().map((b) => b.id)).toEqual(["n1", "n2"]);
  });

  it("acortar el documento borra sólo la cola", () => {
    const ed = fakeEditor([p("v1", "uno"), p("v2", "dos"), p("v3", "tres")]);
    reconcile(ed, [p("n1", "uno")]);
    expect(ed.calls).toEqual(["remove"]);
    expect(ed.blocks().map((b) => b.id)).toEqual(["v1"]);
  });
});

describe("reconcile — bordes", () => {
  it("un documento entrante VACÍO no borra lo que ya se veía", () => {
    const ed = fakeEditor([p("v1", "uno")]);
    reconcile(ed, []);
    expect(ed.calls).toEqual([]);
    expect(ed.blocks()).toHaveLength(1);
  });

  // BlockNote arranca con un párrafo vacío; el primer tick tiene que poder pisarlo.
  it("siembra sobre el párrafo vacío inicial", () => {
    const ed = fakeEditor([{ id: "vacio", type: "paragraph", content: [] }]);
    reconcile(ed, [p("n1", "Contrato")]);
    expect(ed.blocks().map((b) => b.id)).toEqual(["n1"]);
  });

  it("si el splice revienta, cae a reemplazar todo en vez de dejarlo a medias", () => {
    const ed = fakeEditor([p("v1", "uno")]);
    const boom = vi.fn(() => {
      throw new Error("target no está");
    });
    let veces = 0;
    const roto: ReconcilableEditor = {
      document: ed.blocks(),
      replaceBlocks: (a, b) => {
        // El primer intento (la cola) falla; el fallback tiene que llamarse.
        if (veces++ === 0) throw new Error("splice inválido");
        ed.replaceBlocks(a, b);
      },
      insertBlocks: boom,
      removeBlocks: boom,
    };
    reconcile(roto, [p("n1", "distinto")]);
    expect(veces).toBe(2);
  });

  it("compara por CONTENIDO, así que un cambio de props sí cuenta", () => {
    const ed = fakeEditor([{ id: "v1", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "T" }] }]);
    reconcile(ed, [{ id: "n1", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "T" }] }]);
    expect(ed.blocks()[0].id).toBe("n1");
  });
});
