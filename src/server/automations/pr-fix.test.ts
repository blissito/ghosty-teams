// Automatizaciones PR-FIX: filtros, claves y anti-bucle (sin GitHub ni base).
import { describe, expect, it } from "vitest";
import type { AppPrInfo } from "../connectors/github.server";
import {
  attemptKey, buildPrFixAutomations, headKey, isDepPr, isFork, isOwnBot, isRedRun, needsGreen,
  prNumberOf, prView, skipReason, threadKeyOf, type PrFixDeps,
} from "./pr-fix.server";
import type { AutomationCtx, AutomationKind, RepoEvent } from "./types";

const REPO = "acme/web";

const livePr = (o: Partial<AppPrInfo> = {}): AppPrInfo => ({
  state: "open", draft: false, author: "ana", authorType: "User", head: "feat/x", headSha: "abc1234def",
  headRepo: REPO, base: "main", mergeableState: "clean", url: `https://github.com/${REPO}/pull/7`, ...o,
});

const redRun = (o: Partial<RepoEvent> = {}): RepoEvent => ({
  deliveryId: "d1", event: "workflow_run", action: "completed", repo: REPO,
  sender: { login: "ana", type: "User" },
  run: { id: 99, name: "CI", conclusion: "failure", headSha: "abc1234def", headBranch: "feat/x", event: "pull_request", prNumbers: [7], url: "https://github.com/acme/web/actions/runs/99" },
  ...o,
});

