import { describe, expect, it } from "vitest";
import { MAX_CHARS, MIN_CHARS, partirEnFrases } from "./tts-split";

// El párrafo real del documento donde se vio el problema (6.4 s hasta el primer sonido).
const PARRAFO =
  "Hay una figura que reaparece en casi toda mitología con las manos manchadas de trabajo: " +
  "el que sabe hacer cosas que nadie más sabe hacer, y a quien esa habilidad le cuesta cara. " +
  "En Grecia se llama Dédalo. Más atrás, en China, no tiene un solo nombre sino dos que " +
  "trabajan juntos: Nüwa y Fuxi, compás y escuadra, la pareja que mide el mundo antes de que " +
  "el mundo tenga forma para ser medido.";

describe("partirEnFrases", () => {
  it("no pierde ni un carácter (el invariante que sostiene todo lo demás)", () => {
    for (const t of [PARRAFO, "Una sola frase sin punto final", "Corto.", "A. B. C."]) {
      expect(partirEnFrases(t).join(" ")).toBe(t);
    }
  });

  it("vacío es vacío, y cualquier texto da al menos un segmento", () => {
    expect(partirEnFrases("")).toEqual([]);
    expect(partirEnFrases("   ")).toEqual([]);
    expect(partirEnFrases("Hola")).toEqual(["Hola"]);
  });

  it("el primer segmento es corto: es lo que separa del primer sonido", () => {
    const segs = partirEnFrases(PARRAFO);
    expect(segs.length).toBeGreaterThan(1);
    // Con ~16 ms/char, el objetivo es arrancar bien por debajo de los 6.4 s del bloque entero.
    expect(segs[0].length).toBeLessThan(PARRAFO.length / 2);
  });

  it("ningún segmento pasa de MAX_CHARS", () => {
    const largo = "Palabra ".repeat(200).trim();
    for (const s of partirEnFrases(largo)) expect(s.length).toBeLessThanOrEqual(MAX_CHARS);
    for (const s of partirEnFrases(PARRAFO)) expect(s.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("es idempotente sobre cada segmento", () => {
    for (const s of partirEnFrases(PARRAFO)) expect(partirEnFrases(s)).toEqual([s]);
  });

  it("no corta en abreviaturas ni en iniciales", () => {
    const t = "El Sr. López firmó el art. 14 ante el Lic. J. Pérez el día de ayer por la mañana.";
    expect(partirEnFrases(t)).toEqual([t]);
  });

  it("no corta en decimales ni en viñetas numeradas", () => {
    const t = "1. El monto es de 3.5 millones y la cláusula 1.2.3 lo confirma sin lugar a dudas.";
    expect(partirEnFrases(t)).toEqual([t]);
  });

  it("no corta dentro de un dominio", () => {
    const t = "Consulta www.gob.mx para el trámite y luego regresa a la ventanilla con el acuse.";
    expect(partirEnFrases(t)).toEqual([t]);
  });

  it("fusiona las frases cortas en vez de gastar una petición por cada una", () => {
    const segs = partirEnFrases("Sí. No. Tal vez. Puede ser. Quién sabe. Habrá que verlo con calma.");
    expect(segs).toHaveLength(1);
  });

  it("el último segmento nunca queda suelto y corto", () => {
    const segs = partirEnFrases(`${"Texto de relleno suficientemente largo para pasar el umbral. ".repeat(4)}Fin.`);
    expect(segs[segs.length - 1].length).toBeGreaterThanOrEqual(MIN_CHARS);
  });
});
