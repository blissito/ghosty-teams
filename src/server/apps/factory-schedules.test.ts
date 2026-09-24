import { describe, it, expect, vi, beforeEach } from "vitest";

let cfg: Record<string, unknown> | null = null;
let due: Record<string, unknown>[] = [];
let claimOk = true;
const wakes: { key: string }[] = [];

vi.mock("./installed.server", () => ({ getAppConfig: async () => cfg }));
vi.mock("../tenant.server", () => ({ withNamespace: (_ns: string, fn: () => unknown) => fn() }));
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string) => {
    if (sql.startsWith("SELECT * FROM gt_factory_schedules WHERE enabled")) return due;
    if (sql.startsWith("UPDATE gt_factory_schedules SET next_at")) return claimOk ? [{ kind: "nightly" }] : [];
    return [];
  },
}));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "plan", name: "Plan", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string }) => {
    wakes.push(w);
    return true;
  },
  mintWakeRef: () => "ref",
  armWakeups: () => {},
}));

import { sweepTenant } from "./factory-schedules.server";

const row = { kind: "nightly", enabled: 1, hour: 2, weekdays_only: 1, tz: "America/Mexico_City", next_at: 1, owner_sub: "u1" };

describe("sweep de tareas programadas", () => {
  beforeEach(() => {
    cfg = null;
    due = [row];
    claimOk = true;
    wakes.length = 0;
  });

  it("sin la fábrica instalada no despierta a nadie", async () => {
    await sweepTenant("ns");
    expect(wakes).toHaveLength(0);
  });

  it("con la fábrica despierta a @plan con llave sched: (la del OK sin burbuja)", async () => {
    cfg = { roomId: 12 };
    await sweepTenant("ns");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].key).toMatch(/^sched:factory-nightly:/);
  });

  it("si otro tick ya la reclamó, no dispara dos veces", async () => {
    cfg = { roomId: 12 };
    claimOk = false;
    await sweepTenant("ns");
    expect(wakes).toHaveLength(0);
  });
});