function fakeCtx(settings: Record<string, unknown> = {}, budgetOk = true) {
  const claimed = new Set<string>();
  const wakes: { handle: string; text: string; threadKey: string; title?: string }[] = [];
  const ctx: AutomationCtx = {
    ns: "acme", roomId: "1", repo: REPO,
    wake: async (o) => { wakes.push(o); },
    claim: async (kind: AutomationKind, key: string) => {
      const k = `${kind}|${key}`;
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    budget: async () => budgetOk,
    settings: async <T,>() => settings as T,
  };
  return { ctx, wakes, claimed };
}

const deps = (pr: AppPrInfo | null, factory = false): PrFixDeps => ({
  fetchPr: async () => pr,
  isFactoryPr: async () => factory,
});

const byKind = (d: PrFixDeps, kind: AutomationKind) => buildPrFixAutomations(d).find((a) => a.kind === kind)!;

describe("lógica pura", () => {
  it("claves por cabeza, intento e hilo (repo en minúsculas)", () => {
    expect(headKey("Acme/Web", 7, "abc")).toBe("acme/web#7:abc");
    expect(attemptKey("Acme/Web", 7, 2)).toBe("acme/web#7:2");
    expect(threadKeyOf("Acme/Web", 7)).toBe("pr-fix:acme/web#7");
  });
  it("bots: propio y de dependencias", () => {
    expect(isOwnBot("ghosty-studio[bot]")).toBe(true);
    expect(isOwnBot("ana")).toBe(false);
    expect(isDepPr("dependabot[bot]", "x")).toBe(true);
    expect(isDepPr("Renovate[bot]", "x")).toBe(true);
    expect(isDepPr(null, "dependabot/npm_and_yarn/vite-6")).toBe(true);
    expect(isDepPr("ana", "feat/x")).toBe(false);
  });
  it("sólo workflow_run completed en failure/timed_out", () => {
    expect(isRedRun(redRun())).toBe(true);
    expect(isRedRun(redRun({ run: { id: 1, conclusion: "timed_out" } }))).toBe(true);
    expect(isRedRun(redRun({ run: { id: 1, conclusion: "success" } }))).toBe(false);
    expect(isRedRun(redRun({ run: { id: 1, conclusion: "cancelled" } }))).toBe(false);
    expect(isRedRun(redRun({ event: "check_suite" }))).toBe(false);
  });
  it("número del PR: bloque pr o el primero del run", () => {
    expect(prNumberOf(redRun())).toBe(7);
    expect(prNumberOf(redRun({ pr: { number: 3 } }))).toBe(3);
    expect(prNumberOf(redRun({ run: { id: 1, prNumbers: [] } }))).toBeNull();
  });
  it("mergeable_state", () => {
    expect(needsGreen("dirty")).toBe("dirty");
    expect(needsGreen("behind")).toBe("behind");
    expect(needsGreen("unknown")).toBeNull();
    expect(needsGreen("clean")).toBeNull();
  });
  it("borradores fuera salvo includeDrafts; cerrados fuera; fork por headRepo", () => {
    const pr = prView(redRun(), 7, livePr({ draft: true }));
    expect(skipReason(pr, {})).toBe("borrador");
    expect(skipReason(pr, { includeDrafts: true })).toBeNull();
    expect(skipReason(prView(redRun(), 7, livePr({ state: "closed" })), {})).toBe("pr cerrado");
    expect(isFork(prView(redRun(), 7, livePr({ headRepo: "otro/web" })), REPO)).toBe(true);
    expect(isFork(prView(redRun(), 7, livePr({ headRepo: null })), REPO)).toBe(false);
  });
});

describe("ci_fix", () => {
  it("despierta a @build una vez por cabeza, con log, rama y liga", async () => {
    const { ctx, wakes } = fakeCtx();
    const a = byKind(deps(livePr()), "ci_fix");
    await a.handle(redRun(), ctx);
    await a.handle(redRun({ deliveryId: "d2" }), ctx); // reenvío / otro workflow del mismo sha
    expect(wakes).toHaveLength(1);
    expect(wakes[0].handle).toBe("build");
    expect(wakes[0].threadKey).toBe("pr-fix:acme/web#7");
    expect(wakes[0].text).toContain("github_workflow_run_logs");
    expect(wakes[0].text).toContain("runId: 99");
    expect(wakes[0].text).toContain("`feat/x`");
    expect(wakes[0].text).toContain("intento 1 de 3");
  });
  it("máximo 3 intentos por PR aunque cambie la cabeza", async () => {
    const { ctx, wakes } = fakeCtx();
    for (const sha of ["s1", "s2", "s3", "s4"]) {
      const a = byKind(deps(livePr({ headSha: sha })), "ci_fix");
      await a.handle(redRun({ run: { id: 1, conclusion: "failure", headSha: sha, prNumbers: [7] }, sender: { login: "ghosty-studio[bot]", type: "Bot" } }), ctx);
    }
    expect(wakes.map((w) => /intento (\d)/.exec(w.text)?.[1])).toEqual(["1", "2", "3"]);
  });
  it("ignora: PR de la fábrica, dependabot, borrador, cabeza vieja, verde y sin presupuesto", async () => {
    const cases: [PrFixDeps, RepoEvent, boolean?][] = [
      [deps(livePr(), true), redRun()],
      [deps(livePr({ author: "dependabot[bot]" })), redRun()],
      [deps(livePr({ draft: true })), redRun()],
      [deps(livePr({ headSha: "nuevo" })), redRun()],
      [deps(livePr()), redRun({ run: { id: 1, conclusion: "success", prNumbers: [7] } })],
      [deps(livePr()), redRun(), false],
    ];
    for (const [d, ev, budget] of cases) {
      const { ctx, wakes } = fakeCtx({}, budget ?? true);
      await byKind(d, "ci_fix").handle(ev, ctx);
      expect(wakes).toHaveLength(0);
    }
  });
  it("fork: sólo diagnóstico, sin push", async () => {
    const { ctx, wakes } = fakeCtx();
    await byKind(deps(livePr({ headRepo: "extraño/web" })), "ci_fix").handle(redRun(), ctx);
    expect(wakes[0].text).toContain("fork");
    expect(wakes[0].text).not.toContain("github_push_files");
  });
  it("sin poder leer el PR sigue con lo del evento", async () => {
    const { ctx, wakes } = fakeCtx();
    await byKind(deps(null), "ci_fix").handle(redRun(), ctx);
    expect(wakes).toHaveLength(1);
  });
});

describe("dep_fix", () => {
  it("sólo PR de dependabot/renovate, y pide adaptar sin bajar versión", async () => {
    const { ctx, wakes } = fakeCtx();
    await byKind(deps(livePr()), "dep_fix").handle(redRun(), ctx);
    expect(wakes).toHaveLength(0);
    await byKind(deps(livePr({ author: "renovate[bot]", head: "renovate/vite-6.x" })), "dep_fix").handle(redRun(), ctx);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("changelog");
    expect(wakes[0].text).toContain("Nunca bajes la versión");
  });
});

describe("pr_to_green", () => {
  const prEv = (o: Partial<RepoEvent> = {}): RepoEvent => ({
    deliveryId: "p1", event: "pull_request", action: "synchronize", repo: REPO,
    sender: { login: "ana" }, pr: { number: 7 }, ...o,
  });
  it("dirty → update_branch primero y merge con mergeFrom; nunca mergea", async () => {
    const { ctx, wakes } = fakeCtx();
    await byKind(deps(livePr({ mergeableState: "dirty" })), "pr_to_green").handle(prEv(), ctx);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("github_update_branch");
    expect(wakes[0].text).toContain('mergeFrom: "main"');
    expect(wakes[0].text).toContain("Nunca mergees");
  });
  it("behind también; clean/unknown no", async () => {
    for (const [state, n] of [["behind", 1], ["clean", 0], ["unknown", 0]] as const) {
      const { ctx, wakes } = fakeCtx();
      await byKind(deps(livePr({ mergeableState: state })), "pr_to_green").handle(prEv(), ctx);
      expect(wakes).toHaveLength(n);
    }
  });
  it("anti-bucle: ignora al propio bot y a la fábrica", async () => {
    const { ctx, wakes } = fakeCtx();
    await byKind(deps(livePr({ mergeableState: "dirty" })), "pr_to_green").handle(prEv({ sender: { login: "ghosty-studio[bot]", type: "Bot" } }), ctx);
    await byKind(deps(livePr({ mergeableState: "dirty" }), true), "pr_to_green").handle(prEv(), ctx);
    expect(wakes).toHaveLength(0);
  });
});
