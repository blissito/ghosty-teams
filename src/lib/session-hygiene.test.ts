import { describe, expect, it } from "vitest";
import { turnosDesdeElClear, compactacionesDesdeElClear, continuacionTrasFresca, MARCA_CLEAR, MARCA_FRESCA, TURNOS_LARGA } from "./session-hygiene";

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

describe("memoria fresca", () => {
  const p = (body: string) => ({ agent_handle: "ghosty", sender_sub: "u1", body });
  const a = (body: string) => ({ agent_handle: "ghosty", sender_sub: null, body });
  const fresca = () => a(MARCA_FRESCA);

  it("cuenta las compactaciones desde el último ancla", () => {
    const tools = '```gt-tools\n{"tools":[{"label":"Compacté la memoria","status":"done"}]}\n```\nlisto';
    expect(compactacionesDesdeElClear([a(tools), clear(), a(tools), a("x"), a(tools)])).toBe(2);
    expect(compactacionesDesdeElClear([a(tools), fresca(), a("x")])).toBe(0);
  });

  it("la burbuja de memoria fresca reinicia el contador de turnos", () => {
    expect(turnosDesdeElClear([a("1"), a("2"), fresca(), p("hola"), a("3")])).toBe(1);
  });

  it("lleva la cola de lo hablado sólo en el primer turno después", () => {
    const flow = [a("viejo"), clear(), p("hazme el contrato"), a("```gt-tools\n{}\n```\nAquí va el contrato"), fresca(), p("ajusta la cláusula 3")];
    const c = continuacionTrasFresca(flow);
    expect(c).toContain("Persona: hazme el contrato");
    expect(c).toContain("Tú: Aquí va el contrato");
    expect(c).not.toContain("viejo");
    expect(c).not.toContain("gt-tools");
    expect(continuacionTrasFresca([...flow, a("listo, ajustada")])).toBe("");
    expect(continuacionTrasFresca([a("x"), clear(), p("hola")])).toBe("");
  });
});
