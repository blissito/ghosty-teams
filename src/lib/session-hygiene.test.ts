import { describe, expect, it } from "vitest";
import { turnosDesdeElClear, MARCA_CLEAR, TURNOS_LARGA } from "./session-hygiene";

const humano = (body = "hola") => ({ agent_handle: null, body });
const agente = (body = "respuesta") => ({ agent_handle: "ghosty", body });
const clear = () => ({ agent_handle: "ghosty", body: MARCA_CLEAR });

describe("turnosDesdeElClear", () => {
  it("cuenta sólo las respuestas del agente", () => {
    expect(turnosDesdeElClear([humano(), agente(), humano(), agente()])).toBe(2);
  });

  // La cáscara del turno se crea VACÍA y eager (`postDmMessageFn`): contarla adelantaría
  // el umbral un turno entero, y encima el aviso saldría a media respuesta.
  it("🔴 no cuenta la cáscara vacía del turno en curso", () => {
    expect(turnosDesdeElClear([humano(), agente(), humano(), agente("")])).toBe(1);
    expect(turnosDesdeElClear([agente("   ")])).toBe(0);
  });

  it("el /clear pone el contador a cero y no se cuenta a sí mismo", () => {
    expect(turnosDesdeElClear([agente(), agente(), clear(), humano(), agente()])).toBe(1);
    expect(turnosDesdeElClear([agente(), agente(), clear()])).toBe(0);
  });

  it("manda el ÚLTIMO clear, no el primero", () => {
    expect(turnosDesdeElClear([clear(), agente(), agente(), clear(), agente()])).toBe(1);
  });

  it("un flujo vacío o sin cargar es 0, nunca un aviso espurio", () => {
    expect(turnosDesdeElClear(null)).toBe(0);
    expect(turnosDesdeElClear(undefined)).toBe(0);
    expect(turnosDesdeElClear([])).toBe(0);
    expect(turnosDesdeElClear([humano(), humano()])).toBe(0);
  });

  // Fija el umbral contra el caso real que lo motivó (descti, 2026-08-31): 44 respuestas
  // sin un solo clear. Un expediente normal de 10-15 turnos NO debe encenderlo.
  it("🔴 44 respuestas cruzan el umbral; 15 no", () => {
    const flujo = (n: number) => Array.from({ length: n }, () => agente());
    expect(turnosDesdeElClear(flujo(44))).toBeGreaterThanOrEqual(TURNOS_LARGA);
    expect(turnosDesdeElClear(flujo(15))).toBeLessThan(TURNOS_LARGA);
  });
});
