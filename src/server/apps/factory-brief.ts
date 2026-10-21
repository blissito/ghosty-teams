// El «brief de decisión» de un escalado (21-oct): en vez de los hallazgos crudos de @check, gs
// resume en llano qué pasa, qué ya verificó la plataforma y qué conviene. Puro: sin red ni base.
import type { EscalationKind } from "./factory-flow";

export type BriefAction = "fix" | "replan" | "close" | "close_ignore" | "recheck" | "env" | "retry_preview";

export type EscalationBrief = {
  summary: string;
  verified: string[];
  recommend: { action: BriefAction; why: string };
  question?: string | null;
  /** ISO del evento de escalado para el que se hizo. */
  at: string | null;
};

/** Los mismos textos de los botones de la tarjeta (y de ESCALATION_ASK) para cada acción. */
export const BRIEF_ACTION_LABEL: Record<BriefAction, string> = {
  fix: "Que @build lo arregle",
  replan: "Rehacer el plan",
  close: "Cerrar PR",
  close_ignore: "Cerrar e ignorar esta versión",
  recheck: "Que @check revise",
  env: "Guardar variables",
  retry_preview: "Reintentar preview",
};

// Lo que dice @check al escalar, según el tipo (easybits, 20-oct: todo decía «Necesita una decisión»).
export const ESCALATION_TITLE: Record<EscalationKind, string> = {
  env: "Faltan variables",
  fix: "@build lo puede arreglar, pero lo decide una persona",
  skip: "No conviene este cambio",
  decision: "Necesita una decisión",
  platform: "En pausa por la plataforma",
};

/** Sólo estos escalados llevan brief: `platform` se reintenta solo y `skip` ya trae sus botones claros. */
export const BRIEF_KINDS: readonly EscalationKind[] = ["decision", "fix", "env"];
export const wantsBrief = (kind: EscalationKind): boolean => BRIEF_KINDS.includes(kind);

/** Valida lo que contestó gs. Antes de su despliegue no hay `brief` (payload viejo de why): null. */
export function parseBrief(j: unknown): EscalationBrief | null {
  const b = (j as { brief?: unknown } | null)?.brief as Partial<EscalationBrief> | null | undefined;
  if (!b || typeof b !== "object") return null;
  const summary = typeof b.summary === "string" ? b.summary.trim() : "";
  const action = b.recommend?.action;
  if (!summary || !action || !(action in BRIEF_ACTION_LABEL)) return null;
  return {
    summary,
    verified: Array.isArray(b.verified) ? b.verified.filter((v): v is string => typeof v === "string" && !!v.trim()) : [],
    recommend: { action, why: typeof b.recommend?.why === "string" ? b.recommend.why.trim() : "" },
    question: typeof b.question === "string" && b.question.trim() ? b.question.trim() : null,
    at: typeof b.at === "string" && b.at ? b.at : null,
  };
}

/** El mensaje del hilo: el brief arriba, la recomendación resaltada y los hallazgos crudos al final. */
export function briefMessage(brief: EscalationBrief, findings: string, kind: EscalationKind): string {
  const parts = [`⚠️ **${ESCALATION_TITLE[kind]}** — ${brief.summary}`];
  if (brief.verified.length) parts.push(["**Ya verificado**", ...brief.verified.map((v) => `- ✓ ${v}`)].join("\n"));
  const rec = `👉 **Recomendado: ${BRIEF_ACTION_LABEL[brief.recommend.action]}**${brief.recommend.why ? ` — ${brief.recommend.why}` : ""}`;
  parts.push(brief.question ? `${rec}\n\n❓ ${brief.question}` : rec);
  if (findings.trim()) parts.push(`**Detalle de @check**\n\n${findings.trim()}`);
  return parts.join("\n\n");
}

/**
 * ¿Se publica este brief? Uno por escalado: si ya hay un `brief_posted` con el mismo `at`, no. Un
 * escalado NUEVO trae otro `at` y sí lleva el suyo. Sin `at` no hay con qué deduplicar: se publica.
 */
export function shouldPostBrief(at: string | null, postedAts: (string | null)[]): boolean {
  return !at || !postedAts.includes(at);
}
