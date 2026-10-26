import { describe, it, expect } from "vitest";
import { extractEbPatches, stripEbPatches } from "./ebdoc";

describe("eb-patch con la dirección en la línea siguiente (descti #794)", () => {
  it("eb-remove", () => {
    const body = "Quito la fila.\n```eb-remove\na17\n```";
    expect(extractEbPatches(body)).toEqual([{ nodeId: "a17", html: "", closed: true, op: "remove", remove: true }]);
    expect(stripEbPatches(body)).toBe("Quito la fila.");
  });
  it("eb-insert con posición", () => {
    const body = "```eb-insert\na12 after\n<tr><td>x</td></tr>\n```";
    const [p] = extractEbPatches(body);
    expect(p).toMatchObject({ nodeId: "a12", op: "insert", pos: "after", closed: true });
    expect(p.html).toBe("<tr><td>x</td></tr>");
  });
  it("un patch normal no cambia", () => {
    const [p] = extractEbPatches("```eb-patch a3\n<p>hola</p>\n```");
    expect(p).toMatchObject({ nodeId: "a3", html: "<p>hola</p>", op: "replace" });
  });
});
