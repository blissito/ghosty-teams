import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Reenviar (forward estilo WhatsApp) ───────────────────────────────────────
// Compartir un mensaje COMPLETO (texto + adjuntos) a otro canal/DM del workspace.
// Lo re-publica el usuario ACTUAL, marcado "Reenviado de <autor original>".

// Destinos a los que el usuario puede reenviar: canales visibles + sus DMs.
export const forwardTargetsFn = createServerFn({ method: "GET" }).handler(async () => {
  await (await import("./schema.server")).ensureSchema().catch(() => {});
  const db = await import("../db.server");
  const me = await sessionUser();
  const empty = { channels: [] as { slug: string; name: string; icon: string | null }[], dms: [] as { id: number; name: string; avatar: string }[] };
  if (!me) return empty;
  const channels = (await db.listChannels(me.sub, !!me.isOwner))
    .filter((c) => !c.archived)
    .map((c) => ({ slug: c.slug, name: c.name, icon: c.icon }));
  const dms = (await db.listDmConversations(me.sub)).map((d) => ({
    id: d.id,
    name: d.title ?? (d.members.map((m) => m.name).join(", ") || "Conversación"),
    avatar: d.members[0]?.avatar ?? "",
  }));
  return { channels, dms };
});

export const forwardMessageFn = createServerFn({ method: "POST" })
  .validator((d: { messageId: number; to: { slug: string } | { dmId: number } }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const ns = await currentNamespace();

    const src = await db.getMessage(data.messageId);
    if (!src) throw new Error("mensaje no encontrado");

    // Autz por lo que el usuario PUEDE ver/postear (canales visibles + sus DMs). Valida el
    // ORIGEN (¿puede leerlo?) y el DESTINO (¿es miembro?) contra el mismo set.
    const chans = await db.listChannels(me.sub, !!me.isOwner);
    const dms = await db.listDmConversations(me.sub);
    const chanIds = new Set(chans.map((c) => c.id));
    const dmIds = new Set(dms.map((d) => d.id));
    if (src.dm_id != null ? !dmIds.has(src.dm_id) : !chanIds.has(src.channel_id)) {
      throw new Error("no autorizado (origen)");
    }

    // Contenido a copiar: cuerpo + adjuntos (mismos file_ids → sin re-subir). Preserva el
    // autor ORIGINAL aunque el mensaje ya fuera un reenvío (cadena → misma fuente).
    const [withAtt] = await db.attachAttachments([src]);
    const attachments = (withAtt.attachments ?? []).map((a) => ({
      fileId: a.file_id,
      mime: a.mime ?? "application/octet-stream",
      size: a.size ?? 0,
      name: a.name ?? "archivo",
      thumbFileId: a.thumb_file_id ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    }));
    const body = (src.body ?? "").trim();
    if (!body && attachments.length === 0) throw new Error("nada que reenviar");
    const original = src.forwarded_from || src.sender || "alguien";

    const publishNew = async (id: number) => {
      await db.setForwardedFrom(id, original);
      if (attachments.length) await db.createAttachments(id, attachments);
      const msg = await db.getMessage(id);
      return msg ? (await db.attachAttachments([msg]))[0] : null;
    };

    if ("slug" in data.to) {
      const ch = await db.getChannel(data.to.slug);
      if (!ch || !chanIds.has(ch.id)) throw new Error("no autorizado (destino)");
      const { id } = await db.createMessage({ channelId: ch.id, parentId: null, sender: me.name, senderSub: me.sub, avatar: me.avatar, body });
      const full = await publishNew(id);
      if (full) bus.publish(bus.ch.room(ns, ch.id), { t: "message:new", msg: full });
      return { ok: true as const, kind: "room" as const, slug: ch.slug, name: ch.name };
    }

    const dmId = data.to.dmId;
    if (!dmIds.has(dmId)) throw new Error("no autorizado (destino)");
    const { id } = await db.createDmMessage({ dmId, sender: me.name, senderSub: me.sub, avatar: me.avatar, body });
    const full = await publishNew(id);
    if (full) for (const sub of await db.getDmMembers(dmId)) bus.publish(bus.ch.user(ns, sub), { t: "message:new", msg: full });
    const dest = dms.find((d) => d.id === dmId);
    return { ok: true as const, kind: "dm" as const, dmId, name: dest?.title ?? "Conversación" };
  });
