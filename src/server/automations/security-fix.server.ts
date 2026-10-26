// ── security_fix: alertas de seguridad del repo → UN PR borrador con los arreglos en lote ──
//
// Como el autofix agéntico de GitHub (GA 15-oct-2026): code scanning y Dependabot avisan por
// alerta, pero un análisis de CodeQL o un aviso nuevo de una librería sueltan decenas en segundos.
// Despertar a @build por cada una serían decenas de turnos y de PRs. Se agrupa:
//
// 1. La PRIMERA alerta del repo abre la ventana (`claim` de `<repo>:security:batch`, 10 min).
//    Con la fábrica instalada abre un PEDIDO de la fábrica con el plan ya firmado (el camino de
//    cualquier pedido: caja, git, @check, CI rojo → @build, tarjeta; un solo pedido vivo por repo).
//    Sin fábrica, un turno suelto de @build con retraso (`delayS`; si el ctx no lo soporta sale ya).
// 2. Las que llegan dentro de la ventana no despiertan a nadie: cuando @build corre, LISTA las
//    abiertas con las tools (GitHub es la fuente de verdad, ya trae las que llegaron después y no
//    las que alguien cerró a mano) y arregla hasta 25 en un PR borrador.
//
// Secret scanning NO se arregla con código: borrar la línea no sirve (el secreto sigue en la
// historia y ya hay que darlo por quemado). Se avisa DIRECTO en el room, sin turno de ningún
// agente: así el aviso no le da a un modelo ni la oportunidad de pedir el valor, y el texto se arma
// sólo con campos de una lista blanca (número, tipo, liga). El secreto jamás viaja.
import type { Automation, AutomationCtx, RepoEvent } from "./types";

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
export const attemptKey = (repo: string, alert: NonNullable<RepoEvent["alert"]>, i: number) =>
  `${repoKey(repo)}#${alert.kind}-${alert.number}:${i}`;

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

type Deps = {
  /** Aviso directo en el room, sin turno de agente. */
  postNotice(ctx: AutomationCtx, body: string): Promise<void>;
  /** El lote como pedido de la fábrica (caja, git, @check, CI, tarjeta). */
  openFactoryRun(ctx: AutomationCtx, o: { repo: string; title: string; planMd: string; first: NonNullable<RepoEvent["alert"]> }): Promise<FactoryOutcome>;
  now(): number;
};

/**
 * Un pedido de la fábrica con el plan ya firmado, como los tickets de sprint que se aprueban solos:
 * `openAdoptedRun` (lo mismo que adopta los PRs de Dependabot) + `decide`, que pide la caja, encola
 * si no hay lugar y le pasa el encargo a @build. Así @build empuja con `factory_git_remote` (un
 * turno suelto no puede: esa tool exige pedido) y el resto del camino es el de cualquier pedido.
 * Un solo pedido vivo por repo: el que corre ya lista las alertas abiertas.
 */
async function openSecurityRun(
  ctx: AutomationCtx,
  o: { repo: string; title: string; planMd: string; first: NonNullable<RepoEvent["alert"]> },
): Promise<FactoryOutcome> {
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
  });
  const { dbq } = await import("../../dbq.server");
  await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, 1, ?)", [run.id, o.planMd]);
  const R = await import("../apps/factory-runs.server");
  await R.decide({ run, version: 1, decision: "approve", sub: row.connectedBy, who: "La automatización «Arreglar alertas»", origin: "" });
  void R.refreshRoom(channelId);
  return "opened";
}

/** Publica en el room como un agente del espacio, igual que los avisos de PR (`postAgent`, no despierta a nadie). */
async function postRoomNotice(ctx: AutomationCtx, body: string): Promise<void> {
  const channelId = Number(ctx.roomId);
  if (!Number.isFinite(channelId) || channelId <= 0) return;
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { resolvedAgents } = await import("../../agents.server");
  const agents = (await resolvedAgents()).filter((a) => !["plan", "build", "check", "eval"].includes(a.handle));
  const who = agents[0] ?? { handle: "ghosty", name: "Ghosty", avatar: "" };
  const { id } = await db.postAgent(channelId, null, body, "msg", who.handle, who.name, "general", who.avatar);
  const msg = await db.getMessage(id);
  if (msg) bus.publish(bus.ch.room(ctx.ns, channelId), { t: "message:new", msg });
}

const defaultDeps: Deps = { postNotice: postRoomNotice, openFactoryRun: openSecurityRun, now: () => Date.now() };

/** ¿Le quedan intentos a esta alerta? Reserva el siguiente (1…3). */
async function takeAttempt(ctx: AutomationCtx, repo: string, alert: NonNullable<RepoEvent["alert"]>): Promise<boolean> {
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
        await deps.postNotice(ctx, buildSecretNotice(repo, ev.alert));
        return;
      }

      if (!isFixableEvent(ev)) return;
      const settings = await ctx.settings<{ minSeverity?: string }>("security_fix");
      const minSeverity = severityRank(settings?.minSeverity) ? String(settings.minSeverity).toLowerCase() : "high";
      if (!meetsSeverity(ev.alert.severity, minSeverity)) return;
      if (!(await takeAttempt(ctx, repo, ev.alert))) return;
      // Ya hay un lote abierto para el repo: el turno que viene la va a listar con las tools.
      if (!(await ctx.claim("security_fix", batchKey(repo), BATCH_WINDOW_S * 1000))) return;
      if (!(await ctx.budget("security_fix"))) return;

      const now = deps.now();
      const date = cdmxDate(now);
      const title = `Alertas de seguridad · ${repo} · ${date}`;
      const outcome = await deps.openFactoryRun(ctx, { repo, title, planMd: buildFixPrompt({ repo, first: ev.alert, minSeverity, date, factory: true }), first: ev.alert });
      if (outcome !== "no_factory") return;

      // Sin fábrica: turno suelto de @build en un hilo propio.
      const opts = {
        handle: "build",
        text: buildFixPrompt({ repo, first: ev.alert, minSeverity, date }),
        threadKey: `security:${repoKey(repo)}:${Math.floor(now / 1000)}`,
        title,
        // Retraso para juntar el lote. Campo opcional pedido a EVENTOS; si su `wake` no lo
        // conoce, lo ignora y el turno sale ya (sigue funcionando: @build relista con las tools).
        delayS: BATCH_WINDOW_S,
      };
      await ctx.wake(opts as Parameters<AutomationCtx["wake"]>[0]);
    },
  };
}

export const automations: Automation[] = [makeSecurityFix()];
