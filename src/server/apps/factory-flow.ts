// Máquina de estados de una corrida de la Software Factory. Pura (sin DB) para probarla.
//
//   planning ──plan_submitted──▶ plan_review ──approve──▶ building ──build_done──▶ checking
//      ▲                            │                        ▲                       │
//      └──────────changes───────────┘                        └──check_fail (<3)──────┤
//                                                                                    ├─check_fail (3ª)──▶ escalated
//                                                                                    └─check_pass──▶ pr_review ──close──▶ done
//   pr_review ──conflict──▶ building   (otro PR entró antes y éste ya no mezcla limpio)
//   pr_review ──rework────▶ building   (una persona pidió más sobre el PR listo: factory_note)
//   cualquiera ──cancel──▶ cancelled
//
// Por qué un tope de 3 vueltas build↔check: si @check sigue encontrando huecos después de
// tres correcciones, el problema es el plan o el diseño, y eso lo decide una persona.

export type RunStatus =
  | "planning"
  | "plan_review"
  | "building"
  | "checking"
  | "pr_review"
  | "escalated"
  | "done"
  | "cancelled";

export type RunEvent = "plan_submitted" | "approve" | "changes" | "build_done" | "check_pass" | "check_fail" | "check_blocked" | "close" | "merged" | "cancel" | "conflict" | "rework" | "recheck";

export const MAX_LOOPS = 3;

/** El estado siguiente, o null si el evento no aplica en este estado. */
export function nextStatus(status: RunStatus, event: RunEvent, loops = 0): RunStatus | null {
  if (event === "cancel") return status === "done" || status === "cancelled" ? null : "cancelled";
  // El PR se mezcló en GitHub: el pedido terminó, vaya en la etapa que vaya (alguien pudo
  // mezclarlo sin esperar a @check).
  if (event === "merged") return status === "done" || status === "cancelled" ? null : "done";
  switch (status) {
    case "planning":
      return event === "plan_submitted" ? "plan_review" : null;
    case "plan_review":
      if (event === "approve") return "building";
      if (event === "changes") return "planning";
      // @plan puede mandar otra versión antes de que alguien firme (se corrigió solo).
      if (event === "plan_submitted") return "plan_review";
      return null;
    case "building":
      return event === "build_done" ? "checking" : null;
    case "checking":
      if (event === "check_pass") return "pr_review";
      if (event === "check_fail") return loops + 1 >= MAX_LOOPS ? "escalated" : "building";
      // Lo que falta no lo puede hacer @build (una tool, un permiso, un acceso): regresárselo
      // sólo gasta vueltas. Pasa directo a una persona.
      if (event === "check_blocked") return "escalated";
      return null;
    case "escalated":
      // Una persona decide: mandar a construir otra vez o replanear.
      if (event === "approve") return "building";
      if (event === "changes") return "planning";
      // Lo que bloqueaba lo resolvió una persona (variables de la preview, un acceso): @check
      // vuelve a revisar el MISMO PR. Mandarlo a @build gastaba una vuelta en nada (#125, 20-oct).
      if (event === "recheck") return "checking";
      return null;
    case "pr_review":
      if (event === "conflict" || event === "rework") return "building";
      return event === "close" ? "done" : null;
    default:
      return null;
  }
}

/**
 * ¿El `check_fail` gasta una vuelta? Sólo si @build cambió código: la cabeza del PR es otra
 * que la que @check revisó la última vez. Si re-cerró sin commits o el ciclo se repitió por un
 * error de la plataforma, no se cobra (pedido #10: 2 de sus 3 vueltas las gastó la plataforma).
 * Una sola vuelta gratis por cabeza: si la anterior tampoco contó, ésta sí, para que un @build
 * que re-cierra sin cambiar nada no gire para siempre. Sin dato de GitHub, cuenta.
 */
export function countsLoop(opts: { checkedSha: string | null; headSha: string | null; prevUncounted: boolean }): boolean {
  if (!opts.checkedSha || !opts.headSha) return true;
  if (opts.headSha !== opts.checkedSha) return true;
  return opts.prevUncounted;
}

