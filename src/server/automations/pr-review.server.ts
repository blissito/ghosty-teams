// Automatizaciones de revisión de PRs (contrato de 25-oct-2026):
//  - pr_review: un PR de una PERSONA se abre o queda listo → @check lo revisa y deja UNA review
//    con comentarios en línea sólo de lo grave.
//  - review_autofix: una persona comenta en la review → @build corrige en la misma rama, contesta
//    el hilo y lo resuelve sólo si lo arregló.
// Lo de una mención @ghosty lo atiende el camino del chat (PrThread) y lo de un pedido de la
// fábrica lo vigila pr-watches: aquí no se responde dos veces.
import { GITHUB_REPLY_FORMAT, LOOSE_PR_BUILD_BRIEF, loosePrReviewBrief } from "../apps/factory-roles";
import type { Automation, AutomationCtx, RepoEvent } from "./types";

export type Severity = "P0" | "P1" | "P2";
export type PrReviewSettings = { minSeverity?: Severity; reReviewOnPush?: boolean };

/** Máximo de intentos por PR (regla dura del contrato). */
export const MAX_ATTEMPTS = 3;
/** Ventana en la que los comentarios de una misma review se juntan en un solo turno de @build. */
export const AUTOFIX_WINDOW_MS = 90_000;
const ATTEMPT_TTL_MS = 30 * 24 * 3600_000;
const AUTOFIX_ATTEMPT_TTL_MS = 24 * 3600_000;

const BOT_LOGIN = /\[bot\]$/i;
const GHOSTY_MENTION = /(^|[^\w-])@ghosty\b/i;

export function isBot(login?: string, type?: string): boolean {
  return type === "Bot" || (!!login && BOT_LOGIN.test(login));
}

export function mentionsGhosty(text?: string): boolean {
  return !!text && GHOSTY_MENTION.test(text);
}

/** `head` llega como rama o como label `owner:rama`; si el dueño no es el del repo, es un fork. */
export function isForkHead(repo: string, head?: string): boolean {
  if (!head || !head.includes(":")) return false;
  const owner = head.split(":")[0].toLowerCase();
  return owner !== repo.split("/")[0].toLowerCase();
}

export function normalizeSeverity(v: unknown): Severity {
  return v === "P0" || v === "P2" ? v : "P1";
}

/** Qué entra a la review según la severidad mínima. */
export function severityScope(min: Severity): string {
  if (min === "P0") return "sólo P0 (rompe producción, hueco de seguridad, pérdida o fuga de datos)";
  if (min === "P2") return "P0, P1 y P2 (P2 = mantenibilidad o pruebas que faltan con riesgo real; nunca estilo ni gustos)";
  return "sólo P0 y P1 (bugs, seguridad, pérdida de datos, condiciones de carrera, regresiones claras)";
}

export function reviewKey(repo: string, pr: number, headSha: string): string {
  return `${repo.toLowerCase()}#${pr}:${headSha}`;
}

export function attemptKey(repo: string, pr: number, i: number): string {
  return `${repo.toLowerCase()}#${pr}:${i}`;
}

export function threadKeyOf(kind: "pr_review" | "review_autofix", repo: string, pr: number): string {
  return `${kind}:${repo.toLowerCase()}#${pr}`;
}

/** Ocupa el primer intento libre (1..MAX_ATTEMPTS). false = ya se usaron todos. */
export async function claimAttempt(ctx: AutomationCtx, kind: "pr_review" | "review_autofix", repo: string, pr: number, ttlMs: number): Promise<boolean> {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    if (await ctx.claim(kind, `${kind}:${attemptKey(repo, pr, i)}`, ttlMs)) return true;
  }
  return false;
}

/** Las mismas reglas que la fábrica le da a cada rol (`.ghosty/factory.md`, docs/agents, AGENTS.md). */
export const REPO_RULES =
  "Reglas del repo, le ganan a tu criterio general: lee con github_read_file el AGENTS.md o CLAUDE.md más cercano a los archivos que cambian (y el de la raíz), las fichas de docs/agents/ que toquen el tema y .ghosty/factory.md si existe (convenciones y la sección de tu rol, «## @check» o «## @build»).";

export type Deps = {
  isFactoryPr(repo: string, pr: number): Promise<boolean>;
  /** 👀 de la App sobre el comentario, como hace la fábrica con un pedido desde GitHub. */
  ack(repo: string, commentUrl: string): Promise<unknown>;
};

