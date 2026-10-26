// ── issue_triage: un issue que abre una persona → @plan lo etiqueta, busca duplicados y pide repro ──
//
// Inspirado en `issue-triage` de gh-aw (githubnext/agentics): etiquetas que YA existen en el repo,
// duplicados enlazados (nunca cerrados) y, si es un bug sin pasos, una pregunta corta. Un solo
// comentario por issue: el `claim` de `<repo>#<n>` vale también para el reabierto.
import type { Automation, AutomationCtx, RepoEvent } from "./types";

export type IssueTriageSettings = {
  /** Permite crear etiquetas que no existen. Apagado: sólo se usan las del repo. */
  createLabels?: boolean;
  /** Pedir pasos de reproducción a un bug que no los trae (default sí). */
  askRepro?: boolean;
};

const BOT_LOGIN = "ghosty-studio[bot]";
// Un mes: el mismo issue reabierto semanas después no recibe un segundo comentario.
const CLAIM_TTL_MS = 30 * 24 * 3600_000;

/** ¿Lo causó un bot (el nuestro incluido)? Los bots no se triagean: dependabot, renovate, nosotros. */
export function isBotActor(login?: string, type?: string): boolean {
  if (type === "Bot") return true;
  const l = (login ?? "").toLowerCase();
  return l === BOT_LOGIN || l.endsWith("[bot]");
}

/** ¿Este evento merece triage? Issue abierto/reabierto por una persona. */
export function shouldTriage(ev: RepoEvent): boolean {
  if (ev.event !== "issues" || (ev.action !== "opened" && ev.action !== "reopened")) return false;
  if (!ev.issue?.number) return false;
  if (isBotActor(ev.sender?.login, ev.sender?.type) || isBotActor(ev.issue.author)) return false;
  return true;
}

export function triageClaimKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** Instrucciones del turno de @plan. El room prendió la automatización: no hace falta confirmar. */
export function triagePrompt(ev: RepoEvent, s: IssueTriageSettings): string {
  const i = ev.issue!;
  const ref = `${ev.repo}#${i.number}`;
  const url = i.url ?? `https://github.com/${ev.repo}/issues/${i.number}`;
  const labelRule = s.createLabels
    ? "Usa las etiquetas existentes (`github_list_labels`); sólo si ninguna encaja puedes crear UNA con `github_label_write`."
    : "Usa SÓLO etiquetas que ya existen en el repo (`github_list_labels`). Nunca crees etiquetas.";
  const repro = s.askRepro === false
    ? ""
    : "\n4. Si es un bug y no trae pasos para reproducirlo (o versión/entorno), pide eso en el comentario, en una o dos frases.";
  return [
    `Automatización «triage de issues» (prendida en este room). Llegó ${ev.action === "reopened" ? "reabierto" : "nuevo"} ${ref}: «${i.title ?? ""}» — ${url}`,
    `Autor: @${i.author ?? ev.sender?.login ?? "?"}. Tienes permiso para etiquetar y comentar sin pedir confirmación; nada más.`,
    "",
    "Haz esto:",
    `1. Lee el issue con \`github_get_issue\`. ${labelRule} Aplica 1–3 con \`github_update_issue\`; \`labels\` REEMPLAZA la lista, así que manda las que ya tenía más las nuevas.`,
    `2. Busca duplicados con \`github_search\` (\`repo: ${ev.repo}\`, \`type: issue\`, abiertos y cerrados, 2–3 búsquedas con palabras clave del título). Sólo cuenta como duplicado lo que describe el mismo problema.`,
    "3. Deja UN solo comentario con `github_comment`: qué etiquetas pusiste, los posibles duplicados como `#N` (sin cerrar nada) y, si aplica, lo del punto 4. Si no hay nada útil que decir (sin duplicados ni preguntas), no comentes." + repro,
    "",
    "Reglas: nunca cierres, asignes, bloquees ni edites el texto del issue. Corto, en el idioma del issue, sin plantillas largas. Al final, resume aquí en 2 renglones con la liga.",
  ].join("\n");
}

async function handle(ev: RepoEvent, ctx: AutomationCtx): Promise<void> {
  if (!shouldTriage(ev)) return;
  const n = ev.issue!.number;
  // Primero el claim: una reentrega del webhook no gasta cupo del día.
  if (!(await ctx.claim("issue_triage", triageClaimKey(ev.repo, n), CLAIM_TTL_MS))) return;
  if (!(await ctx.budget("issue_triage"))) return;
  const s = await ctx.settings<IssueTriageSettings>("issue_triage");
  await ctx.wake({
    handle: "plan",
    text: triagePrompt(ev, s ?? {}),
    threadKey: `issue_triage:${triageClaimKey(ev.repo, n)}`,
    title: `Triage ${ev.repo}#${n}`,
  });
}

export const automations: Automation[] = [
  { kind: "issue_triage", on: ["issues.opened", "issues.reopened"], handle },
];
