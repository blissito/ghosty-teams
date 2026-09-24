import { describe, it, expect } from "vitest";
import { nextStatus, parseThreadDecision, MAX_LOOPS } from "./factory-flow";

describe("nextStatus", () => {
  it("camino feliz", () => {
    expect(nextStatus("planning", "plan_submitted")).toBe("plan_review");
    expect(nextStatus("plan_review", "approve")).toBe("building");
    expect(nextStatus("building", "build_done")).toBe("checking");
    expect(nextStatus("checking", "check_pass")).toBe("pr_review");
    expect(nextStatus("pr_review", "close")).toBe("done");
  });

  it("pedir cambios regresa a planear, y una v2 vuelve a firma", () => {
    expect(nextStatus("plan_review", "changes")).toBe("planning");
    expect(nextStatus("plan_review", "plan_submitted")).toBe("plan_review");
  });

  it("check que falla regresa a build hasta el tope, luego escala", () => {
    expect(nextStatus("checking", "check_fail", 0)).toBe("building");
    expect(nextStatus("checking", "check_fail", MAX_LOOPS - 2)).toBe("building");
    expect(nextStatus("checking", "check_fail", MAX_LOOPS - 1)).toBe("escalated");
    expect(nextStatus("escalated", "approve")).toBe("building");
    expect(nextStatus("escalated", "changes")).toBe("planning");
  });

  it("no se salta la firma ni el check", () => {
    expect(nextStatus("planning", "approve")).toBeNull();
    expect(nextStatus("plan_review", "build_done")).toBeNull();
    expect(nextStatus("building", "check_pass")).toBeNull();
    expect(nextStatus("pr_review", "approve")).toBeNull();
  });

  it("cancelar desde cualquier estado vivo", () => {
    expect(nextStatus("building", "cancel")).toBe("cancelled");
    expect(nextStatus("done", "cancel")).toBeNull();
  });
});

describe("parseThreadDecision", () => {
  it("firmas", () => {
    for (const t of ["✅", "👍", "aprobado", "Va", "sí", "ok!", "LGTM", "dale"]) expect(parseThreadDecision(t)).toEqual({ decision: "approve" });
  });
  it("cambios con nota", () => {
    expect(parseThreadDecision("cambios: ponme en copia")).toEqual({ decision: "changes", note: "ponme en copia" });
    expect(parseThreadDecision("Cambio - sin botón manual")).toEqual({ decision: "changes", note: "sin botón manual" });
  });
  it("lo demás no es firma", () => {
    for (const t of ["¿y si lo hacemos semanal?", "va a tardar mucho?", "cambios", "✅ pero ponme en copia"]) expect(parseThreadDecision(t)).toBeNull();
  });
});