/** Etiqueta de la etapa en la tarea de Tasks. */
export function stageLabel(status: RunStatus): string {
  return (
    {
      planning: "plan",
      plan_review: "esperando aprobación",
      building: "build",
      checking: "check",
      pr_review: "PR",
      escalated: "necesita decisión",
      done: "listo",
      cancelled: "cancelada",
    } as const
  )[status];
}

/**
 * ¿Una respuesta en el hilo es una firma? «✅», «aprobado», «va», «sí» → aprobar;
 * «cambios: …» → pedir cambios con esa nota. Lo demás no se interpreta: mejor que la
 * persona use el botón que adivinar una firma.
 */
export function parseThreadDecision(text: string): { decision: "approve" } | { decision: "changes"; note: string } | null {
  const t = text.trim();
  if (!t || t.length > 2000) return null;
  const m = t.match(/^(?:cambios?|cambia|pido cambios)\s*[:：-]\s*([\s\S]+)$/i);
  if (m && m[1].trim()) return { decision: "changes", note: m[1].trim() };
  if (/^(✅|👍|☑️|✔️)+\s*$/u.test(t)) return { decision: "approve" };
  if (/^(aprobad[oa]|apruebo|aprobar|va|dale|s[ií]|ok|adelante|lgtm)[\s.!]*$/i.test(t)) return { decision: "approve" };
  return null;
}

// ── El escalado con tipo (easybits, 20-oct) ──────────────────────────────────
//
// «Te toca 8» y ocho tarjetas sin decir qué decidir: 5 eran la misma falla de la plataforma (la
// preview nunca salió de `pending`) y 3 decisiones reales. Cada escalado lleva ahora un tipo, un
// motivo de un renglón y los botones que lo resuelven. gs replica `needsYou` tal cual.

/**
 * - `env`: faltan variables o credenciales (las da una persona).
 * - `fix`: @build lo puede arreglar en la rama (hermanos de un grupo de Dependabot, un tipo).
 * - `skip`: no conviene este bump: cerrar el PR (y que Dependabot lo ignore).
 * - `decision`: una persona elige entre caminos.
 * - `platform`: falla nuestra (la preview no arrancó). Nunca la elige @check: la pone el sistema.
 */
export type EscalationKind = "env" | "fix" | "skip" | "decision" | "platform";
export const ESCALATION_KINDS: readonly EscalationKind[] = ["env", "fix", "skip", "decision", "platform"];

/** Lo que se le ofrece a la persona según el tipo (mismo orden que los botones). */
export type EscalationAction = "env" | "recheck" | "fix" | "replan" | "close" | "close_ignore" | "advise" | "retry_preview";
export const ESCALATION_ACTIONS: Record<EscalationKind, EscalationAction[]> = {
  env: ["env", "recheck"],
  fix: ["fix", "replan"],
  skip: ["close", "close_ignore", "fix"],
  decision: ["advise", "fix", "replan"],
  platform: ["retry_preview", "recheck"],
};

export function isEscalationKind(v: unknown): v is EscalationKind {
  return typeof v === "string" && (ESCALATION_KINDS as readonly string[]).includes(v);
}

// Variables que faltan: «faltan las variables», «DATABASE_URL no está», «.env.example»…
const ENV_HINT =
  /variables? de entorno|\benv(ironment)? ?var(iable)?s?\b|\.env(\.example)?\b|faltan? (las |unas |\d+ )?variables|missing (env|environment|secret)/i;
// Un nombre de variable en mayúsculas que suena a credencial (`STRIPE_SECRET_KEY`, `DATABASE_URL`).
const ENV_NAME_HINT = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(KEY|SECRET|TOKEN|URL)\b/;
// La preview que no llegó: «preview pending», «factory_preview sigue construyendo», «no arrancó»…
const PLATFORM_HINT =
  /factory_preview|preview[^.\n]{0,60}(pending|pendiente|constru|en camino|no (arranc|lleg|est[áa] lista|existe)|nunca)|(pending|pendiente)[^.\n]{0,40}preview/i;

