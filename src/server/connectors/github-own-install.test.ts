import { describe, expect, it } from "vitest";
import { ownReposMissing } from "./github-own-install";

describe("¿faltan los repos propios?", () => {
  it("sólo ve la instalación de otro (colaboradora) → faltan los suyos", () => {
    expect(ownReposMissing([{ account: { login: "blissito" } }], "BrendaOrtega")).toBe(true);
  });
  it("con su propia instalación → no faltan, aunque vea otras", () => {
    expect(ownReposMissing([{ account: { login: "blissito" } }, { account: { login: "brendaortega" } }], "BrendaOrtega")).toBe(false);
  });
  it("una org extra no estorba ni la sustituye", () => {
    expect(ownReposMissing([{ account: { login: "acme" } }], "ana")).toBe(true);
    expect(ownReposMissing([{ account: { login: "ana" } }, { account: { login: "acme" } }], "ana")).toBe(false);
  });
  it("sin login conocido: como antes, sólo si no hay ninguna", () => {
    expect(ownReposMissing([], null)).toBe(true);
    expect(ownReposMissing([{ account: { login: "x" } }], null)).toBe(false);
  });
});
