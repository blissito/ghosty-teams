// Huecos medidos en 30 días de transcripciones (6,065 llamadas github_*): tools que el Worker
// buscaba y no existían, nombres inventados, y errores que no decían qué hacer.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.server", () => ({ getConnectorRow: async () => null }));
vi.mock("./oauth.server", () => ({ getValidToken: async () => "tok" }));
vi.mock("../../db.server", () => ({ listRoomRepos: async () => [] }));
vi.mock("./github-app.server", async (orig) => ({ ...(await orig<object>()), botIdentityEnabled: () => false }));

const G = await import("./github.server");
const tool = (n: string) => G.allTools().find((t) => t.name === n)!;

type Call = { url: string; method: string; accept: string | null };
let calls: Call[] = [];
function fakeGithub(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? null;
    calls.push({ url: path, method, accept });
    // La ruta más larga que calce gana: «GET /repos/a/b» no debe tapar «GET /repos/a/b/pulls/1».
    const bare = `${method} ${path.split("?")[0]}`;
    const key = Object.keys(routes).find((k) => k === bare);
    const r = key ? routes[key] : { status: 404, json: { message: "Not Found" } };
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, { status: r.status ?? 200 });
  });
}
afterEach(() => vi.unstubAllGlobals());

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-uno\n+dos\n",
  "diff --git a/README.md b/README.md\nindex 3..4 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hola\n+adiós\n",
].join("");

describe("github_pr_diff", () => {
  it("pide el diff unificado con Accept de diff y lo devuelve entero si cabe", async () => {
    fakeGithub({ "GET /repos/acme/app/pulls/7": { text: DIFF } });
    const r: any = await tool("github_pr_diff").handler("u", { repo: "acme/app", number: 7 });
    expect(calls[0]).toMatchObject({ url: "/repos/acme/app/pulls/7", accept: "application/vnd.github.diff" });
    expect(r).toMatchObject({ number: 7, truncated: false, files: ["src/a.ts", "README.md"] });
    expect(r.diff).toBe(DIFF);
  });

  it("recorta a maxChars y lo avisa; paths filtra por archivo", async () => {
    fakeGithub({ "GET /repos/acme/app/pulls/7": { text: DIFF } });
    const cut: any = await tool("github_pr_diff").handler("u", { repo: "acme/app", number: 7, maxChars: 1000 });
    expect(cut.truncated).toBe(false);
    const c = G.clipDiff(DIFF, 50);
    expect(c).toMatchObject({ truncated: true, totalChars: DIFF.length });
    expect(c.diff.length).toBe(50);
    const only: any = await tool("github_pr_diff").handler("u", { repo: "acme/app", number: 7, paths: ["README.md"] });
    expect(only.files).toEqual(["README.md"]);
    expect(only.diff).not.toContain("src/a.ts");
  });

  it("PR demasiado grande (406) manda a github_pr_files", async () => {
    fakeGithub({ "GET /repos/acme/app/pulls/7": { status: 406, text: "too large" } });
    const r: any = await tool("github_pr_diff").handler("u", { repo: "acme/app", number: 7 });
    expect(r.error).toMatch(/demasiado grande.*github_pr_files/);
  });
});

describe("jobs de Actions", () => {
  it("github_list_workflow_jobs: ids, estado y el paso que falló", async () => {
    fakeGithub({
      "GET /repos/acme/app/actions/runs/55/jobs": {
        json: {
          total_count: 1,
          jobs: [{ id: 901, name: "verify", status: "completed", conclusion: "failure", html_url: "u", steps: [
            { number: 1, name: "checkout", status: "completed", conclusion: "success" },
            { number: 2, name: "npm test", status: "completed", conclusion: "failure" },
          ] }],
        },
      },
    });
    const r: any = await tool("github_list_workflow_jobs").handler("u", { repo: "acme/app", run_id: 55 });
    expect(calls[0].url).toBe("/repos/acme/app/actions/runs/55/jobs?per_page=100&filter=latest");
    expect(r.jobs[0]).toMatchObject({ id: 901, name: "verify", conclusion: "failure", failedStep: "npm test" });
  });

  it("github_job_logs: la cola de N líneas sin marcas de tiempo", async () => {
    const log = Array.from({ length: 10 }, (_, i) => `2026-10-20T10:00:0${i}.123Z línea ${i}`).join("\n") + "\n";
    fakeGithub({ "GET /repos/acme/app/actions/jobs/901/logs": { text: log } });
    const r: any = await tool("github_job_logs").handler("u", { repo: "acme/app", job_id: 901, lines: 3 });
    expect(r).toMatchObject({ jobId: 901, totalLines: 10, truncated: true, lines: "línea 7\nlínea 8\nlínea 9" });
  });
});