// GitHub limitó las peticiones (#137 de business, 20-oct: «github_pr_files, github_pr_checks y
// github_get_pr devolvieron "GitHub está limitando las peticiones"»). Es de la plataforma, no una
// decisión. Pide que se nombre a GitHub (o la frase de nuestros conectores) para no confundirlo con
// un PR que agrega rate limiting a una API. Un 403 suelto no cuenta: también es «sin permiso».
const RATE_LIMIT_HINT =
  /est[áa] limitando las peticiones|secondary rate limit|api rate limit exceeded|github[^.\n]{0,80}(rate.?limit|l[íi]mite de (peticiones|solicitudes)|\b429\b)|(rate.?limit|\b429\b)[^.\n]{0,80}github/i;

/** ¿Los hallazgos (o el motivo) dicen que GitHub limitó las peticiones? */
export function isGithubRateLimit(text: string): boolean {
  return RATE_LIMIT_HINT.test(String(text ?? ""));
}

/** Espera por defecto si GitHub no dijo cuándo se libera. */
export const RATE_LIMIT_RETRY_S = 15 * 60;

/** El motivo de un escalado por límite de GitHub, con los minutos que faltan para que @check revise sola. */
export function rateLimitReason(retryAt: number, now = Math.floor(Date.now() / 1000)): string {
  const min = Math.max(1, Math.ceil((retryAt - now) / 60));
  return `GitHub limitó las peticiones; @check revisa otra vez sola en ${min} min.`;
}

/** Escalados viejos (sin `kind`): se deduce con las señales que ya había en los hallazgos. */
export function deduceEscalationKind(findings: string): EscalationKind {
  const f = String(findings ?? "");
  if (isGithubRateLimit(f)) return "platform";
  if (ENV_HINT.test(f) || ENV_NAME_HINT.test(f)) return "env";
  if (PLATFORM_HINT.test(f)) return "platform";
  return "decision";
}

