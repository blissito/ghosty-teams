// Hilos de review por GraphQL: listar con su node id y resolverlos como la App.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({ getConnectorRow: async () => null }));
vi.mock("./oauth.server", () => ({ getValidToken: async () => "tok" }));
vi.mock("../../db.server", () => ({ listRoomRepos: async () => [] }));
vi.mock("./github-app.server", async (orig) => ({ ...(await orig<object>()), botIdentityEnabled: () => false }));

const { allTools, RESOLVE_THREAD_MUTATION, REVIEW_THREADS_QUERY } = await import("./github.server");
const tool = (n: string) => allTools().find((t) => t.name === n)!;

let bodies: any[] = [];
function fakeGraphql(data: unknown, errors?: unknown[]) {
  bodies = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.github.com/graphql");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data, errors }), { status: 200, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("hilos de review", () => {
  it("resolve manda resolveReviewThread con el node id del hilo", async () => {
    fakeGraphql({ resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } });
    const r: any = await tool("github_resolve_review_thread").handler("u", { repo: "acme/app", thread_id: " PRRT_1 " });
    expect(r).toEqual({ ok: true, resolved: true });
    expect(bodies[0]).toEqual({ query: RESOLVE_THREAD_MUTATION, variables: { id: "PRRT_1" } });
    expect(bodies[0].query).toContain("resolveReviewThread(input: { threadId: $id })");
  });

  it("resolve sin thread_id no llama a GitHub", async () => {
    fakeGraphql({});
    const r: any = await tool("github_resolve_review_thread").handler("u", { repo: "acme/app" });
    expect(r.error).toMatch(/thread_id/);
    expect(bodies).toHaveLength(0);
  });

  it("un error de GraphQL (200 con errors[]) no pasa por éxito", async () => {
    fakeGraphql(null, [{ message: "Resource not accessible by integration" }]);
    const r: any = await tool("github_resolve_review_thread").handler("u", { repo: "acme/app", thread_id: "PRRT_1" });
    expect(r.error).toMatch(/not accessible/);
  });

  it("lista los hilos con su threadId y filtra los resueltos", async () => {
    fakeGraphql({ repository: { pullRequest: { reviewThreads: { nodes: [
      { id: "PRRT_a", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, comments: { nodes: [{ databaseId: 11, author: { login: "beto" }, body: "usa const", createdAt: "t" }] } },
      { id: "PRRT_b", isResolved: true, isOutdated: false, path: "b.ts", line: 1, comments: { nodes: [] } },
    ] } } } });
    const all: any = await tool("github_pr_review_threads").handler("u", { repo: "acme/app", number: 7 });
    expect(all).toHaveLength(2);
    expect(bodies[0]).toEqual({ query: REVIEW_THREADS_QUERY, variables: { owner: "acme", name: "app", number: 7 } });
    const open: any = await tool("github_pr_review_threads").handler("u", { repo: "acme/app", number: 7, unresolved: true });
    expect(open).toEqual([{ threadId: "PRRT_a", resolved: false, outdated: false, path: "src/a.ts", line: 3, comments: [{ id: 11, author: "beto", body: "usa const", at: "t" }] }]);
  });
});
