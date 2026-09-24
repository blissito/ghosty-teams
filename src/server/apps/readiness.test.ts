import { describe, it, expect, vi, beforeEach } from "vitest";

// Un repo simulado: archivos de la raíz, de .github/, contenidos y reglas.
let root: string[] = [];
let gh: string[] = [];
let workflows: string[] = [];
let contents: Record<string, string> = {};
let rulesets: { name: string }[] = [];
let branchProtected = false;
let calls = 0;

const b64 = (s: string) => Buffer.from(s).toString("base64");

vi.mock("../connectors/github.server", () => ({
  githubApi: async (_sub: string, path: string) => {
    calls++;
    if (path === "/repos/acme/app") return { default_branch: "main", owner: { login: "acme", type: "User" } };
    if (path === "/repos/acme/app/contents/") return root.map((name) => ({ name }));
    if (path === "/repos/acme/app/contents/.github") return gh.length ? gh.map((name) => ({ name })) : { error: "404" };
    if (path === "/repos/acme/app/contents/.github/workflows") return workflows.length ? workflows.map((name) => ({ name })) : { error: "404" };
    if (path === "/repos/acme/app/branches/main") return { protected: branchProtected };
    if (path.endsWith("/rulesets")) return rulesets;
    const f = path.replace("/repos/acme/app/contents/", "");
    if (contents[f] !== undefined) return { content: b64(contents[f]) };
    const m = /\/commits\/(v\d+)$/.exec(path);
    if (m) return { sha: `sha-${m[1]}` };
    return { error: "404" };
  },
}));

import {
  agentsMdSkeleton,
  codeownersCoversGithub,
  invalidateReadiness,
  levelOf,
  preparationFiles,
  preparationPlan,
  repoReadiness,
  type Readiness,
} from "./readiness.server";

function bare() {
  root = ["package.json", "src"];
  gh = [];
  workflows = [];
  contents = { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }) };
  rulesets = [];
  branchProtected = false;
}

function complete() {
  root = ["README.md", "package.json", "pnpm-lock.yaml", "AGENTS.md"];
  gh = ["workflows", "CODEOWNERS", "dependabot.yml"];
  workflows = ["ci.yml"];
  contents = {
    "package.json": JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }),
    ".github/CODEOWNERS": "/.github/ @acme\n",
  };
  rulesets = [{ name: "Ghosty Factory" }];
}

async function check(): Promise<Readiness> {
  invalidateReadiness("acme/app");
  const r = await repoReadiness("u", "acme/app");
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("Listo para agentes", () => {
  beforeEach(() => {
    bare();
    calls = 0;
  });

  it("el nivel exige TODOS los criterios del nivel y los de abajo", () => {
    expect(levelOf({})).toBe(0);
    expect(levelOf({ readme: true, lockfile: true, scripts: true })).toBe(1);
    // Nivel 3 completo pero sin el 2: se queda en 1.
    expect(levelOf({ readme: true, lockfile: true, scripts: true, codeowners: true, dependabot: true, protected: true })).toBe(1);
    expect(
      levelOf({ readme: true, lockfile: true, scripts: true, agents_md: true, ci: true, codeowners: true, dependabot: true, protected: true }),
    ).toBe(3);
  });

  it("CODEOWNERS cuenta sólo si cubre .github/ (o todo el repo)", () => {
    expect(codeownersCoversGithub("/.github/ @acme")).toBe(true);
    expect(codeownersCoversGithub("* @acme")).toBe(true);
    expect(codeownersCoversGithub(".github/** @acme")).toBe(true);
    expect(codeownersCoversGithub("/src/ @acme\n# /.github/ @acme")).toBe(false);
    expect(codeownersCoversGithub(null)).toBe(false);
  });

  it("repo pelón: nivel 0 y los scripts que faltan", async () => {
    const r = await check();
    expect(r.level).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.total).toBe(8);
    expect(r.facts.missingScripts).toEqual(["test", "typecheck"]);
    expect(r.facts.pm).toBeNull();
  });

  it("repo completo: nivel 3, 8/8", async () => {
    complete();
    const r = await check();
    expect(r.level).toBe(3);
    expect(r.passed).toBe(8);
    expect(r.facts.pm).toBe("pnpm");
  });

  it("protección clásica de rama también cuenta", async () => {
    complete();
    rulesets = [];
    branchProtected = true;
    expect((await check()).checks.find((c) => c.key === "protected")!.ok).toBe(true);
  });

  it("se cachea por repo y se invalida", async () => {
    await check();
    const before = calls;
    await repoReadiness("u", "acme/app");
    expect(calls).toBe(before);
    invalidateReadiness("acme/app");
    await repoReadiness("u", "acme/app");
    expect(calls).toBeGreaterThan(before);
  });

  it("el plan incluye SÓLO lo que falta y nunca inventa scripts", async () => {
    complete();
    root = root.filter((f) => f !== "AGENTS.md");
    gh = gh.filter((f) => f !== "dependabot.yml");
    const { planMd, fixes } = preparationPlan(await check());
    expect(fixes).toEqual(["agents_md", "dependabot"]);
    expect(planMd).toContain("AGENTS.md");
    expect(planMd).toContain("dependabot.yml");
    expect(planMd).not.toContain("ci.yml");
    expect(planMd).not.toContain("Fuera de este PR");
  });

  it("scripts, lockfile y protección van FUERA del PR", async () => {
    const { planMd, fixes } = preparationPlan(await check());
    expect(fixes).not.toContain("scripts");
    expect(fixes).not.toContain("protected");
    expect(planMd).toContain("## Fuera de este PR");
    expect(planMd).toContain("`test`, `typecheck`");
  });

  it("los archivos: CI + CODEOWNERS del starter, dependabot, AGENTS y README", async () => {
    const out = await preparationFiles("u", await check(), "ws-acme");
    if ("error" in out) throw new Error(out.error);
    expect(out.files.map((f) => f.path).sort()).toEqual(
      [".github/CODEOWNERS", ".github/dependabot.yml", ".github/workflows/ci.yml", "AGENTS.md", "README.md"].sort(),
    );
    expect(out.files.find((f) => f.path.endsWith("ci.yml"))!.content).toContain("[self-hosted, ws-acme]");
  });

  it("con CI ya puesto no se reescribe; sólo lo que falta", async () => {
    complete();
    gh = ["workflows", "CODEOWNERS"];
    const out = await preparationFiles("u", await check(), null);
    if ("error" in out) throw new Error(out.error);
    expect(out.files.map((f) => f.path)).toEqual([".github/dependabot.yml"]);
  });

  it("AGENTS.md lista sólo comandos que existen y remite a CLAUDE.md", () => {
    const md = agentsMdSkeleton({
      owner: "acme",
      defaultBranch: "main",
      pm: "pnpm",
      scripts: { test: "vitest", typecheck: "tsc" },
      hasClaudeMd: true,
      missingScripts: [],
    });
    expect(md).toContain("pnpm install --frozen-lockfile");
    expect(md).toContain("`pnpm typecheck`");
    expect(md).toContain("`pnpm test`");
    expect(md).not.toContain("lint");
    expect(md).not.toContain("build`");
    expect(md).toContain("CLAUDE.md");
  });
});
