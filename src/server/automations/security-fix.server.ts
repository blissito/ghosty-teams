// ── security_fix: alertas de seguridad del repo → UN PR borrador con los arreglos en lote ──
//
// Como el autofix agéntico de GitHub (GA 15-oct-2026): code scanning y Dependabot avisan por
// alerta, pero un análisis de CodeQL o un aviso nuevo de una librería sueltan decenas en segundos.
// Despertar a @build por cada una serían decenas de turnos y de PRs. Se agrupa:
//
// 1. La PRIMERA alerta del repo abre la ventana (`claim` de `<repo>:security:batch`, 10 min).
//    Con la fábrica instalada abre un PEDIDO de la fábrica con el plan ya firmado (el camino de
//    cualquier pedido: caja, git, @check, CI rojo → @build, tarjeta; un solo pedido vivo por repo).
//    Sin fábrica, un turno suelto de @build con retraso durable (`delayS`).
// 2. Las que llegan dentro de la ventana no despiertan a nadie: cuando @build corre, LISTA las
//    abiertas con las tools (GitHub es la fuente de verdad, ya trae las que llegaron después y no
//    las que alguien cerró a mano) y arregla hasta 25 en un PR borrador.
//
// Secret scanning NO se arregla con código: borrar la línea no sirve (el secreto sigue en la
// historia y ya hay que darlo por quemado). Se avisa DIRECTO en el room (`ctx.post`), sin turno de
// ningún agente: así el aviso no le da a un modelo ni la oportunidad de pedir el valor, y el texto se arma
// sólo con campos de una lista blanca (número, tipo, liga). El secreto jamás viaja.
import type { Automation, AutomationCtx, RepoEvent } from "./types";
import { isDependabot } from "../../lib/dependabot";

export const BATCH_WINDOW_S = 10 * 60;
export const MAX_ALERTS_PER_PR = 25;
export const MAX_ATTEMPTS = 3;
const ATTEMPT_TTL_MS = 30 * 24 * 3600_000;
const SECRET_NOTICE_TTL_MS = 24 * 3600_000;
const BOT_LOGIN = "ghosty-studio[bot]";

export type Severity = "low" | "medium" | "high" | "critical";
const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Severidad en la escala de 4. Code scanning trae `security_severity_level` (critical…low) en
 * reglas de seguridad y `severity` (error/warning/note) en las demás; Dependabot dice `moderate`
 * en GraphQL y `medium` en REST. Desconocida = 0 (no pasa ningún umbral).
 */
export function severityRank(s: string | undefined | null): number {
  const v = String(s ?? "").trim().toLowerCase();
  if (v in RANK) return RANK[v as Severity];
  if (v === "moderate" || v === "warning") return RANK.medium;
  if (v === "error") return RANK.high;
  if (v === "note") return RANK.low;
  return 0;
}

export function meetsSeverity(s: string | undefined | null, min: Severity | string | undefined): boolean {
  const floor = severityRank(min) || RANK.high;
  return severityRank(s) >= floor;
}

/** ¿Es una alerta que se arregla con código, en una acción que pide trabajo? */
export function isFixableEvent(ev: RepoEvent): boolean {
  if (ev.event !== "code_scanning_alert" && ev.event !== "dependabot_alert") return false;
  if (ev.action !== "created" && ev.action !== "reopened") return false;
  return !!ev.alert && ev.alert.kind !== "secret_scanning" && Number(ev.alert.number) > 0;
}

export function isSecretEvent(ev: RepoEvent): boolean {
  return (
    ev.event === "secret_scanning_alert" &&
    (ev.action === "created" || ev.action === "reopened") &&
    !!ev.alert &&
    Number(ev.alert.number) > 0
  );
}

const repoKey = (repo: string) => repo.toLowerCase();
export const batchKey = (repo: string) => `${repoKey(repo)}:security:batch`;
export const attemptKey = (repo: string, alert: AlertRef, i: number) =>
  `${repoKey(repo)}#${alert.kind}-${alert.number}:${i}`;
