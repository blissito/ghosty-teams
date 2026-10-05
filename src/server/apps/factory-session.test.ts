import { describe, it, expect, vi, beforeEach } from "vitest";

// Los roles de la fábrica ya no comparten la conversación del room (MailMask, 4-oct: ~200k y un
// minuto compactando por una línea): van por pedido o por hilo.
let installed = true;
let runs: Record<number, { id: number }> = {};
vi.mock("./installed.server", () => ({ isInstalled: async () => installed }));
vi.mock("./factory-runs.server", () => ({ runOfThread: async (_c: number, root: number) => runs[root] ?? null }));
let lastEvent: { type: string; actor: string | null } | null = null;
vi.mock("../../dbq.server", () => ({ dbq: async () => (lastEvent ? [lastEvent] : []) }));

import { fleetSuffixFor, factoryFollowHandle } from "./factory-session.server";

const ch = { id: 14, slug: "mailmask" };
beforeEach(() => {
  installed = true;
  runs = {};
  lastEvent = null;
});

describe("fleetSuffixFor", () => {
  it("rol de la fábrica en el hilo de un pedido: la conversación del pedido (la misma de los relevos)", async () => {
    runs[3970] = { id: 10 };
    expect(await fleetSuffixFor("plan", ch, 3970)).toBe("factory-10");
  });
  it("rol de la fábrica en un hilo sin pedido: una por hilo", async () => {
    expect(await fleetSuffixFor("plan", ch, 4140)).toBe("factory-thread-4140");
  });
  it("cualquier otro agente sigue en la del room", async () => {
    expect(await fleetSuffixFor("ghosty", ch, 4140)).toBe("mailmask-flow");
  });
  it("sin la fábrica instalada, @plan es un agente más", async () => {
    installed = false;
    expect(await fleetSuffixFor("plan", ch, 4140)).toBe("mailmask-flow");
  });
});

// Un mensaje sin mención en el hilo de un pedido: los avisos de la plataforma salen con la cara de
// un rol y «haz otro sprint» le llegaba a @build (palmera-legal, 4-oct).
describe("factoryFollowHandle", () => {
  it("hilo sin pedido: decide la regla general", async () => {
    expect(await factoryFollowHandle(14, 4140)).toBeNull();
  });
  it("hilo de un pedido: @plan, aunque el último aviso lo firmara @build", async () => {
    runs[3970] = { id: 10 };
    lastEvent = { type: "build_done", actor: "build" };
    expect(await factoryFollowHandle(14, 3970)).toBe("plan");
  });
  it("un rol le preguntó algo a la persona: la respuesta es para él", async () => {
    runs[3970] = { id: 10 };
    lastEvent = { type: "waiting_person", actor: "build" };
    expect(await factoryFollowHandle(14, 3970)).toBe("build");
  });
  it("sin la fábrica instalada: regla general", async () => {
    installed = false;
    runs[3970] = { id: 10 };
    expect(await factoryFollowHandle(14, 3970)).toBeNull();
  });
});
