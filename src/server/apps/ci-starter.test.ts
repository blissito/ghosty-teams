import { describe, it, expect, vi, beforeEach } from "vitest";

let files: Record<string, boolean> = {};
let checkRuns: string[] = [];
let priv = false;
let canChecks = false;
let ruleset: any = null;
const posts: { path: string; body: any; method?: string }[] = [];

vi.mock("../connectors/github.server", () => ({
  appCanWriteChecks: async () => canChecks,
  forgetRequiredChecks: () => {},
  githubApi: async (_sub: string, path: string, init?: RequestInit) => {
    if (init?.method) {
      posts.push({ path, body: JSON.parse(String(init.body)), method: init.method });
      return { id: 9 };
    }
    if (path === "/repos/acme/app") return { default_branch: "main", owner: { login: "acme", type: "User" }, private: priv };
    const m = /^\/repos\/([^/]+\/[^/]+)\/commits\/(v\d+)$/.exec(path);
    if (m) return { sha: `${m[1].replace("/", "-")}-${m[2]}-sha` };
    if (path.startsWith("/repos/acme/app/contents/")) {
      const f = path.slice("/repos/acme/app/contents/".length);
      if (f === ".github/workflows") return files[f] ? [{ name: "ci.yml" }] : { error: "404" };
      return files[f] ? { name: f } : { error: "404" };
    }
    if (path.includes("/check-runs")) return { check_runs: checkRuns.map((name) => ({ name })) };
    if (path.endsWith("/rulesets")) return ruleset ? [{ id: 3, name: "Ghosty Factory" }] : [];
    if (path.endsWith("/rulesets/3")) return ruleset;
    return { error: "?" };
  },
}));

import { buildCiStarter, protectMain, hasWorkflows, deployWorkflowOf, uncoveredScripts, rulesetRequiresPreviewCheck, protectionState } from "./ci-starter.server";

