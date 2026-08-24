// ¿Este mensaje pertenece a la conversación que el usuario tiene ABIERTA?
//
// El stream SSE entrega los mensajes de TODOS los rooms visibles + los DMs del usuario
// (una sola conexión por pestaña). Sin este filtro, un artefacto que un agente arma en
// #general abría el panel de artefacto aunque estuvieras leyendo un DM — reportado el
// 2026-07-24. Se usa para decidir si un evento puede tomar la UI (abrir/actualizar el
// panel), NO para descartar el evento: el mensaje igual se guarda en su cache.
export function belongsToOpenConversation(
  msg: { channel_id?: number | null; dm_id?: number | null } | undefined | null,
  openDmId: number | null,
  openChannelId: number
): boolean {
  // Sin el mensaje en cache no podemos ubicarlo → NO pasa. Esto decide si un borrador te
  // toma el panel, así que la duda se resuelve a favor de no enseñar nada: dejarlo pasar
  // era un fail-open que abría en tu pantalla trabajo de otra conversación. No se pierde
  // nada: los deltas siguen llegando y el `message:new` de la cáscara aterriza antes que
  // el siguiente chunk, así que el panel abre un instante después.
  if (!msg) return false;
  if (openDmId != null) return msg.dm_id === openDmId;
  return msg.dm_id == null && msg.channel_id === openChannelId;
}