/** Identidad de una alerta dentro del repo («dependabot#12»). */
export const alertId = (a: AlertRef) => `${a.kind}#${a.number}`;
type AlertRef = { kind: string; number: number };

/** Fecha de CDMX (AAAA-MM-DD): la rama del día se nombra con la hora de quien la lee. */
export function cdmxDate(ms = Date.now()): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

/** Sólo ligas de GitHub: el texto va al room y al prompt, no se pega lo que venga. */
const safeUrl = (u: string | undefined) => (u && /^https:\/\/github\.com\/[\w./#?=&%-]+$/.test(u) ? u : "");
/** Una línea, sin backticks ni saltos: nada del evento puede romper el markdown del aviso. */
const clean = (s: string | undefined, max = 120) => String(s ?? "").replace(/[`\r\n]+/g, " ").trim().slice(0, max);

export function alertLine(a: NonNullable<RepoEvent["alert"]>): string {
  const what = a.kind === "dependabot" ? `paquete \`${clean(a.package) || "?"}\`` : `regla \`${clean(a.rule) || "?"}\``;
  const src = a.kind === "dependabot" ? "Dependabot" : "code scanning";
  const url = safeUrl(a.url);
  return `- ${src} #${a.number} · ${what} · severidad ${clean(a.severity, 20) || "?"}${url ? ` · ${url}` : ""}`;
}

/**
 * El encargo. Con la fábrica instalada es el PLAN del pedido (lo lee @build al construir y @check
 * al revisar: los pasos son sus criterios); sin ella, el texto del turno suelto de @build.
 */
export function buildFixPrompt(o: { repo: string; first: NonNullable<RepoEvent["alert"]>; minSeverity: string; date: string; factory?: boolean }): string {
  const branch = `ghosty/security-fix-${o.date}`;
  return [
    `🛡️ **Alertas de seguridad en \`${o.repo}\`** (automatización «Arreglar alertas», severidad mínima: ${o.minSeverity}).`,
    "",
    "La que abrió el lote:",
    alertLine(o.first),
    "",
    "Qué hacer:",
    `1. Lista las alertas ABIERTAS de severidad ${o.minSeverity} o mayor con \`github_code_scanning_alerts\` y \`github_dependabot_alerts\` (pueden haber llegado más después de este aviso). Toma hasta ${MAX_ALERTS_PER_PR}, primero las críticas.`,
    `2. Busca con \`github_search\` si ya hay un PR abierto que las cubra y sáltate ésas: uno de \`ghosty/security-fix-\` que las cite, o uno de Dependabot que ya suba ese paquete (la fábrica revisa esos por su lado).`,
    "3. Lee el detalle de cada una (con `number`) y arréglala de raíz: el código vulnerable o la versión del paquete (la que indica `fixedIn`).",
    "4. Corre los tests y el build del repo. Si algo se rompe por un arreglo, quita ese arreglo en vez de entregar rojo.",
    `5. Abre UN PR en BORRADOR desde la rama \`${branch}\` (si ya existe, agrégale \`-2\`, \`-3\`…). En la descripción cita cada alerta arreglada con su número y su liga.`,
    "6. Comenta en el PR las que NO pudiste arreglar y por qué (sin versión que lo arregle, cambio de API, falso positivo probable…).",
    "",
    "",
    "Nunca descartes (dismiss) alertas, nunca hagas merge y nunca empujes a ramas de otras personas.",
    o.factory
      ? "Criterio para @check: cada alerta citada en el PR está arreglada en el diff (no silenciada ni ignorada con un comentario), tests y build en verde, y las pendientes comentadas con su razón."
      : "Al terminar, deja aquí la liga del PR y el conteo: arregladas / pendientes.",
  ].join("\n");
}

/** El aviso de un secreto filtrado. Sólo número, tipo y liga: el valor nunca entra aquí. */
export function buildSecretNotice(repo: string, a: NonNullable<RepoEvent["alert"]>): string {
  const url = safeUrl(a.url);
  const type = clean(a.rule, 80) || "una credencial";
  return [
    `🔐 **GitHub detectó un secreto expuesto en \`${clean(repo, 140)}\`** · ${type} · aviso #${a.number}${url ? ` · ${url}` : ""}`,
    "",
    "**Rota esa credencial ya** en el servicio que la emitió. Borrarla del código no basta: sigue en la historia de git y hay que darla por quemada.",
    "Después cierra el aviso en GitHub como «revoked». Ghosty no lo arregla solo ni lee el valor.",
  ].join("\n");
}

type FactoryOutcome = "opened" | "busy" | "no_factory";

export type FactoryRunInput = {
  repo: string;
  title: string;
  planMd: string;
  first: NonNullable<RepoEvent["alert"]>;
  /** Arranca solo a esta hora (unix s): junta el lote antes de que @build empiece. */
  dueAt?: number;
  kindMeta?: Record<string, unknown>;
};

type Deps = {
  /** El lote como pedido de la fábrica (caja, git, @check, CI, tarjeta). */
  openFactoryRun(ctx: AutomationCtx, o: FactoryRunInput): Promise<FactoryOutcome>;
  /** El PR de Dependabot abierto que ya sube el paquete de la alerta (su número), o null. */
  coveredBy?(ctx: AutomationCtx, alert: NonNullable<RepoEvent["alert"]>): Promise<number | null>;
  now(): number;
};

/**
 * Un pedido de la fábrica con el plan ya firmado, como los tickets de sprint que se aprueban solos:
 * `openAdoptedRun` (lo mismo que adopta los PRs de Dependabot) + `decide`, que pide la caja, encola
 * si no hay lugar y le pasa el encargo a @build. Así @build empuja con `factory_git_remote` (un
 * turno suelto no puede: esa tool exige pedido) y el resto del camino es el de cualquier pedido.
 * Un solo pedido vivo por repo: el que corre ya lista las alertas abiertas.
 */
async function openSecurityRun(ctx: AutomationCtx, o: FactoryRunInput): Promise<FactoryOutcome> {
  const channelId = Number(ctx.roomId);
  const { isInstalled } = await import("../apps/installed.server");
  if (!Number.isFinite(channelId) || !(await isInstalled("factory").catch(() => false))) return "no_factory";
  const A = await import("../apps/factory-adopt.server");
  if ((await A.liveRunsOfKind("security", o.repo)) > 0) return "busy";
  const db = await import("../../db.server");
  const row = (await db.listRoomRepos(channelId)).find((r) => r.repo.toLowerCase() === o.repo.toLowerCase());
  if (!row) return "no_factory";
  const run = await A.openAdoptedRun({
    room: channelId,
    sub: row.connectedBy,
    repo: o.repo,
    title: o.title,
    rootBody: `🛡️ **Alertas de seguridad · \`${o.repo}\`**\n${alertLine(o.first)}`,
    rootHandle: "build",
    status: "plan_review",
    kind: "security",
    planVersion: 1,
    event: { type: "adopted", actor: "security", data: { alert: `${o.first.kind}#${o.first.number}` } },
    // Con hora: espera en `plan_review` y el tick lo aprueba al vencer (`startDueAdoptedRuns`).
    dueAt: o.dueAt ?? null,
    dueWho: SECURITY_WHO,
    kindMeta: o.kindMeta ?? null,
  });
  const { dbq } = await import("../../dbq.server");
  await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, 1, ?)", [run.id, o.planMd]);
  const R = await import("../apps/factory-runs.server");
  if (!o.dueAt) await R.decide({ run, version: 1, decision: "approve", sub: row.connectedBy, who: SECURITY_WHO, origin: "" });
  void R.refreshRoom(channelId);
  return "opened";
}

/** Con las credenciales de quien conectó el repo al room (las del pedido). */
async function repoSub(roomId: number, repo: string): Promise<string | null> {
  const db = await import("../../db.server");
  const row = (await db.listRoomRepos(roomId).catch(() => [])).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
  return row?.connectedBy ?? null;
}

async function coveredByDepPr(ctx: AutomationCtx, alert: NonNullable<RepoEvent["alert"]>): Promise<number | null> {
  if (alert.kind !== "dependabot" || !alert.package) return null;
  const sub = await repoSub(Number(ctx.roomId), ctx.repo);
  if (!sub) return null;
  const prs = await fetchDepPrs(sub, ctx.repo);
  return prs ? (coveringPr(alert, prs)?.number ?? null) : null;
}

const defaultDeps: Deps = { openFactoryRun: openSecurityRun, coveredBy: coveredByDepPr, now: () => Date.now() };

/** ¿Le quedan intentos a esta alerta? Reserva el siguiente (1…3). */
async function takeAttempt(ctx: AutomationCtx, repo: string, alert: AlertRef): Promise<boolean> {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    if (await ctx.claim("security_fix", attemptKey(repo, alert, i), ATTEMPT_TTL_MS)) return true;
  }
  return false;
}

export function makeSecurityFix(deps: Deps = defaultDeps): Automation {
  return {
    kind: "security_fix",
    on: [
      "code_scanning_alert.created",
      "code_scanning_alert.reopened",
      "dependabot_alert.created",
      "dependabot_alert.reopened",
      "secret_scanning_alert.created",
      "secret_scanning_alert.reopened",
    ],
    async handle(ev, ctx) {
      if (ev.sender?.login === BOT_LOGIN || !ev.alert) return;
      const repo = ev.repo || ctx.repo;

      if (isSecretEvent(ev)) {
        // Una vez por aviso y acción al día: gs reintenta y GitHub reenvía.
        if (!(await ctx.claim("security_fix", `${repoKey(repo)}#secret-${ev.alert.number}:${ev.action}`, SECRET_NOTICE_TTL_MS))) return;
        if (!(await ctx.budget("security_fix"))) return;
        await ctx.post(buildSecretNotice(repo, ev.alert));
        return;
      }

      if (!isFixableEvent(ev)) return;
      const settings = await ctx.settings<{ minSeverity?: string }>("security_fix");
      const minSeverity = severityRank(settings?.minSeverity) ? String(settings.minSeverity).toLowerCase() : "high";
      if (!meetsSeverity(ev.alert.severity, minSeverity)) return;
      // Ya la sube un PR de Dependabot abierto: ése es el arreglo (la fábrica lo revisa por su lado).
      const cover = await deps.coveredBy?.(ctx, ev.alert).catch(() => null);
      if (cover) return;
      if (!(await takeAttempt(ctx, repo, ev.alert))) return;
      // Ya hay un lote abierto para el repo: el turno que viene la va a listar con las tools.
      if (!(await ctx.claim("security_fix", batchKey(repo), BATCH_WINDOW_S * 1000))) return;
      if (!(await ctx.budget("security_fix"))) return;

      const now = deps.now();
      const date = cdmxDate(now);
      const title = `Alertas de seguridad · ${repo} · ${date}`;
      // El pedido espera la ventana del lote: al vencer, la plataforma lista las alertas abiertas,
      // salta las que ya cubre un PR de Dependabot y reescribe el plan (`prepareSecurityRun`).
      const outcome = await deps.openFactoryRun(ctx, {
        repo,
        title,
        planMd: buildFixPrompt({ repo, first: ev.alert, minSeverity, date, factory: true }),
        first: ev.alert,
        dueAt: Math.floor(now / 1000) + BATCH_WINDOW_S,
        kindMeta: { minSeverity, first: alertId(ev.alert), alerts: 1 },
      });
      if (outcome !== "no_factory") return;

      // Sin fábrica: turno suelto de @build en un hilo propio.
      const opts = {
        handle: "build",
        text: buildFixPrompt({ repo, first: ev.alert, minSeverity, date }),
        threadKey: `security:${repoKey(repo)}:${Math.floor(now / 1000)}`,
        title,
        // Retraso durable para juntar el lote: el turno sale cuando ya llegaron las demás.
        delayS: BATCH_WINDOW_S,
      };
      await ctx.wake(opts);
    },
  };
}

export const automations: Automation[] = [makeSecurityFix()];

const SECURITY_WHO = "La automatización «Arreglar alertas»";

// ── El lote lo arma la plataforma: alertas abiertas ↔ PRs de Dependabot ──────────────────────
//
// GitHub es la fuente de verdad: al arrancar un pedido (vence la ventana) y en el barrido, se
// listan las alertas ABIERTAS ≥ severidad mínima y los PRs abiertos de Dependabot. Una alerta de
// Dependabot cuyo paquete ya sube un PR abierto (adoptado o no) se salta y se cita «la cubre #N»:
// no depende de que el modelo lo busque.

export type OpenAlert = NonNullable<RepoEvent["alert"]> & { fixedIn?: string | null };
export type DepPr = { number: number; title: string; head: string; body: string; url: string };

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * El PR de Dependabot que ya arregla la alerta: el paquete en el título («Bump lodash from…»),
 * en la rama (`dependabot/npm_and_yarn/lodash-4.17.21`, `…/babel/traverse-7.23.2`) o, en un PR
 * de grupo, en el cuerpo. Palabra completa: `lodash-es` no cubre `lodash`.
 */
export function coveringPr(a: Pick<OpenAlert, "kind" | "package">, prs: DepPr[]): DepPr | null {
  if (a.kind !== "dependabot" || !a.package) return null;
  const pkg = a.package.trim().toLowerCase();
  if (!pkg) return null;
  const bare = pkg.replace(/^@/, "");
  const word = new RegExp(`(^|[\\s\`'"(\\[])${escRe(pkg)}($|[\\s\`'"):,\\]])`);
  const ref = new RegExp(`/${escRe(bare)}(-\\d|$)`);
  for (const pr of prs) {
    const title = pr.title.toLowerCase();
    if (word.test(title)) return pr;
    if (pr.head.toLowerCase().startsWith("dependabot/") && ref.test(pr.head.toLowerCase())) return pr;
    if (/\bgroup\b/.test(title) && (pr.body.toLowerCase().includes(`[${pkg}]`) || word.test(pr.body.toLowerCase()))) return pr;
  }
  return null;
}

/**
 * Del total de abiertas: las candidatas (≥ severidad, sin PR que las cubra), de la más grave a la
 * menos y por número, y las cubiertas con su PR. El tope y los intentos se aplican después.
 */
export function planBatch(alerts: OpenAlert[], prs: DepPr[], minSeverity: string): { candidates: OpenAlert[]; covered: { alert: OpenAlert; pr: number }[] } {
  const candidates: OpenAlert[] = [];
  const covered: { alert: OpenAlert; pr: number }[] = [];
  for (const a of alerts) {
    if (a.kind === "secret_scanning" || !(Number(a.number) > 0) || !meetsSeverity(a.severity, minSeverity)) continue;
    const pr = coveringPr(a, prs);
    if (pr) covered.push({ alert: a, pr: pr.number });
    else candidates.push(a);
  }
  candidates.sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || x.number - y.number);
  return { candidates, covered };
}

