import { describe, expect, it } from "vitest";
import { pickRows } from "./prospeccion-run";

const rows = [
  { id: 1, data: { k: { v: "digital" } } },
  { id: 2, data: { k: { v: null } } }, // corrió y no lo encontró
  { id: 3, data: { k: { v: null, err: "el turno del agente falló" } } },
  { id: 4, data: {} }, // nunca corrió
  { id: 5, data: {} },
];
const ids = (r: { id: number }[]) => r.map((x) => x.id);

describe("pickRows", () => {
  it("sin alcance: todas, y el límite corta", () => {
    expect(ids(pickRows(rows, "k", {}))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(pickRows(rows, "k", { limit: 2 }))).toEqual([1, 2]);
  });
  it("Seguir: sólo las que nunca corrieron (no repite «no lo encontró»)", () => {
    expect(ids(pickRows(rows, "k", { onlyUntried: true }))).toEqual([4, 5]);
  });
  it("Reintentar: sólo las que fallaron", () => {
    expect(ids(pickRows(rows, "k", { onlyFailed: true }))).toEqual([3]);
  });
  it("Huecos: todo lo que no tiene valor", () => {
    expect(ids(pickRows(rows, "k", { onlyEmpty: true }))).toEqual([2, 3, 4, 5]);
  });
});
