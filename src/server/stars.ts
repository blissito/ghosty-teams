import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Star / Pin / Mute (Fase 2.3) ────────────────────────────────────────────
// Star = marcador PERSONAL (por-usuario) → evento a ch.user(sub) para sincronizar
// las demás pestañas del mismo usuario. Pin = fijado de ROOM (lo ven todos, solo
// owner/creador) → evento a ch.room. Mute = silencia un scope (room/dm): filtra su
// badge de no-leídos y suprime el push (ver unreadBy*/notify* en db/chat/dm).

export const toggleStarFn = createServerFn({ method: "POST" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autorizado");
    const { starred } = await db.toggleStar(me.sub, data.messageId);
    // Personal: sincroniza mis otras pestañas/dispositivos.
    bus.publish(bus.ch.user(me.sub), { t: "star", messageId: data.messageId, starred });
    return { ok: true as const, starred };
  });

export const togglePinFn = createServerFn({ method: "POST" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autorizado");
    const msg = await db.getMessage(data.messageId);
    if (!msg) throw new Error("mensaje no encontrado");
    // Fijar es acción de room: solo owner o creador del room.
    const ch = (await db.listChannels(me.sub, !!me.isOwner)).find((c) => c.id === msg.channel_id);
    if (!ch || (!me.isOwner && ch.created_by !== me.sub)) throw new Error("no autorizado");
    const { pinned } = await db.togglePin(msg.channel_id, data.messageId, me.sub);
    bus.publish(bus.ch.room(msg.channel_id), {
      t: "pin",
      channelId: msg.channel_id,
      messageId: data.messageId,
      pinned,
    });
    return { ok: true as const, pinned };
  });

// Mensajes fijados de un room (barra en el header del room).
export const getPinsFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    const ch = await db.getChannel(data.slug);
    if (!ch || !me) return [];
    return db.attachMeta(await db.listPinned(ch.id), me.sub);
  });

export const toggleMuteFn = createServerFn({ method: "POST" })
  .validator((d: { scope: "room" | "dm"; scopeId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autorizado");
    const { muted } = await db.toggleMute(me.sub, data.scope, data.scopeId);
    return { ok: true as const, muted };
  });

// Scopes silenciados por el usuario (para pintar dimmed y suprimir badge en el sidebar).
export const listMutesFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return [];
  return db.listMutes(me.sub);
});
