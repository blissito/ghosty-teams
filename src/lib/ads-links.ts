// Ghosty Ads en el hilo: la línea «✏️ … → vN» que abre el panel en esa versión, el link
// directo a una campaña y el texto de la tarjeta compacta. Puro (lo usan el cliente, el
// servidor y las pruebas).

export type VersionLine = { text: string; campaignId: number | null; version: number };

/**
 * «✏️ @ads ajustó la propuesta #4 → v3» → { campaignId: 4, version: 3 }. Las líneas viejas
 * no traen el #N (`campaignId: null`): la campaña sale del hilo donde viven.
 */
export function parseVersionLine(body: string): VersionLine | null {
  const m = String(body ?? "").trim().match(/^✏️\s+(.+?)\s+→\s+v(\d+)$/u);
  if (!m) return null;
  const version = Number(m[2]);
  if (!Number.isInteger(version) || version < 1) return null;
  const id = m[1].match(/#(\d+)/);
  return { text: m[1], campaignId: id ? Number(id[1]) : null, version };
}

/** La línea que publica la plataforma al guardar una versión. */
export function versionLine(who: string, what: string | null, campaignId: number, version: number): string {
  return what ? `✏️ ${who} cambió ${what} de la propuesta #${campaignId} → v${version}` : `✏️ ${who} ajustó la propuesta #${campaignId} → v${version}`;
}

/** Link para compartir: abre el hilo con la campaña en el panel lateral. */
export function campaignLink(roomSlug: string, threadId: number | null, campaignId: number): string {
  const q = new URLSearchParams();
  if (threadId) q.set("thread", String(threadId));
  q.set("campaign", String(campaignId));
  return `/c/${encodeURIComponent(roomSlug)}?${q.toString()}`;
}

/** «Propuesta #4 · v3 · $50/día · hasta 27 oct» (el estado lo pinta la tarjeta aparte). */
export function compactSummary(x: { campaignId: number; proposal: boolean; version: number; dailyBudget: number | null; endTime: string | null }): string {
  const parts = [`${x.proposal ? "Propuesta" : "Campaña"} #${x.campaignId}`, `v${x.version}`];
  if (x.dailyBudget) parts.push(`$${x.dailyBudget.toLocaleString("es-MX")}/día`);
  const end = x.endTime ? new Date(x.endTime) : null;
  if (end && Number.isFinite(end.getTime()))
    parts.push(`hasta ${end.toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "America/Mexico_City" }).replace(".", "")}`);
  return parts.join(" · ");
}
