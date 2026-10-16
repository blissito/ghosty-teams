import { describe, it, expect, vi, beforeEach } from "vitest";

// «Mézclalo» con una base vieja: el CI verde del PR no dice nada del main de hoy (palmera-legal
// #9 entró sobre el #7 y main tronó, 3-oct). Se pone al día y no se mezcla.
const calls: { path: string; method: string }[] = [];
let behindBy: number | null = 0;
let merged = 0;
let checks: { state: string; failed?: string[] } | { error: string } = { state: "success" };

// La fila de la preview del pedido (lo que lee `runPreview`) y la bitácora (`smoke_fail`).
let previewRow: Record<string, unknown> | null = null;
let smokeFail: { sha: string; fails: string } | null = null;
const events: string[] = [];
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.includes("INSERT INTO gt_factory_events")) events.push(String(args[2]));
    if (sql.includes("preview_state") && sql.startsWith("SELECT") && previewRow) return [previewRow];
    if (sql.includes("gt_factory_events") && args[1] === "smoke_fail" && smokeFail) return [{ data_json: JSON.stringify(smokeFail) }];
    return [];
  },
}));
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
  allTools: () => [
    { name: "github_merge_pr", handler: async () => (merged++, { merged: true }) },
    { name: "github_pr_checks", handler: async () => checks },
  ],
}));

import { mergeRun, type Run } from "./factory-runs.server";

const run: Run = {
  id: 9, channelId: 3, rootMsgId: 99, topic: "general", title: "FR/PT", status: "pr_review", planVersion: 1, loops: 0,
  repo: null, branch: null, prUrl: "https://github.com/o/r/pull/9", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
} as Run;

beforeEach(() => {
  calls.length = 0;
  merged = 0;
  checks = { state: "success" };
  previewRow = null;
  smokeFail = null;
  events.length = 0;
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

// El chip de la tarjeta era la única señal del CI y «Merge» entraba igual (MailMask #8, 4-oct).
describe("mergeRun: guarda de CI", () => {
  beforeEach(() => {
    behindBy = 0;
  });
  it("CI en rojo: no mezcla y dice qué falló", async () => {
    checks = { state: "failure", failed: ["verify"] };
    const r = await mergeRun(run, "beto");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("verify");
    expect(merged).toBe(0);
  });
  it("CI corriendo: espera", async () => {
    checks = { state: "pending" };
    expect((await mergeRun(run, "beto")).ok).toBe(false);
    expect(merged).toBe(0);
  });
  it("repo sin CI o CI verde: mezcla", async () => {
    checks = { state: "none" };
    expect((await mergeRun(run, "beto")).ok).toBe(true);
    checks = { state: "success" };
    expect((await mergeRun(run, "beto")).ok).toBe(true);
    expect(merged).toBe(2);
  });
  it("si GitHub no contesta los checks, mezcla como antes", async () => {
    checks = { error: "GitHub no contestó" };
    expect((await mergeRun(run, "beto")).ok).toBe(true);
    expect(merged).toBe(1);
  });
});

// El #96 (16-oct): major de Dependabot mezclado con la preview en `needs_env`; la reserva de
// Deník quedó 18 h rota. Como un required deployment de GitHub: lo que falta bloquea.
describe("mergeRun: guarda de preview", () => {
  const major = { ...run, taskRef: "dependabot:major" } as Run;
  const row = (state: string, sha: string | null = "abc") => ({ status: "pr_review", preview_state: state, preview_url: "https://p", preview_error: null, preview_sha: sha, pr_url: null });
  beforeEach(() => {
    behindBy = 0;
  });
  it("preview exigida en needs_env: no mezcla y ofrece la salida", async () => {
    previewRow = row("needs_env", null);
    const r = await mergeRun(major, "beto");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Mezclar sin preview");
    expect(!r.ok && r.queue).toBeFalsy();
    expect(merged).toBe(0);
  });
  it("construyéndose: queda en cola", async () => {
    previewRow = row("pending", null);
    const r = await mergeRun(major, "beto");
    expect(!r.ok && r.queue).toBe(true);
    expect(merged).toBe(0);
  });
  it("lista en la cabeza: mezcla", async () => {
    previewRow = row("ready", "abc");
    expect((await mergeRun(major, "beto")).ok).toBe(true);
  });
  it("«Mezclar sin preview»: mezcla y queda en la bitácora", async () => {
    previewRow = row("needs_env", null);
    expect((await mergeRun(major, "beto", { skipPreview: true })).ok).toBe(true);
    expect(events).toContain("merge_without_preview");
  });
  it("un patch sin plan que la pida no la exige", async () => {
    previewRow = row("needs_env", null);
    expect((await mergeRun({ ...run, taskRef: "dependabot:patch" } as Run, "beto")).ok).toBe(true);
  });
  it("la preview de esta cabeza rechazó el POST del smoke: no mezcla", async () => {
    smokeFail = { sha: "abc", fails: "POST /_root.data → 400: la app rechazó el envío" };
    const r = await mergeRun(run, "beto");
    expect(!r.ok && r.error).toContain("rechaza envíos");
    smokeFail = { sha: "viejo", fails: "x" };
    expect((await mergeRun(run, "beto")).ok).toBe(true);
  });
});
