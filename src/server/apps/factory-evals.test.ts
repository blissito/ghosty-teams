import { describe, it, expect } from "vitest";
import { configLabel, evalBranch, parseEvalScore, summarizeEvals } from "./factory-evals";

const ok = { scores: { plan: 5, tests: 4, maintainability: 3, scope: 5 }, vs_original: "same", notes: "bien" };

describe("evals de la fábrica", () => {
  it("la rama del eval es fija por pedido", () => {
    expect(evalBranch(12)).toBe("ghosty-eval/12");
  });

  it("valida las notas del juez", () => {
    expect(parseEvalScore(ok)).toMatchObject({ vsOriginal: "same", scores: { maintainability: 3 } });
    expect(parseEvalScore({ ...ok, scores: { ...ok.scores, tests: 6 } })).toEqual({ error: "scores.tests tiene que ser un entero de 1 a 5" });
    expect(parseEvalScore({ ...ok, scores: { ...ok.scores, plan: 4.5 } })).toHaveProperty("error");
    expect(parseEvalScore({ ...ok, vs_original: "mejor" })).toHaveProperty("error");
  });

  it("resume por configuración, la mejor arriba", () => {
    const r = parseEvalScore(ok) as any;
    const worse = { ...r, vsOriginal: "worse", scores: { plan: 2, tests: 2, maintainability: 2, scope: 2 } };
    const flash = { role: "build" as const, model: "flash" };
    const opus = { role: "build" as const, model: "opus" };
    const s = summarizeEvals([
      { config: flash, result: worse, buildSeconds: 100 },
      { config: opus, result: r, buildSeconds: 300 },
      { config: opus, result: null, buildSeconds: 500 },
    ]);
    expect(s.map((x) => x.label)).toEqual(["@build · opus", "@build · flash"]);
    expect(s[0]).toMatchObject({ runs: 2, scored: 1, avg: 4.3, same: 1, medianBuildSeconds: 400 });
    expect(s[1]).toMatchObject({ avg: 2, worse: 1 });
    expect(configLabel({ role: "build", agent: "Gaspar", model: null })).toBe("@build · Gaspar");
  });
});
