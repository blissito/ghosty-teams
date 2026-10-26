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
// `apps/factory-runs.server.ts`); un PR de un pedido se deja a ese camino y aquí se ignora. Los
// textos del encargo son los de la fábrica (`apps/factory-fix-hints.ts`), no una copia.
// Sólo se escucha `workflow_run` (no `check_suite`): es lo único cuyo log puede leer @build con
// `github_workflow_run_logs`, y un check_suite también llega por checks ajenos (previews,
// el propio «Ghosty · Preview»), que no se arreglan tocando código.
//
// Con la fábrica instalada, ci_fix/dep_fix NO despiertan un turno suelto: el PR se ADOPTA como
// pedido (`openAdoptedRun`, lo mismo que adopta los PRs de Dependabot y los lotes de seguridad) con
// el plan ya firmado. Así @build empuja con git real (`factory_git_remote`, en la rama del PR), @check
// revisa, un rojo después lo regresa `onPrCiRed` (2 vueltas y aviso a una persona) y la tarjeta
// cuenta todo. Un PR de Dependabot que la fábrica ya adoptó sólo avisaba al rojo: con dep_fix
// prendido se hace lo de «Pedir arreglo a @build». Sin fábrica (o en un fork) queda el turno suelto.
//
// Anti-bucle: una vez por cabeza (`<repo>#<n>:<sha>`) y máximo 3 intentos por PR. El rojo que
// llega DESPUÉS de que @build empujó su arreglo lo causa nuestro bot: en ci_fix/dep_fix sí cuenta
// (es el intento siguiente, y el tope de 3 lo frena); en pr_to_green no.
import { ciRedNote, DEP_RED_FROM_MAIN_HINT, MERGE_FROM_HINT, RERUN_HINT, WORK_BOX_HINT } from "../apps/factory-fix-hints";
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
  /** El arreglo como pedido de la fábrica. "no_factory" = sin fábrica en el room: turno suelto. */
  openFactoryFix(ctx: AutomationCtx, o: FactoryFixInput): Promise<FactoryFixOutcome>;
};

export type FactoryFixInput = { kind: "ci_fix" | "dep_fix"; ev: RepoEvent; pr: PrView };
/** opened = pedido nuevo · fixing = pedido de Dependabot reabierto a @build · handled = ya es de la fábrica. */
export type FactoryFixOutcome = "opened" | "fixing" | "handled" | "no_factory";

const defaultDeps: PrFixDeps = {
  async fetchPr(repo, number) {
    const G = await import("../connectors/github.server");
    return G.appPullRequest(repo, number);
  },
  async isFactoryPr(repo, number) {
    const R = await import("../apps/factory-runs.server");
    return (await R.runsByPr(repo, number).catch(() => [])).length > 0;
  },
  openFactoryFix: openFactoryFixRun,
};

/**
 * ci_fix/dep_fix como pedido de la fábrica (mismo molde que `openSecurityRun`): `openAdoptedRun`
 * con la rama y la cabeza del PR + plan firmado + `decide`, que pide la caja y le pasa el plan a
 * @build. Si el PR ya es un pedido de Dependabot esperando revisión, es «Pedir arreglo a @build»
 * (`factoryFixCiFn`): nota + `reopenWithNotes` en la misma rama. Cualquier otro pedido lo lleva la
 * fábrica sola (`onPrCiRed`).
 */
