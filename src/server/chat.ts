import { createServerFn } from "@tanstack/react-start";
import type { RtEvent } from "./bus.server";

// Server functions — modelo Slack. El pool_ token nunca toca el browser.

export async function sessionUser() {
  const { useSession } = await import("@tanstack/react-start/server");
  const s = await useSession<{
    user?: { sub: string; name: string; avatar: string; isOwner: boolean };
  }>({ password: process.env.SESSION_SECRET!, name: "gc_session" });
  return s.data.user ?? null;
}

// Menciones grupales: @all/@channel/@everyone/@aquí notifican a TODA la audiencia
// del room (miembros si es privado; todo el workspace si es público).
const GROUP_MENTIONS = new Set(["all", "channel", "everyone", "aqui", "here", "todos"]);

// Push a los usuarios cuyos @handle aparecen en el mensaje (excluye al autor).
// Soporta menciones grupales (@all/@channel) que abarcan a toda la audiencia.
async function notifyMentions(
  slug: string,
  channelId: number,
  channelName: string,
  body: string,
  senderName: string,
  senderSub: string,
  isPrivate: boolean
): Promise<void> {
  const tokens = (body.match(/@([\wáéíóúñ]+)/gi) ?? []).map((t) => t.slice(1).toLowerCase());
  if (!tokens.length) return;
  const users = await import("../users.server");
  const db = await import("../db.server");

  let targets: string[];
  if (tokens.some((t) => GROUP_MENTIONS.has(t))) {
    // @all/@channel → toda la audiencia del room, menos el autor.
    const audience = isPrivate
      ? await db.listChannelMembers(channelId)
      : (await users.listUsers()).map((u) => u.sub);
    targets = audience.filter((s) => s && s !== senderSub);
  } else {
    targets = await users.resolveMentionedUserSubs(tokens, senderSub);
  }
  if (!targets.length) return;
  // Silencio (mute): quien silenció este room no recibe push por menciones.
  const subs = await db.filterMutedOut(targets, "room", channelId);
  if (!subs.length) return;
  const { notify } = await import("./notify.server");
  const excerpt = body.length > 120 ? body.slice(0, 117) + "…" : body;
  await notify({
    kind: "mention",
    recipients: subs,
    title: `${senderName} te mencionó en #${channelName}`,
    body: excerpt,
    url: `/c/${slug}`,
  });
}

// Publica un evento a la audiencia de un mensaje: si es DM → a cada miembro
// (ch.user); si es de room → al room. Unifica delete/edit/react para rooms y DMs.
async function publishToAudience(
  msg: { channel_id: number; dm_id?: number | null },
  ev: RtEvent
): Promise<void> {
  const bus = await import("./bus.server");
  if (msg.dm_id != null) {
    const db = await import("../db.server");
    for (const sub of await db.getDmMembers(msg.dm_id)) bus.publish(bus.ch.user(sub), ev);
  } else {
    bus.publish(bus.ch.room(msg.channel_id), ev);
  }
}

// Menciones disponibles para el typeahead: agentes + usuarios (miembros).
export const listMentionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { resolvedAgents } = await import("../agents.server");
  const users = await import("../users.server");
  const [agents, us] = await Promise.all([resolvedAgents(), users.listUsers()]);
  return [
    // Menciones grupales (notifican a toda la audiencia del room).
    { handle: "all", name: "Notificar a todos", avatar: "", kind: "group" as const },
    { handle: "channel", name: "Notificar al room", avatar: "", kind: "group" as const },
    ...agents.map((a) => ({ handle: a.handle, name: a.name, avatar: a.avatar, kind: "agent" as const })),
    ...us.map((u) => ({ handle: u.handle, name: u.name, avatar: u.avatar, kind: "user" as const })),
  ];
});

// Shell del room (sidebar + meta), SIN el flujo → el loader es ligero y el
// flujo carga client-side con skeleton (apertura inmediata). Filtra visibilidad.
export const getChannelView = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    // Auto-cura el schema de teams existentes (aditivo, idempotente, memoizado).
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const db = await import("../db.server");
    const user = await sessionUser();
    const channel = await db.getChannel(data.slug);
    if (!channel) return null;
    if (user && !(await db.canSeeChannel(channel, user.sub, user.isOwner))) return null;
    const channels = await db.listChannels(user?.sub ?? "", !!user?.isOwner);
    return { channels, channel };
  });

// El flujo del room (client-side, con skeleton). Adjunta reacciones (1 query).
// Con `topic` filtra al eje Zulip; sin él devuelve el room completo (compat).
export const getChannelFlow = createServerFn({ method: "GET" })
  .validator((d: { slug: string; topic?: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    const user = await sessionUser();
    return db.attachMeta(await db.listChannelFlow(channel.id, data.topic), user?.sub ?? "");
  });

// Topics del room (submenús del sidebar) — distintos topics con conteo/actividad.
export const getTopicsFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    return db.listTopics(channel.id);
  });