describe("CI starter", () => {
  beforeEach(() => {
    files = {};
    checkRuns = [];
    posts.length = 0;
    priv = false;
  });

  it("un workflow que sólo despliega no cuenta como CI; uno que corre en PR sí (MailMask, 4-oct)", async () => {
    const listing = [{ name: "deploy.yml", path: ".github/workflows/deploy.yml" }];
    const yml = (on: string) => ({ content: Buffer.from(`name: X\non:\n  ${on}\njobs: {}\n`).toString("base64") });
    const api = (await import("../connectors/github.server")) as any;
    const orig = api.githubApi;
    const spy = vi.spyOn(api, "githubApi");
    spy.mockImplementation(async () => yml("push:\n    branches: [main]"));
    expect(await hasWorkflows("u", "acme/app", listing)).toBe(false);
    spy.mockImplementation(async () => yml("pull_request:"));
    expect(await hasWorkflows("u", "acme/app", listing)).toBe(true);
    expect(await hasWorkflows("u", "acme/app", { error: "404" })).toBe(false);
    spy.mockImplementation(orig);
  });

  it("CI que sólo prueba no cubre tipos ni build (#17, 7-oct)", () => {
    const scripts = { typecheck: "tsc --noEmit", test: "vitest run", build: "vite build", "build:css": "x", dev: "vite" };
    const onlyTest = "on: pull_request\njobs:\n  t:\n    steps:\n      - run: npm ci\n      - run: npm test\n      - run: npm run build:css\n";
    expect(uncoveredScripts([onlyTest], scripts)).toEqual(["typecheck", "build"]);
    const full = onlyTest + "      - run: npx tsc --noEmit\n      - run: pnpm run --if-present build\n";
    expect(uncoveredScripts([full], scripts)).toEqual([]);
    expect(uncoveredScripts([onlyTest], {})).toEqual([]);
  });

  it("dependency-review sólo en repo público (en privado sin GHAS falla siempre)", async () => {
    const pub = (await buildCiStarter("u", "acme/app")) as any;
    expect(pub.files[0].content).toContain("dependency-review-action@");
    priv = true;
    const pr = (await buildCiStarter("u", "acme/app")) as any;
    expect(pr.files[0].content).not.toContain("dependency-review-action");
    expect(pr.files[0].content).toContain("gitleaks-action@");
    expect(pr.notes.join(" ")).toContain("Advanced Security");
  });

  it("npm por default, actions fijadas por SHA con su tag, y runner de GitHub sin caja", async () => {
    const r = (await buildCiStarter("u", "acme/app")) as any;
    const yml = r.files[0].content as string;
    expect(yml).toContain("run: npm ci");
    expect(yml).toContain("actions/checkout@actions-checkout-v4-sha # v4");
    expect(yml).toContain("runs-on: ubuntu-latest");
    expect(yml).toContain("permissions:\n  contents: read");
    expect(r.files[1].content).toContain("/.github/ @acme");
  });

  it("pnpm por lockfile y la caja de CI del espacio en un repo privado", async () => {
    files["pnpm-lock.yaml"] = true;
    priv = true;
    const r = (await buildCiStarter("u", "acme/app", "ws-business")) as any;
    priv = false;
    const yml = r.files[0].content as string;
    expect(yml).toContain("pnpm install --frozen-lockfile");
    expect(yml).toContain("pnpm/action-setup@");
    expect(yml).toContain("runs-on: [self-hosted, ws-business]");
    // gitleaks siempre en GitHub: en la caja truena por la ruta de /home/runner.
    expect(yml).toMatch(/security:\n.*\n.*\n    runs-on: ubuntu-latest/);
  });

  it("repo público: el CI se queda en GitHub aunque el espacio tenga caja", async () => {
    const r = (await buildCiStarter("u", "acme/app", "ws-business")) as any;
    expect(r.files[0].content).not.toContain("self-hosted");
    expect(r.notes.join(" ")).toContain("Repo público");
  });

  it("proteger main exige SÓLO los checks que ya corren (nunca nombres supuestos)", async () => {
    checkRuns = ["verify", "security", "verify"];
    const r = await protectMain("u", "acme/app");
    expect(r).toMatchObject({ ok: true, checks: ["verify", "security"] });
    const rules = posts[0].body.rules.map((x: any) => x.type);
    expect(rules).toContain("pull_request");
    expect(rules).toContain("required_status_checks");
  });

  it("sin CI, la regla no exige checks (no bloquea todo PR)", async () => {
    await protectMain("u", "acme/app");
    expect(posts[0].body.rules.map((x: any) => x.type)).not.toContain("required_status_checks");
  });

  it("con la App capaz de escribir checks, exige «Ghosty · Preview» de NUESTRA App (16-oct)", async () => {
    canChecks = true;
    process.env.GITHUB_APP_ID = "4242";
    checkRuns = ["verify", "Ghosty · Preview"];
    try {
      const r = await protectMain("u", "acme/app");
      expect(r).toMatchObject({ ok: true, checks: ["verify", "Ghosty · Preview"] });
      const rule = posts.find((p) => p.path.endsWith("/rulesets"))!.body.rules.find((x: any) => x.type === "required_status_checks");
      expect(rule.parameters.required_status_checks).toEqual([{ context: "verify" }, { context: "Ghosty · Preview", integration_id: 4242 }]);
    } finally {
      canChecks = false;
      delete process.env.GITHUB_APP_ID;
    }
  });

  it("sin permiso de checks en la App, no se exige (nunca reportaría y bloquearía todo)", async () => {
    checkRuns = ["verify"];
    await protectMain("u", "acme/app");
    const rule = posts[0].body.rules.find((x: any) => x.type === "required_status_checks");
    expect(rule.parameters.required_status_checks).toEqual([{ context: "verify" }]);
  });

  it("un ruleset de antes (sin «Ghosty · Preview») cuenta como pendiente, sólo si la App puede publicarlo", async () => {
    ruleset = { rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify" }] } }] };
    try {
      expect(await protectionState("u", "acme/app")).toBe("protected");
      canChecks = true;
      expect(await protectionState("u", "acme/app")).toBe("unprotected");
      ruleset.rules[0].parameters.required_status_checks.push({ context: "Ghosty · Preview" });
      expect(await protectionState("u", "acme/app")).toBe("protected");
    } finally {
      canChecks = false;
      ruleset = null;
    }
  });

  it("detecta si un ruleset ya exige la preview", () => {
    expect(rulesetRequiresPreviewCheck({ rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Ghosty · Preview" }] } }] })).toBe(true);
    expect(rulesetRequiresPreviewCheck({ rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify" }] } }] })).toBe(false);
    expect(rulesetRequiresPreviewCheck(null)).toBe(false);
  });
});

describe("deployWorkflowOf", () => {
  const fly = "name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: flyctl deploy --remote-only\n";
  it("encuentra el deploy por push y ve si le falta environment", () => {
    expect(deployWorkflowOf([{ path: ".github/workflows/deploy.yml", text: fly }])).toEqual({ path: ".github/workflows/deploy.yml", hasEnv: false });
  });
  it("environment: production (corto o con name) cuenta", () => {
    const corto = fly.replace("    runs-on:", "    environment: production\n    runs-on:");
    const largo = fly.replace("    runs-on:", "    environment:\n      name: production\n    runs-on:");
    expect(deployWorkflowOf([{ path: "d.yml", text: corto }])?.hasEnv).toBe(true);
    expect(deployWorkflowOf([{ path: "d.yml", text: largo }])?.hasEnv).toBe(true);
  });
  it("el CI de los PR no es deploy; sin workflows de deploy, null", () => {
    const ci = "name: CI\non:\n  pull_request:\n  push:\njobs:\n  t:\n    steps:\n      - run: npm test\n";
    expect(deployWorkflowOf([{ path: "ci.yml", text: ci }])).toBeNull();
    expect(deployWorkflowOf([])).toBeNull();
  });
});