const defaultDeps: Deps = {
  async isFactoryPr(repo, pr) {
    const { runsByPr } = await import("../apps/factory-runs.server");
    return (await runsByPr(repo, pr)).length > 0;
  },
  async ack(repo, url) {
    const { ackGithubComment } = await import("../connectors/github.server");
    return ackGithubComment(repo, url);
  },
};

// ── pr_review ────────────────────────────────────────────────────────────────

/** Filtro puro de pr_review: null = actuar; si no, por qué no. */
export function prReviewSkip(ev: RepoEvent, settings: PrReviewSettings): string | null {
  const pr = ev.pr;
  if (ev.event !== "pull_request" || !pr) return "no es un PR";
  const actions = ["opened", "ready_for_review", ...(settings.reReviewOnPush ? ["synchronize"] : [])];
  if (!ev.action || !actions.includes(ev.action)) return "acción sin interés";
  if (pr.draft) return "borrador";
  if (!pr.headSha) return "sin headSha";
  if (isBot(pr.author, pr.authorType)) return "PR de un bot";
  if (isBot(ev.sender?.login, ev.sender?.type)) return "lo causó un bot";
  return null;
}

export function prReviewPrompt(ev: RepoEvent, min: Severity): string {
  const pr = ev.pr!;
  const ref = `${ev.repo}#${pr.number}`;
  return [
    `Revisión automática del PR ${ref}${pr.title ? ` «${pr.title}»` : ""}${pr.author ? ` de @${pr.author}` : ""}${pr.url ? ` (${pr.url})` : ""}, commit ${pr.headSha}. La prendió el equipo para este repo: no pidas confirmación. NO hay pedido de la fábrica: ${loosePrReviewBrief({ commentOnly: true })}`,
    REPO_RULES,
    `Severidad: de lo que encuentres, publica ${severityScope(min)}; lo demás no se comenta. Antes de señalar algo, confirma en el código que pasa de verdad; si dudas, no lo señales. Un comentario en línea por hallazgo, con la severidad al inicio («P1: …»), qué falla y cómo arreglarlo. Si no hay nada grave, la review es una línea: «Sin hallazgos graves».`,
    `No empujes commits ni toques el PR.`,
  ].join("\n");
}

export async function handlePrReview(ev: RepoEvent, ctx: AutomationCtx, deps: Deps = defaultDeps): Promise<void> {
  const settings = await ctx.settings<PrReviewSettings>("pr_review");
  if (prReviewSkip(ev, settings)) return;
  const pr = ev.pr!;
  if (await deps.isFactoryPr(ev.repo, pr.number)) return;
  if (!(await ctx.claim("pr_review", reviewKey(ev.repo, pr.number, pr.headSha!)))) return;
  if (!(await ctx.budget("pr_review"))) return;
  if (!(await claimAttempt(ctx, "pr_review", ev.repo, pr.number, ATTEMPT_TTL_MS))) return;
  await ctx.wake({
    handle: "check",
    threadKey: threadKeyOf("pr_review", ev.repo, pr.number),
    title: `Revisión de ${ev.repo}#${pr.number}`,
    text: prReviewPrompt(ev, normalizeSeverity(settings.minSeverity)),
  });
}

// ── review_autofix ───────────────────────────────────────────────────────────

/** Filtro puro de review_autofix: null = actuar; si no, por qué no. */
export function autofixSkip(ev: RepoEvent): string | null {
  const pr = ev.pr;
  if (!pr) return "sin PR";
  if (isBot(ev.sender?.login, ev.sender?.type)) return "lo causó un bot";
  if (isBot(pr.author, pr.authorType) && !pr.head?.startsWith("ghosty/")) {
    // Un PR de Dependabot/Renovate no se corrige a mano: lo atiende dep_fix. Los de nuestras
    // automatizaciones (`ghosty/<kind>-<n>`) sí: una persona los está revisando.
    return "PR de un bot ajeno";
  }
  if (isForkHead(ev.repo, pr.head)) return "rama de un fork: la App no puede empujar";
  if (ev.event === "pull_request_review_comment") {
    if (ev.action !== "created" || !ev.comment) return "acción sin interés";
    if (isBot(ev.comment.author)) return "comentario de un bot";
    if (mentionsGhosty(ev.comment.body)) return "mención @ghosty: la atiende el chat";
    if (!ev.comment.body?.trim()) return "comentario vacío";
    return null;
  }
  if (ev.event === "pull_request_review") {
    if (ev.action !== "submitted" || !ev.review) return "acción sin interés";
    if (String(ev.review.state).toLowerCase() !== "changes_requested") return "no pide cambios";
    if (isBot(ev.review.author)) return "review de un bot";
    if (mentionsGhosty(ev.review.body)) return "mención @ghosty: la atiende el chat";
    return null;
  }
  return "evento sin interés";
}