// Listado de hilos del canal (para no enterrarlos) — estilo columna Zulip.
export const getChannelThreads = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    return db.listThreadRoots(channel.id);
  });

// Borra un mensaje (y sus respuestas si es raíz). Solo autor u owner.
export const deleteMessageFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { useSession } = await import("@tanstack/react-start/server");
    const s = await useSession<{ user?: { name: string; isOwner: boolean } }>({
      password: process.env.SESSION_SECRET!,
      name: "gc_session",
    });
    const user = s.data.user;
    const msg = await db.getMessage(data.id);
    if (!msg) return { ok: false as const };
    if (!user?.isOwner && msg.sender !== user?.name) throw new Error("no autorizado");
    // Borra los objetos en EasyBits antes de quitar el mensaje (best-effort).
    const fileIds = await db.attachmentFileIds(data.id).catch(() => [] as string[]);
    if (fileIds.length) {
      const { deleteEasyBitsFile } = await import("./easybits-files.server");
      await Promise.all(fileIds.map((fid) => deleteEasyBitsFile(fid).catch(() => false)));
    }
    await db.deleteMessage(data.id);
    await publishToAudience(msg, {
      t: "message:deleted",
      id: msg.id,
      channelId: msg.channel_id,
      parentId: msg.parent_id,
      dmId: msg.dm_id ?? null,
    });
    return { ok: true as const };
  });

// Catch-up (lossless): mensajes del room con id > sinceId. El cliente lo llama al
// (re)conectar / volver a la pestaña para rellenar lo que el SSE pudiera haber perdido.
export const getMessagesSince = createServerFn({ method: "GET" })
  .validator((d: { slug: string; sinceId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    const user = await sessionUser();
    return db.attachMeta(await db.listMessagesSince(channel.id, data.sinceId), user?.sub ?? "");
  });

// Señal efímera de "escribiendo…" (sin DB) → se publica al room.
export const pingTypingFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const user = await sessionUser();
    const channel = await db.getChannel(data.slug);
    if (!channel || !user) return { ok: false as const };
    bus.publish(bus.ch.room(channel.id), {
      t: "typing",
      sub: user.sub,
      name: user.name,
      channelId: channel.id,
    });
    return { ok: true as const };
  });

// Toggle de reacción emoji sobre un mensaje. Publica el nuevo total en vivo.
// Message-centric: la audiencia (room o DM) se deriva del propio mensaje, así
// funciona igual para rooms y DMs (el `slug` queda opcional, ya no es necesario).
export const toggleReactionFn = createServerFn({ method: "POST" })
  .validator((d: { slug?: string; messageId: number; emoji: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const user = await sessionUser();
    if (!user) throw new Error("no autorizado");
    const msg = await db.getMessage(data.messageId);
    if (!msg) throw new Error("Mensaje no encontrado");
    const { op, count } = await db.toggleReaction(data.messageId, user.sub, data.emoji);
    await publishToAudience(msg, {
      t: "reaction",
      messageId: data.messageId,
      emoji: data.emoji,
      userSub: user.sub,
      op,
      count,
    });
    return { ok: true as const, op, count };
  });

// Editar mensaje (solo autor u owner). Publica refresh del contexto.
export const editMessageFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; id: number; body: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const user = await sessionUser();
    const body = data.body.trim();
    if (!body) return { ok: false as const };
    const msg = await db.getMessage(data.id);
    if (!msg) return { ok: false as const };
    if (!user?.isOwner && msg.sender !== user?.name) throw new Error("no autorizado");
    await db.editMessage(data.id, body);
    await publishToAudience(msg, {
      t: "message:edited",
      id: msg.id,
      body,
      edited_at: Math.floor(Date.now() / 1000),
    });
    return { ok: true as const };
  });

// Un hilo: el mensaje raíz + sus respuestas.
export const getThread = createServerFn({ method: "GET" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const user = await sessionUser();
    const [root, replies] = await Promise.all([
      db.getMessage(data.messageId),
      db.listThread(data.messageId),
    ]);
    const withReactions = await db.attachMeta([...(root ? [root] : []), ...replies], user?.sub ?? "");
    const newRoot = root ? withReactions[0] : null;
    const newReplies = root ? withReactions.slice(1) : withReactions;
    return { root: newRoot, replies: newReplies };
  });

export const listChannelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const user = await sessionUser();
  return db.listChannels(user?.sub ?? "", !!user?.isOwner);
});

