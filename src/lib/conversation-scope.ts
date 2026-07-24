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
  // Sin el mensaje en cache no podemos ubicarlo → no bloqueamos (comportamiento previo).
  if (!msg) return true;
  if (openDmId != null) return msg.dm_id === openDmId;
  return msg.dm_id == null && msg.channel_id === openChannelId;
}
