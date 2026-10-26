import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// De quién es un turno: sólo quien lo pidió lo detiene, lo corrige (steer) o lo interrumpe.
// El canal es compartido, así que cortar el trabajo de otra persona es una acción sobre ella,
// no sobre el agente. Las dos salidas medidas: el turno atorado > 15 min (goose en descti,
// 325 min, 18-sep: el ■ de bliss devolvía false en silencio) y el dueño del espacio con
// `force` (Oswaldo no podía parar el turno de Iris en palmera-legal, 7-oct).
vi.mock("../dbq.server", () => ({ dbq: async () => [], num: (v: unknown) => Number(v) }));
vi.mock("./tenant.server", () => ({ withNamespace: async (_ns: string, fn: () => Promise<unknown>) => fn() }));

const T = await import("./turns.server");

let next = 1000;
function turn(over: { groupId?: string; invokerSub?: string | null; startedAt?: number; ns?: string } = {}) {
  const controller = new AbortController();
  const t = T.registerTurn({
    ns: over.ns ?? "acme",
    messageId: ++next,
    groupId: over.groupId ?? "g1",
    invokerSub: over.invokerSub === undefined ? "ana" : over.invokerSub,
    controller,
    ...(over.startedAt ? { startedAt: over.startedAt } : {}),
  } as never);
  return { id: t.messageId, ns: t.ns, controller };
}

const vivos: { ns: string; id: number }[] = [];
const reg = (o?: Parameters<typeof turn>[0]) => {
  const t = turn(o);
  vivos.push(t);
  return t;
};

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout"] }));
afterEach(() => {
  for (const t of vivos.splice(0)) T.finishTurn(t.ns, t.id);
  vi.useRealTimers();
});

describe("detener un turno", () => {
  it("quien lo pidió lo detiene y el fetch al worker se corta", () => {
    const t = reg();
    expect(T.stopTurn("acme", t.id, "ana")).toBe(true);
    expect(t.controller.signal.aborted).toBe(true);
    expect(T.turnState("acme", t.id)?.state).toBe("stopped");
  });

  it("otra persona NO lo detiene, y se puede decir por qué", () => {
    const t = reg();
    expect(T.turnOwnedByOther("acme", t.id, "beto")).toBe(true);
    expect(T.stopTurn("acme", t.id, "beto")).toBe(false);
    expect(t.controller.signal.aborted).toBe(false);
  });

  it("el dueño del espacio (force) sí lo detiene", () => {
    const t = reg();
    expect(T.stopTurn("acme", t.id, "beto", { force: true })).toBe(true);
  });

  it("atorado más de 15 min: cualquiera del espacio lo cierra", () => {
    const t = reg({ startedAt: Date.now() - 16 * 60_000 });
    expect(T.stopTurn("acme", t.id, "beto")).toBe(true);
  });

  it("a los 14 min todavía es trabajo de alguien", () => {
    const t = reg({ startedAt: Date.now() - 14 * 60_000 });
    expect(T.stopTurn("acme", t.id, "beto")).toBe(false);
  });

  it("detenido pero colgado: a los 5 s se retira del mapa aunque el finally no llegue", () => {
    const t = reg();
    T.stopTurn("acme", t.id, "ana");
    expect(T.turnState("acme", t.id)).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(T.turnState("acme", t.id)).toBeNull();
  });

  it("los ids no chocan entre espacios: detener en otro ns no toca el turno", () => {
    const t = reg({ ns: "acme" });
    expect(T.stopTurn("otro", t.id, "ana")).toBe(false);
    expect(t.controller.signal.aborted).toBe(false);
  });
});

describe("steer e interrupción: sólo los turnos propios", () => {
  it("hasOwnInflight sólo ve mis turnos vivos del mismo flow", () => {
    const t = reg({ groupId: "g-steer", invokerSub: "ana" });
    expect(T.hasOwnInflight("g-steer", "ana")).toBe(true);
    expect(T.hasOwnInflight("g-steer", "beto")).toBe(false);
    expect(T.hasOwnInflight("g-otro", "ana")).toBe(false);
    expect(T.hasOwnInflight("g-steer", null)).toBe(false);
    T.stopTurn("acme", t.id, "ana");
    expect(T.hasOwnInflight("g-steer", "ana")).toBe(false);
  });

  it("interruptOwnTurns corta los míos y deja vivo el de otra persona", () => {
    const mio = reg({ groupId: "g-int", invokerSub: "ana" });
    const ajeno = reg({ groupId: "g-int", invokerSub: "beto" });
    expect(T.interruptOwnTurns("g-int", "ana")).toBe(1);
    expect(mio.controller.signal.aborted).toBe(true);
    expect(ajeno.controller.signal.aborted).toBe(false);
    expect(T.interruptOwnTurns("g-int", null)).toBe(0);
  });

  it("la cola: el primero del flow corre y el segundo espera en posición 2", () => {
    const a = reg({ groupId: "g-cola" });
    vi.advanceTimersByTime(1);
    const b = reg({ groupId: "g-cola", invokerSub: "beto" });
    expect(T.turnState("acme", a.id)).toMatchObject({ state: "running", position: 1 });
    expect(T.turnState("acme", b.id)).toMatchObject({ state: "queued", position: 2 });
    T.finishTurn("acme", a.id);
    expect(T.turnState("acme", b.id)).toMatchObject({ state: "running", position: 1 });
  });
});