// Postea al flujo (parentId null) o dentro de un hilo (parentId set).
// `nonce` = id del cliente; se devuelve en el evento realtime para que la pestaña
// autora descarte su propio eco (ya lo tiene optimista).
export const postMessage = createServerFn({ method: "POST" })
  .validator(
    (d: {
      slug: string;
      parentId: number | null;
      body: string;
      nonce?: string;
      topic?: string;
      attachments?: { fileId: string; mime: string; size: number; name: string }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, detectMention } = await import("../agents.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const body = data.body.trim();
    const files = data.attachments ?? [];
    if (!body && files.length === 0) return { ok: false as const };

    // Topic (eje Zulip): los top-level llevan el topic elegido; las respuestas
    // heredan el del root del hilo (un hilo no cambia de topic a media conversación).
    const parent = data.parentId !== null ? await db.getMessage(data.parentId) : null;
    const topic =
      data.parentId !== null
        ? parent?.topic ?? "general"
        : (data.topic ?? "general").trim() || "general";

    const agents = await resolvedAgents();
    const mentioned = detectMention(body, agents.map((a) => a.handle));
    const me = await sessionUser();
    const name = me?.name || "invitado";
    const avatar = me?.avatar || "";
    const { id } = await db.createMessage({
      channelId: channel.id,
      parentId: data.parentId,
      sender: name,
      avatar,
      body,
      agentHandle: mentioned,
      topic,
    });
    if (files.length) await db.createAttachments(id, files);
    // Realtime: publica el mensaje ya persistido a los suscriptores del room.
    let created = await db.getMessage(id);
    if (created && files.length) [created] = await db.attachAttachments([created]);
    if (created) bus.publish(bus.ch.room(channel.id), { t: "message:new", msg: created, nonce: data.nonce });
    // Push a los usuarios @tagged (fire-and-forget resiliente).
    await notifyMentions(channel.slug, channel.id, channel.name, body, name, me?.sub ?? "", channel.is_private === 1).catch(() => {});
    // ¿Qué agente responde y dónde? (handle undefined = ninguno)
    // - @handle en el flujo → abre un HILO bajo ese mensaje (parent = id).
    // - @handle dentro de un hilo → mismo hilo (parent = parentId).
    // - mensaje en un hilo de un agente (root.agent_handle) → auto, sin re-tag.
    let agentHandle: string | undefined;
    let agentParent: number | undefined;
    if (mentioned) {
      agentHandle = mentioned;
      agentParent = data.parentId === null ? id : data.parentId;
    } else if (data.parentId !== null) {
      if (parent?.agent_handle && agents.some((a) => a.handle === parent.agent_handle)) {
        agentHandle = parent.agent_handle;
        agentParent = data.parentId;
      }
    }
    if (agentHandle !== undefined && agentParent !== undefined) {
      const ag = agents.find((a) => a.handle === agentHandle);
      await db.postAgent(channel.id, agentParent, "👾 pensando…", "status", agentHandle, ag?.name ?? "Ghosty", topic);
      // El status "pensando…" aparece en vivo para todos (churn de agente → refresh).
      bus.publish(bus.ch.room(channel.id), { t: "refresh", channelId: channel.id, parentId: agentParent });
    }
    return {
      ok: true as const,
      id,
      agentParent: agentParent ?? null,
      agentHandle: agentHandle ?? null,
      needsAgent: agentHandle !== undefined,
    };
  });

// El agente responde en el MISMO contexto (flujo o hilo). Limpia el "pensando".
export const askAgent = createServerFn({ method: "POST" })
  .validator((d: { slug: string; parentId: number | null; body: string; sender: string; handle: string; topic?: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { resolvedAgents, callAgentBackend } = await import("../agents.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    let reply: string;
    let name = "Ghosty";
    if (!agent) {
      reply = `👾 @${data.handle} no está conectado. El owner lo configura en Ajustes → Agentes.`;
    } else {
      name = agent.name;
      const groupId = `ghosty-chat-${channel.slug}-${data.parentId ?? "flow"}`;
      reply = await callAgentBackend(agent, groupId, data.sender, data.body);
    }
    // El reply es una respuesta de hilo (parentId no-null); hereda el topic del root.
    let topic = data.topic;
    if (topic == null && data.parentId != null) {
      const root = await db.getMessage(data.parentId);
      topic = root?.topic ?? "general";
    }
    await db.clearStatus(channel.id, data.parentId);
    await db.postAgent(channel.id, data.parentId, reply, "msg", data.handle, name, topic ?? "general");
    // La respuesta del agente aparece en vivo para todos (borra el status + muestra reply).
    const bus = await import("./bus.server");
    bus.publish(bus.ch.room(channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
    return { ok: true as const };
  });
