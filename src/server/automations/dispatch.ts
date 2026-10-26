// Lógica pura del despachador de automatizaciones (sin DB ni red): qué automatización le toca a
// un evento, anti-bucle y claves. La prueba vive en dispatch.test.ts.
import type { Automation, AutomationKind, RepoEvent } from "./types";

/** Nuestros bots: un evento que causó uno de ellos no despierta automatizaciones (anti-bucle). */
export const GHOSTY_BOTS = ["ghosty-studio[bot]", "ghosty[bot]"];

export function isGhostyBot(login: string | null | undefined): boolean {
  return GHOSTY_BOTS.includes((login ?? "").toLowerCase());
}

/** ¿Este evento le interesa a `on`? Vale el nombre del evento solo o `evento.acción`. */
export function eventMatches(on: string[], ev: Pick<RepoEvent, "event" | "action">): boolean {
  return on.includes(ev.event) || (!!ev.action && on.includes(`${ev.event}.${ev.action}`));
}

/** Las automatizaciones que corren: prendidas en el room, interesadas en el evento y sin bucle. */
export function pickAutomations(all: Automation[], enabled: Set<AutomationKind>, ev: RepoEvent): Automation[] {
  const byGhosty = isGhostyBot(ev.sender?.login);
  return all.filter((a) => enabled.has(a.kind) && eventMatches(a.on, ev) && (!byGhosty || a.allowGhostyBot === true));
}

/** Los PRs de los que habla el evento (para no pisar a la fábrica). */
export function prNumbersOf(ev: RepoEvent): number[] {
  const out = new Set<number>();
  if (ev.pr?.number) out.add(ev.pr.number);
  for (const n of ev.run?.prNumbers ?? []) out.add(n);
  return [...out];
}

/** Día del tope diario, en CDMX (UTC−6): el tope se renueva a medianoche de México. */
export function budgetDay(now = Date.now()): string {
  return new Date(now - 6 * 3600_000).toISOString().slice(0, 10);
}

export const DEFAULT_DAILY_BUDGET = 20;
export const DEFAULT_CLAIM_TTL_MS = 24 * 3600_000;

/** Sufijo de conversación del hilo de una automatización: estable por `threadKey`, sin caracteres raros. */
export function automationGroupSuffix(roomSlug: string, threadKey: string): string {
  const key = threadKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${roomSlug}-auto-${key || "x"}`;
}
