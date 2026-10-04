import { describe, it, expect, vi, beforeEach } from "vitest";

// Los roles de la fábrica ya no comparten la conversación del room (MailMask, 4-oct: ~200k y un
// minuto compactando por una línea): van por pedido o por hilo.
let installed = true;
let runs: Record<number, { id: number }> = {};
vi.mock("./installed.server", () => ({ isInstalled: async () => installed }));
vi.mock("./factory-runs.server", () => ({ runOfThread: async (_c: number, root: number) => runs[root] ?? null }));

import { fleetSuffixFor } from "./factory-session.server";

const ch = { id: 14, slug: "mailmask" };
beforeEach(() => {
  installed = true;
  runs = {};
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
