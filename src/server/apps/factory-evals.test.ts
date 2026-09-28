import { describe, it, expect } from "vitest";
import { configLabel, evalBranch, evalResultMarkdown, formatUsd, parseEvalScore, summarizeEvals } from "./factory-evals";

const ok = { scores: { plan: 5, tests: 4, maintainability: 3, scope: 5 }, vs_original: "same", notes: "bien" };
const okPlan = { scores: { coverage: 4, concrete: 4, risks: 3, signable: 5 }, vs_original: "better" };

describe("evals de la fábrica", () => {
  it("la rama del eval es fija por pedido", () => {
    expect(evalBranch(12)).toBe("ghosty-eval/12");
  });

  it("valida las notas del juez con la rúbrica del rol", () => {
    expect(parseEvalScore("build", ok)).toMatchObject({ vsOriginal: "same", scores: { maintainability: 3 } });
    expect(parseEvalScore("build", { ...ok, scores: { ...ok.scores, tests: 6 } })).toHaveProperty("error");
    expect(parseEvalScore("build", { ...ok, scores: { ...ok.scores, plan: 4.5 } })).toHaveProperty("error");
    expect(parseEvalScore("build", { ...ok, vs_original: "mejor" })).toHaveProperty("error");
    expect(parseEvalScore("plan", okPlan)).toMatchObject({ vsOriginal: "better", scores: { signable: 5 } });
    // Las claves de build no sirven para un eval de @plan.
    expect((parseEvalScore("plan", ok) as any).error).toContain("coverage");
    expect(parseEvalScore("check", { scores: { catches: 2, precision: 5, actionable: 4, verdict: 1 }, vs_original: "worse" })).not.toHaveProperty("error");
  });

  it("resume por configuración: por rol y la mejor arriba, con tiempo y costo", () => {
    const r = parseEvalScore("build", ok) as any;
    const worse = { ...r, vsOriginal: "worse", scores: { plan: 2, tests: 2, maintainability: 2, scope: 2 } };
    const flash = { role: "build" as const, model: "flash" };
    const opus = { role: "build" as const, model: "opus" };
    const planGrey = { role: "plan" as const, agent: "Grey" };
    const s = summarizeEvals([
      { config: flash, result: worse, seconds: 100, costUsd: 0.1 },
      { config: opus, result: r, seconds: 300, costUsd: 0.5 },
      { config: opus, result: null, seconds: 500, costUsd: null },
      { config: planGrey, result: parseEvalScore("plan", okPlan) as any, seconds: 60, costUsd: 0.02 },
    ]);
    expect(s.map((x) => x.label)).toEqual(["plan con Grey", "build con opus", "build con flash"]);
    expect(s[1]).toMatchObject({ role: "build", runs: 2, scored: 1, avg: 4.3, same: 1, medianSeconds: 400, medianCostUsd: 0.5 });
    expect(s[2]).toMatchObject({ avg: 2, worse: 1 });
    expect(configLabel({ role: "build", agent: "Gaspar", model: null })).toBe("build con Gaspar");
    expect(configLabel({ role: "check", agent: "Grey", model: "terra" })).toBe("check con Grey · terra");
  });

  it("el resultado sale como tabla, sin menciones, con modelo y costo", () => {
    const md = evalResultMarkdown({ role: "build", agent: "Grey" }, parseEvalScore("build", ok) as any, 0.42, ["gpt-5.6-terra"]);
    expect(md).toContain("build con Grey — 4.3/5");
    expect(md).toContain("igual que el PR original · gpt-5.6-terra · $0.42 USD");
    expect(md).toContain("| Mantenible | 3/5 |");
    expect(md).not.toContain("@build");
    expect(evalResultMarkdown({ role: "plan", agent: "Grey" }, parseEvalScore("plan", okPlan) as any)).toContain("mejor que el plan firmado");
    expect(formatUsd(0.004)).toBe("< $0.01 USD");
  });
});
