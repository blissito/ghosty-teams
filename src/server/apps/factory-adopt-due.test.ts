import { describe, it, expect, vi, beforeEach } from "vitest";

// Filas de mentira de gt_factory_runs; dbq contesta las consultas de `startDueAdoptedRuns`.
const rows = new Map<number, { id: number; status: string; due_at: number | null; due_who: string | null; kind: string }>();
vi.mock("../../dbq.server", () => ({
  dbq: vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("UPDATE gt_factory_runs SET due_at = NULL WHERE due_at IS NOT NULL AND status")) {
      for (const r of rows.values()) if (r.due_at != null && r.status !== "plan_review") r.due_at = null;
      return [];
    }
    if (sql.startsWith("SELECT id, due_who")) {
      const now = Number(args[0]);
      return [...rows.values()].filter((r) => r.due_at != null && r.due_at <= now && r.status === "plan_review").sort((a, b) => a.due_at! - b.due_at!);
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET due_at = NULL WHERE id = ?")) {
      const r = rows.get(Number(args[0]));
      if (!r || r.due_at == null) return [];
      r.due_at = null;
      return [{ id: r.id }];
    }
    throw new Error(`sql inesperado: ${sql}`);
  }),
}));
const decide = vi.fn(async () => ({}));
const applyEvent = vi.fn(async () => ({}));
const postInThread = vi.fn(async () => 1);
vi.mock("./factory-runs.server", () => ({
  getRun: async (id: number) => {
    const r = rows.get(id);
    return r ? { id, channelId: 10, status: r.status, planVersion: 1, kind: r.kind, requestedBy: "u1", approvedBy: "u1", repo: "acme/web" } : null;
  },
  decide,
  applyEvent,
  postInThread,
  refreshRoom: async () => {},
}));
const prepare = vi.fn(async () => undefined as { skip?: string } | undefined);
vi.mock("../automations/security-fix.server", () => ({ prepareSecurityRun: (...a: unknown[]) => prepare(...(a as [])) }));

const { startDueAdoptedRuns } = await import("./factory-adopt.server");

beforeEach(() => {
  rows.clear();
  decide.mockClear();
  applyEvent.mockClear();
  prepare.mockReset();
  prepare.mockResolvedValue(undefined);
});

describe("pedidos adoptados con hora", () => {
  it("antes de su hora no arrancan; al vencer se aprueban una sola vez", async () => {
    rows.set(1, { id: 1, status: "plan_review", due_at: 1000, due_who: "La automatización «Arreglar alertas»", kind: "security" });
    expect(await startDueAdoptedRuns(999)).toBe(0);
    expect(await startDueAdoptedRuns(1000)).toBe(1);
    expect(await startDueAdoptedRuns(1001)).toBe(0);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]).toEqual([expect.objectContaining({ decision: "approve", version: 1, sub: "u1", who: "La automatización «Arreglar alertas»" })]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("si alguien ya firmó, sólo se limpia la hora", async () => {
    rows.set(2, { id: 2, status: "building", due_at: 500, due_who: "x", kind: "security" });
    expect(await startDueAdoptedRuns(1000)).toBe(0);
    expect(rows.get(2)!.due_at).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("la preparación puede cancelarlo con su razón", async () => {
    rows.set(3, { id: 3, status: "plan_review", due_at: 10, due_who: "x", kind: "security" });
    prepare.mockResolvedValue({ skip: "🛡️ Ya no queda ninguna alerta" });
    expect(await startDueAdoptedRuns(20)).toBe(0);
    expect(postInThread).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), "build", "🛡️ Ya no queda ninguna alerta");
    expect(applyEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), "cancel", {}, expect.anything());
    expect(decide).not.toHaveBeenCalled();
  });

  it("un tipo sin preparación arranca directo", async () => {
    rows.set(4, { id: 4, status: "plan_review", due_at: 10, due_who: null, kind: "ci_fix" });
    expect(await startDueAdoptedRuns(20)).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(decide.mock.calls[0]).toEqual([expect.objectContaining({ who: "La plataforma" })]);
  });
});