/** Un renglón llano (≤140) para la tarjeta, el push y la Live Activity. */
export function clipReason(text: string, max = 140): string {
  const t = String(text ?? "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * ¿Le toca a una persona? La regla que gs y la app replican (una sola fuente de verdad):
 * firmar un plan sí; un escalado sí salvo que sea falla de la plataforma; un PR listo sí salvo
 * que vaya a entrar solo (automerge o merge en cola, igual que `viewState`); lo demás no.
 */
export function needsYou(
  run: { status: RunStatus },
  escalation: { kind: EscalationKind } | null | undefined,
  opts: { merge?: "auto" | "queued" | null } = {},
): boolean {
  if (run.status === "plan_review") return true;
  if (run.status === "escalated") return (escalation?.kind ?? "decision") !== "platform";
  if (run.status === "pr_review") return !opts.merge;
  return false;
}

// ── Lo que ve la persona (barra del hilo, panel y tablero) ───────────────────
//
// Lo CALCULA la plataforma con el estado y la última actividad; el modelo nunca declara
// «listo» (patrón de Linear: el estado de la sesión sale de sus actividades).

export type ViewColumn = "planning" | "waiting" | "building" | "checking" | "ready" | "closed";
export type PrimaryAction = "sign" | "merge" | "decide" | "resume" | "stop" | null;

export type RunView = {
  column: ViewColumn;
  /** Texto corto de la etapa para la barra. */
  label: string;
  /** Abierto, sin actividad en `staleAfter` s y sin turno en vuelo. */
  stale: boolean;
  /** A quién le toca: una persona o el rol que trabaja. */
  whoseTurn: { kind: "person"; sub: string } | { kind: "agent"; handle: "plan" | "build" | "check" } | null;
  primary: PrimaryAction;
};

export function viewState(
  run: { status: RunStatus; requestedBy: string; approvedBy?: string | null; boxWaiting?: boolean; dueAt?: number | null },
  opts: {
    lastActivityAt: number;
    now: number;
    busy: boolean;
    staleAfter?: number;
    waitingOn?: string | null;
    /** PR aprobado que entra solo: `auto` = automerge del room, `queued` = alguien picó «Merge» con el CI corriendo. */
    merge?: "auto" | "queued" | null;
    /** El tipo del último escalado (`escalationOf`): `platform` no le toca a nadie. */
    escalationKind?: EscalationKind | null;
  },
): RunView {
  const open = !["done", "cancelled"].includes(run.status);
  // Firmado pero sin lugar en el tier: espera su caja. No es «Construyendo» ni «Sin avanzar», y
  // nadie tiene que hacer nada: arranca solo cuando se libere un lugar.
  if (run.boxWaiting && run.status === "building")
    return { column: "waiting", label: "En espera de lugar", stale: false, whoseTurn: null, primary: "stop" };
  // Un rol le preguntó algo a la persona: le toca a ella, no está «parado».
  if (opts.waitingOn && !opts.busy && ["planning", "building", "checking"].includes(run.status))
    return { column: "waiting", label: "Espera tu respuesta", stale: false, whoseTurn: { kind: "person", sub: run.requestedBy }, primary: null };
  const working = ["planning", "building", "checking"].includes(run.status);
  const stale = working && !opts.busy && opts.now - opts.lastActivityAt >= (opts.staleAfter ?? 30 * 60);
  const owner = { kind: "person" as const, sub: run.requestedBy };
  const reviewer = { kind: "person" as const, sub: run.approvedBy || run.requestedBy };
  switch (run.status) {
    case "planning":
      return { column: stale ? "waiting" : "planning", label: stale ? "Sin avanzar" : "Planeando", stale, whoseTurn: stale ? owner : { kind: "agent", handle: "plan" }, primary: stale ? "resume" : "stop" };
    case "plan_review":
      // Adoptado con hora (lote de alertas): arranca solo, nadie tiene que firmar (se puede antes).
      if (run.dueAt) return { column: "waiting", label: "Arranca solo", stale: false, whoseTurn: null, primary: "sign" };
      return { column: "waiting", label: "Espera tu firma", stale: false, whoseTurn: owner, primary: "sign" };
    case "building":
      return { column: stale ? "waiting" : "building", label: stale ? "Sin avanzar" : "Construyendo", stale, whoseTurn: stale ? owner : { kind: "agent", handle: "build" }, primary: stale ? "resume" : "stop" };
    case "checking":
      return { column: stale ? "waiting" : "checking", label: stale ? "Sin avanzar" : "En revisión", stale, whoseTurn: stale ? owner : { kind: "agent", handle: "check" }, primary: stale ? "resume" : "stop" };
    case "pr_review":
      // Entra solo: no le toca a nadie (no cuenta en «Sólo lo mío») y no se pide «Merge».
      if (opts.merge) return { column: "ready", label: opts.merge === "auto" ? "Se mergea solo" : "Merge en cola", stale: false, whoseTurn: null, primary: null };
      return { column: "ready", label: "Listo para merge", stale: false, whoseTurn: reviewer, primary: "merge" };
    case "escalated":
      // Falla de la plataforma (la preview no arrancó): nadie tiene que decidir; se reintenta sola.
      if (opts.escalationKind === "platform") return { column: "checking", label: "Esperando preview", stale: false, whoseTurn: null, primary: null };
      return { column: "waiting", label: "Necesita tu decisión", stale: false, whoseTurn: owner, primary: "decide" };
    default:
      return { column: "closed", label: run.status === "done" ? "Terminado" : "Cancelado", stale: false, whoseTurn: open ? owner : null, primary: null };
  }
}

/**
 * El cuerpo de un PR con `Closes #n` al final, salvo que ya lo cierre (`close[sd]`, `fix(es|ed)`,
 * `resolve[sd]` + `#n`, como los lee GitHub). Lo pone la plataforma, no el modelo.
 */
export function withClosingRef(body: string | null | undefined, n: number): string {
  const b = String(body ?? "");
  if (new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s*:?\\s+#${n}\\b`, "i").test(b)) return b;
  return `${b.replace(/\s+$/, "")}${b.trim() ? "\n\n" : ""}Closes #${n}`;
}

/**
 * Si un PR aprobado entra solo. `queuedBy`/`queuedAuto` son las columnas del pedido; `roomAuto`,
 * el automerge del room. Con el room encendido y el pedido aún sin ver (NULL) también es `auto`:
 * el tick lo forma en la cola en la siguiente vuelta. `queuedAuto = 0` = anterior al default.
 */
export function mergeMode(queuedBy: unknown, queuedAuto: unknown, roomAuto: boolean): "auto" | "queued" | null {
  if (queuedBy) return Number(queuedAuto) === 1 ? "auto" : "queued";
  return roomAuto && queuedAuto == null ? "auto" : null;
}
