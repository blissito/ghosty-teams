import { describe, it, expect, vi, beforeEach } from "vitest";

// Arranque desde Tasks: sin fábrica no hace nada; con una corrida viva de esa tarea no abre
// otra; y una corrida nacida de una tarea no crea una segunda tarea.
let cfg: Record<string, unknown> | null = null;
let alive: { id: number }[] = [];
const posted: string[] = [];
const inserted: unknown[][] = [];
const tasksCalls: string[] = [];

vi.mock("./installed.server", () => ({ getAppConfig: async () => cfg, isInstalled: async () => !!cfg }));
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.includes("WHERE task_ref")) return alive;
    if (sql.startsWith("INSERT INTO gt_factory_runs")) {
      inserted.push(args);
      return [{ id: 7 }];
    }
    if (sql.includes("FROM gt_factory_runs WHERE id")) {
      return [{ id: 7, channel_id: 3, root_msg_id: 99, topic: "general", title: "t", status: "planning", plan_version: 0, loops: 0, task_ref: "12", requested_by: "u1" }];
    }
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  listRoomRepos: async () => [{ repo: "blissito/agenda" }],
  postAgent: async (_c: number, _p: unknown, body: string) => {
    posted.push(body);
    return { id: 99 };
  },
  getMessage: async () => null,
}));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "plan", name: "Plan", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({ enqueueWakeup: async () => true, mintWakeRef: () => "ref", armWakeups: () => {} }));
vi.mock("../tasks-bridge.server", () => ({
  callTasks: async (_s: string, _u: string, _b: number, name: string) => {
    tasksCalls.push(name);
    return { ok: true, result: { id: 5 } };
  },
}));

import { startRunFromTask, createTaskFor, getRun } from "./factory-runs.server";

const base = { taskRef: "12", title: "Recordatorios", description: "a los 3 días", requestedBy: "u1", origin: "" };

describe("startRunFromTask", () => {
  beforeEach(() => {
    cfg = null;
    alive = [];
    posted.length = 0;
    inserted.length = 0;
    tasksCalls.length = 0;
  });

  it("sin la fábrica instalada no hace nada", async () => {
    expect(await startRunFromTask(base)).toHaveProperty("error");
    expect(posted).toHaveLength(0);
  });

  it("publica el pedido en el room de la fábrica y abre la corrida con la tarea", async () => {
    cfg = { roomId: 3 };
    expect(await startRunFromTask(base)).toEqual({ runId: 7, existing: false });
    expect(posted[0]).toContain("Tarea #12 asignada a @plan");
    expect(inserted[0]).toContain("12");
  });

  it("reasignar la misma tarea con una corrida viva no abre otra", async () => {
    cfg = { roomId: 3 };
    alive = [{ id: 4 }];
    expect(await startRunFromTask(base)).toEqual({ runId: 4, existing: true });
    expect(posted).toHaveLength(0);
  });

  it("una corrida que ya tiene tarea no crea otra", async () => {
    cfg = { roomId: 3, boardId: 1 };
    const run = (await getRun(7))!;
    await createTaskFor(run, "plan");
    expect(tasksCalls).not.toContain("task_create");
  });
});
