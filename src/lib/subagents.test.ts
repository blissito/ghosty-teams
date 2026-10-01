import { describe, expect, it } from "vitest";
import { extractSubagents, extractToolState } from "./ebdoc";

const block = (obj: unknown) => "```gt-tools\n" + JSON.stringify(obj) + "\n```\n\nhola";

describe("subagentes en el bloque gt-tools", () => {
  it("se leen aparte de las tools", () => {
    const body = block({
      tools: [{ label: "Busqué en la web", status: "done" }],
      subagents: [{ id: "r1", name: "Investigar Linear", task: "Cómo asigna Linear", status: "running", startedAt: 1, toolUses: 3, tokens: 1200 }],
    });
    expect(extractToolState(body)).toHaveLength(1);
    expect(extractSubagents(body)).toEqual([
      { id: "r1", name: "Investigar Linear", task: "Cómo asigna Linear", status: "running", startedAt: 1, toolUses: 3, tokens: 1200 },
    ]);
  });
  it("sin tools pero con subagentes, la lista existe y las tools no", () => {
    const body = block({ tools: [], subagents: [{ id: "r1", name: "x", task: "", status: "done", startedAt: 1, toolUses: 0, tokens: 0 }] });
    expect(extractToolState(body)).toBeNull();
    expect(extractSubagents(body)).toHaveLength(1);
  });
  it("un bloque viejo sin subagentes no rompe", () => {
    expect(extractSubagents(block({ tools: [{ label: "a", status: "done" }] }))).toBeNull();
  });
});
