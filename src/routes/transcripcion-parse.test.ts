import { describe, it, expect } from "vitest";
import { partirTranscripcion } from "./room.$slug.transcripcion.$id";

describe("partirTranscripcion", () => {
  it("lee las marcas de tiempo de whisper", () => {
    const s = partirTranscripcion(
      "[00:00:01.000 --> 00:00:04.500]   hola qué tal\n" +
        "[00:01:12.000 --> 00:01:15.000]   seguimos aquí\n"
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ t: "00:01", segundos: 1, texto: "hola qué tal" });
    expect(s[1]).toMatchObject({ t: "01:12", segundos: 72 });
  });

  it("pasa a hh:mm:ss cuando la grabación cruza la hora", () => {
    const [s] = partirTranscripcion("[01:02:03.000 --> 01:02:05.000]  larga\n");
    expect(s.t).toBe("01:02:03");
    expect(s.segundos).toBe(3723);
  });

  it("descarta los segmentos vacíos (whisper los emite en los silencios)", () => {
    const s = partirTranscripcion(
      "[00:00:00.000 --> 00:00:02.000]   \n[00:00:02.000 --> 00:00:04.000]  algo\n"
    );
    expect(s).toHaveLength(1);
  });

  // ⚠️ Las grabaciones anteriores al 2026-08-12 se generaron SIN marcas: la vista tiene
  // que seguir sirviendo para ellas o quedan ilegibles para siempre.
  it("parte en párrafos un texto sin marcas, sin cortar palabras", () => {
    const texto = ("palabra ".repeat(200)).trim();
    const s = partirTranscripcion(texto);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.t === "")).toBe(true);
    for (const x of s) expect(x.texto.startsWith("abra")).toBe(false);
    // Y no se pierde nada por el camino: es una transcripción, no un resumen.
    expect(s.map((x) => x.texto).join(" ").replace(/\s+/g, " ").trim()).toBe(texto);
  });

  it("no revienta con texto vacío", () => {
    expect(partirTranscripcion("")).toEqual([]);
  });
});
