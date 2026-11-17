// El check run «Ghosty · Preview» en la cabeza del PR (16-oct, tras el #96 de Deník). La puerta
// de la preview vivía sólo en Teams (`mergeRun`, el veredicto de @check): un merge directo en
// GitHub o con `github_merge_pr` se la saltaba. Como Vercel y Netlify, el check lo publica la App
// y el ruleset de la fábrica lo exige: GitHub bloquea cualquier camino, y un check requerido que
// nunca reporta bloquea igual. La regla es la misma puerta (`previewGateBlock`) dicha a GitHub.
import { previewGateBlock, type PreviewGateState } from "./factory-preview-gate";
import { scrubPreviewKeys } from "./preview-link";

export const PREVIEW_CHECK_NAME = "Ghosty · Preview";

export type PreviewCheck = {
  status: "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | null;
  title: string;
  summary: string;
  /** A dónde manda «Detalles» en GitHub: la preview (`/preview/<id>`, sin llave) si está lista; si no, el hilo. */
  detailsUrl?: string | null;
};

const done = (conclusion: PreviewCheck["conclusion"], title: string, summary: string): PreviewCheck => ({ status: "completed", conclusion, title, summary });

export type PreviewCheckRun = {
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
    /** Liga estable `/preview/<id>` (absoluta, SIN llave): la que va a GitHub. La llave la pide Teams a gs al abrirla. */
    openUrl?: string | null;
};

function rawCheck(
  run: PreviewCheckRun | null,
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
  if (gate?.waits)
    return {
      status: "in_progress",
      conclusion: null,
      title: run.preview.state === "waiting" ? "La preview espera lugar" : "La preview se está construyendo",
      summary: `El merge espera a que esté lista en este commit.${run.preview.state === "waiting" && run.preview.error ? ` (${run.preview.error})` : ""}${thread}`,
    };
  if (gate) {
    const env = run.preview.state === "needs_env" && run.envUrl ? ` [Guárdalas con datos de prueba](${run.envUrl}) y arranca sola.` : "";
    return done("failure", `La preview ${gate.reason.split(":")[0]}`, `El pedido #${run.id} exige la preview y ${gate.reason}.${env}${thread}`);
  }
  if (run.smokeFail)
    return done("failure", "La preview rechaza envíos", "El POST con el Origin real (como el navegador) falló:\n\n```\n" + run.smokeFail.slice(0, 1500) + "\n```" + thread);
  const open = run.openUrl ? ` [Abrir la preview](${run.openUrl}).` : "";
  return done("success", "Preview lista", `Lista en este commit; el smoke no encontró fallos.${open}${thread}`);
}

const ICON = { ok: "✅", wait: "⏳", fail: "❌", idle: "▫️" } as const;

/** Los pasos de la preview como tabla (el «stepper» del PR): caja → construcción → smoke. */
export function previewSteps(run: PreviewCheckRun): string {
  const st = run.preview.state;
  const box = st === "waiting" ? ICON.wait : ICON.ok;
  const build = st === "ready" ? ICON.ok : st === "failed" || st === "needs_env" ? ICON.fail : st === "waiting" ? ICON.idle : ICON.wait;
  const smoke = st !== "ready" ? ICON.idle : run.smokeFail ? ICON.fail : ICON.ok;
  return ["| Paso | Estado |", "|---|---|", `| Caja de trabajo | ${box} |`, `| Preview del commit | ${build} |`, `| Smoke (POST con el Origin real) | ${smoke} |`].join("\n");
}

/**
 * El estado del check. `run: null` = PR que no es de un pedido (el ruleset lo exige en todos).
 * Nunca sale una llave de preview (`?k=`): el resumen se limpia aunque alguien la meta en un mensaje, y
 * «Detalles» apunta a la liga estable, no a la de la caja (auditoría del 17-nov: un PR de repo público
 * dejaba abierta la preview «privada»).
 */
export function previewCheckFrom(run: PreviewCheckRun | null): PreviewCheck {
  const c = rawCheck(run);
  const steps = run && run.required && !run.skippedBy && !run.repoOff ? `\n\n${previewSteps(run)}` : "";
  return {
    ...c,
    title: scrubPreviewKeys(c.title),
    summary: scrubPreviewKeys(`${c.summary}${steps}`),
    detailsUrl: run ? ((c.conclusion === "success" && run.openUrl) || run.threadUrl || null) : null,
  };
}

/** Idempotencia por (repo, sha): mismo contenido = nada; de terminado a en curso, uno nuevo (GitHub enseña el último). */
export function checkRunWrite(existing: { completed: boolean; sig: string | null } | null, next: { status: PreviewCheck["status"]; sig: string }): "skip" | "patch" | "post" {
  if (existing?.sig === next.sig) return "skip";
  return !existing || (existing.completed && next.status === "in_progress") ? "post" : "patch";
}
