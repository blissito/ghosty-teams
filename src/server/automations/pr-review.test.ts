import { describe, expect, it } from "vitest";
import type { AutomationCtx, AutomationKind, RepoEvent } from "./types";
import {
  autofixSkip, handlePrReview, handleReviewAutofix, isFork, mentionsGhosty, normalizeSeverity,
  prReviewPrompt, prReviewSkip, reviewKey, MAX_ATTEMPTS,
} from "./pr-review.server";

function fakeCtx(settings: Record<string, unknown> = {}, budget = true) {
  const claimed = new Set<string>();
  const wakes: { handle: string; text: string; threadKey: string; title?: string }[] = [];
  const posts: string[] = [];
  const ctx: AutomationCtx = {
    ns: "acme", roomId: "1", repo: "acme/app",
    wake: async (o) => { wakes.push(o); },
    post: async (t: string) => { posts.push(t); },
    claim: async (kind: AutomationKind, key: string) => {
      const k = `${kind}|${key}`;
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    budget: async () => budget,
    settings: async <T,>() => settings as T,
  };
  return { ctx, wakes, claimed, posts };
}
const notFactory = { isFactoryPr: async () => false, ack: async () => true };

const opened = (over: Partial<RepoEvent> = {}, pr: Partial<NonNullable<RepoEvent["pr"]>> = {}): RepoEvent => ({
  deliveryId: "d1", event: "pull_request", action: "opened", repo: "acme/app",
  sender: { login: "ana", type: "User" },
  pr: { number: 7, title: "Arregla login", author: "ana", authorType: "User", draft: false, head: "fix-login", headSha: "abc", url: "https://github.com/acme/app/pull/7", ...pr },
  ...over,
});

describe("pr_review: filtros", () => {
  it("actúa en opened y ready_for_review de una persona", () => {
    expect(prReviewSkip(opened(), {})).toBeNull();
    expect(prReviewSkip(opened({ action: "ready_for_review" }), {})).toBeNull();
  });
  it("synchronize sólo con reReviewOnPush", () => {
    expect(prReviewSkip(opened({ action: "synchronize" }), {})).toBe("acción sin interés");
    expect(prReviewSkip(opened({ action: "synchronize" }), { reReviewOnPush: true })).toBeNull();
  });
  it("ignora borradores, bots y los causados por bots", () => {
    expect(prReviewSkip(opened({}, { draft: true }), {})).toBe("borrador");
    expect(prReviewSkip(opened({}, { author: "dependabot[bot]", authorType: "Bot" }), {})).toBe("PR de un bot");
    expect(prReviewSkip(opened({}, { author: "renovate[bot]" }), {})).toBe("PR de un bot");
    expect(prReviewSkip(opened({ sender: { login: "ghosty-studio[bot]", type: "Bot" } }), {})).toBe("lo causó un bot");
  });
  it("severidad mínima: P1 por default", () => {
    expect(normalizeSeverity(undefined)).toBe("P1");
    expect(normalizeSeverity("P0")).toBe("P0");
    expect(normalizeSeverity("raro")).toBe("P1");
    expect(prReviewPrompt(opened(), "P0")).toContain("sólo P0 (");
    expect(prReviewPrompt(opened(), "P1")).toContain("Sin hallazgos graves");
    expect(prReviewPrompt(opened(), "P1")).toContain("«## @check»");
    expect(prReviewPrompt(opened(), "P1")).toContain("No uses factory_check_verdict");
    expect(prReviewPrompt(opened(), "P1")).toContain("nunca APPROVE");
  });
});

describe("pr_review: claim y wake", () => {
  it("clave <repo>#<pr>:<headSha> en minúsculas", () => {
    expect(reviewKey("Acme/App", 7, "abc")).toBe("acme/app#7:abc");
  });
  it("despierta a @check una vez por sha; una reentrega no repite", async () => {
    const { ctx, wakes } = fakeCtx();
    await handlePrReview(opened(), ctx, notFactory);
    await handlePrReview(opened({ deliveryId: "d2" }), ctx, notFactory);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ handle: "check", threadKey: "pr_review:acme/app#7" });
  });
  it("máximo 3 reviews por PR aunque cambie el sha", async () => {
    const { ctx, wakes } = fakeCtx({ reReviewOnPush: true });
    for (const sha of ["a", "b", "c", "d", "e"]) await handlePrReview(opened({ action: "synchronize" }, { headSha: sha }), ctx, notFactory);
    expect(wakes).toHaveLength(MAX_ATTEMPTS);
  });
  it("no actúa en PRs de la fábrica ni sin presupuesto", async () => {
    const a = fakeCtx();
    await handlePrReview(opened(), a.ctx, { isFactoryPr: async () => true, ack: async () => true });
    expect(a.wakes).toHaveLength(0);
    const b = fakeCtx({}, false);
    await handlePrReview(opened(), b.ctx, notFactory);
    expect(b.wakes).toHaveLength(0);
  });
});

