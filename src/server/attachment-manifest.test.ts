import { describe, expect, it } from "vitest";
import { manifiestoAdjuntos, REGLA_REENTREGA, REGLA_VARIOS_ADJUNTOS } from "../agents.server";

const f = (name: string) => ({ name, mime: "application/pdf", size: 1234 });

describe("manifiestoAdjuntos", () => {
  // ── El incidente del 2026-08-31 (descti) ────────────────────────────────────────
  // Pidieron el .docx de un PDF escaneado. El PDF correcto se re-entregó y ESTABA nombrado
  // en el manifiesto — y el agente entregó dos veces un .docx de otro tema, de su propia
  // caja, de veinte turnos antes. La lista salía sin ninguna regla: `pista` era "".
  it("🔴 la re-entrega SÍ lleva regla", () => {
    const out = manifiestoAdjuntos([f("Licitacion_OM.pdf")], { reentrega: true, ambito: "conversación" });
    expect(out).toContain(REGLA_REENTREGA);
    expect(out).toContain("Licitacion_OM.pdf");
  });

  // La cláusula que hace el trabajo, y la primera que alguien recortaría por brevedad.
  it("🔴 la regla desautoriza explícitamente la caja del agente", () => {
    expect(REGLA_REENTREGA).toMatch(/tu caja/i);
    expect(REGLA_REENTREGA).toMatch(/pregúntalo/i);
  });

  it("varios adjuntos propios siguen llevando la regla de siempre, no la de re-entrega", () => {
    const out = manifiestoAdjuntos([f("a.pdf"), f("b.pdf")], { reentrega: false, ambito: "hilo" });
    expect(out).toContain(REGLA_VARIOS_ADJUNTOS);
    expect(out).not.toContain(REGLA_REENTREGA);
  });

  // Un solo archivo propio no tiene ambigüedad que resolver: el manifiesto sería ruido en
  // cada turno. Es el comportamiento que ya había y no debe cambiar.
  it("un solo adjunto propio no genera manifiesto", () => {
    expect(manifiestoAdjuntos([f("a.pdf")], { reentrega: false, ambito: "hilo" })).toBe("");
    expect(manifiestoAdjuntos([], { reentrega: false, ambito: "hilo" })).toBe("");
  });

  // El orden ES la dirección: es el mismo de los FileParts, y el nombre no distingue
  // (el navegador sube todo como `image.png`).
  it("numera en el orden de los FileParts", () => {
    const out = manifiestoAdjuntos([f("uno.pdf"), f("dos.pdf")], { reentrega: true, ambito: "hilo" });
    expect(out).toMatch(/1\. uno\.pdf/);
    expect(out).toMatch(/2\. dos\.pdf/);
  });

  it("el ámbito cambia el título, no la regla", () => {
    expect(manifiestoAdjuntos([f("a.pdf")], { reentrega: true, ambito: "hilo" })).toContain("este hilo");
    expect(manifiestoAdjuntos([f("a.pdf")], { reentrega: true, ambito: "conversación" })).toContain("esta conversación");
  });
});