/** El plan con la lista ya hecha por la plataforma (pedido de la fábrica o turno suelto). */
export function batchPlanMd(o: { repo: string; take: OpenAlert[]; covered: { alert: OpenAlert; pr: number }[]; minSeverity: string; date: string; factory?: boolean }): string {
  const branch = `ghosty/security-fix-${o.date}`;
  const fix = (a: OpenAlert) => alertLine(a) + (a.fixedIn ? ` · se arregla en \`${clean(a.fixedIn, 40)}\`` : "");
  return [
    `🛡️ **Alertas de seguridad en \`${o.repo}\`** (automatización «Arreglar alertas», severidad mínima: ${o.minSeverity}).`,
    "",
    `Arregla estas ${o.take.length} (las listó la plataforma, de la más grave a la menos):`,
    ...o.take.map(fix),
    ...(o.covered.length
      ? ["", "No las toques: ya las cubre un PR de Dependabot abierto (la fábrica revisa esos PRs por su lado):", ...o.covered.map((c) => `${alertLine(c.alert)} — la cubre #${c.pr}`)]
      : []),
    "",
    "Qué hacer:",
    "1. Lee el detalle de cada una con `github_code_scanning_alerts` o `github_dependabot_alerts` (con `number`) y arréglala de raíz: el código vulnerable o la versión del paquete (la que indica `fixedIn`).",
    "2. Corre los tests y el build del repo. Si algo se rompe por un arreglo, quita ese arreglo en vez de entregar rojo.",
    `3. Abre UN PR en BORRADOR desde la rama \`${branch}\` (si ya existe, agrégale \`-2\`, \`-3\`…). En la descripción cita cada alerta arreglada con su número y su liga.`,
    "4. Comenta en el PR las que NO pudiste arreglar y por qué (sin versión que lo arregle, cambio de API, falso positivo probable…).",
    "",
    "Nunca descartes (dismiss) alertas, nunca hagas merge y nunca empujes a ramas de otras personas.",
    o.factory
      ? "Criterio para @check: cada alerta citada en el PR está arreglada en el diff (no silenciada ni ignorada con un comentario), tests y build en verde, y las pendientes comentadas con su razón."
      : "Al terminar, deja aquí la liga del PR y el conteo: arregladas / pendientes.",
  ].join("\n");
}

