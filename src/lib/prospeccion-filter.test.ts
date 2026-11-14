import { describe, expect, it } from "vitest";
import { describe as describeCond, facets, matches } from "./prospeccion-filter";

const row = (v: string | null) => ({ name: "x", data: { k: { v } } });
const rows = [row("digital"), row("Digital"), row("otro"), row(null), row("digitales")];

describe("is", () => {
  it("igualdad exacta sin mayúsculas: «digital» no atrapa «digitales»", () => {
    const f = [{ op: "is" as const, field: "k", value: "digital" }];
    expect(rows.filter((r) => matches(r, f, ["k"])).length).toBe(2);
  });
  it("value vacío = sin dato", () => {
    expect(rows.filter((r) => matches(r, [{ op: "is", field: "k", value: "" }], ["k"])).length).toBe(1);
  });
  it("se lee en el chip", () => {
    expect(describeCond({ op: "is", field: "k", value: "digital" }, () => "¿Agencia digital?")).toBe("¿Agencia digital? = digital");
  });
});

describe("facets", () => {
  it("cuenta por valor, del más común al menos", () => {
    expect(facets(rows, "k")).toEqual([
      { value: "digital", n: 2 },
      { value: "", n: 1 },
      { value: "digitales", n: 1 },
      { value: "otro", n: 1 },
    ]);
  });
  it("null con demasiados valores distintos o con uno solo", () => {
    expect(facets(rows, "k", 3)).toBeNull();
    expect(facets([row("a"), row("a")], "k")).toBeNull();
  });
});

describe("valor con evidencia", () => {
  it("la URL que deja el agente no cuenta como valor", () => {
    const rows = [
      { data: { ag: { v: "digital https://www.duplimedios.com" } } },
      { data: { ag: { v: "digital https://kode.mx" } } },
      { data: { ag: { v: "otro https://aseprom.com" } } },
    ];
    expect(facets(rows, "ag")).toEqual([{ value: "digital", n: 2 }, { value: "otro", n: 1 }]);
    expect(rows.filter((r) => matches(r, [{ op: "is", field: "ag", value: "digital" }], ["ag"])).length).toBe(2);
  });
});
