import { describe, it, expect, vi, beforeEach } from "vitest";

// Lo que regresa solo a @build sin que nadie pique nada: el CI en rojo del PR (`onPrCiRed`) y lo
// que piden en GitHub con @ghosty (`noteFromGithub`). MailMask #8, 4-oct.
const sqls: { sql: string; args: unknown[] }[] = [];
const posts: string[] = [];
const wakeups: { key: string; text: string }[] = [];
let ciRedPrev: { sha: string | null }[] = [];
let origin = "https://business.teams.ghosty.studio";
let notes: { id: number; by: string; text: string }[] = [];

const row = (status: string) => ({ id: 10, channel_id: 14, root_msg_id: 3970, topic: "general", title: "CLI", status, plan_version: 1, loops: 0, requested_by: "ana", approved_by: "beto", pr_url: "https://github.com/o/r/pull/8" });

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.includes("type = 'ci_red' ORDER BY")) return ciRedPrev.map((p) => ({ data_json: JSON.stringify(p) }));
    if (sql.includes("FROM gt_agent_wakeups")) return origin ? [{ origin }] : [];
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) return [row(String(args[0]))];
    if (sql.startsWith("INSERT INTO gt_factory_notes")) {
      notes.push({ id: notes.length + 1, text: String(args[1]), by: String(args[2]) });
      return [{ id: notes.length }];
    }
    // `takeNotes`: las pendientes viajan en el encargo.
    if (sql.startsWith("UPDATE gt_factory_notes")) return notes.splice(0);
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 14, slug: "mailmask" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "build", name: "Build", avatar: "", backend: { kind: "other" } }, { handle: "plan", name: "Plan", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string; text: string }) => (wakeups.push(w), true),
  mintWakeRef: () => "ref",
  kickWakeups: () => {},
}));
vi.mock("../connectors/github.server", () => ({ ackGithubComment: async () => true }));

import { onPrCiRed, noteFromGithub, type Run } from "./factory-runs.server";

const run = (status: Run["status"]): Run => ({
  id: 10, channelId: 14, rootMsgId: 3970, topic: "general", title: "CLI", status, planVersion: 1, loops: 0,
  repo: "o/r", branch: null, prUrl: "https://github.com/o/r/pull/8", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const events = () => sqls.filter((s) => s.sql.startsWith("INSERT INTO gt_factory_events")).map((s) => s.args[2]);

beforeEach(() => {
  sqls.length = 0;
  posts.length = 0;
  wakeups.length = 0;
  ciRedPrev = [];
  notes = [];
  origin = "https://business.teams.ghosty.studio";
});

describe("CI en rojo en la etapa PR", () => {
  it("primera vez con esa cabeza: se lo regresa a @build con qué falló", async () => {
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    await flush();
    expect(events()).toEqual(expect.arrayContaining(["ci_red", "note", "rework"]));
    expect(posts.some((p) => p.includes("🔧") && p.includes("verify"))).toBe(true);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].text).toContain("github_workflow_run_logs");
  });

  it("misma cabeza otra vez: no repite", async () => {
    ciRedPrev = [{ sha: "abc" }];
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    expect(events()).toEqual([]);
    expect(wakeups).toHaveLength(0);
  });

  it("tercera vuelta: lo ve una persona y no se reabre", async () => {
    ciRedPrev = [{ sha: "b" }, { sha: "a" }];
    await onPrCiRed(run("pr_review"), "c", ["verify"]);
    await flush();
    expect(events()).toEqual(["ci_red_help"]);
    expect(posts.some((p) => p.startsWith("⚠️"))).toBe(true);
    expect(wakeups).toHaveLength(0);
  });

  it("sin origen para el encargo: avisa en vez de quedarse callado", async () => {
    origin = "";
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    expect(events()).toEqual(["ci_red_help"]);
  });
});

describe("pedido desde GitHub (@ghosty)", () => {
  const ask = { text: "@ghosty quita el código prellenado", url: "https://github.com/o/r/pull/8#issuecomment-1" };

  it("PR listo: se reabre, se cuenta en el hilo con la liga y @build sabe dónde contestar", async () => {
    expect(await noteFromGithub(run("pr_review"), "bliss", ask)).toBe("reopened");
    await flush();
    expect(posts.some((p) => p.includes("💬 @bliss en GitHub") && p.includes(ask.url))).toBe(true);
    expect(wakeups[0].text).toContain("github_comment");
  });

  it("comentario en línea: @build contesta en ese hilo", async () => {
    await noteFromGithub(run("pr_review"), "bliss", { ...ask, path: "cli/a.ts", line: 3 });
    expect(wakeups[0].text).toContain("github_reply_review_comment");
    expect(wakeups[0].text).toContain("cli/a.ts:3");
  });

  it("en revisión: queda para su siguiente encargo, sin despertar a nadie", async () => {
    expect(await noteFromGithub(run("checking"), "bliss", ask)).toBe("queued");
    expect(wakeups).toHaveLength(0);
    expect(events()).toContain("note");
  });

  it("pedido terminado: no hace nada", async () => {
    expect(await noteFromGithub(run("done"), "bliss", ask)).toBe("closed");
    expect(sqls).toHaveLength(0);
  });
});
