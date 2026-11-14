import { describe, expect, it } from "vitest";
import { fillVars, listVars, missingVars } from "./prospeccion-vars";

const cols = [{ key: "agencia_digital", label: "¿Agencia digital?" }];
const dup = { name: "DUPLIMEDIOS", website: "https://WWW.DUPLIMEDIOS.COM/", category: "Agencias de publicidad", data: { agencia_digital: { v: "digital https://www.duplimedios.com" } } };
const vacia = { name: "Kode IT", website: "", data: {} };

describe("fillVars", () => {
  it("llena negocio, sitio y columnas, como lo escribiría una persona", () => {
    expect(fillVars("Hola, equipo de {negocio}. Vi {sitio}.", dup)).toBe("Hola, equipo de Duplimedios. Vi duplimedios.com.");
    expect(fillVars("Son {agencia_digital}", dup, cols)).toBe("Son digital");
  });
  it("sin dato usa el respaldo, o desaparece", () => {
    expect(fillVars("Vi {sitio|su sitio}", vacia)).toBe("Vi su sitio");
    expect(fillVars("Vi {sitio} hoy", vacia)).toBe("Vi hoy");
  });
  it("respeta un nombre que no viene en mayúsculas y siglas", () => {
    expect(fillVars("{negocio}", vacia)).toBe("Kode IT");
    expect(fillVars("{negocio}", { name: "KODE IT" })).toBe("Kode IT");
  });
});

describe("missingVars / listVars", () => {
  it("cuenta las filas sin dato y si hay respaldo", () => {
    expect(missingVars("{negocio} {sitio|su sitio}", [dup, vacia])).toEqual([
      { name: "negocio", hasFallback: false, missing: 0 },
      { name: "sitio", hasFallback: true, missing: 1 },
    ]);
  });
  it("ofrece las base y las columnas de la lista", () => {
    expect(listVars(cols).map((v) => v.name)).toContain("agencia_digital");
  });
});