/** Alertas abiertas de code scanning y Dependabot. null = GitHub no contestó ninguna de las dos. */
export async function fetchOpenAlerts(sub: string, repo: string): Promise<OpenAlert[] | null> {
  const { githubApi } = await import("../connectors/github.server");
  const [cs, dep] = await Promise.all([
    githubApi(sub, `/repos/${repo}/code-scanning/alerts?state=open&per_page=100`).catch(() => null),
    githubApi(sub, `/repos/${repo}/dependabot/alerts?state=open&per_page=100`).catch(() => null),
  ]);
  if (!Array.isArray(cs) && !Array.isArray(dep)) return null;
  const out: OpenAlert[] = [];
  for (const x of Array.isArray(cs) ? cs : [])
    out.push({ kind: "code_scanning", number: Number(x?.number), severity: x?.rule?.security_severity_level ?? x?.rule?.severity, rule: x?.rule?.id, url: x?.html_url });
  for (const x of Array.isArray(dep) ? dep : [])
    out.push({
      kind: "dependabot",
      number: Number(x?.number),
      severity: x?.security_advisory?.severity ?? x?.security_vulnerability?.severity,
      package: x?.dependency?.package?.name,
      fixedIn: x?.security_vulnerability?.first_patched_version?.identifier ?? null,
      url: x?.html_url,
    });
  return out.filter((a) => a.number > 0);
}

