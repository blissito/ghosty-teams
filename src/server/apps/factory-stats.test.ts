import { describe, it, expect } from "vitest";
import { runStats } from "./factory-stats";

const row = (status: string, loops = 0, createdAt = 0, prReadyAt: number | null = null) => ({ status, loops, createdAt, prReadyAt });

describe("números de la fábrica", () => {
  it("sin pedidos no inventa porcentajes", () => {
    expect(runStats([])).toMatchObject({ total: 0, successRate: null, avgLoops: null, medianToPrSeconds: null });
  });

  it("se concreta = mezclados / cerrados; los abiertos no cuentan", () => {
    const s = runStats([row("done", 1, 0, 600), row("done", 0, 0, 1200), row("cancelled"), row("building"), row("escalated", 3)]);
    expect(s).toMatchObject({ total: 5, merged: 2, cancelled: 1, escalated: 1, open: 2 });
    expect(s.successRate).toBeCloseTo(2 / 3);
    expect(s.avgLoops).toBe(0.5);
    // Uno mezclado sin prReadyAt (anterior a la medición) igual cuenta sus vueltas.
    expect(runStats([row("done", 2)]).avgLoops).toBe(2);
    expect(s.medianToPrSeconds).toBe(900);
  });

  it("mediana con número impar", () => {
    expect(runStats([row("done", 0, 0, 100), row("done", 0, 0, 300), row("pr_review", 0, 0, 200)]).medianToPrSeconds).toBe(200);
  });

  it("pasa a la primera: aprobado o mezclado sin pedir cambios; lo pendiente no cuenta", () => {
    const r = (x: Partial<Parameters<typeof runStats>[0][number]>) => ({ status: "pr_review", loops: 0, createdAt: 0, prReadyAt: 100, ...x });
    const s = runStats([
      r({ firstReviewState: "approved", firstReviewAt: 400 }),
      r({ status: "done", mergedAt: 700 }),
      r({ firstReviewState: "changes_requested", firstReviewAt: 1100 }),
      r({ firstReviewState: "commented", firstReviewAt: 200 }),
      r({ prReadyAt: null, status: "building" }),
    ]);
    expect(s.firstPassRate).toBeCloseTo(2 / 3);
    // 300, 600, 1000, 100 → mediana 450.
    expect(s.medianReviewSeconds).toBe(450);
    expect(runStats([]).firstPassRate).toBeNull();
  });
});
