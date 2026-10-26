// ── Automatizaciones PR-FIX: llevar a verde un PR que NO es de la fábrica ───────────────────
//
// Tres tipos, apagados por default (los prende el switch del room+repo):
// - `ci_fix`: terminó un workflow de Actions en rojo en la cabeza de un PR abierto → @build lee
//   el log, arregla en la MISMA rama y contesta en el PR qué cambió.
// - `dep_fix`: lo mismo cuando el PR es de dependabot[bot]/renovate[bot]: adaptar el código a la
//   versión nueva, nunca bajarla sin decirlo.
// - `pr_to_green`: PR con conflictos («dirty») o atrás de su base («behind») → primero «Update
//   branch»; si choca, @build hace el merge con los choques resueltos. Nunca mergea el PR.
//
// Es el mismo flujo que la fábrica ya tiene para sus pedidos (`onPrCiRed`/`onPrConflict` en
// `apps/factory-runs.server.ts`); un PR de un pedido se deja a ese camino y aquí se ignora.
// Sólo se escucha `workflow_run` (no `check_suite`): es lo único cuyo log puede leer @build con
// `github_workflow_run_logs`, y un check_suite también llega por checks ajenos (previews,
// el propio «Ghosty · Preview»), que no se arreglan tocando código.
//
// Anti-bucle: una vez por cabeza (`<repo>#<n>:<sha>`) y máximo 3 intentos por PR. El rojo que
// llega DESPUÉS de que @build empujó su arreglo lo causa nuestro bot: en ci_fix/dep_fix sí cuenta
// (es el intento siguiente, y el tope de 3 lo frena); en pr_to_green no.
import type { AppPrInfo } from "../connectors/github.server";
import type { Automation, AutomationCtx, AutomationKind, RepoEvent } from "./types";

const MAX_ATTEMPTS = 3;
/** Cuánto vive el claim de una cabeza o de un intento: una semana basta para un PR vivo. */
const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;
const RED = new Set(["failure", "timed_out"]);
const DEP_BOTS = new Set(["dependabot[bot]", "renovate[bot]"]);

export type PrFixSettings = { includeDrafts?: boolean };

/** Lo que se le pregunta al mundo; inyectable para las pruebas. */
export type PrFixDeps = {
  fetchPr(repo: string, number: number): Promise<AppPrInfo | null>;
  isFactoryPr(repo: string, number: number): Promise<boolean>;
};

const defaultDeps: PrFixDeps = {
  async fetchPr(repo, number) {
    const G = await import("../connectors/github.server");
    return G.appPullRequest(repo, number);
  },
  async isFactoryPr(repo, number) {
    const R = await import("../apps/factory-runs.server");
    return (await R.runsByPr(repo, number).catch(() => [])).length > 0;
  },
};

// ── Lógica pura (con pruebas) ────────────────────────────────────────────────

export function ownBotLogin(): string {
  return `${process.env.GITHUB_APP_SLUG ?? "ghosty-studio"}[bot]`;
}

export function isOwnBot(login: string | null | undefined): boolean {
  return !!login && login.toLowerCase() === ownBotLogin().toLowerCase();
}

/** PR de un bot de dependencias: por autor o, si el evento no lo trae, por el nombre de la rama. */
export function isDepPr(author: string | null | undefined, head: string | null | undefined): boolean {
  if (author && DEP_BOTS.has(author.toLowerCase())) return true;
  return /^(dependabot|renovate)\//i.test(String(head ?? ""));
}

/** Un workflow de Actions terminó en rojo. */
export function isRedRun(ev: RepoEvent): boolean {
  return ev.event === "workflow_run" && ev.action === "completed" && RED.has(String(ev.run?.conclusion ?? ""));
}

/** El PR del evento: el del bloque `pr` o el primero que GitHub liga al run (forks: ninguno). */
export function prNumberOf(ev: RepoEvent): number | null {
  const n = ev.pr?.number ?? ev.run?.prNumbers?.[0];
  return typeof n === "number" && n > 0 ? n : null;
}

export function headKey(repo: string, number: number, sha: string): string {
  return `${repo.toLowerCase()}#${number}:${sha}`;
}

export function attemptKey(repo: string, number: number, attempt: number): string {
  return `${repo.toLowerCase()}#${number}:${attempt}`;
}

/** Un hilo por PR para las tres: así un CI rojo y un conflicto del mismo PR no corren en paralelo. */
export function threadKeyOf(repo: string, number: number): string {
  return `pr-fix:${repo.toLowerCase()}#${number}`;
}

export function needsGreen(state: string | null | undefined): "dirty" | "behind" | null {
  return state === "dirty" || state === "behind" ? state : null;
}

/** El PR tal como lo ve la automatización: lo fresco de GitHub gana a lo que trajo el evento. */
export type PrView = {
  number: number;
  state: string | null;
  draft: boolean;
  author: string | null;
  head: string | null;
  headSha: string | null;
  headRepo: string | null;
  base: string | null;
  mergeableState: string | null;
  url: string;
};

