import { describe, expect, it } from "vitest";
import { cuantosPide, giroScian } from "./scian-giros";

describe("giroScian", () => {
  it("agencia digital va a 541510 (donde viven las de verdad) y a publicidad", () => {
    expect(giroScian("agencias marketing digital")?.scian).toEqual(["541510", "541810"]);
    expect(giroScian("agencias digitales")?.scian).toEqual(["541510", "541810"]);
  });
  it("páginas web y software, sin acentos o con ellos", () => {
    expect(giroScian("diseño páginas web")?.scian).toEqual(["541510"]);
    expect(giroScian("desarrolladores software")?.scian).toEqual(["541510"]);
  });
  it("publicidad y diseño gráfico", () => {
    expect(giroScian("agencias publicidad")?.scian).toEqual(["541810", "541850"]);
    expect(giroScian("diseno grafico")?.scian).toEqual(["541430"]);
  });
  it("lo que no reconoce sigue por palabras", () => {
    expect(giroScian("dentistas")).toBeNull();
    expect(giroScian("ferreterias")).toBeNull();
  });
});

describe("cuantosPide", () => {
  it("respeta el número del inicio con tope 500", () => {
    expect(cuantosPide("500 agencias de publicidad en CDMX")).toBe(500);
    expect(cuantosPide("2000 dentistas en Torreón")).toBe(500);
    expect(cuantosPide("30 dentistas")).toBe(30);
  });
  it("un número en medio no cuenta", () => {
    expect(cuantosPide("contadores en 5 de Mayo")).toBeNull();
    expect(cuantosPide("dentistas en Torreón")).toBeNull();
  });
});
