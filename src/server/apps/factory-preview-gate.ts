// Puerta de la preview (16-oct, pedido #96 de Deník). @check aprobó una subida a React Router 8
// con «probado en la caja» aunque el plan exigía la reserva EN LA PREVIEW; la preview nunca
// existió (faltaban variables), la tarjeta se puso verde, se mezcló y prod quedó 18 h sin poder
// reservar. Como un check requerido de GitHub que nunca reporta: lo que falta bloquea igual que
// lo que falla. Aquí vive la regla pura; la aplican `factory_check_verdict` y `mergeRun`.
import type { BumpLevel } from "../../lib/dependabot";

export type PreviewGateState = "none" | "pending" | "ready" | "failed" | "needs_env" | "off" | "waiting";

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
  waiting: "espera lugar para levantarse",
};

/** El estado en palabras para la tarjeta y los errores («falló: <motivo>»). */
export function previewStateText(p: { state: PreviewGateState; error?: string | null }): string {
  return STATE_TEXT[p.state] + ((p.state === "failed" || p.state === "waiting") && p.error ? `: ${String(p.error).slice(0, 200)}` : "");
}

/**
 * null = la preview exigida está lista en la cabeza del PR. Si no, el motivo. `pending` y
 * `waiting` son lo único que se resuelve solo (un merge en cola puede esperarlo); `needs_env` y `failed` piden a
 * una persona.
 */
export function previewGateBlock(
  p: { state: PreviewGateState; sha: string | null; error?: string | null },
  headSha: string | null,
): { reason: string; waits: boolean } | null {
  if (p.state === "ready" && (!headSha || p.sha === headSha)) return null;
  const state = p.state === "ready" ? "pending" : p.state; // lista, pero de un commit viejo
  // Esperar lugar también se resuelve solo (el tick la levanta al liberarse uno).
  return { reason: previewStateText({ state, error: p.error }), waits: state === "pending" || state === "waiting" };
}

/** Variable del `.env` de la preview que toca producción (la clasifica gs: sólo viaja el nombre). */
export type EnvRiskEntry = { key: string; risk: "remote_db" | "live_payment_key" | "real_email" };
const ENV_RISK_LABEL: Record<EnvRiskEntry["risk"], string> = { remote_db: "base remota", live_payment_key: "llave live", real_email: "correo real" };

/** «DATABASE_URL (base remota), STRIPE_SECRET_KEY (llave live)». */
export function envRisksText(risks: EnvRiskEntry[], max = 6): string {
  const shown = risks.slice(0, max).map((r) => `${r.key} (${ENV_RISK_LABEL[r.risk] ?? r.risk})`);
  return shown.join(", ") + (risks.length > max ? ` y ${risks.length - max} más` : "");
}

/** El aviso de que la preview usa PRODUCCIÓN (null = no hay nada que avisar). En el #96 la de
 *  `agenda` escribía en la base de prod y traía llaves live; nadie lo supo hasta revisarlo a mano. */
export function envRiskLine(repo: string, risks: EnvRiskEntry[] | null | undefined): string | null {
  if (!risks?.length) return null;
  const rules = [
    risks.some((r) => r.risk === "remote_db") ? "con la base remota, nada de pruebas que escriban" : null,
    risks.some((r) => r.risk === "live_payment_key") ? "con llaves live, no se completan pagos" : null,
  ].filter(Boolean);
  return (
    `⚠ La preview de ${repo} usa recursos de PRODUCCIÓN: ${envRisksText(risks)}. Lo que escriba, cobre o envíe será real. ` +
    `Pide variables de prueba en «Riesgos» antes de exigir la preview${rules.length ? `; mientras, ${rules.join(" y ")}` : ""}.`
  );
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
  /** Lo que gs marcó como producción en las variables guardadas. */
  envRisks?: EnvRiskEntry[] | null;
}): string {
  const line = previewViabilityBase(repo, f);
  // Con hosting propio o apagada, las variables guardadas no se usan.
  const risk = f.off || f.hosting || !f.runnable ? null : envRiskLine(repo, f.envRisks);
  return risk ? `${line} ${risk}` : line;
}

function previewViabilityBase(repo: string, f: Parameters<typeof previewViabilityLine>[1]): string {
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
