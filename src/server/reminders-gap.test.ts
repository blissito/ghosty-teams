import { describe, it, expect } from "vitest";
import { gapDesdeUltimaRespuesta } from "../agents.server";
import { esRecordatorio, REMINDER_MARK } from "./reminders.server";

// Contexto: el catch-up del canal le inyecta al agente los mensajes POSTERIORES a su
// última respuesta, dando por hecho que todo lo anterior ya está en su sesión. Un
// RECORDATORIO rompe ese supuesto: lo publica la plataforma con la cara del agente y
// nunca pasó por un turno suyo, así que no está en su transcript. Contarlo como corte
// lo dejaba fuera del contexto por los dos lados a la vez.
//
// Visto en producción el 2026-08-01: al responder "ya la pagué" a un recordatorio, el
// agente contestó "déjame ver qué recordatorio es" y acto seguido retomó un trabajo del
// día anterior — lo único que sí recordaba.

const msg = (agent_handle: string | null, body: string) => ({ agent_handle, body });

describe("gap del catch-up", () => {
  it("un recordatorio NO corta el gap: viaja al contexto junto con la respuesta", () => {
    const recientes = [
      msg("ghosty", "aquí tienes la galería"),
      msg("ghosty", `${REMINDER_MARK} — @fixtergeek\n\nPagar mi tarjeta de crédito`),
      msg(null, "ya la pague"),
    ];
    const gap = gapDesdeUltimaRespuesta(recientes, esRecordatorio);
    expect(gap.map((m) => m.body)).toEqual([
      `${REMINDER_MARK} — @fixtergeek\n\nPagar mi tarjeta de crédito`,
      "ya la pague",
    ]);
  });

  it("una respuesta de verdad del agente SÍ corta: lo anterior ya está en su sesión", () => {
    const recientes = [
      msg(null, "hola"),
      msg("ghosty", "qué tal"),
      msg(null, "seguimos"),
    ];
    expect(gapDesdeUltimaRespuesta(recientes, esRecordatorio).map((m) => m.body)).toEqual([
      "seguimos",
    ]);
  });

  it("el corte es la ÚLTIMA respuesta real, aunque haya recordatorios después", () => {
    const recientes = [
      msg("ghosty", "listo"),
      msg("ghosty", `${REMINDER_MARK}\n\nregar las plantas`),
      msg("ghosty", "ahí va otra cosa"),
      msg("ghosty", `${REMINDER_MARK}\n\nsacar la basura`),
      msg(null, "ok"),
    ];
    expect(gapDesdeUltimaRespuesta(recientes, esRecordatorio).map((m) => m.body)).toEqual([
      `${REMINDER_MARK}\n\nsacar la basura`,
      "ok",
    ]);
  });

  it("sin ninguna respuesta del agente el gap es todo (sesión fresca)", () => {
    const recientes = [msg(null, "uno"), msg(null, "dos")];
    expect(gapDesdeUltimaRespuesta(recientes, esRecordatorio)).toHaveLength(2);
  });

  it("un mensaje vacío del agente no cuenta como respuesta (cáscara de streaming)", () => {
    const recientes = [msg(null, "uno"), msg("ghosty", "   "), msg(null, "dos")];
    expect(gapDesdeUltimaRespuesta(recientes, esRecordatorio)).toHaveLength(3);
  });

  it("esRecordatorio reconoce el marcador que escribe deliver, con o sin sangría", () => {
    expect(esRecordatorio(`${REMINDER_MARK} — @x\n\ntexto`)).toBe(true);
    expect(esRecordatorio(`\n ${REMINDER_MARK}\n\ntexto`)).toBe(true);
    expect(esRecordatorio("un mensaje normal")).toBe(false);
    expect(esRecordatorio(null)).toBe(false);
  });
});
