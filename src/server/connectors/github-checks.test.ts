// El veredicto de CI de un PR y cuándo despertar al agente que lo vigila.
//
// Lo que se protege: que un status externo en rojo (Vercel) no se pierda detrás de un
// Actions en verde, que "sin CI" no se lea como verde, y que la vigilancia avise por
// TRANSICIÓN — un PR que ya estaba en verde no despierta a nadie en la primera vuelta.
import { describe, expect, it } from "vitest";

import { aggregateChecks, prWatchVerdict, AUTO_MERGE_GRACE_S, type ChecksSummary, type PrSnapshot } from "./github-checks";

const run = (name: string, status: string, conclusion: string | null = null) => ({
  name, status, conclusion, html_url: `https://gh/${name}`,
});

describe("aggregateChecks", () => {
  it("todo completado y en verde → success; neutral y skipped no son fallos", () => {
    const r = aggregateChecks(
      { check_runs: [run("test", "completed", "success"), run("deploy", "completed", "skipped"), run("lint", "completed", "neutral")] },
      { statuses: [{ context: "vercel", state: "success" }] },
    );
    expect(r).toEqual({ state: "success", total: 4, failed: [], pending: [] });
  });

  it("un status externo en rojo gana aunque Actions esté en verde", () => {
    const r = aggregateChecks(
      { check_runs: [run("test", "completed", "success")] },
      { statuses: [{ context: "vercel", state: "error", target_url: "https://v" }] },
    );
    expect(r.state).toBe("failure");
    expect(r.failed).toEqual([{ name: "vercel", conclusion: "error", url: "https://v" }]);
  });

  it("un rojo gana a lo que sigue corriendo", () => {
    const r = aggregateChecks(
      { check_runs: [run("test", "completed", "timed_out"), run("e2e", "in_progress")] },
      null,
    );
    expect(r.state).toBe("failure");
    expect(r.pending).toEqual(["e2e"]);
    expect(r.failed.map((f) => f.name)).toEqual(["test"]);
  });

  it("sin rojos y algo en cola → pending", () => {
    const r = aggregateChecks(
      { check_runs: [run("test", "completed", "success"), run("e2e", "queued")] },
      { statuses: [{ context: "ci/legacy", state: "pending" }] },
    );
    expect(r.state).toBe("pending");
    expect(r.pending).toEqual(["e2e", "ci/legacy"]);
  });

  it("sin ningún check → none, que NO es verde", () => {
    expect(aggregateChecks({ check_runs: [] }, { statuses: [] }).state).toBe("none");
    expect(aggregateChecks(null, null).state).toBe("none");
  });
});

const sum = (state: ChecksSummary["state"], total = 3, failed: string[] = []): ChecksSummary => ({
  state, total, pending: [], failed: failed.map((name) => ({ name, conclusion: "failure", url: null })),
});
const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  merged: false, state: "open", sha: "a1", checks: sum("pending"), autoMerge: false, ...over,
});

describe("prWatchVerdict", () => {
  const L = "o/r#12";
  const T = 1_000_000;

  it("de pending a verde → avisa con el conteo", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "pending", greenSince: null }, snap({ checks: sum("success", 5) }), T);
    expect(v.notice).toBe("o/r#12: checks en verde (5/5).");
  });

  it("de pending a rojo → avisa cuáles fallaron", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "pending", greenSince: null }, snap({ checks: sum("failure", 4, ["test", "lint"]) }), T);
    expect(v.notice).toBe("o/r#12: fallaron 2 de 4 checks (test, lint).");
  });

  it("recién abierto (none) y ya terminó → cuenta como transición", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "none", greenSince: null }, snap({ checks: sum("success") }), T);
    expect(v.notice).toContain("checks en verde");
  });

  it("ya estaba en verde con el mismo commit → no despierta", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "success", greenSince: T - 5 }, snap({ checks: sum("success") }), T);
    expect(v.notice).toBeNull();
  });

  it("un push nuevo que terminó entre dos vueltas sí despierta", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "failure", greenSince: null }, snap({ sha: "b2", checks: sum("success") }), T);
    expect(v.notice).toContain("checks en verde");
  });

  it("sigue corriendo → no despierta y recuerda el estado", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "none", greenSince: null }, snap(), T);
    expect(v.notice).toBeNull();
    expect(v.memory).toEqual({ sha: "a1", checks: "pending", greenSince: null });
  });

  it("mergeado o cerrado → avisa siempre", () => {
    const prev = { sha: "a1", checks: "success" as const, greenSince: null };
    expect(prWatchVerdict(L, prev, snap({ merged: true, state: "closed" }), T).notice).toBe("o/r#12: mergeado.");
    expect(prWatchVerdict(L, prev, snap({ state: "closed" }), T).notice).toBe("o/r#12: se cerró sin mergear.");
  });

  it("con auto-merge, el verde no despierta: se espera al merge", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "pending", greenSince: null }, snap({ checks: sum("success"), autoMerge: true }), T);
    expect(v.notice).toBeNull();
    expect(v.memory.greenSince).toBe(T);
  });

  it("con auto-merge, verde demasiado rato sin mergear → avisa", () => {
    const v = prWatchVerdict(
      L,
      { sha: "a1", checks: "success", greenSince: T - AUTO_MERGE_GRACE_S },
      snap({ checks: sum("success"), autoMerge: true }),
      T,
    );
    expect(v.notice).toContain("sigue sin mergearse");
  });

  it("con auto-merge y CI en rojo → avisa del rojo", () => {
    const v = prWatchVerdict(L, { sha: "a1", checks: "pending", greenSince: null }, snap({ checks: sum("failure", 2, ["test"]), autoMerge: true }), T);
    expect(v.notice).toContain("fallaron 1 de 2");
  });
});
