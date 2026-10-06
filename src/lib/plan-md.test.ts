import { describe, it, expect } from "vitest";
import { splitPlan } from "./plan-md";

describe("splitPlan", () => {
  it("quita el título y saca «Listo cuando»", () => {
    const r = splitPlan("# Docs del CLI\n**Listo cuando:** `/docs` muestra el CLI de hoy.\n\n## Problema\nTexto.");
    expect(r.done).toBe("`/docs` muestra el CLI de hoy.");
    expect(r.body).toBe("## Problema\nTexto.");
  });
  it("también con los dos puntos fuera de la negrita", () => {
    expect(splitPlan("**Listo cuando**: ya.\n\nResto").done).toBe("ya.");
  });
  it("un plan viejo queda intacto", () => {
    const old = "## Historia\nQuien lee…\n\n## Brief técnico\n- algo";
    expect(splitPlan(old)).toEqual({ done: null, body: old });
  });
  it("sólo quita el H1 si es lo primero; un # más abajo se queda", () => {
    const md = "Intro\n\n# No soy título\nTexto";
    expect(splitPlan(md).body).toBe(md);
  });
});
