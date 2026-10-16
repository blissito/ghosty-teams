import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Postmortem automático (16-oct, #96 de Deník): un pedido que se aprobó sin cumplir un criterio
// del plan despierta a @plan UNA vez para que proponga barandales; los demás sólo dejan la nota 🩺.
const sqls: { sql: string; args: unknown[] }[] = [];
const posts: string[] = [];
const wakeups: { key: string; text: string; cause: string }[] = [];
const fetches: { url: string; body: Record<string, unknown> }[] = [];
let postmortemDone = false;
let reply: Record<string, unknown> = {};

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.includes("type = 'postmortem_requested'")) return postmortemDone ? [{ 1: 1 }] : [];
    if (sql.startsWith("INSERT INTO gt_factory_events") && args[2] === "postmortem_requested") postmortemDone = true;
    if (sql.includes("FROM gt_agent_wakeups")) return [{ origin: "https://denik.teams.ghosty.studio" }];
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_state = 'pending'"))
      return [{ id: 106, channel_id: 14, root_msg_id: 5000, topic: "general", title: "Login", status: "checking", plan_version: 1, loops: 0, requested_by: "ana", pr_url: "https://github.com/o/r/pull/9" }];
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 14, slug: "denik" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../ghosty-runtime.server", () => ({ nativeRuntimeBase: async () => "https://gs.test", partnerHeaders: () => ({}) }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "plan", name: "Arqui", avatar: "" }, { handle: "check", name: "Arqui", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string; text: string; cause: string }) => (wakeups.push(w), true),
  mintWakeRef: () => "ref",
  kickWakeups: () => {},
  armWakeups: () => {},
}));

import { fetchRunWhy, postWhyIfUnhealthy, retryPreviews, type Run } from "./factory-runs.server";

const run: Run = {
  id: 96, channelId: 14, rootMsgId: 3970, topic: "general", title: "React Router 8", status: "done", planVersion: 1, loops: 0,
  repo: "o/agenda", branch: null, prUrl: "https://github.com/o/agenda/pull/8", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
};

beforeEach(() => {
  sqls.length = 0;
  posts.length = 0;
  wakeups.length = 0;
  fetches.length = 0;
  postmortemDone = false;
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    fetches.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("postmortem automático", () => {
  it("criterio incumplido y aprobado: nota 🩺 y @plan con el encargo, una sola vez", async () => {
    reply = { healthy: false, category: "approved_unmet_criterion", incomplete: null, note: "🩺 Se aprobó sin la preview." };
    await postWhyIfUnhealthy(run);
    await postWhyIfUnhealthy(run);
    expect(posts.filter((p) => p.includes("🩺"))).toHaveLength(2);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].key).toMatch(/^factory:96:plan:\d+:postmortem$/);
    expect(wakeups[0].text).toContain("factory_run_review");
    expect(wakeups[0].text).toContain("factory_suggest");
  });
  it("otro motivo: sólo la nota", async () => {
    reply = { healthy: false, category: "premature_stop", incomplete: null, note: "🩺 Cerró antes." };
    await postWhyIfUnhealthy(run);
    expect(posts).toHaveLength(1);
    expect(wakeups).toHaveLength(0);
  });
  it("fetchRunWhy pide el análisis completo y rehecho cuando se le dice", async () => {
    reply = { healthy: true, category: "none", incomplete: null, note: null, why: { summary: "sano" } };
    const j = await fetchRunWhy(96, { full: true, refresh: true });
    expect(fetches[0]).toEqual({ url: "https://gs.test/api/v2/factory/why", body: { runId: 96, full: true, refresh: true } });
    expect(j?.why?.summary).toBe("sano");
    await fetchRunWhy(96);
    expect(fetches[1].body).toEqual({ runId: 96 });
  });
});

describe("variables nuevas: las previews vivas se reconstruyen (#106)", () => {
  it("con envChanged entran lista y construyéndose de pedidos abiertos, y se avisa en el hilo", async () => {
    expect(await retryPreviews({ repo: "o/r", envChanged: true })).toBe(1);
    const sql = sqls.find((q) => q.sql.startsWith("UPDATE gt_factory_runs SET preview_state = 'pending'"))!.sql;
    expect(sql).toContain("'ready','pending'");
    expect(sql).toContain("status NOT IN ('done','cancelled')");
    expect(sql).toContain("preview_sha = NULL");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.some((p) => p.includes("🔁") && p.includes("variables nuevas"))).toBe(true);
  });
  it("«Reintentar» sigue tocando sólo las fallidas, sin aviso", async () => {
    await retryPreviews({ runId: 106 });
    const sql = sqls.find((q) => q.sql.startsWith("UPDATE gt_factory_runs SET preview_state = 'pending'"))!.sql;
    expect(sql).not.toContain("'ready'");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(0);
  });
});