export function prView(ev: RepoEvent, number: number, live: AppPrInfo | null): PrView {
  return {
    number,
    state: live?.state ?? null,
    draft: live?.draft ?? !!ev.pr?.draft,
    author: live?.author ?? ev.pr?.author ?? null,
    head: live?.head ?? ev.pr?.head ?? ev.run?.headBranch ?? null,
    headSha: live?.headSha ?? ev.pr?.headSha ?? ev.run?.headSha ?? null,
    headRepo: live?.headRepo ?? null,
    base: live?.base ?? ev.pr?.base ?? null,
    mergeableState: live?.mergeableState ?? ev.pr?.mergeableState ?? null,
    url: live?.url ?? ev.pr?.url ?? `https://github.com/${ev.repo}/pull/${number}`,
  };
}

/** Fork = la rama vive en otro repo: la App no le empuja. Sin dato, no se asume fork. */
export function isFork(pr: PrView, repo: string): boolean {
  return !!pr.headRepo && pr.headRepo.toLowerCase() !== repo.toLowerCase();
}

/**
 * Los filtros comunes. Devuelve el motivo para no actuar (para las pruebas y el log), o null.
 * `state` null = no se pudo leer el PR: se sigue con lo del evento y @build lo confirma.
 */
export function skipReason(pr: PrView, settings: PrFixSettings): string | null {
  if (pr.state && pr.state !== "open") return "pr cerrado";
  if (pr.draft && !settings.includeDrafts) return "borrador";
  return null;
}

/** Primer intento libre de los 3 del PR, o 0 si ya se gastaron. */
export async function claimAttempt(ctx: AutomationCtx, kind: AutomationKind, repo: string, number: number): Promise<number> {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    if (await ctx.claim(kind, attemptKey(repo, number, i), CLAIM_TTL_MS)) return i;
  }
  return 0;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");

export function ciFixText(kind: "ci_fix" | "dep_fix", ev: RepoEvent, pr: PrView, attempt: number): string {
  const run = ev.run!;
  const fork = isFork(pr, ev.repo);
  const lines = [
    `🔧 CI en rojo en el PR #${pr.number} de ${ev.repo} (intento ${attempt} de ${MAX_ATTEMPTS}).`,
    `PR: ${pr.url} · rama \`${pr.head ?? "?"}\` · sha \`${short(pr.headSha)}\``,
    `Run: ${run.name ?? "workflow"} (${run.conclusion}) ${run.url ?? ""} · runId ${run.id}`,
    "",
  ];
  if (kind === "dep_fix") {
    lines.push(
      `Este PR lo abrió ${pr.author ?? "un bot de dependencias"} para subir una dependencia. El trabajo es ADAPTAR el código a la versión nueva: lee sus notas de versión o changelog (breaking changes) y cambia lo que haga falta.`,
      "Nunca bajes la versión ni la fijes en la vieja sin decirlo, en el PR y aquí, con el motivo.",
      "",
    );
  }
  lines.push(
    `1. Lee el log con github_workflow_run_logs {repo: "${ev.repo}", runId: ${run.id}}. Si no lo puedes leer, dilo y da la liga del run; nunca inventes una línea de log.`,
    "2. Si la falla no viene del PR (truena igual en la rama principal, es intermitente, falta un secreto o una cuota), no toques código: comenta el diagnóstico en el PR con github_comment.",
  );
  if (fork) {
    lines.push(
      `3. El PR viene de un fork (${pr.headRepo}): la App no puede empujar ahí. Sólo comenta en el PR con github_comment qué falla y cómo arreglarlo (archivo y cambio concreto).`,
    );
  } else {
    lines.push(
      `3. Si es del PR: reprodúcelo con github_checkout {repo: "${ev.repo}", pr: ${pr.number}} y corre las pruebas en tu caja. Arregla con github_push_files en la MISMA rama \`${pr.head ?? "?"}\` (un solo commit; nunca la principal, nunca force-push). Si GitHub te niega empujar, sólo comenta el diagnóstico.`,
      "4. Contesta en el PR con github_comment qué falló y qué cambiaste (con la liga del commit).",
    );
  }
  lines.push(
    "",
    "Al final, resume aquí en 2-3 líneas con la liga del PR. No mergees, no cierres el PR y no lo saques de borrador.",
  );
  return lines.join("\n");
}