describe("errores que dicen qué hacer", () => {
  it("update_branch con conflicto: lo dice claro, con base, rama y pasos", async () => {
    fakeGithub({
      "PUT /repos/acme/app/pulls/3/update-branch": { status: 422, json: { message: "merge conflict between base and head" } },
      "GET /repos/acme/app/pulls/3": { json: { base: { ref: "main" }, head: { ref: "feat/x" }, mergeable_state: "dirty" } },
    });
    const r: any = await tool("github_update_branch").handler("u", { repo: "acme/app", number: 3 });
    expect(r).toMatchObject({ conflict: true, base: "main", head: "feat/x" });
    expect(r.error).toMatch(/^Conflicto: feat\/x choca con main/);
    expect(r.error).toMatch(/git merge origin\/main/);
    expect(r.error).toMatch(/mergeFrom: "main"/);
  });

  it("get_pr expone mergeableState con su pista", async () => {
    fakeGithub({
      "GET /repos/acme/app/pulls/3": { json: { number: 3, state: "open", base: { ref: "main" }, head: { ref: "f", sha: "s" }, mergeable: false, mergeable_state: "dirty" } },
      "GET /repos/acme/app/issues/3/comments": { json: [] },
      "GET /repos/acme/app/pulls/3/reviews": { json: [] },
    });
    const r: any = await tool("github_get_pr").handler("u", { repo: "acme/app", number: 3 });
    expect(r.mergeableState).toBe("dirty");
    expect(r.mergeHint).toMatch(/CONFLICTOS con main/);
    expect(G.mergeabilityOf({ state: "open", mergeable_state: "clean" })).toEqual({ mergeableState: "clean" });
    expect(G.mergeabilityOf({ state: "open" }).mergeHint).toMatch(/calcula/);
  });

  it("pr_checks en pending: nota de que no es error", async () => {
    fakeGithub({
      "GET /repos/acme/app/pulls/3": { json: { head: { sha: "abc1234567" } } },
      "GET /repos/acme/app/commits/abc1234567/check-runs": { json: { check_runs: [{ name: "verify", status: "in_progress" }] } },
      "GET /repos/acme/app/commits/abc1234567/status": { json: { statuses: [] } },
    });
    const r: any = await tool("github_pr_checks").handler("u", { repo: "acme/app", number: 3 });
    expect(r.state).toBe("pending");
    expect(r.note).toMatch(/NO es un error/);
  });

  it("404 de un repo fuera de la instalación: la liga para agregarlo", async () => {
    fakeGithub({});
    const r: any = await tool("github_rerun_workflow").handler("u", { repo: "acme/app", run_id: 9 });
    expect(r.error).toMatch(/no encuentro acme\/app.*Repository access/);
    expect(r.installUrl).toMatch(/github\.com\/apps\/.+\/installations\/new/);
  });

  it("404 con el repo al alcance: el dato está mal, no la instalación", async () => {
    fakeGithub({ "GET /repos/acme/app": { json: { full_name: "acme/app" } } });
    const r: any = await tool("github_rerun_workflow").handler("u", { repo: "acme/app", run_id: 9 });
    expect(r.error).toMatch(/sí está al alcance.*\/actions\/runs\/9\/rerun-failed-jobs/);
    expect(r.installUrl).toBeUndefined();
  });

  it("rerun con 403 y sin App: falta el permiso Actions: write (con la liga)", async () => {
    fakeGithub({ "POST /repos/acme/app/actions/runs/9/rerun-failed-jobs": { status: 403, json: { message: "Resource not accessible by integration" } } });
    const r: any = await tool("github_rerun_workflow").handler("u", { repo: "acme/app", run_id: 9 });
    expect(r.error).toMatch(/Actions: write/);
  });
});

describe("nombres inventados", () => {
  it("los medidos contestan «¿quisiste decir…?» con la tool real", () => {
    expect(G.suggestGithubTool("github_job_log")).toMatch(/¿Quisiste decir github_job_logs\?/);
    expect(G.suggestGithubTool("github_put_file")).toMatch(/github_write_file/);
    expect(G.suggestGithubTool("github_commit_files")).toMatch(/github_push_files/);
    expect(G.suggestGithubTool("github_list_tools")).toMatch(/list\(\)/);
  });

  it("toda sugerencia del mapa apunta a una tool que existe", () => {
    const real = new Set(G.allTools().map((t) => t.name));
    for (const n of ["github_job_log", "github_pr_info", "github_list_dir", "github_diff", "github_workflow_jobs", "github_rerun"]) {
      const target = G.suggestGithubTool(n)!.match(/decir (github_[a-z_]+)/)![1];
      expect(real.has(target)).toBe(true);
    }
  });

  it("las reales no se tocan; un nombre nuevo cae al más parecido", () => {
    expect(G.suggestGithubTool("github_pr_diff")).toBeNull();
    expect(G.suggestGithubTool("github_list_workflow_jobs")).toBeNull();
    expect(G.suggestGithubTool("calendly_x")).toBeNull();
    expect(G.suggestGithubTool("github_pull_request_files")).toMatch(/github_pr_files/);
  });
});
