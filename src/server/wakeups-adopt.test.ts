import { describe, it, expect, vi, beforeEach } from "vitest";

// Un deploy de Teams a media revisión: la adopción tiene que aguantar otro reinicio, no dejar la
// burbuja vacía y guardar el cuerpo mientras corre (palmera-legal #9, 4-oct).
const bodies: { id: number; body: string }[] = [];
const registered: number[] = [];
const durable: { id: number; wakeKey?: string }[] = [];
const finished: number[] = [];
const steps: string[] = [];
let ranTurn = false;
let calls: string[] = [];
const mentioned: string[] = [];

vi.mock("../dbq.server", () => ({ dbq: async () => [] }));
vi.mock("./tenant.server", () => ({ withNamespace: (_ns: string, f: () => unknown) => f(), freshOrigin: async (o: string) => o }));
vi.mock("../db.server", () => ({
  setMessageBody: async (id: number, body: string) => void bodies.push({ id, body }),
  getChannelById: async () => ({ id: 14, slug: "mailmask" }),
  getMessage: async () => null,
  deleteMessage: async () => {},
  postAgent: async () => ({ id: 500 }),
  setMessageBodyStreaming: async (id: number, body: string) => void bodies.push({ id, body }),
}));
vi.mock("./bus.server", () => ({ publish: () => {}, ch: { room: () => "r", user: () => "u" } }));
vi.mock("./turns.server", () => ({
  registerTurn: (t: { messageId: number }) => (calls.push("register"), registered.push(t.messageId)),
  setTurnDurable: async (id: number, f: { wakeKey?: string }) => void durable.push({ id, ...f }),
  finishTurn: (_ns: string, id: number) => void finished.push(id),
  turnState: () => null,
  setTurnStep: (_ns: string, _id: number, p: string) => void steps.push(p),
}));
vi.mock("./mentions.server", () => ({ notificarMencionesDelAgente: async (_ns: string, _c: unknown, reply: string) => (mentioned.push(reply), "") }));
vi.mock("./apps/factory-runs.server", () => ({ afterFactoryTurn: async () => {} }));
vi.mock("./delivery-fences.server", () => ({ attachDeliveryFences: async () => null }));
vi.mock("../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "check", name: "Check", avatar: "" }],
  runAgentTurn: async (o: any) => {
    calls.push("run");
    ranTurn = true;
    const id = await o.createShell();
    o.onShell?.(id);
    o.emitBody(id, "```gt-steps\n{\"steps\":[\"Leyendo dns.ts\"]}\n```\nVoy a medio camino");
    return { id, reply: "Listo: aprobado." };
  },
}));

import { fire, type Wakeup, type WakeRef } from "./wakeups.server";

const ref = (adopt?: { shellId: number; turnId: string }): WakeRef =>
  ({ sub: "ana", ns: "ns", groupId: "g", dest: { channelId: 14, parentId: 99, handle: "check", topic: "general" }, ...(adopt ? { adopt } : {}) }) as WakeRef;
const wake = (key: string): Wakeup => ({ id: "w", key, ref: "r", cause: "x", text: "revisa", origin: "", dueAt: 0 });

beforeEach(() => {
  bodies.length = 0;
  registered.length = 0;
  durable.length = 0;
  finished.length = 0;
  steps.length = 0;
  ranTurn = false;
  calls = [];
  mentioned.length = 0;
});

describe("adopción tras un reinicio", () => {
  it("la fila vuelve a running ANTES de correr (otro reinicio en ese hueco la vuelve a adoptar)", async () => {
    await fire("ns", wake("sched:turn:1:adopt"), ref({ shellId: 288, turnId: "t1" }));
    expect(calls.slice(0, 2)).toEqual(["register", "run"]);
    expect(durable[0]).toMatchObject({ id: 288, wakeKey: "sched:turn:1:adopt" });
  });

  it("la burbuja dice «Retomando…» en vez de quedar vacía", async () => {
    await fire("ns", wake("sched:turn:1:adopt"), ref({ shellId: 288, turnId: "t1" }));
    expect(bodies[0]).toEqual({ id: 288, body: "_Retomando tras un reinicio…_" });
    expect(bodies.some((b) => b.body === "")).toBe(false);
  });

  it("después de 4 adopciones no se encadena otra: se dice y no corre", async () => {
    await fire("ns", wake("factory:9:check:1:adopt:adopt:adopt:adopt:adopt"), ref({ shellId: 288, turnId: "t1" }));
    expect(ranTurn).toBe(false);
    expect(bodies[0].body).toContain("demasiadas veces");
  });
});

describe("turno de despertador", () => {
  it("el cuerpo se guarda mientras corre y el paso va al estado del turno", async () => {
    await fire("ns", wake("sched:turn:2"), ref());
    expect(steps).toContain("Leyendo dns.ts");
    // El flush del cierre deja en la DB lo que llevaba antes del cuerpo final.
    expect(bodies.some((b) => b.body.includes("Voy a medio camino"))).toBe(true);
    expect(bodies[bodies.length - 1].body).toBe("Listo: aprobado.");
    expect(finished).toHaveLength(1);
  });
});

// @build le pidió los datos del equipo a Oswaldo y a su celular no llegó nada (palmera-legal, 4-oct).
describe("menciones en un turno de despertador", () => {
  it("la respuesta final pasa por el aviso de menciones (push a la persona)", async () => {
    await fire("ns", wake("sched:turn:3"), ref());
    expect(mentioned).toEqual(["Listo: aprobado."]);
  });
});