const comment = (body: string, over: Partial<RepoEvent> = {}, c: Partial<NonNullable<RepoEvent["comment"]>> = {}): RepoEvent => ({
  ...opened(),
  event: "pull_request_review_comment", action: "created", sender: { login: "beto", type: "User" },
  comment: { id: 55, body, path: "src/a.ts", line: 3, author: "beto", ...c },
  ...over,
});
const review = (state: string, body = "Cambia esto", author = "beto"): RepoEvent => ({
  ...opened(),
  event: "pull_request_review", action: "submitted", sender: { login: author, type: "User" },
  review: { id: 9, state, body, author },
});

describe("review_autofix: filtros", () => {
  it("actúa en un comentario de persona y en changes_requested", () => {
    expect(autofixSkip(comment("usa const"))).toBeNull();
    expect(autofixSkip(review("changes_requested"))).toBeNull();
    expect(autofixSkip(review("CHANGES_REQUESTED"))).toBeNull();
  });
  it("ignora approve/commented, bots y menciones @ghosty", () => {
    expect(autofixSkip(review("approved"))).toBe("no pide cambios");
    expect(autofixSkip(review("commented"))).toBe("no pide cambios");
    expect(autofixSkip(comment("x", { sender: { login: "ghosty-studio[bot]", type: "Bot" } }, { author: "ghosty-studio[bot]" }))).toBe("lo causó un bot");
    expect(autofixSkip(comment("x", {}, { author: "coderabbit[bot]" }))).toBe("comentario de un bot");
    expect(autofixSkip(comment("@ghosty arréglalo"))).toBe("mención @ghosty: la atiende el chat");
    expect(autofixSkip(comment("@Ghosty, porfa"))).toBe("mención @ghosty: la atiende el chat");
    expect(autofixSkip(review("changes_requested", "@ghosty mira"))).toBe("mención @ghosty: la atiende el chat");
  });
  it("forks y PRs de bots ajenos fuera; las ramas ghosty/ sí", () => {
    expect(autofixSkip(comment("x", { pr: { ...opened().pr!, fork: true, headRepo: "otra/app" } }))).toMatch(/fork/);
    expect(autofixSkip(comment("x", { pr: { ...opened().pr!, headRepo: "otra/app" } }))).toMatch(/fork/);
    expect(autofixSkip(comment("x", { pr: { ...opened().pr!, fork: false, headRepo: "acme/app" } }))).toBeNull();
    expect(autofixSkip(comment("x", { pr: { ...opened().pr!, author: "dependabot[bot]", authorType: "Bot", head: "dependabot/npm/x" } }))).toBe("PR de un bot ajeno");
    expect(autofixSkip(comment("x", { pr: { ...opened().pr!, author: "ghosty-studio[bot]", authorType: "Bot", head: "ghosty/ci_fix-7" } }))).toBeNull();
  });
  it("mentionsGhosty no confunde correos ni otros handles", () => {
    expect(mentionsGhosty("escribe a hola@ghosty.studio")).toBe(false);
    expect(mentionsGhosty("@ghostyx")).toBe(false);
    expect(isFork("acme/app", {})).toBe(false);
    expect(isFork("Acme/App", { headRepo: "acme/app" })).toBe(false);
  });
});

describe("review_autofix: claim y wake", () => {
  it("una review con varios comentarios = un solo turno de @build", async () => {
    const { ctx, wakes } = fakeCtx();
    await handleReviewAutofix(comment("a", {}, { id: 1 }), ctx, notFactory);
    await handleReviewAutofix(comment("b", {}, { id: 2 }), ctx, notFactory);
    await handleReviewAutofix(review("changes_requested"), ctx, notFactory);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].handle).toBe("build");
    expect(wakes[0].threadKey).toBe("review_autofix:acme/app#7");
    expect(wakes[0].text).toContain("github_resolve_review_thread");
    expect(wakes[0].text).toContain("SÓLO si lo arreglaste");
    expect(wakes[0].text).toContain("No uses factory_build_done");
  });
  it("no actúa en PRs de la fábrica", async () => {
    const { ctx, wakes } = fakeCtx();
    await handleReviewAutofix(comment("a"), ctx, { isFactoryPr: async () => true, ack: async () => true });
    expect(wakes).toHaveLength(0);
  });
});

describe("texto compartido con la fábrica", () => {
  it("la revisión suelta de la tarjeta sigue igual; la automatización sólo comenta", async () => {
    const { loosePrReviewBrief } = await import("../apps/factory-roles");
    expect(loosePrReviewBrief()).toContain("github_create_review (APPROVE o REQUEST_CHANGES, hallazgos con archivo:línea)");
    expect(loosePrReviewBrief({ commentOnly: true })).toContain("evento COMMENT");
  });
  it("review_autofix pone 👀 en el comentario como la fábrica", async () => {
    const { ctx } = fakeCtx();
    const acks: string[] = [];
    await handleReviewAutofix(comment("a", {}, { url: "https://github.com/acme/app/pull/7#discussion_r5" }), ctx, { isFactoryPr: async () => false, ack: async (_r, u) => acks.push(u) });
    expect(acks).toEqual(["https://github.com/acme/app/pull/7#discussion_r5"]);
  });
});
