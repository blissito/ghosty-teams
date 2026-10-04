import { describe, it, expect, vi, beforeEach } from "vitest";

// «Mézclalo» con una base vieja: el CI verde del PR no dice nada del main de hoy (palmera-legal
// #9 entró sobre el #7 y main tronó, 3-oct). Se pone al día y no se mezcla.
const calls: { path: string; method: string }[] = [];
let behindBy: number | null = 0;
let merged = 0;

vi.mock("../../dbq.server", () => ({ dbq: async () => [] }));
vi.mock("../../db.server", () => ({ getChannelById: async () => ({ id: 3, slug: "dev" }), filterMutedOut: async (s: string[]) => s }));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../connectors/github.server", () => ({
  githubApi: async (_sub: string, path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.includes("/compare/")) return behindBy == null ? { error: "GitHub no contestó" } : { behind_by: behindBy };
    if (path.endsWith("/update-branch")) return { message: "Updating pull request branch." };
    return { base: { ref: "main" }, head: { sha: "abc" } };
  },
  allTools: () => [{ name: "github_merge_pr", handler: async () => (merged++, { merged: true }) }],
}));

import { mergeRun, type Run } from "./factory-runs.server";

const run: Run = {
  id: 9, channelId: 3, rootMsgId: 99, topic: "general", title: "FR/PT", status: "pr_review", planVersion: 1, loops: 0,
  repo: null, branch: null, prUrl: "https://github.com/o/r/pull/9", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
} as Run;

beforeEach(() => {
  calls.length = 0;
  merged = 0;
});

describe("mergeRun: guarda de base", () => {
  it("atrás de main: pone al día la rama y NO mezcla", async () => {
    behindBy = 2;
    const r = await mergeRun(run, "beto");
    expect(r.ok).toBe(false);
    expect(merged).toBe(0);
    expect(calls.some((c) => c.path === "/repos/o/r/pulls/9/update-branch" && c.method === "PUT")).toBe(true);
  });
  it("al día con main: mezcla", async () => {
    behindBy = 0;
    expect((await mergeRun(run, "beto")).ok).toBe(true);
    expect(merged).toBe(1);
  });
  it("si GitHub no contesta el compare, mezcla como antes", async () => {
    behindBy = null;
    expect((await mergeRun(run, "beto")).ok).toBe(true);
    expect(merged).toBe(1);
  });
});