/** PRs abiertos de Dependabot del repo. null = GitHub no contestó. */
export async function fetchDepPrs(sub: string, repo: string): Promise<DepPr[] | null> {
  const { githubApi } = await import("../connectors/github.server");
  const prs = await githubApi(sub, `/repos/${repo}/pulls?state=open&per_page=100`).catch(() => null);
  if (!Array.isArray(prs)) return null;
  return prs
    .filter((p: any) => isDependabot(p?.user?.login))
    .map((p: any) => ({ number: Number(p.number), title: String(p.title ?? ""), head: String(p.head?.ref ?? ""), body: String(p.body ?? ""), url: String(p.html_url ?? "") }));
}

/** Las que entran al lote: hasta el tope, cada una gastando un intento (las agotadas se saltan). */
async function takeBatch(ctx: AutomationCtx, repo: string, candidates: OpenAlert[], already: Set<string>): Promise<OpenAlert[]> {
  const take: OpenAlert[] = [];
  for (const a of candidates) {
    if (take.length >= MAX_ALERTS_PER_PR) break;
    if (already.has(alertId(a)) || (await takeAttempt(ctx, repo, a))) take.push(a);
  }
  return take;
}

const minSeverityOf = (v: unknown) => (severityRank(String(v ?? "")) ? String(v).toLowerCase() : "high");

