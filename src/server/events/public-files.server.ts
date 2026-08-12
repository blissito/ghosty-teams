/**
 * ¿Este archivo se puede servir SIN sesión?
 *
 * `/api/attachment/:id` exige `gc_session`, y con los rooms abiertos eso dejó de bastar:
 * a un invitado le devolvía 401, así que las imágenes del room y **los emojis custom del
 * workspace** llegaban rotas. Un chip de reacción con una imagen rota es peor que no
 * tener reacciones — parece que el producto está roto, no que falte un permiso.
 *
 * ⚠️ El criterio NO es "trae cookie de invitado", es **el archivo ya es público**:
 *
 *  · un adjunto de un mensaje que está en un room abierto y es posterior a su apertura.
 *    Ese mensaje ya se sirve a cualquiera por `eventFlowFn` sin pedir nada; negarle la
 *    imagen sería proteger el envoltorio y regalar el contenido.
 *  · un emoji custom del workspace. Se pintan dentro de esos mismos mensajes y el
 *    selector del room los ofrece; son la marca del cliente, no un secreto.
 *
 * Todo lo demás sigue necesitando sesión. En particular, un adjunto de un mensaje
 * ANTERIOR a la apertura del room no pasa: es justo el historial que `public_since`
 * mantiene dentro.
 */
export async function publicFileAccess(fileId: string): Promise<boolean> {
  if (!fileId) return false;
  try {
    const { dbq } = await import("../../dbq.server");

    // Adjunto de un mensaje ya público.
    const adj = await dbq(
      `SELECT 1
         FROM gc_attachments a
         JOIN gc_messages m  ON m.id = a.message_id
         JOIN gc_channels c  ON c.id = m.channel_id
        WHERE (a.file_id = ? OR a.thumb_file_id = ?)
          AND c.public_access = 1
          AND c.public_since IS NOT NULL
          AND m.created_at >= c.public_since
        LIMIT 1`,
      [fileId, fileId]
    );
    if (adj.length) return true;

    // Emoji custom del workspace.
    const emo = await dbq("SELECT 1 FROM gc_emojis WHERE file_id = ? LIMIT 1", [fileId]);
    return emo.length > 0;
  } catch {
    // Fail-CLOSED, al revés que los limitadores: aquí lo que está en juego es servir un
    // archivo privado, no dejar mudo a nadie.
    return false;
  }
}
