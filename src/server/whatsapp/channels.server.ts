/**
 * Estado de un número de WhatsApp conectado, y el hilo de cada contacto.
 *
 * La verdad está REPARTIDA a propósito y conviene tenerlo claro antes de tocar esto:
 *   - **Formmy** manda en la conexión con Meta (el token, el WABA) y en si el número
 *     contesta o no (`Channel.autoRespond`, que nace apagado).
 *   - **Nosotros** mandamos en dónde aterriza la conversación (qué room, qué hilo).
 *
 * No dupliquemos su mitad aquí: una segunda copia de "está encendido" divergiría, y ése
 * es exactamente el patrón que ya se pagó con los asientos.
 */
import { dbq, num } from "../../dbq.server";

export type WaChannel = {
  integrationId: string;
  phone: string;
  channelSecret: string;
  roomId: number;
  agentHandle: string | null;
  actingSub: string | null;
};

function rowToChannel(r: Record<string, string | null>): WaChannel {
  return {
    integrationId: r.integration_id ?? "",
    phone: r.phone ?? "",
    channelSecret: r.channel_secret ?? "",
    roomId: num(r.room_id),
    agentHandle: r.agent_handle,
    actingSub: r.acting_sub,
  };
}

/**
 * Guarda (o refresca) el número conectado. Idempotente por `integration_id`, que es la
 * misma clave con la que Formmy deduplica su lado: reconectar el mismo número reusa la
 * fila en vez de dejar dos que apuntan a rooms distintos.
 */
export async function saveWaChannel(c: WaChannel): Promise<void> {
  await dbq(
    `INSERT INTO gt_wa_channels (integration_id, phone, channel_secret, room_id, agent_handle, acting_sub, created_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(integration_id) DO UPDATE SET
       phone = excluded.phone,
       channel_secret = excluded.channel_secret,
       room_id = excluded.room_id,
       agent_handle = excluded.agent_handle,
       acting_sub = excluded.acting_sub`,
    [c.integrationId, c.phone, c.channelSecret, c.roomId, c.agentHandle, c.actingSub],
  );
}

export async function getWaChannel(integrationId: string): Promise<WaChannel | null> {
  const rows = await dbq(`SELECT * FROM gt_wa_channels WHERE integration_id = ?`, [integrationId]);
  return rows[0] ? rowToChannel(rows[0]) : null;
}

export async function listWaChannels(): Promise<WaChannel[]> {
  const rows = await dbq(`SELECT * FROM gt_wa_channels ORDER BY created_at DESC`);
  return rows.map(rowToChannel);
}

export async function deleteWaChannel(integrationId: string): Promise<void> {
  await dbq(`DELETE FROM gt_wa_channels WHERE integration_id = ?`, [integrationId]);
  await dbq(`DELETE FROM gt_wa_threads WHERE integration_id = ?`, [integrationId]);
}

/**
 * El hilo de un contacto, creándolo la primera vez.
 *
 * La raíz es una CABECERA ("💬 +52… · Nombre"), no el primer mensaje del cliente. Así el
 * hilo tiene un título estable: con el primer mensaje de raíz, un "hola" quedaría como
 * nombre de la conversación para siempre.
 *
 * Devuelve también `created` para que quien llama publique la raíz al bus la primera vez
 * (sin eso, el hilo nuevo no aparece hasta recargar).
 */
export async function resolveContactThread(args: {
  integrationId: string;
  roomId: number;
  phone: string;
  contactName: string;
  topic: string;
}): Promise<{ threadId: number; created: boolean }> {
  const rows = await dbq(
    `SELECT thread_id FROM gt_wa_threads WHERE integration_id = ? AND phone = ?`,
    [args.integrationId, args.phone],
  );
  if (rows[0]) return { threadId: num(rows[0].thread_id), created: false };

  const db = await import("../../db.server");
  const label = args.contactName.trim()
    ? `💬 WhatsApp · ${args.contactName.trim()} · +${args.phone}`
    : `💬 WhatsApp · +${args.phone}`;
  const { id } = await db.createMessage({
    channelId: args.roomId,
    parentId: null,
    sender: args.contactName.trim() || `+${args.phone}`,
    senderSub: null, // un contacto de WhatsApp NO es miembro: no ocupa asiento
    avatar: "",
    body: label,
    topic: args.topic,
  });
  // La carrera existe (dos mensajes del mismo contacto a la vez) y la resuelve el UNIQUE:
  // si otro ya insertó, nos quedamos con SU hilo y la cabecera de más queda huérfana en el
  // room. Preferible a dos hilos para el mismo contacto, que es el fallo que se ve.
  await dbq(
    `INSERT INTO gt_wa_threads (integration_id, phone, thread_id, created_at)
     VALUES (?, ?, ?, unixepoch()) ON CONFLICT(integration_id, phone) DO NOTHING`,
    [args.integrationId, args.phone, id],
  );
  const after = await dbq(
    `SELECT thread_id FROM gt_wa_threads WHERE integration_id = ? AND phone = ?`,
    [args.integrationId, args.phone],
  );
  const winner = after[0] ? num(after[0].thread_id) : id;
  return { threadId: winner, created: winner === id };
}
