// El check run «Ghosty · Preview» en la cabeza del PR (16-oct, tras el #96 de Deník). La puerta
// de la preview vivía sólo en Teams (`mergeRun`, el veredicto de @check): un merge directo en
// GitHub o con `github_merge_pr` se la saltaba. Como Vercel y Netlify, el check lo publica la App
// y el ruleset de la fábrica lo exige: GitHub bloquea cualquier camino, y un check requerido que
// nunca reporta bloquea igual. Aquí vive la regla pura; la publica `factory-preview-check.server`.
import { previewStateText, type PreviewGateState } from "./factory-preview-gate";

export const PREVIEW_CHECK_NAME = "Ghosty · Preview";

export type PreviewCheck = {
  status: "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | null;
  title: string;
  summary: string;
};

export type PreviewCheckInput = {
  required: boolean;
  /** «Sin preview» del dueño en todo el repo. */
  repoOff: boolean;
  preview: { state: PreviewGateState; sha: string | null; url?: string | null; error?: string | null };
  headSha: string;
  /** Lo que rechazó el smoke en ESTA cabeza (null = pasó o no corrió). */
  smokeFail: string | null;
  /** Quien picó «Mezclar sin preview» en esta cabeza. */
  skippedBy: string | null;
  runId: number;
  /** Ligas absolutas a Teams (null si no se conocen). */
  threadUrl: string | null;
  envUrl: string | null;
};

const link = (text: string, url: string | null) => (url ? `[${text}](${url})` : text);

/** El estado del check a partir de lo que la fábrica sabe del pedido. */
export function previewCheckFrom(i: PreviewCheckInput): PreviewCheck {
  const order = `pedido #${i.runId}`;
  const thread = i.threadUrl ? ` ${link("Ver el hilo del pedido", i.threadUrl)}.` : "";
  if (i.skippedBy)
    return {
      status: "completed",
      conclusion: "neutral",
      title: `Preview omitida por ${i.skippedBy}`,
      summary: `${i.skippedBy} eligió «Mezclar sin preview» en el ${order}; queda en la bitácora.${thread}`,
    };
  if (!i.required)
    return {
      status: "completed",
      conclusion: "neutral",
      title: i.repoOff ? "Preview apagada en este repo" : "Este pedido no exige preview",
      summary: i.repoOff
        ? `El dueño apagó la preview del repo («Sin preview»): la fábrica no la exige.${thread}`
        : `El plan del ${order} no pide probarlo en la preview: no bloquea el merge.${thread}`,
    };
  const current = i.preview.state === "ready" && i.preview.sha === i.headSha;
  if (current && i.smokeFail)
    return {
      status: "completed",
      conclusion: "failure",
      title: "La preview rechaza envíos",
      summary:
        `El smoke mandó un POST con el Origin real (como el navegador) y la preview de este commit lo rechazó:\n\n` +
        "```\n" + i.smokeFail.slice(0, 1500) + "\n```\n\nPídele el arreglo a @build o usa «Mezclar sin preview» en la tarjeta." + thread,
    };
  if (current)
    return {
      status: "completed",
      conclusion: "success",
      title: "Preview lista",
      summary: `La preview de este commit está lista${i.preview.url ? `: ${i.preview.url}` : ""} y el smoke no encontró fallos.${thread}`,
    };
  if (i.preview.state === "needs_env")
    return {
      status: "completed",
      conclusion: "failure",
      title: "La preview espera las variables del repo",
      summary: `El ${order} exige la preview y no arranca sin variables. ${link("Guárdalas con datos de prueba", i.envUrl)} y se levanta sola.${thread}`,
    };
  if (i.preview.state === "failed")
    return {
      status: "completed",
      conclusion: "failure",
      title: "La preview no arrancó",
      summary: `El ${order} exige la preview y ${previewStateText({ state: "failed", error: i.preview.error })}.${thread}`,
    };
  // none, pending o lista de un commit viejo: se está construyendo la de esta cabeza.
  return {
    status: "in_progress",
    conclusion: null,
    title: "La preview se está construyendo",
    summary: `El ${order} exige la preview: el merge espera a que esté lista en este commit.${thread}`,
  };
}

/** Un PR que no es de un pedido (el ruleset exige el check en todos): pasa, y lo dice. */
export function loosePrCheck(): PreviewCheck {
  return {
    status: "completed",
    conclusion: "neutral",
    title: "No es un pedido de la fábrica",
    summary: "Ghosty sólo exige la preview en los PRs de sus pedidos; este PR no la necesita para mezclarse.",
  };
}

/**
 * Idempotencia por (repo, sha): mismo contenido = nada; si ya existe, se edita; de terminado a
 * construyéndose se crea uno nuevo (GitHub enseña el último con ese nombre).
 */
export function checkRunWrite(
  existing: { id: number; completed: boolean; sig: string | null } | null,
  next: { status: PreviewCheck["status"]; sig: string },
): "skip" | "patch" | "post" {
  if (existing && existing.sig === next.sig) return "skip";
  if (!existing) return "post";
  return existing.completed && next.status === "in_progress" ? "post" : "patch";
}