/**
 * Preparación al vencer la ventana (la llama `startDueAdoptedRuns`): reescribe el plan v1 con las
 * alertas abiertas que nadie cubre y pone el conteo en el título y la tarjeta. Sin ninguna, el
 * pedido se cancela con su razón. Si GitHub no contesta se queda el plan provisional (que pide a
 * @build listarlas).
 */
export async function prepareSecurityRun(run: import("../apps/factory-runs.server").Run): Promise<{ skip?: string } | void> {
  if (!run.repo) return;
  const meta = run.kindMeta ?? {};
  const minSeverity = minSeverityOf(meta.minSeverity);
  const alerts = await fetchOpenAlerts(run.approvedBy ?? run.requestedBy, run.repo);
  if (!alerts) return;
  const prs = (await fetchDepPrs(run.approvedBy ?? run.requestedBy, run.repo)) ?? [];
  const { candidates, covered } = planBatch(alerts, prs, minSeverity);
  const { currentNamespace } = await import("../tenant.server");
  const { automationCtx } = await import("./ctx.server");
  const ctx = automationCtx({ ns: await currentNamespace(), roomId: run.channelId, repo: run.repo, kind: "security_fix" });
  const take = await takeBatch(ctx, run.repo, candidates, new Set(typeof meta.first === "string" ? [meta.first] : []));
  if (!take.length) {
    const why = covered.length ? ` (${covered.length} ya las cubre${covered.length === 1 ? "" : "n"} un PR de Dependabot)` : "";
    return { skip: `🛡️ Ya no queda ninguna alerta abierta de severidad ${minSeverity} o mayor sin cubrir${why}. No hace falta construir nada.` };
  }
  await savePlanAndMeta(run.id, run.planVersion || 1, {
    title: securityTitle(take.length, run.repo, cdmxDate()),
    planMd: batchPlanMd({ repo: run.repo, take, covered, minSeverity, date: cdmxDate(), factory: true }),
    meta: { ...meta, minSeverity, alerts: take.length, covered: covered.map((c) => ({ alert: alertId(c.alert), pr: c.pr })) },
  });
}

