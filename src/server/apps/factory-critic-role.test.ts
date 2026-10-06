import { describe, it, expect, vi } from "vitest";

// El turno de @check en un pedido que espera firma con su plan pendiente de crítica es el del
// CRÍTICO: no le tocan las instrucciones de revisar un PR.
let status = "plan_review";
let critique: string | null = "pending";
vi.mock("./installed.server", () => ({ isInstalled: async () => true }));
vi.mock("./factory-runs.server", () => ({
  runOfThread: async () => ({ id: 7, status, planVersion: 1 }),
  getPlan: async () => ({ critique }),
}));

import { isCriticTurn } from "./factory-tools.server";
import { CRITIC_ROLE } from "./factory-roles";

describe("turno del crítico del plan", () => {
  it("sólo con el pedido en plan_review y la crítica pendiente", async () => {
    const dest = { channelId: 1, parentId: 3, handle: "check" };
    expect(await isCriticTurn(dest)).toBe(true);
    critique = "pass";
    expect(await isCriticTurn(dest)).toBe(false);
    critique = "pending";
    status = "checking";
    expect(await isCriticTurn(dest)).toBe(false);
    expect(await isCriticTurn({ channelId: 1, handle: "check" })).toBe(false); // sin hilo
  });
  it("su papel le prohíbe veredicto y cajas", () => {
    expect(CRITIC_ROLE).toContain("factory_plan_critique");
    expect(CRITIC_ROLE).toContain("no usas factory_check_verdict");
  });
});
