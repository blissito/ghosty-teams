import { describe, it, expect } from "vitest";
import { briefMessage, parseBrief, shouldPostBrief, wantsBrief, type EscalationBrief } from "./factory-brief";

// El brief de decisión (21-oct): la persona leía los hallazgos crudos de @check y no sabía qué tocar.
const brief: EscalationBrief = {
  summary: "La preview no arranca porque falta DATABASE_URL.",
  verified: ["La caja tiene 4 GB", "El runner es 2.3"],
  recommend: { action: "env", why: "con la variable de prueba arranca sola" },
  question: null,
  at: "2026-10-21T10:00:00Z",
};

describe("briefMessage", () => {
  it("pone el resumen, lo verificado, la recomendación con el texto del botón y los hallazgos al final", () => {
    const m = briefMessage(brief, "- falta DATABASE_URL en .env", "env");
    expect(m.startsWith("⚠️ **Faltan variables** — La preview no arranca porque falta DATABASE_URL.")).toBe(true);
    expect(m).toContain("**Ya verificado**\n- ✓ La caja tiene 4 GB\n- ✓ El runner es 2.3");
    expect(m).toContain("👉 **Recomendado: Guardar variables** — con la variable de prueba arranca sola");
    expect(m).not.toContain("❓");
    expect(m.indexOf("**Detalle de @check**")).toBeGreaterThan(m.indexOf("👉"));
    expect(m.endsWith("- falta DATABASE_URL en .env")).toBe(true);
  });

  it("sin verificados ni hallazgos no deja encabezados vacíos; la pregunta va con ❓", () => {
    const m = briefMessage({ ...brief, verified: [], question: "¿Subimos a Node 22?", recommend: { action: "fix", why: "" } }, "  ", "decision");
    expect(m).not.toContain("Ya verificado");
    expect(m).not.toContain("Detalle de @check");
    expect(m).toContain("👉 **Recomendado: Que @build lo arregle**\n\n❓ ¿Subimos a Node 22?");
    expect(m.startsWith("⚠️ **Necesita una decisión**")).toBe(true);
  });
});

describe("parseBrief", () => {
  it("el payload viejo de why (sin brief) o null es «sin brief»", () => {
    expect(parseBrief({ healthy: false, note: "x" })).toBeNull();
    expect(parseBrief({ brief: null })).toBeNull();
    expect(parseBrief(null)).toBeNull();
  });
  it("una acción desconocida o sin resumen se descarta", () => {
    expect(parseBrief({ brief: { ...brief, recommend: { action: "merge", why: "" } } })).toBeNull();
    expect(parseBrief({ brief: { ...brief, summary: " " } })).toBeNull();
  });
  it("limpia verificados y pregunta vacíos", () => {
    const b = parseBrief({ brief: { ...brief, verified: ["ok", "", 3], question: "  " } })!;
    expect(b.verified).toEqual(["ok"]);
    expect(b.question).toBeNull();
    expect(b.at).toBe("2026-10-21T10:00:00Z");
  });
});

describe("guarda de un brief por escalado", () => {
  it("no repite el del mismo escalado; uno nuevo sí lleva el suyo", () => {
    expect(shouldPostBrief("2026-10-21T10:00:00Z", [])).toBe(true);
    expect(shouldPostBrief("2026-10-21T10:00:00Z", ["2026-10-21T10:00:00Z"])).toBe(false);
    expect(shouldPostBrief("2026-10-21T11:00:00Z", ["2026-10-21T10:00:00Z"])).toBe(true);
    expect(shouldPostBrief(null, [null])).toBe(true);
  });
  it("sólo decision, fix y env", () => {
    expect(["decision", "fix", "env", "skip", "platform"].map((k) => wantsBrief(k as never))).toEqual([true, true, true, false, false]);
  });
});