/** «Seguridad: 3 alertas · acme/web · 2026-10-25». */
export function securityTitle(n: number, repo: string, date: string): string {
  return `Seguridad: ${n} ${n === 1 ? "alerta" : "alertas"} · ${repo} · ${date}`;
}

async function savePlanAndMeta(runId: number, version: number, o: { title: string; planMd: string; meta: Record<string, unknown> }) {
  const { dbq } = await import("../../dbq.server");
  await dbq("UPDATE gt_factory_plans SET plan_md = ? WHERE run_id = ? AND version = ?", [o.planMd, runId, version]);
  await dbq("UPDATE gt_factory_runs SET title = ?, kind_meta = ? WHERE id = ?", [o.title.slice(0, 200), JSON.stringify(o.meta), runId]);
}

// ── Barrido: alertas que llegaron mientras otro pedido trabajaba ─────────────────────────────
//
// Con un pedido de seguridad vivo, las alertas nuevas no abren otro (uno por repo). Al cerrarse
// ese pedido, o cada `sweepHours` (default 6), se listan las abiertas que nadie cubre y se abre un
// pedido nuevo con ellas (o el turno suelto de @build sin fábrica). Sólo repos con security_fix
// prendido. Los intentos por alerta (3) frenan las que no se dejan arreglar.

export const SWEEP_HOURS = 6;
const lastClosedSeen = new Map<string, number>();

/** ¿Toca barrer? Al cerrarse un pedido de seguridad desde la última vista, o por horario. */
export function sweepTrigger(prevClosedAt: number | undefined, closedAt: number): "closed" | null {
  return prevClosedAt !== undefined && closedAt > prevClosedAt ? "closed" : null;
}

type SweepDeps = Pick<Deps, "openFactoryRun"> & {
  rows(): Promise<{ roomId: number; repo: string; settings: Record<string, unknown> }[]>;
  liveRuns(repo: string): Promise<number>;
  lastClosedAt(repo: string): Promise<number>;
  ctxOf(roomId: number, repo: string): AutomationCtx;
  sub(roomId: number, repo: string): Promise<string | null>;
  alerts(sub: string, repo: string): Promise<OpenAlert[] | null>;
  depPrs(sub: string, repo: string): Promise<DepPr[] | null>;
  now(): number;
};

