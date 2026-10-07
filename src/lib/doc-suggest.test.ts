import { describe, expect, it } from "vitest";
import type { DocBlock } from "./doc-blocks";
import { acceptSuggestion, applyPatchesGuarded, humanTouchedIds, mergeSuggestions, wordDiff } from "./doc-suggest";

const p = (id: string, text: string): DocBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
const parse = async (md: string) => [p(`new-${md.length}`, md.trim())];

describe("sugerencias por bloque", () => {
  const agente = [p("a", "Vigencia de seis meses."), p("b", "Gratuito."), p("c", "Jurisdicción: Ciudad Demo.")];
  const persona = [p("a", "Vigencia de doce meses."), p("b", "Gratuito."), p("c", "Jurisdicción: Ciudad Demo."), p("d", "Seguro a cargo del comodatario.")];

  it("detecta lo que tocó la persona (editado y nuevo)", () => {
    expect(humanTouchedIds(agente, persona)).toEqual(["a", "d"]);
  });

  it("el patch sobre un bloque de la persona queda como sugerencia; el resto se aplica", async () => {
    const res = await applyPatchesGuarded(
      persona,
      [
        { nodeId: "a", html: "Vigencia de un año, renovable.", closed: true },
        { nodeId: "c", html: "Jurisdicción: tribunales de Ciudad Demo.", closed: true },
      ],
      ["a", "d"],
      { parse },
    );
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]).toMatchObject({ targetId: "a", op: "replace", beforeText: "Vigencia de doce meses." });
    // `a` intacto, `c` reemplazado
    expect(JSON.stringify(res.blocks)).toContain("Vigencia de doce meses.");
    expect(JSON.stringify(res.blocks)).toContain("tribunales de Ciudad Demo");
  });

  it("aceptar reemplaza el bloque; un remove lo quita", async () => {
    const { suggestions } = await applyPatchesGuarded(persona, [{ nodeId: "a", html: "Un año.", closed: true }, { nodeId: "d", html: "", closed: true, remove: true }], ["a", "d"], { parse });
    let blocks = persona;
    for (const s of suggestions) blocks = acceptSuggestion(blocks, s)!.blocks;
    expect(blocks.map((b) => b.id)).toEqual(["new-7", "b", "c"]);
  });

  it("una sugerencia por bloque, gana la nueva; las de bloques borrados se van", () => {
    const s = (id: string, t: string, at: number) => ({ id, targetId: t, op: "replace" as const, after: [], beforeText: "", afterText: id, at });
    const out = mergeSuggestions([s("1", "a", 1), s("2", "zz", 1)], [s("3", "a", 2)], persona);
    expect(out.map((x) => x.id)).toEqual(["3"]);
  });

  it("diff por palabras", () => {
    expect(wordDiff("seis meses", "doce meses").filter((d) => d.t !== "eq").map((d) => `${d.t}:${d.s}`)).toEqual(["del:seis", "ins:doce"]);
  });
});
