// Puerta de la preview (16-oct, pedido #96 de Deník). @check aprobó una subida a React Router 8
// con «probado en la caja» aunque el plan exigía la reserva EN LA PREVIEW; la preview nunca
// existió (faltaban variables), la tarjeta se puso verde, se mezcló y prod quedó 18 h sin poder
// reservar. Como un check requerido de GitHub que nunca reporta: lo que falta bloquea igual que
// lo que falla. Aquí vive la regla pura; la aplican `factory_check_verdict` y `mergeRun`.
import type { BumpLevel } from "../../lib/dependabot";

export type PreviewGateState = "none" | "pending" | "ready" | "failed" | "needs_env" | "off";

/** La sección «Criterios de aceptación» del plan (hasta el siguiente encabezado ##). */
export function acceptanceSection(planMd: string): string {
  const m = planMd.match(/^#{1,6}\s*criterios( de aceptaci[óo]n)?\s*:?\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
  return m ? m[2] : "";
}

/** ¿Algún criterio de aceptación se comprueba en la preview? Respaldo de los planes sin `requires_preview`. */
export function planAsksPreview(planMd: string | null | undefined): boolean {
  return /\bpreview\b|vista previa/i.test(acceptanceSection(String(planMd ?? "")));
}

/**
 * ¿Este pedido exige la preview para aprobarse y mezclarse?
 * - Con la preview del repo apagada («Sin preview», decisión explícita del dueño): no.
 * - El plan la marcó (`requires_preview`), o, en planes viejos sin la marca, un criterio la nombra.
 * - Un major de Dependabot (o un salto que no se sabe, p. ej. un grupo) siempre: semver dice que
 *   puede romper en ejecución, y el CI no lo ve (el #96 pasó lint, typecheck, tests y build).
 */
export function previewRequiredFrom(i: {
  repoOff: boolean;
  requiresPreview: boolean | null;
  planMd: string | null;
  dependabotLevel: BumpLevel | null;
}): boolean {
  if (i.repoOff) return false;
  if (i.dependabotLevel === "major" || i.dependabotLevel === "unknown") return true;
  if (i.requiresPreview !== null) return i.requiresPreview;
  return planAsksPreview(i.planMd);
}

const STATE_TEXT: Record<PreviewGateState, string> = {
  none: "todavía no existe",
  pending: "se está construyendo",
  ready: "lista",
  failed: "falló",
  needs_env: "espera las variables del repo",
  off: "apagada",
};

/** El estado en palabras para la tarjeta y los errores («falló: <motivo>»). */
export function previewStateText(p: { state: PreviewGateState; error?: string | null }): string {
  return STATE_TEXT[p.state] + (p.state === "failed" && p.error ? `: ${String(p.error).slice(0, 200)}` : "");
}

/**
 * null = la preview exigida está lista en la cabeza del PR. Si no, el motivo. `pending` es lo
 * único que se resuelve solo (un merge en cola puede esperarlo); `needs_env` y `failed` piden a
 * una persona.
 */
export function previewGateBlock(
  p: { state: PreviewGateState; sha: string | null; error?: string | null },
  headSha: string | null,
): { reason: string; waits: boolean } | null {
  if (p.state === "ready" && (!headSha || p.sha === headSha)) return null;
  const state = p.state === "ready" ? "pending" : p.state; // lista, pero de un commit viejo
  return { reason: previewStateText({ state, error: p.error }), waits: state === "pending" };
}

/**
 * Lo que @plan sabe de la preview del repo ANTES de planear: en el #96 nadie lo supo hasta el
 * final, y la falta de variables apareció como un aviso suelto después del build.
 */
export function previewViabilityLine(repo: string, f: {
  off: boolean;
  hosting: boolean;
  runnable: boolean;
  envExampleKeys: string[];
  envSavedKeys: string[] | null;
}): string {
  if (f.off) return `Preview de ${repo}: el dueño la apagó («Sin preview»). No pidas criterios «en la preview».`;
  if (f.hosting) return `Preview de ${repo}: la publica su hosting en cada PR.`;
  if (!f.runnable) return `Preview de ${repo}: no se puede levantar (sin script start/preview/dev ni index.html). Si un criterio la necesita, el plan dice cómo se va a probar o propone habilitarla.`;
  const saved = new Set(f.envSavedKeys ?? []);
  const missing = f.envExampleKeys.filter((k) => !saved.has(k));
  if (f.envExampleKeys.length && !f.envSavedKeys?.length)
    return `Preview de ${repo}: NO arrancará: pide ${f.envExampleKeys.length} variable(s) de .env.example y no hay ninguna guardada (${f.envExampleKeys.slice(0, 8).join(", ")}). Si el plan la exige, pon en «Riesgos» que el dueño debe guardarlas en /factory antes de construir.`;
  if (missing.length)
    return `Preview de ${repo}: la caja de gs la levanta; faltan por guardar ${missing.slice(0, 8).join(", ")} (de .env.example). Si alguna es obligatoria, dilo en «Riesgos».`;
  return `Preview de ${repo}: la caja de gs la levanta con las variables guardadas.`;
}