export async function sweepSecurityAlerts(ns: string, d?: Partial<SweepDeps>): Promise<number> {
  const deps: SweepDeps = { ...(await defaultSweepDeps(ns)), ...d };
  let opened = 0;
  for (const row of await deps.rows()) {
    const repo = row.repo;
    if ((await deps.liveRuns(repo)) > 0) continue;
    const seenKey = `${ns}:${row.roomId}:${repo.toLowerCase()}`;
    const closedAt = await deps.lastClosedAt(repo);
    const trigger = sweepTrigger(lastClosedSeen.get(seenKey), closedAt);
    lastClosedSeen.set(seenKey, closedAt);
    const ctx = deps.ctxOf(row.roomId, repo);
    const hours = typeof row.settings.sweepHours === "number" && row.settings.sweepHours > 0 ? row.settings.sweepHours : SWEEP_HOURS;
    // El horario es durable (claim con vencimiento): un reinicio no barre de más.
    if (!trigger && !(await ctx.claim("security_fix", `${repoKey(repo)}:security:sweep:${row.roomId}`, hours * 3600_000))) continue;
    const sub = await deps.sub(row.roomId, repo);
    if (!sub) continue;
    const alerts = await deps.alerts(sub, repo);
    if (!alerts?.length) continue;
    const minSeverity = minSeverityOf(row.settings.minSeverity);
    const { candidates, covered } = planBatch(alerts, (await deps.depPrs(sub, repo)) ?? [], minSeverity);
    if (!candidates.length) continue;
    // Un lote del webhook en curso ya las va a listar.
    if (!(await ctx.claim("security_fix", batchKey(repo), BATCH_WINDOW_S * 1000))) continue;
    const take = await takeBatch(ctx, repo, candidates, new Set());
    if (!take.length || !(await ctx.budget("security_fix"))) continue;
    const date = cdmxDate(deps.now());
    const title = securityTitle(take.length, repo, date);
    const outcome = await deps.openFactoryRun(ctx, {
      repo,
      title,
      planMd: batchPlanMd({ repo, take, covered, minSeverity, date, factory: true }),
      first: take[0],
      kindMeta: { minSeverity, alerts: take.length, covered: covered.map((c) => ({ alert: alertId(c.alert), pr: c.pr })), sweep: true },
    });
    if (outcome === "opened") opened++;
    if (outcome !== "no_factory") continue;
    await ctx.wake({
      handle: "build",
      text: batchPlanMd({ repo, take, covered, minSeverity, date }),
      threadKey: `security:${repoKey(repo)}:${Math.floor(deps.now() / 1000)}`,
      title,
    });
    opened++;
  }
  return opened;
}

async function defaultSweepDeps(ns: string): Promise<SweepDeps> {
  const { dbq } = await import("../../dbq.server");
  const { automationCtx } = await import("./ctx.server");
  return {
    openFactoryRun: openSecurityRun,
    async rows() {
      const rows = await dbq("SELECT room_id, repo, settings_json FROM gt_repo_automations WHERE kind = 'security_fix' AND enabled = 1", []).catch(() => []);
      return rows.map((r) => {
        let settings: Record<string, unknown> = {};
        try {
          const v = JSON.parse(String(r.settings_json ?? "{}"));
          if (v && typeof v === "object" && !Array.isArray(v)) settings = v;
        } catch {}
        return { roomId: Number(r.room_id), repo: String(r.repo), settings };
      });
    },
    liveRuns: async (repo) => (await import("../apps/factory-adopt.server")).liveRunsOfKind("security", repo),
    async lastClosedAt(repo) {
      const [r] = await dbq(
        "SELECT MAX(updated_at) AS t FROM gt_factory_runs WHERE kind = 'security' AND LOWER(repo) = LOWER(?) AND status IN ('done','cancelled')",
        [repo],
      ).catch(() => [{ t: 0 }]);
      return Number(r?.t ?? 0);
    },
    ctxOf: (roomId, repo) => automationCtx({ ns, roomId, repo, kind: "security_fix" }),
    sub: repoSub,
    alerts: fetchOpenAlerts,
    depPrs: fetchDepPrs,
    now: () => Date.now(),
  };
}
