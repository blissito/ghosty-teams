// Máquina de estados de una corrida de la Software Factory. Pura (sin DB) para probarla.
//
//   planning ──plan_submitted──▶ plan_review ──approve──▶ building ──build_done──▶ checking
//      ▲                            │                        ▲                       │
//      └──────────changes───────────┘                        └──check_fail (<3)──────┤
//                                                                                    ├─check_fail (3ª)──▶ escalated
//                                                                                    └─check_pass──▶ pr_review ──close──▶ done
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

export type RunEvent = "plan_submitted" | "approve" | "changes" | "build_done" | "check_pass" | "check_fail" | "close" | "cancel";

export const MAX_LOOPS = 3;

/** El estado siguiente, o null si el evento no aplica en este estado. */
export function nextStatus(status: RunStatus, event: RunEvent, loops = 0): RunStatus | null {
  if (event === "cancel") return status === "done" || status === "cancelled" ? null : "cancelled";
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
      return null;
    case "escalated":
      // Una persona decide: mandar a construir otra vez o replanear.
      if (event === "approve") return "building";
      if (event === "changes") return "planning";
      return null;
    case "pr_review":
      return event === "close" ? "done" : null;
    default:
      return null;
  }
}

/** Etiqueta de la etapa en la tarea de Tasks. */
export function stageLabel(status: RunStatus): string {
  return (
    {
      planning: "plan",
      plan_review: "firma del plan",
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
