import { describe, it, expect } from "vitest";
import { adjuntosDelHueco, HUECO_ADJUNTOS_MAX } from "../agents.server";

// El 2026-09-07, revisando los DMs de descti: seis veces la persona escribió la instrucción,
// la mandó, y DESPUÉS soltó los archivos — que salen como un mensaje aparte con el cuerpo
// VACÍO. El agente contestaba «no veo ningún archivo adjunto» y le echaba la culpa al
// remitente («parece que el envío no se completó de tu lado»). Uno de esos mensajes traía
// DIEZ archivos.
//
// Y el scan de re-entrega de `dm.ts`, que existía justo para esto, era un NO-OP: filtraba
// con `if (m.agent_handle) continue` creyendo que esa columna marca los mensajes DEL agente.
// Marca a quién van DIRIGIDOS, y en un DM con un agente la lleva también el mensaje del
// humano — los 250 mensajes de esos 7 DMs la tienen puesta. Ése es el caso de abajo que
// más importa.

const att = (name: string) => ({ file_id: `f-${name}`, mime: "application/pdf", size: 10, name });
const msg = (sub: string | null, atts: string[] = [], agent_handle: string | null = "ghosty") =>
  ({ sender_sub: sub, agent_handle, attachments: atts.map(att) });

describe("adjuntosDelHueco", () => {
  it("toma los adjuntos del humano AUNQUE el mensaje lleve agent_handle", () => {
    const gap = [msg("u1", ["instruccion.txt"]), msg(null, []), msg("u1", ["a.pdf", "b.pdf"])];
    expect(adjuntosDelHueco(gap, "u1").map((a) => a.name)).toEqual(["instruccion.txt", "a.pdf", "b.pdf"]);
  });

  it("ignora los del agente (sender_sub NULL)", () => {
    expect(adjuntosDelHueco([msg(null, ["salida.pdf"])], "u1")).toEqual([]);
  });

  it("ignora los de OTRA persona del canal", () => {
    expect(adjuntosDelHueco([msg("u2", ["ajeno.pdf"])], "u1")).toEqual([]);
  });

  it("sin invocador no arrastra nada", () => {
    expect(adjuntosDelHueco([msg("u1", ["a.pdf"])], null)).toEqual([]);
  });

  it("conserva los MÁS NUEVOS al pasarse del tope", () => {
    const muchos = Array.from({ length: HUECO_ADJUNTOS_MAX + 3 }, (_, i) => msg("u1", [`f${i}.pdf`]));
    const out = adjuntosDelHueco(muchos, "u1");
    expect(out).toHaveLength(HUECO_ADJUNTOS_MAX);
    expect(out[out.length - 1].name).toBe(`f${HUECO_ADJUNTOS_MAX + 2}.pdf`);
  });
});
