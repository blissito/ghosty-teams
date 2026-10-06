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

export type RunEvent = "plan_submitted" | "approve" | "changes" | "build_done" | "check_pass" | "check_fail" | "check_blocked" | "close" | "merged" | "cancel" | "conflict" | "rework";

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
  run: { status: RunStatus; requestedBy: string; approvedBy?: string | null },
  opts: { lastActivityAt: number; now: number; busy: boolean; staleAfter?: number; waitingOn?: string | null },
): RunView {
  const open = !["done", "cancelled"].includes(run.status);
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
      return { column: "waiting", label: "Espera tu firma", stale: false, whoseTurn: owner, primary: "sign" };
    case "building":
      return { column: stale ? "waiting" : "building", label: stale ? "Sin avanzar" : "Construyendo", stale, whoseTurn: stale ? owner : { kind: "agent", handle: "build" }, primary: stale ? "resume" : "stop" };
    case "checking":
      return { column: stale ? "waiting" : "checking", label: stale ? "Sin avanzar" : "En revisión", stale, whoseTurn: stale ? owner : { kind: "agent", handle: "check" }, primary: stale ? "resume" : "stop" };
    case "pr_review":
      return { column: "ready", label: "Listo para merge", stale: false, whoseTurn: reviewer, primary: "merge" };
    case "escalated":
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
