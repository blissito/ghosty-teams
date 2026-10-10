import { describe, expect, it } from "vitest";
import { reviewEffort } from "./review-effort";
import { relaySegments, shortDuration } from "./factory-relay";

describe("reviewEffort", () => {
  it("un PR chico sin nada delicado es trivial", () => {
    expect(reviewEffort({ additions: 10, deletions: 2, files: 1 }).score).toBe(1);
  });
  it("lo delicado pesa más que el tamaño", () => {
    expect(reviewEffort({ additions: 100, deletions: 0, files: 3, riskReasons: ["auth"] }).score).toBe(3);
  });
  it("el PR grande de 24 archivos con API pública es muy complejo y dice por qué", () => {
    const e = reviewEffort({ additions: 1339, deletions: 12, files: 24, riskReasons: ["size", "api"] });
    expect(e.score).toBe(5);
    expect(e.label).toBe("Muy complejo");
    expect(e.reasons).toContain("toca la API pública");
    expect(e.reasons.join(" ")).not.toContain("size");
    expect(e.minutes).toBeGreaterThanOrEqual(30);
  });
});

describe("relaySegments", () => {
  it("reparte el tiempo entre quienes tuvieron el pedido y junta tramos seguidos", () => {
    const s = relaySegments(
      [
        { at: 0, type: "created" },
        { at: 240, type: "plan_submitted" },
        { at: 360, type: "approve" },
        { at: 1680, type: "build_done" },
        { at: 2000, type: "check_fail" },
        { at: 2300, type: "build_done" },
        { at: 2400, type: "check_pass" },
      ],
      2580,
    );
    expect(s).toEqual([
      { who: "plan", seconds: 240 },
      { who: "you", seconds: 120 },
      { who: "build", seconds: 1320 },
      { who: "check", seconds: 320 },
      { who: "build", seconds: 300 },
      { who: "check", seconds: 100 },
      { who: "you", seconds: 180 },
    ]);
  });
  it("formatea corto", () => {
    expect(shortDuration(240)).toBe("4m");
    expect(shortDuration(4800)).toBe("1h 20m");
  });
});
