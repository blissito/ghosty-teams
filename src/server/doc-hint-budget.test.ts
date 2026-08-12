import { describe, it, expect } from "vitest";
import { clampInline, ARTIFACT_INLINE_MAX_CHARS } from "../agents.server";

// El artefacto entero viajaba en CADA turno del hilo, para siempre — 40 KB ≈ 10K tokens,
// incluso cuando el turno era "gracias". Estos tests fijan las dos propiedades que hacen
// que recortarlo sea seguro: que se DIGA, y que no se corte por el final.

describe("clampInline", () => {
  it("no toca lo que cabe — el caso común no paga nada", () => {
    expect(clampInline("hola")).toBeNull();
    expect(clampInline("x".repeat(ARTIFACT_INLINE_MAX_CHARS))).toBeNull();
  });

  it("declara el recorte y cuántos caracteres faltan", () => {
    const out = clampInline("y".repeat(40_000))!;
    expect(out).toBeTruthy();
    expect(out).toContain("RECORTE DE LA PLATAFORMA");
    expect(out).toContain("doc_read");
    expect(out.length).toBeLessThan(ARTIFACT_INLINE_MAX_CHARS + 500);
  });

  it("conserva principio Y final — un corte al final se lee como 'aquí termina'", () => {
    const md = "INICIO-" + "z".repeat(40_000) + "-FINAL";
    const out = clampInline(md)!;
    expect(out.startsWith("INICIO-")).toBe(true);
    expect(out.endsWith("-FINAL")).toBe(true);
  });

  it("respeta un tope propio", () => {
    expect(clampInline("a".repeat(1000), 5000)).toBeNull();
    expect(clampInline("a".repeat(6000), 5000)).toBeTruthy();
  });
});
