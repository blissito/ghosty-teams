import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkRunWrite, loosePrCheck, previewCheckFrom, type PreviewCheckInput } from "./factory-preview-check";
import { aggregateChecks } from "../connectors/github-checks";

const base: PreviewCheckInput = {
  required: true,
  repoOff: false,
  preview: { state: "ready", sha: "abc", url: "https://pr-7.preview.test" },
  headSha: "abc",
  smokeFail: null,
  skippedBy: null,
  runId: 96,
  threadUrl: "https://denik.teams.ghosty.studio/c/fabrica?thread=1&run=96",
  envUrl: "https://denik.teams.ghosty.studio/factory?repo=denik%2Fagenda",
};

describe("check «Ghosty · Preview»", () => {
  it("preview lista en la cabeza y smoke limpio → success", () => {
    const c = previewCheckFrom(base);
    expect(c).toMatchObject({ status: "completed", conclusion: "success", title: "Preview lista" });
    expect(c.summary).toContain("https://pr-7.preview.test");
  });

  it("construyéndose, sin preview aún o lista de un commit viejo → in_progress", () => {
    expect(previewCheckFrom({ ...base, preview: { state: "pending", sha: null } }).status).toBe("in_progress");
    expect(previewCheckFrom({ ...base, preview: { state: "none", sha: null } }).status).toBe("in_progress");
    const old = previewCheckFrom({ ...base, preview: { state: "ready", sha: "viejo" } });
    expect(old).toMatchObject({ status: "in_progress", conclusion: null });
  });

  it("el #96: faltan variables → failure con la liga para guardarlas", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "needs_env", sha: null } });
    expect(c).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(c.summary).toContain("/factory?repo=denik%2Fagenda");
  });

  it("preview que no arrancó → failure con el motivo", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "failed", sha: null, error: "npm ci falló" } });
    expect(c.conclusion).toBe("failure");
    expect(c.summary).toContain("npm ci falló");
  });

  it("el smoke rechazó el POST en esta cabeza → failure aunque la preview esté lista", () => {
    const c = previewCheckFrom({ ...base, smokeFail: "POST / → 400 (CSRF)" });
    expect(c).toMatchObject({ conclusion: "failure", title: "La preview rechaza envíos" });
    expect(c.summary).toContain("400 (CSRF)");
  });

  it("no exigida → neutral (GitHub la cuenta como pasada); repo apagado lo dice", () => {
    expect(previewCheckFrom({ ...base, required: false, preview: { state: "none", sha: null } })).toMatchObject({
      conclusion: "neutral",
      title: "Este pedido no exige preview",
    });
    expect(previewCheckFrom({ ...base, required: false, repoOff: true, preview: { state: "off", sha: null } }).title).toBe("Preview apagada en este repo");
  });

  it("«Mezclar sin preview» → neutral con quién la omitió, gane lo que gane", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "needs_env", sha: null }, skippedBy: "Brenda" });
    expect(c).toMatchObject({ status: "completed", conclusion: "neutral", title: "Preview omitida por Brenda" });
  });

  it("PR suelto → neutral", () => {
    expect(loosePrCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("no cuenta como CI: un «Ghosty · Preview» construyéndose no deja el CI en pendiente", () => {
    const s = aggregateChecks(
      { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "Ghosty · Preview", status: "in_progress" }] },
      null,
    );
    expect(s).toMatchObject({ state: "success", total: 1 });
  });
});

describe("idempotencia por (repo, sha)", () => {
  it("decide crear, editar o nada", () => {
    expect(checkRunWrite(null, { status: "in_progress", sig: "a" })).toBe("post");
    expect(checkRunWrite({ id: 1, completed: false, sig: "a" }, { status: "in_progress", sig: "a" })).toBe("skip");
    expect(checkRunWrite({ id: 1, completed: false, sig: "a" }, { status: "completed", sig: "b" })).toBe("patch");
    // De terminado a construyéndose (p. ej. «Reintentar»): uno nuevo, GitHub enseña el último.
    expect(checkRunWrite({ id: 1, completed: true, sig: "b" }, { status: "in_progress", sig: "c" })).toBe("post");
    // Encontrado por nombre (sin contenido conocido): se edita, no se duplica.
    expect(checkRunWrite({ id: 1, completed: true, sig: null }, { status: "completed", sig: "b" })).toBe("patch");
  });
});

vi.mock("../connectors/github-app.server", () => ({
  appJwtOrNull: () => "jwt",
  botIdentityEnabled: () => true,
  coAuthorTrailer: () => "",
  agentTrailer: () => "",
  pushDenialReason: async () => null,
  installationToken: async () => "inst-token",
}));
vi.mock("../connectors/oauth.server", () => ({ getValidToken: async () => "user-token" }));
vi.mock("../connectors/store.server", () => ({ getConnectorRow: async () => null }));
vi.mock("../../db.server", () => ({ listRoomRepos: async () => [] }));

describe("upsertCheckRun", () => {
  const calls: { method: string; url: string; body: any }[] = [];
  let existing: any[] = [];
  beforeEach(() => {
    calls.length = 0;
    existing = [];
    process.env.GITHUB_APP_ID = "4242";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/installation")) return json({ id: 7 });
      if (method === "GET" && url.includes("/check-runs?")) return json({ check_runs: existing });
      return json({ id: 555 });
    });
  });

  it("crea una vez, no repite el mismo contenido y edita el mismo check al cambiar", async () => {
    const G = await import("../connectors/github.server");
    const c = { name: "Ghosty · Preview", status: "in_progress" as const, conclusion: null, title: "t", summary: "s" };
    expect(await G.upsertCheckRun("acme/app", "sha1", c)).toMatchObject({ action: "post" });
    expect(await G.upsertCheckRun("acme/app", "sha1", c)).toMatchObject({ action: "skip" });
    expect(await G.upsertCheckRun("acme/app", "sha1", { ...c, status: "completed", conclusion: "success" })).toMatchObject({ action: "patch" });
    const writes = calls.filter((x) => x.method !== "GET");
    expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
    expect(writes[0].body).toMatchObject({ head_sha: "sha1", name: "Ghosty · Preview", status: "in_progress" });
    expect(writes[1].url).toContain("/check-runs/555");
    expect(writes[1].body).toMatchObject({ conclusion: "success" });
  });

  it("sin memoria, encuentra el de NUESTRA App por nombre y lo edita en vez de duplicar", async () => {
    existing = [{ id: 31, status: "completed", app: { id: 999 } }, { id: 77, status: "in_progress", app: { id: 4242 } }];
    const G = await import("../connectors/github.server");
    await G.upsertCheckRun("acme/app", "sha2", { name: "Ghosty · Preview", status: "completed", conclusion: "neutral", title: "t", summary: "s" });
    const w = calls.filter((x) => x.method !== "GET");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: "PATCH" });
    expect(w[0].url).toContain("/check-runs/77");
  });
});
