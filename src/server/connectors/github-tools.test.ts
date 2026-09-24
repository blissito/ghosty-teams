// Las tools de GitHub que igualan al MCP oficial (github/github-mcp-server) y que usa la
// Software Factory: commit de varios archivos, editar PR, reintentar CI, Dependabot.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({ getConnectorRow: async () => null }));
vi.mock("./oauth.server", () => ({ getValidToken: async () => "tok" }));
vi.mock("../../db.server", () => ({ listRoomRepos: async () => [] }));
vi.mock("./github-app.server", async (orig) => ({ ...(await orig<object>()), botIdentityEnabled: () => false }));

const { allTools } = await import("./github.server");
const tool = (n: string) => allTools().find((t) => t.name === n)!;

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
function fakeGithub(routes: Record<string, { status?: number; json?: unknown }>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const r = key ? routes[key] : { status: 404, json: { message: "Not Found" } };
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.json ?? {}), { status, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("tools de GitHub para la fábrica", () => {
  it("push_files: un commit con escrituras y borrados (tree → commit → ref)", async () => {
    fakeGithub({
      "GET /repos/acme/app/git/ref/heads/feat": { json: { object: { sha: "p1" } } },
      "GET /repos/acme/app/git/commits/p1": { json: { tree: { sha: "t0" } } },
      "GET /repos/acme/app": { json: { default_branch: "main" } },
      "POST /repos/acme/app/git/trees": { json: { sha: "t1" } },
      "POST /repos/acme/app/git/commits": { json: { sha: "c1" } },
      "PATCH /repos/acme/app/git/refs/heads/feat": { json: {} },
    });
    const r: any = await tool("github_push_files").handler("u", {
      repo: "acme/app",
      branch: "feat",
      message: "limpia",
      files: [{ path: "a.txt", content: "hola" }, { path: "/b.jpeg", delete: true }],
    });
    expect(r).toMatchObject({ ok: true, commit: "c1", files: 2, deleted: 1 });
    const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!.body;
    expect(tree.base_tree).toBe("t0");
    expect(tree.tree).toEqual([
      { path: "a.txt", mode: "100644", type: "blob", content: "hola" },
      { path: "b.jpeg", mode: "100644", type: "blob", sha: null },
    ]);
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!.body.parents).toEqual(["p1"]);
  });

  it("push_files se niega en la rama principal", async () => {
    fakeGithub({ "GET /repos/acme/app": { json: { default_branch: "main" } } });
    const r: any = await tool("github_push_files").handler("u", { repo: "acme/app", branch: "main", message: "x", files: [{ path: "a", content: "b" }] });
    expect(r.error).toMatch(/rama principal/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("update_pr exige title o body", async () => {
    fakeGithub({});
    const r: any = await tool("github_update_pr").handler("u", { repo: "acme/app", number: 3 });
    expect(r.error).toMatch(/title o body/);
  });

  it("sin permiso de la App: rerun y Dependabot dicen QUÉ permiso falta", async () => {
    fakeGithub({
      "POST /repos/acme/app/actions/runs/9/rerun-failed-jobs": { status: 403, json: { message: "Resource not accessible by integration" } },
      "GET /repos/acme/app/dependabot/alerts": { status: 403, json: { message: "Resource not accessible by integration" } },
    });
    expect(((await tool("github_rerun_workflow").handler("u", { repo: "acme/app", run_id: 9 })) as any).error).toMatch(/Actions: write.*github\.com\/settings\/installations/);
    expect(((await tool("github_dependabot_alerts").handler("u", { repo: "acme/app" })) as any).error).toMatch(/Dependabot alerts: read/);
  });
});
