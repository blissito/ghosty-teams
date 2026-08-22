/**
 * Cerrar el loop: el prospecto contestó.
 *
 * Cuando entra un WhatsApp, se cruza el número contra las filas de prospección. Si hay
 * coincidencia, esa fila pasa a `replied` y la tocada queda marcada.
 *
 * ⚠️ Es lo que hace legal y seguro el paso a WhatsApp: **el prospecto escribió PRIMERO**,
 * lo que abre la ventana de 24 h de Meta y permite contestar con text libre, sin plantilla.
 * Todo el diseño del correo —el botón `wa.me` con text prellenado— existe para provocar
 * exactamente este evento. Nunca al revés.
 *
 * Se cruza por los últimos 10 dígitos, la misma normalización del opt-out: el número llega
 * de Meta como `5215512345678` y en DENUE está como `55 1234 5678`. Comparar los strings
 * enteros no cruzaría nunca.
 *
 * ⚠️ Y una palabra de baja ("BAJA", "STOP") en el primer mensaje da de baja de inmediato.
 * Quien pide que lo dejen en paz no debería tener que buscar un enlace.
 */
import { dbq, num } from "../../dbq.server";
import { normalize } from "./optout.server";

/** Lo que una persona escribe cuando quiere que la dejen en paz. */
const STOP_WORDS = /^\s*(baja|stop|unsubscribe|no me interesa|no molestar|quitenme|quítenme|elimina(r|me)?|dejen de escribir)\b/i;

export type InboundMatch = {
  rowId: number;
  listId: number;
  listName: string;
  business: string | null;
  isStopRequest: boolean;
};

/**
 * ¿Este número es de un prospecto nuestro?
 *
 * Devuelve null si no lo es — que es el case_ normal: la inmensa mayoría de los WhatsApp que
 * entran son de clientes, no de prospección. Por eso la consulta es una y barata.
 */
export async function matchInbound(phone: string, text: string): Promise<InboundMatch | null> {
  const norm = normalize("phone", phone);
  if (!norm) return null;

  // Se compara por sufijo porque `gt_prosp_rows.phone` guarda lo que dio la fuente, con el
  // formato que traía. Un índice sobre `phone` no sirve para un LIKE con comodín delante,
  // pero las listas son de cientos de filas y la consulta corre una vez por mensaje.
  const rows = await dbq(
    `SELECT r.id, r.list_id, r.name, r.status, r.phone, l.name AS list_name
       FROM gt_prosp_rows r JOIN gt_prosp_lists l ON l.id = r.list_id
      WHERE r.phone IS NOT NULL AND r.phone != ''`
  );

  const hit = rows.find((r) => normalize("phone", String(r.phone ?? "")) === norm);
  if (!hit) return null;

  return {
    rowId: num(hit.id),
    listId: num(hit.list_id),
    listName: hit.list_name ?? "",
    business: hit.name ?? null,
    isStopRequest: STOP_WORDS.test(text ?? ""),
  };
}

/**
 * Registra la respuesta y devuelve qué pasó, para poder avisarlo en el room.
 *
 * La tocada que se marca es la ÚLTIMA de correo de esa fila: es la que provocó el mensaje.
 * Si no hay ninguna (el prospecto escribió por su cuenta), igual se marca la fila.
 */
export async function recordReply(m: InboundMatch): Promise<{ optedOut: boolean }> {
  if (m.isStopRequest) {
    const { addOptOut } = await import("./optout.server");
    const r = await dbq(`SELECT email, phone FROM gt_prosp_rows WHERE id = ? LIMIT 1`, [m.rowId]);
    const row = r[0];
    if (row?.email) await addOptOut("email", String(row.email), "replied_stop");
    if (row?.phone) await addOptOut("phone", String(row.phone), "replied_stop");
    await dbq(`UPDATE gt_prosp_rows SET status = 'optout' WHERE id = ?`, [m.rowId]);
    return { optedOut: true };
  }

  const last = await dbq(
    `SELECT id FROM gt_prosp_touches WHERE row_id = ? AND channel = 'email' AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1`,
    [m.rowId]
  );
  if (last[0]) {
    const { markEvent } = await import("./touches.server");
    await markEvent(num(last[0].id), "replied");
  } else {
    await dbq(`UPDATE gt_prosp_rows SET status = 'replied' WHERE id = ? AND status NOT IN ('optout','bounced')`, [m.rowId]);
  }
  return { optedOut: false };
}

/**
 * El text que se publica en el room cuando un prospecto contesta.
 *
 * Va como mensaje normal y NO como `refresh`, al revés que las aperturas y los clics: una
 * respuesta es la única señal del embudo que merece interrumpir a alguien. Contar cada
 * apertura llenaría el chat y volvería invisible justo esto.
 */
export function replyNotice(m: InboundMatch, optedOut: boolean): string {
  const who = m.business ?? "Un prospecto";
  return optedOut
    ? `🚫 **${who}** pidió what no le escribamos más. Ya está dado de baja en todo el workspace.`
    : `🎯 **${who}** contestó — de la lista *${m.listName}*.`;
}
