import { describe, expect, it } from "vitest";
import { elsewhereNote } from "./touches.server";

describe("elsewhereNote", () => {
  it("sin coincidencias no dice nada", () => {
    expect(elsewhereNote([])).toBeNull();
  });
  it("nombra la campaña y cuándo", () => {
    const h = { listId: 7, listName: "Normi035", byName: "Rosalba" };
    expect(elsewhereNote([{ ...h, days: 5 }, { ...h, days: 9 }])).toBe("ya recibieron «Normi035» hace 5 días");
    expect(elsewhereNote([{ ...h, days: 0 }])).toBe("ya recibieron «Normi035» hoy");
  });
  it("varias campañas: la de más coincidencias primero", () => {
    expect(elsewhereNote([
      { listId: 1, listName: "A", days: 3, byName: null },
      { listId: 2, listName: "B", days: 1, byName: null },
      { listId: 2, listName: "B", days: 2, byName: null },
    ])).toBe("ya recibieron «B» y otras campañas");
  });
});