export function autofixPrompt(ev: RepoEvent): string {
  const pr = ev.pr!;
  const ref = `${ev.repo}#${pr.number}`;
  const who = ev.comment?.author ?? ev.review?.author ?? ev.sender?.login;
  const what = ev.comment
    ? `@${who} comentó en ${ev.comment.path ?? "el diff"}${ev.comment.line ? `:${ev.comment.line}` : ""} (comentario ${ev.comment.id}${ev.comment.url ? `, ${ev.comment.url}` : ""}): «${String(ev.comment.body ?? "").slice(0, 1500)}»`
    : `@${who} pidió cambios en una review${ev.review?.body ? `: «${String(ev.review.body).slice(0, 1500)}»` : "."}`;
  return [
    `Corrección automática en el PR ${ref}${pr.url ? ` (${pr.url})` : ""}, rama ${pr.head ?? "del PR"}. La prendió el equipo para este repo: no pidas confirmación. NO hay pedido de la fábrica: ${LOOSE_PR_BUILD_BRIEF}`,
    what,
    `1. Lista los hilos con github_pr_review_threads y atiende TODOS los que siguen sin resolver y cuyo último comentario es de una persona (una review trae varios a la vez). Salta los que ya contestaste tú o que mencionan @ghosty.`,
    `2. ${REPO_RULES} Aplica los cambios en la MISMA rama, en un solo commit si se puede (o en la caja si hace falta correr pruebas). Nunca force-push, nunca otra rama, nunca mergees.`,
    `3. Contesta en cada hilo con github_reply_review_comment: ${GITHUB_REPLY_FORMAT}. Si no estás de acuerdo o el pedido es ambiguo, NO adivines: explica por qué y pregunta, sin tocar el código.`,
    `4. Resuelve el hilo con github_resolve_review_thread SÓLO si lo arreglaste. Si la rama no se puede empujar (fork o sin permiso), dilo en el hilo y para.`,
    `En este hilo de Teams, 1 a 3 renglones: qué hilos arreglaste, cuáles no y por qué, con la liga al PR.`,
  ].join("\n");
}

export async function handleReviewAutofix(ev: RepoEvent, ctx: AutomationCtx, deps: Deps = defaultDeps): Promise<void> {
  if (autofixSkip(ev)) return;
  const pr = ev.pr!;
  if (await deps.isFactoryPr(ev.repo, pr.number)) return;
  // Dedupe por comentario/review (reentregas del webhook)…
  const id = ev.comment ? `c${ev.comment.id}` : `r${ev.review?.id ?? ev.deliveryId}`;
  if (!(await ctx.claim("review_autofix", `${ev.repo.toLowerCase()}#${pr.number}:${id}`))) return;
  // …y una review con 10 comentarios es UN turno de @build: el primero abre la ventana y el
  // prompt le pide atender todos los hilos abiertos.
  if (!(await ctx.claim("review_autofix", `${ev.repo.toLowerCase()}#${pr.number}:window`, AUTOFIX_WINDOW_MS))) return;
  if (!(await ctx.budget("review_autofix"))) return;
  if (!(await claimAttempt(ctx, "review_autofix", ev.repo, pr.number, AUTOFIX_ATTEMPT_TTL_MS))) return;
  if (ev.comment?.url) void deps.ack(ev.repo, ev.comment.url).catch(() => {});
  await ctx.wake({
    handle: "build",
    threadKey: threadKeyOf("review_autofix", ev.repo, pr.number),
    title: `Correcciones de review en ${ev.repo}#${pr.number}`,
    text: autofixPrompt(ev),
  });
}

export const automations: Automation[] = [
  {
    kind: "pr_review",
    on: ["pull_request.opened", "pull_request.ready_for_review", "pull_request.synchronize"],
    handle: (ev, ctx) => handlePrReview(ev, ctx),
  },
  {
    kind: "review_autofix",
    on: ["pull_request_review_comment.created", "pull_request_review.submitted"],
    handle: (ev, ctx) => handleReviewAutofix(ev, ctx),
  },
];
