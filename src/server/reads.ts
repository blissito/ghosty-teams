import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── No-leídos / read-state (Fase 1.5) ───────────────────────────────────────
// Referencia Zulip: los badges de no-leídos son de primera clase. Aquí el conteo
// es UNA query agregada por scope (rooms + DMs), no polling: los incrementos vivos
// llegan por el evento `unread` a ch.user(sub) (ver publishUnread en chat.ts/dm.ts),
// y bajan a 0 al enfocar (markReadFn). Cross-device gratis: markRead es por-usuario
// y el badge de las demás pestañas se recalcula al recibir el mismo unread/refresh.

// El mapa de no-leídos del usuario (rooms + DMs) en una sola llamada.
export const unreadCountsFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return { rooms: [], dms: [] };
  const [rooms, dms] = await Promise.all([db.unreadByRoom(me.sub), db.unreadByDm(me.sub)]);
  return { rooms, dms };
});

// Marca un scope como leído (al enfocar un room/DM). Notifica a las OTRAS pestañas
// del mismo usuario para que su badge también baje (cross-device).
export const markReadFn = createServerFn({ method: "POST" })
  .validator((d: { scope: "room" | "dm"; scopeId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const ns = await currentNamespace();
    await db.markRead(me.sub, data.scope, data.scopeId);
    // Señal a las demás conexiones del usuario: relean su mapa de no-leídos.
    bus.publish(bus.ch.user(ns, me.sub), { t: "unread", scope: data.scope, scopeId: data.scopeId });
    return { ok: true as const };
  });

// last_read_at del scope (segundos), capturado al abrir para dibujar el divisor
// "nuevos mensajes" ANTES de marcar leído. 0 = nunca leído (todo es nuevo).
export const lastReadFn = createServerFn({ method: "GET" })
  .validator((d: { scope: "room" | "dm"; scopeId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return { at: 0 };
    return { at: await db.getLastRead(me.sub, data.scope, data.scopeId) };
  });

// Read receipts (Fase 4): quién ha leído hasta este mensaje. Reusa gc_reads
// (un lector = last_read_at del scope >= created_at del mensaje). Excluye al autor.
export const readReceiptsFn = createServerFn({ method: "GET" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return [];
    const msg = await db.getMessage(data.messageId);
    if (!msg) return [];
    const scope = msg.dm_id != null ? ("dm" as const) : ("room" as const);
    const scopeId = msg.dm_id != null ? msg.dm_id : msg.channel_id;
    const readers = await db.listReadReceipts(scope, scopeId, msg.created_at);
    // El autor no "recibe" su propio mensaje; se filtra por nombre (no guardamos su sub).
    return readers.filter((r) => r.name !== msg.sender);
  });
