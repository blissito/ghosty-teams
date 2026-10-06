import { describe, it, expect, vi, beforeEach } from "vitest";

// Crítico del plan (5-oct): @check revisa el plan en otra conversación antes de construir.
// Una sola vuelta; el ticket de sprint se aprueba solo al pasar; un fail vuelve a @plan.
const sqls: { sql: string; args: unknown[] }[] = [];
const wakeups: { key: string; text: string }[] = [];
const posts: string[] = [];
let plan: Record<string, unknown> = {};
let failedBefore = false;
let current = "plan_review";

const row = (status: string) => ({ id: 10, channel_id: 14, root_msg_id: 3970, topic: "general", title: "Corte", status, plan_version: 1, loops: 0, requested_by: "ana", approved_by: null, pr_url: null });

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql === "SELECT * FROM gt_factory_runs WHERE id = ?") return [row(current)];
    if (sql.includes("critique = 'fail' LIMIT 1")) return failedBefore ? [{ 1: 1 }] : [];
    if (sql.startsWith("SELECT * FROM gt_factory_plans")) return [{ plan_md: "## Historia\nCorte del día", ...plan }];
    if (sql.startsWith("SELECT critique, auto_approve_by")) return [plan];
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) return [row((current = String(args[0])))];
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 14, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => ({ body: "Quiero el corte del día" }),
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => ["plan", "build", "check"].map((h) => ({ handle: h, name: h, avatar: "", backend: { kind: "other" } })),
  agentGroupId: async (_a: unknown, g: string) => g,
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string; text: string }) => (wakeups.push(w), true),
  mintWakeRef: () => "ref",
  kickWakeups: () => {},
  armWakeups: () => {},
}));

import { startCritique, finishCritique, type Run } from "./factory-runs.server";

const run = (status: Run["status"]): Run => ({
  id: 10, channelId: 14, rootMsgId: 3970, topic: "general", title: "Corte", status, planVersion: 1, loops: 0,
  repo: "o/r", branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "ana", approvedBy: null,
});

beforeEach(() => {
  sqls.length = 0;
  wakeups.length = 0;
  posts.length = 0;
  plan = {};
  failedBefore = false;
  current = "plan_review";
});

describe("crítico del plan", () => {
  it("arranca a @check con el plan y lo pedido, y deja la versión pendiente", async () => {
    expect(await startCritique(run("plan_review"), 1, "https://x")).toBe(true);
    expect(wakeups[0].key).toMatch(/^factory:10:check:/);
    expect(wakeups[0].text).toContain("CRÍTICO DEL PLAN");
    expect(wakeups[0].text).toContain("Quiero el corte del día");
    expect(wakeups[0].text).toContain("factory_plan_critique");
    expect(wakeups[0].text).not.toContain("Habilidades de este paso");
    expect(sqls.some((s) => s.sql.includes("critique = 'pending'"))).toBe(true);
  });

  it("una sola vuelta: si una versión anterior falló, no lo vuelve a llamar", async () => {
    failedBefore = true;
    expect(await startCritique(run("plan_review"), 2, "https://x")).toBe(false);
    expect(wakeups).toHaveLength(0);
  });

  it("pass en un ticket de sprint: se aprueba solo con quien aprobó el sprint", async () => {
    plan = { critique: "pending", auto_approve_by: "beto", auto_approve_who: "Beto", decision: null };
    const r = await finishCritique(run("plan_review"), true, "", "https://x");
    expect(r.status).toBe("building");
    expect(wakeups.some((w) => w.key.startsWith("factory:10:build:"))).toBe(true);
    expect(posts.some((p) => p.includes("Revisé el plan v1"))).toBe(true);
  });

  it("pass en un pedido suelto: sigue esperando la firma de la persona", async () => {
    plan = { critique: "pending", auto_approve_by: null, decision: null };
    const r = await finishCritique(run("plan_review"), true, "", "https://x");
    expect(r.status).toBe("plan_review");
    expect(wakeups).toHaveLength(0);
  });

  it("fail: vuelve a @plan como «cambios» de @check", async () => {
    plan = { critique: "pending", auto_approve_by: "beto", decision: null };
    const r = await finishCritique(run("plan_review"), false, "- dos cifras de vendido hoy", "https://x");
    expect(r.status).toBe("planning");
    const toPlan = wakeups.find((w) => w.key.startsWith("factory:10:plan:"));
    expect(toPlan?.text).toContain("dos cifras de vendido hoy");
  });

  it("si una persona ya firmó, el crítico no toca el pedido", async () => {
    current = "building";
    plan = { critique: "pending", decision: "approve" };
    const r = await finishCritique(run("building"), false, "- algo", "https://x");
    expect(r.status).toBe("building");
    expect(wakeups).toHaveLength(0);
  });
});
