import { beforeEach, describe, expect, it, vi } from "vitest";

// El acuse 👀 → ✅ del agente sobre el mensaje que lo invocó. Lo que se fija aquí son las
// tres cosas que, de romperse, dejan un 👀 clavado o lo ponen donde no toca — y ninguna de
// las tres se ve mirando la pantalla, porque el turno cierra en verde igual.

const setReaction = vi.fn(async () => ({ count: 1 }));
const getMessage = vi.fn(async (id: number) => ({ id, channel_id: 7, dm_id: null }));
const publishToAudience = vi.fn(async () => {});

vi.mock("../db.server", () => ({
  setReaction: (...a: unknown[]) => setReaction(...(a as [])),
  getMessage: (id: number) => getMessage(id),
}));
vi.mock("./chat", () => ({
  publishToAudience: (...a: unknown[]) => publishToAudience(...(a as [])),
}));

const ack = await import("./agent-ack.server");

/** Las llamadas a `setReaction` como tuplas legibles: [messageId, sub, emoji, on]. */
const reacciones = () =>
  setReaction.mock.calls.map((c) => [c[0], c[1], c[2], c[3]] as [number, string, string, boolean]);

beforeEach(() => {
  vi.resetAllMocks();
  setReaction.mockResolvedValue({ count: 1 });
  getMessage.mockImplementation(async (id: number) => ({ id, channel_id: 7, dm_id: null }));
  publishToAudience.mockResolvedValue(undefined);
});

describe("el sub del agente", () => {
  it("lleva el handle dentro, no es un 'Ghosty' único", () => {
    // `doc-users.ts` usa `agent:` para UNA identidad compartida. Con una flota, dos agentes
    // reaccionando al mismo mensaje se pisarían la fila (la PK es message+sub+emoji) y el
    // segundo 👀 no existiría — al cerrar, el primero le quitaría el acuse al segundo.
    expect(ack.agentSub("blue")).toBe("agent:blue");
    expect(ack.agentSub("blue")).not.toBe(ack.agentSub("ghosty"));
  });
});

describe("cerrar el acuse", () => {
  it("QUITA el 👀 y deja la marca — no las apila", async () => {
    await ack.ackEnd("acme", [42], "blue", "done");
    expect(reacciones()).toEqual([
      [42, "agent:blue", "👀", false],
      [42, "agent:blue", "✅", true],
    ]);
  });

  it("cubre TODOS los mensajes del turno, no sólo el primero", async () => {
    // Es el caso del STEER: escribir otra vez con el turno vivo mete el mensaje en el turno
    // en curso, y `postMessage` ya le puso su propio 👀. Cerrando sólo el primero, ese 👀 se
    // queda para siempre: el turno ya no existe y nadie vuelve por él.
    await ack.ackEnd("acme", [42, 43], "blue", "done");
    const conAcuse = reacciones().filter((r) => r[2] === "👀" && r[3] === false).map((r) => r[0]);
    expect(conAcuse).toEqual([42, 43]);
  });

  it("distingue los tres desenlaces", async () => {
    for (const [outcome, emoji] of [["done", "✅"], ["stopped", "⏹"], ["error", "⚠️"]] as const) {
      setReaction.mockClear();
      await ack.ackEnd("acme", [1], "blue", outcome);
      // Un turno DETENIDO o REVENTADO no puede acabar con palomita: sería anunciar como
      // entrega algo que no se entregó.
      expect(reacciones().find((r) => r[3])?.[2]).toBe(emoji);
    }
  });

  it("no revienta si el mensaje ya no existe", async () => {
    // Borrar el mensaje que invocó al agente mientras trabaja es normal. El acuse es
    // best-effort: no puede tumbar el cierre del turno.
    getMessage.mockResolvedValue(null as never);
    await expect(ack.ackEnd("acme", [42], "blue", "done")).resolves.toBeUndefined();
    expect(setReaction).not.toHaveBeenCalled();
  });
});

describe("arrancar el acuse", () => {
  it("pone 👀 y lo anuncia por la audiencia del mensaje", async () => {
    await ack.ackStart("acme", 42, "blue");
    expect(reacciones()).toEqual([[42, "agent:blue", "👀", true]]);
    // Por `publishToAudience` y no por el bus del room: es lo único que sirve igual en un
    // room y en un DM. Y como `reaction`, NUNCA como `message:new` — eso despertaría al
    // agente con su propio acuse y lo contaría como no leído.
    const ev = publishToAudience.mock.calls[0]?.[2] as { t: string; emoji: string };
    expect(ev.t).toBe("reaction");
    expect(ev.emoji).toBe("👀");
  });
});