async function openFactoryFixRun(ctx: AutomationCtx, o: FactoryFixInput): Promise<FactoryFixOutcome> {
  const channelId = Number(ctx.roomId);
  const { isInstalled } = await import("../apps/installed.server");
  if (!Number.isFinite(channelId) || !(await isInstalled("factory").catch(() => false))) return "no_factory";
  const db = await import("../../db.server");
  const row = (await db.listRoomRepos(channelId)).find((r) => r.repo.toLowerCase() === o.ev.repo.toLowerCase());
  if (!row) return "no_factory";
  const R = await import("../apps/factory-runs.server");
  const runs = await R.runsByPr(o.ev.repo, o.pr.number).catch(() => []);
  if (runs.length) {
    const run = runs.find((r) => r.channelId === channelId && r.status === "pr_review" && String(r.taskRef ?? "").startsWith("dependabot:"));
    if (o.kind !== "dep_fix" || !run) return "handled";
    const what = `${o.ev.run?.name ?? "workflow"}: ${o.ev.run?.conclusion}`;
    const who = "La automatización «Arreglar dependencias»";
    // `ci_red` con esta cabeza: `onPrCiRed` ya no la vuelve a tratar, y sus 2 vueltas cuentan ésta.
    await R.logEvent(run.id, "ci_red", "dep_fix", { sha: o.pr.headSha, failed: [what] });
    await R.addNote(run.id, who, `${ciRedNote(what)} ${depFixRule(o.pr)}`);
    await R.postInThread(run, "plan", `🔧 ${who} pidió arreglar el CI del PR (${what}).`);
    const next = await R.reopenWithNotes(run, who, "", "", { ci: [what] });
    void R.refreshRoom(channelId);
    return next ? "fixing" : "handled";
  }
  const A = await import("../apps/factory-adopt.server");
  const run = await A.openAdoptedRun({
    room: channelId,
    sub: row.connectedBy,
    repo: o.ev.repo,
    title: `${o.kind === "dep_fix" ? "Arreglar dependencia" : "Arreglar CI"} · PR #${o.pr.number}`,
    rootBody: `🔧 **CI en rojo · PR #${o.pr.number}** · \`${o.ev.repo}\`\n${o.pr.url}`,
    rootHandle: "build",
    status: "plan_review",
    kind: o.kind,
    prUrl: o.pr.url,
    headSha: o.pr.headSha,
    // La cabeza del PR: `factory_git_remote` empuja AHÍ (su CI y su preview viven en ese PR).
    branch: o.pr.head,
    planVersion: 1,
    event: { type: "adopted", actor: o.kind, data: { pr: o.pr.url, runId: o.ev.run?.id ?? null } },
  });
  const { dbq } = await import("../../dbq.server");
  await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, 1, ?)", [run.id, ciFixPlan(o.kind, o.ev, o.pr)]);
  const who = o.kind === "dep_fix" ? "La automatización «Arreglar dependencias»" : "La automatización «Arreglar CI»";
  await R.decide({ run, version: 1, decision: "approve", sub: row.connectedBy, who, origin: "" });
  void R.refreshRoom(channelId);
  return "opened";
}

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

/** En un room con la fábrica, @build recibe su rol de pedido: aquí no hay pedido que cerrar. */
const NOT_A_RUN =
  "Esto NO es un pedido de la fábrica: no hay plan, ni factory_build_done, ni factory_git_remote (exige pedido). El alcance es el del PR, no lo amplíes.";

/** Lo que dep_fix le pide de más a @build (turno suelto, plan del pedido o nota de reapertura). */
export function depFixRule(pr: PrView): string {
  return (
    `Este PR lo abrió ${pr.author ?? "un bot de dependencias"} para subir una dependencia. ${DEP_RED_FROM_MAIN_HINT}. Si es la subida, el trabajo es ADAPTAR el código a la versión nueva: lee sus notas de versión o changelog (breaking changes, y dónde los usa el repo) y cambia lo que haga falta; si es un grupo, sube juntos los paquetes hermanos. ` +
    "Nunca bajes la versión ni la fijes en la vieja sin decirlo, en el PR y en el hilo, con el motivo."
  );
}

/** El PLAN del pedido adoptado: lo lee @build al construir y @check al revisar (criterios al final). */
export function ciFixPlan(kind: "ci_fix" | "dep_fix", ev: RepoEvent, pr: PrView): string {
  const run = ev.run!;
  const what = `${run.name ?? "workflow"}: ${run.conclusion}`;
  return [
    `## Objetivo`,
    `Dejar en verde el CI del PR ${pr.url} (rama \`${pr.head ?? "?"}\`, sha \`${short(pr.headSha)}\`). Falló ${what}: ${run.url ?? ""} (runId ${run.id}).`,
    ...(kind === "dep_fix" ? ["", depFixRule(pr)] : []),
    "",
    "## Pasos",
    `1. ${ciRedNote(what)} Usa github_workflow_run_logs {repo: "${ev.repo}", runId: ${run.id}}; nunca inventes una línea de log.`,
    `2. Si la falla no viene del PR (truena igual en la rama principal, falta un secreto o una cuota), no toques código: dilo en factory_build_done y comenta el diagnóstico en el PR. Si es pasajera, ${RERUN_HINT}.`,
    `3. Trabaja en la rama EXISTENTE del PR (\`${pr.head ?? "?"}\`) con factory_git_remote: no abras otra rama ni otro PR, y no lo saques de borrador ni le cambies título o descripción (es de su autor).`,
    "4. Contesta en el PR con github_comment qué falló y qué cambiaste (con la liga del commit), y cierra con factory_build_done.",
    "",
    "## Criterios de aceptación",
    "- El check que falló pasa en el último commit del PR, sin saltarse ni desactivar pruebas.",
    "- El diff sólo toca lo necesario para el arreglo: el alcance es el del PR.",
    ...(kind === "dep_fix" ? ["- La versión subida se conserva (o el PR explica por qué no)."] : []),
    "",
    "## Riesgos y fuera de alcance",
    "Nunca mergear, cerrar el PR ni force-push: el PR es de otra persona.",
  ].join("\n");
}

