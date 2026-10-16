// El check run «Ghosty · Preview» en la cabeza del PR (16-oct, tras el #96 de Deník). La puerta
// de la preview vivía sólo en Teams (`mergeRun`, el veredicto de @check): un merge directo en
// GitHub o con `github_merge_pr` se la saltaba. Como Vercel y Netlify, el check lo publica la App
// y el ruleset de la fábrica lo exige: GitHub bloquea cualquier camino, y un check requerido que
// nunca reporta bloquea igual. La regla es la misma puerta (`previewGateBlock`) dicha a GitHub.
import { previewGateBlock, type PreviewGateState } from "./factory-preview-gate";

export const PREVIEW_CHECK_NAME = "Ghosty · Preview";

export type PreviewCheck = {
  status: "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | null;
  title: string;
  summary: string;
};

const done = (conclusion: PreviewCheck["conclusion"], title: string, summary: string): PreviewCheck => ({ status: "completed", conclusion, title, summary });

/** El estado del check. `run: null` = PR que no es de un pedido (el ruleset lo exige en todos). */
export function previewCheckFrom(
  run: {
    id: number;
    required: boolean;
    repoOff: boolean;
    preview: { state: PreviewGateState; sha: string | null; error?: string | null; url?: string | null };
    headSha: string;
    /** Lo que rechazó el smoke en ESTA cabeza. */
    smokeFail: string | null;
    /** Quien picó «Mezclar sin preview» en esta cabeza. */
    skippedBy: string | null;
    /** Ligas absolutas a Teams. */
    threadUrl: string | null;
    envUrl: string | null;
  } | null,
): PreviewCheck {
  if (!run) return done("neutral", "No es un pedido de la fábrica", "Ghosty sólo exige la preview en los PRs de sus pedidos.");
  const thread = run.threadUrl ? ` [Ver el hilo del pedido](${run.threadUrl}).` : "";
  if (run.skippedBy) return done("neutral", `Preview omitida por ${run.skippedBy}`, `«Mezclar sin preview» en el pedido #${run.id}; queda en la bitácora.${thread}`);
  if (!run.required)
    return run.repoOff
      ? done("neutral", "Preview apagada en este repo", `El dueño la apagó («Sin preview»).${thread}`)
      : done("neutral", "Este pedido no exige preview", `El plan del pedido #${run.id} no pide probarlo en la preview.${thread}`);
  // Sin preview todavía (recién abierto o «Reintentar») cuenta como construyéndose.
  const gate = previewGateBlock(run.preview.state === "none" ? { ...run.preview, state: "pending" } : run.preview, run.headSha);
  if (gate?.waits) return { status: "in_progress", conclusion: null, title: "La preview se está construyendo", summary: `El merge espera a que esté lista en este commit.${thread}` };
  if (gate) {
    const env = run.preview.state === "needs_env" && run.envUrl ? ` [Guárdalas con datos de prueba](${run.envUrl}) y arranca sola.` : "";
    return done("failure", `La preview ${gate.reason.split(":")[0]}`, `El pedido #${run.id} exige la preview y ${gate.reason}.${env}${thread}`);
  }
  if (run.smokeFail)
    return done("failure", "La preview rechaza envíos", "El POST con el Origin real (como el navegador) falló:\n\n```\n" + run.smokeFail.slice(0, 1500) + "\n```" + thread);
  return done("success", "Preview lista", `Lista en este commit${run.preview.url ? `: ${run.preview.url}` : ""}; el smoke no encontró fallos.${thread}`);
}

/** Idempotencia por (repo, sha): mismo contenido = nada; de terminado a en curso, uno nuevo (GitHub enseña el último). */
export function checkRunWrite(existing: { completed: boolean; sig: string | null } | null, next: { status: PreviewCheck["status"]; sig: string }): "skip" | "patch" | "post" {
  if (existing?.sig === next.sig) return "skip";
  return !existing || (existing.completed && next.status === "in_progress") ? "post" : "patch";
}