export function toGreenText(ev: RepoEvent, pr: PrView, why: "dirty" | "behind", attempt: number): string {
  const base = pr.base ?? "la rama principal";
  const fork = isFork(pr, ev.repo);
  return [
    `🔀 El PR #${pr.number} de ${ev.repo} ${why === "dirty" ? "tiene conflictos con" : "está atrás de"} \`${base}\` (intento ${attempt} de ${MAX_ATTEMPTS}).`,
    `PR: ${pr.url} · rama \`${pr.head ?? "?"}\` · sha \`${short(pr.headSha)}\``,
    "",
    `1. Primero github_update_branch {repo: "${ev.repo}", number: ${pr.number}}. Si pasa, no hay más que hacer.`,
    fork
      ? `2. Si choca: el PR viene de un fork (${pr.headRepo}) y la App no le empuja. Comenta en el PR con github_comment qué archivos chocan y deja que el autor lo resuelva.`
      : `2. Si choca: fusiona \`${base}\` en la rama con github_push_files y \`mergeFrom: "${base}"\` (commit de MERGE de verdad; en \`files\` va el contenido final de los archivos que chocan). Resuelve sin cambiar el alcance del PR. Si un choque pide decidir algo del producto, no lo adivines: comenta en el PR qué choca y que lo decida una persona.`,
    "3. Nunca mergees el PR, nunca force-push ni rebase.",
    "",
    "Al final, resume aquí en 1-2 líneas con la liga del PR (y en el PR, con github_comment, si resolviste choques).",
  ].join("\n");
}

// ── Las automatizaciones ─────────────────────────────────────────────────────

async function handleRed(kind: "ci_fix" | "dep_fix", ev: RepoEvent, ctx: AutomationCtx, deps: PrFixDeps): Promise<void> {
  if (!isRedRun(ev)) return;
  // El propio bot NO se ignora aquí: su empuje provoca el run del intento siguiente (tope de 3).
  const n = prNumberOf(ev);
  if (!n) return; // sin PR (o de un fork: GitHub no liga el run a su PR)
  if (await deps.isFactoryPr(ev.repo, n)) return; // lo lleva la fábrica (`onPrCiRed`)
  const pr = prView(ev, n, await deps.fetchPr(ev.repo, n));
  if (isDepPr(pr.author ?? ev.sender?.login, pr.head) !== (kind === "dep_fix")) return;
  if (skipReason(pr, await ctx.settings<PrFixSettings>(kind))) return;
  // El run es de una cabeza vieja: ya hay un commit encima y su CI dirá.
  const runSha = ev.run?.headSha ?? null;
  if (runSha && pr.headSha && runSha !== pr.headSha) return;
  const sha = pr.headSha ?? runSha;
  if (!sha) return;
  if (!(await ctx.claim(kind, headKey(ev.repo, n, sha), CLAIM_TTL_MS))) return;
  const attempt = await claimAttempt(ctx, kind, ev.repo, n);
  if (!attempt) return;
  if (!(await ctx.budget(kind))) return;
  await ctx.wake({
    handle: "build",
    text: ciFixText(kind, ev, pr, attempt),
    threadKey: threadKeyOf(ev.repo, n),
    title: `${kind === "dep_fix" ? "Dependencia" : "CI rojo"} · PR #${n}`,
  });
}

async function handleToGreen(ev: RepoEvent, ctx: AutomationCtx, deps: PrFixDeps): Promise<void> {
  if (isOwnBot(ev.sender?.login)) return;
  const n = prNumberOf(ev);
  if (!n) return;
  if (await deps.isFactoryPr(ev.repo, n)) return; // lo lleva la fábrica (`onPrConflict`)
  const pr = prView(ev, n, await deps.fetchPr(ev.repo, n));
  const why = needsGreen(pr.mergeableState);
  if (!why) return; // "unknown" incluido: GitHub aún no lo calcula; el siguiente evento lo trae
  if (skipReason(pr, await ctx.settings<PrFixSettings>("pr_to_green"))) return;
  if (!pr.headSha) return;
  if (!(await ctx.claim("pr_to_green", headKey(ev.repo, n, pr.headSha), CLAIM_TTL_MS))) return;
  const attempt = await claimAttempt(ctx, "pr_to_green", ev.repo, n);
  if (!attempt) return;
  if (!(await ctx.budget("pr_to_green"))) return;
  await ctx.wake({
    handle: "build",
    text: toGreenText(ev, pr, why, attempt),
    threadKey: threadKeyOf(ev.repo, n),
    title: `${why === "dirty" ? "Conflictos" : "Al día"} · PR #${n}`,
  });
}

export function buildPrFixAutomations(deps: PrFixDeps = defaultDeps): Automation[] {
  return [
    { kind: "ci_fix", on: ["workflow_run.completed"], handle: (ev, ctx) => handleRed("ci_fix", ev, ctx, deps) },
    { kind: "dep_fix", on: ["workflow_run.completed"], handle: (ev, ctx) => handleRed("dep_fix", ev, ctx, deps) },
    {
      kind: "pr_to_green",
      // Al terminar el CI GitHub ya calculó `mergeable_state`; en `opened`/`synchronize` suele ser "unknown".
      on: ["pull_request.opened", "pull_request.reopened", "pull_request.synchronize", "pull_request.ready_for_review", "workflow_run.completed"],
      handle: (ev, ctx) => handleToGreen(ev, ctx, deps),
    },
  ];
}

export const automations: Automation[] = buildPrFixAutomations();
