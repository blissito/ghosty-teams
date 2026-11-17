// Abrir la preview de un pedido: `/preview/<id>` (la liga que viaja al PR, al hilo y a la tarjeta, sin
// llave). Aquí se decide quién entra y a dónde: sólo quien ve el room del pedido, y la llave (`?k=`) se
// la pide Teams a gs en el momento y va únicamente en el `Location` de este redirect (no se guarda, no
// se escribe en GitHub). Ver `preview-link.ts`.

export type OpenPreviewDeps = {
  /** La fila del pedido: sólo su room. */
  runChannel: (runId: number) => Promise<number | null>;
  getChannel: (id: number) => Promise<{ id: number } | null>;
  canSee: (channel: { id: number }, sub: string, isOwner: boolean) => Promise<boolean>;
  /** La liga CON llave, pedida a gs (null = no hay preview lista). */
  resolve: (runId: number) => Promise<string | null>;
};

export type OpenPreviewResult =
  | { status: 302; location: string }
  | { status: 401 | 404 | 409; body: string };

/** Cabeceras de toda respuesta de esta ruta: la liga con llave nunca se guarda en cachés ni sale en el Referer. */
export const PREVIEW_OPEN_HEADERS = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
} as const;

export async function openPreview(
  runIdRaw: string,
  me: { sub: string; isOwner: boolean } | null,
  deps: OpenPreviewDeps,
): Promise<OpenPreviewResult> {
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) return { status: 404, body: "not found" };
  if (!me) return { status: 401, body: "Inicia sesión para abrir la preview." };
  // 404 (no 403) para quien no ve el room: no se confirma que el pedido existe.
  const channelId = await deps.runChannel(runId);
  const channel = channelId ? await deps.getChannel(channelId) : null;
  if (!channel || !(await deps.canSee(channel, me.sub, me.isOwner))) return { status: 404, body: "not found" };
  const url = await deps.resolve(runId);
  if (!url) return { status: 409, body: "La preview de este pedido no está lista (o ya se cerró)." };
  return { status: 302, location: url };
}
