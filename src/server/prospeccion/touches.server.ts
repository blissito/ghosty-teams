/**
 * Tocadas — la bitácora de a quién se contactó.
 *
 * APPEND-ONLY, y ésa es toda la diferencia con la hoja `suppressions` de mailmask, que es
 * un upsert: sin historia no se puede responder "¿cuántas veces tocamos a éste?", que es
 * justo lo que hay que saber para parar a los dos intentos sin respuesta.
 *
 * La idempotencia es el índice ÚNICO sobre `idem_key`, no un `SELECT` previo: dos envíos
 * concurrentes de la misma lista pasarían los dos por el select y mandarían dos correos.
 */
import { dbq, num } from "../../dbq.server";

export type Touch = {
  id: number;
  listId: number;
  rowId: number;
  channel: string;
  subject: string | null;
  sentAt: number | null;
  openedAt: number | null;
  clickedAt: number | null;
  repliedAt: number | null;
  bouncedAt: number | null;
  error: string | null;
};

/** La llave de idempotencia: una fila + un canal + una campaña = un solo envío. */
export function idemKey(rowId: number, channel: string, campaign: string): string {
  return `${rowId}:${channel}:${campaign}`;
}

/**
 * Crea la tocada ANTES de mandar, y devuelve null si ya existía.
 *
 * El orden importa: reservar primero significa que si el envío truena a la mitad queda
 * registro del intento. Al revés —mandar y luego registrar— un proceso que muere entre las
 * dos cosas deja un correo enviado del que no hay rastro, y al reintentar se manda otra vez.
 */
export async function reserveTouch(args: {
  listId: number;
  rowId: number;
  channel: "email" | "whatsapp";
  campaign: string;
  subject?: string | null;
  body?: string | null;
}): Promise<number | null> {
  const key = idemKey(args.rowId, args.channel, args.campaign);
  await dbq(
    `INSERT INTO gt_prosp_touches (list_id, row_id, channel, subject, body, idem_key)
     VALUES (?,?,?,?,?,?) ON CONFLICT (idem_key) DO NOTHING`,
    [args.listId, args.rowId, args.channel, args.subject ?? null, args.body ?? null, key]
  );
  const r = await dbq(`SELECT id, sent_at FROM gt_prosp_touches WHERE idem_key = ? LIMIT 1`, [key]);
  if (!r[0]) return null;
  // Si ya se había mandado, no es nuestra: no la vuelvas a mandar.
  if (r[0].sent_at != null) return null;
  return num(r[0].id);
}

export async function markSent(touchId: number, sesMessageId?: string | null): Promise<void> {
  await dbq(
    `UPDATE gt_prosp_touches SET sent_at = unixepoch(), ses_message_id = ? WHERE id = ?`,
    [sesMessageId ?? null, touchId]
  );
}

export async function markError(touchId: number, error: string): Promise<void> {
  await dbq(`UPDATE gt_prosp_touches SET error = ? WHERE id = ?`, [error.slice(0, 400), touchId]);
}

/**
 * Marca un evento del destinatario y arrastra el estado de la fila.
 *
 * `COALESCE` para no pisar la PRIMERA vez: si alguien abre el correo cinco veces, la que
 * importa es la primera. Y el estado de la fila sólo avanza —de `sent` a `opened` a
 * `clicked` a `replied`— nunca retrocede, porque una apertura posterior a una respuesta no
 * significa que el prospecto se haya enfriado.
 */
const STATUS_ORDER = ["new", "queued", "sent", "opened", "clicked", "replied"];

export async function markEvent(
  touchId: number,
  kind: "opened" | "clicked" | "replied" | "bounced"
): Promise<{ rowId: number; listId: number } | null> {
  const col = `${kind}_at`;
  await dbq(`UPDATE gt_prosp_touches SET ${col} = COALESCE(${col}, unixepoch()) WHERE id = ?`, [touchId]);
  const r = await dbq(`SELECT row_id, list_id FROM gt_prosp_touches WHERE id = ? LIMIT 1`, [touchId]);
  if (!r[0]) return null;
  const rowId = num(r[0].row_id);

  const estado = kind === "bounced" ? "bounced" : kind;
  const current = await dbq(`SELECT status FROM gt_prosp_rows WHERE id = ? LIMIT 1`, [rowId]);
  const previo = current[0]?.status ?? "new";
  // `bounced` y `optout` son terminales: no los pisa un evento posterior.
  if (previo !== "optout" && previo !== "bounced") {
    if (estado === "bounced" || STATUS_ORDER.indexOf(estado) > STATUS_ORDER.indexOf(previo)) {
      await dbq(`UPDATE gt_prosp_rows SET status = ? WHERE id = ?`, [estado, rowId]);
    }
  }
  return { rowId, listId: num(r[0].list_id) };
}

export async function getTouch(touchId: number): Promise<Touch | null> {
  const r = await dbq(`SELECT * FROM gt_prosp_touches WHERE id = ? LIMIT 1`, [touchId]);
  const t = r[0];
  if (!t) return null;
  return {
    id: num(t.id),
    listId: num(t.list_id),
    rowId: num(t.row_id),
    channel: t.channel ?? "",
    subject: t.subject ?? null,
    sentAt: t.sent_at == null ? null : num(t.sent_at),
    openedAt: t.opened_at == null ? null : num(t.opened_at),
    clickedAt: t.clicked_at == null ? null : num(t.clicked_at),
    repliedAt: t.replied_at == null ? null : num(t.replied_at),
    bouncedAt: t.bounced_at == null ? null : num(t.bounced_at),
    error: t.error ?? null,
  };
}

/** Cuántas veces se tocó una fila. Es lo que hace cumplir "parar after 2 intentos". */
export async function touchCount(rowId: number, channel?: string): Promise<number> {
  const r = channel
    ? await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_touches WHERE row_id = ? AND channel = ? AND sent_at IS NOT NULL`, [rowId, channel])
    : await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_touches WHERE row_id = ? AND sent_at IS NOT NULL`, [rowId]);
  return num(r[0]?.n);
}
