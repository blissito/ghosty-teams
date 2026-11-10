import { describe, it, expect } from "vitest";
import { isProspTurn } from "./turn-kind";

describe("isProspTurn", () => {
  it("panel y columnas de Prospección", () => {
    expect(isProspTurn("prosp:drawer:v3:38:abc")).toBe(true);
    expect(isProspTurn("prosp:36:mensaje:120")).toBe(true);
  });
  it("chat, DM y fábrica no", () => {
    expect(isProspTurn("ns:general:12")).toBe(false);
    expect(isProspTurn("dm:4")).toBe(false);
    expect(isProspTurn("")).toBe(false);
  });
});