export function ciFixText(kind: "ci_fix" | "dep_fix", ev: RepoEvent, pr: PrView, attempt: number): string {
  const run = ev.run!;
  const fork = isFork(pr, ev.repo);
  const what = `${run.name ?? "workflow"}: ${run.conclusion}`;
  const lines = [
    `🔧 CI en rojo en el PR #${pr.number} de ${ev.repo} (intento ${attempt} de ${MAX_ATTEMPTS}).`,
    `PR: ${pr.url} · rama \`${pr.head ?? "?"}\` · sha \`${short(pr.headSha)}\``,
    `Run: ${what} ${run.url ?? ""} · runId ${run.id}`,
    NOT_A_RUN,
    "",
  ];
  if (kind === "dep_fix") lines.push(depFixRule(pr), "");
  lines.push(
    `1. ${ciRedNote(what)} Usa github_workflow_run_logs {repo: "${ev.repo}", runId: ${run.id}}; si no lo puedes leer, dilo y da la liga del run. Nunca inventes una línea de log. Método: skill dev-depurar.`,
    `2. Si la falla no viene del PR (truena igual en la rama principal, falta un secreto o una cuota) no toques código: comenta el diagnóstico en el PR con github_comment. Si es pasajera, ${RERUN_HINT}.`,
  );
  if (fork) {
    lines.push(
      `3. El PR viene de un fork (${pr.headRepo}): la App no puede empujar ahí. Sólo comenta en el PR con github_comment qué falla y cómo arreglarlo (archivo y cambio concreto).`,
    );
  } else {
    lines.push(
      `3. Si es del PR, reprodúcelo: github_checkout {repo: "${ev.repo}", pr: ${pr.number}}. ${WORK_BOX_HINT}`,
      `4. Arregla con github_push_files en la MISMA rama \`${pr.head ?? "?"}\` (varios archivos en UN commit; nunca la principal, nunca force-push). Antes de empujar, skill dev-verificar. Si GitHub te niega empujar, sólo comenta el diagnóstico.`,
      "5. Contesta en el PR con github_comment qué falló y qué cambiaste (con la liga del commit).",
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
    NOT_A_RUN,
    "",
    `1. Primero github_update_branch {repo: "${ev.repo}", number: ${pr.number}}. Si pasa, no hay más que hacer.`,
    fork
      ? `2. Si choca: el PR viene de un fork (${pr.headRepo}) y la App no le empuja. Comenta en el PR con github_comment qué archivos chocan y deja que el autor lo resuelva.`
      : `2. Si choca: ${MERGE_FROM_HINT} Aquí la rama principal es \`${base}\` (\`mergeFrom: "${base}"\`). Si un choque pide decidir algo del producto, no lo adivines: comenta en el PR qué choca y que lo decida una persona.`,
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
  const pr = prView(ev, n, await deps.fetchPr(ev.repo, n));
  if (isDepPr(pr.author ?? ev.sender?.login, pr.head) !== (kind === "dep_fix")) return;
  // Pedido de una persona: lo lleva la fábrica (`onPrCiRed`). Uno de Dependabot adoptado sólo
  // avisaba al rojo: ése sí pasa (dep_fix lo reabre a @build más abajo).
  if (kind === "ci_fix" && (await deps.isFactoryPr(ev.repo, n))) return;
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
  if (!isFork(pr, ev.repo)) {
    const outcome = await deps.openFactoryFix(ctx, { kind, ev, pr });
    if (outcome !== "no_factory") return;
  } else if (await deps.isFactoryPr(ev.repo, n)) return;
  // Sin fábrica (o en un fork, donde sólo se diagnostica): turno suelto de @build.
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
