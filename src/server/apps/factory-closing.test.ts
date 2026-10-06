import { describe, it, expect } from "vitest";
import { withClosingRef } from "./factory-flow";

describe("withClosingRef", () => {
  it("agrega Closes #n al final", () => {
    expect(withClosingRef("Qué cambió\n\n", 12)).toBe("Qué cambió\n\nCloses #12");
    expect(withClosingRef(null, 3)).toBe("Closes #3");
  });
  it("no duplica si ya lo cierra con cualquier palabra de GitHub", () => {
    for (const b of ["Closes #12", "fixes #12", "Resolved: #12", "close #12."]) expect(withClosingRef(b, 12)).toBe(b);
  });
  it("otro número o una mención no cuentan", () => {
    expect(withClosingRef("Closes #120", 12)).toBe("Closes #120\n\nCloses #12");
    expect(withClosingRef("ver #12", 12)).toBe("ver #12\n\nCloses #12");
  });
});
