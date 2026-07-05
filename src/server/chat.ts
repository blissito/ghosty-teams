import { createServerFn } from "@tanstack/react-start";

// Server functions — modelo Slack. El pool_ token nunca toca el browser.

export async function sessionUser() {
  const { useSession } = await import("@tanstack/react-start/server");
  const s = await useSession<{
    user?: { sub: string; name: string; avatar: string; isOwner: boolean };
  }>({ password: process.env.SESSION_SECRET!, name: "gc_session" });
  return s.data.user ?? null;
}

// Push a los usuarios cuyos @handle aparecen en el mensaje (excluye al autor).
async function notifyMentions(
  slug: string,
  channelName: string,
  body: string,
  senderName: string,
  senderSub: string
): Promise<void> {
  const tokens = (body.match(/@(\w+)/g) ?? []).map((t) => t.slice(1).toLowerCase());
  if (!tokens.length) return;
  const users = await import("../users.server");
  const subs = await users.resolveMentionedUserSubs(tokens, senderSub);
  if (!subs.length) return;
  const db = await import("../db.server");
  const push = await import("../push.server");
  const stored = await db.listPushSubsForUsers(subs);
  const excerpt = body.length > 120 ? body.slice(0, 117) + "…" : body;
  const payload = { title: `${senderName} te mencionó en #${channelName}`, body: excerpt, url: `/c/${slug}` };
  await Promise.all(
    stored.map(async (s) => {
      const r = await push.sendPush(s, payload);
      if (r === "gone") await db.deletePushSub(s.endpoint);
    })
  );
}

// Menciones disponibles para el typeahead: agentes + usuarios (miembros).
export const listMentionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { resolvedAgents } = await import("../agents.server");
  const users = await import("../users.server");
  const [agents, us] = await Promise.all([resolvedAgents(), users.listUsers()]);
  return [
    ...agents.map((a) => ({ handle: a.handle, name: a.name, avatar: a.avatar, kind: "agent" as const })),
    ...us.map((u) => ({ handle: u.handle, name: u.name, avatar: u.avatar, kind: "user" as const })),
  ];
});

// Shell del room (sidebar + meta), SIN el flujo → el loader es ligero y el
// flujo carga client-side con skeleton (apertura inmediata). Filtra visibilidad.
export const getChannelView = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const user = await sessionUser();
    const channel = await db.getChannel(data.slug);
    if (!channel) return null;
    if (user && !(await db.canSeeChannel(channel, user.sub, user.isOwner))) return null;
    const channels = await db.listChannels(user?.sub ?? "", !!user?.isOwner);
    return { channels, channel };
  });

// El flujo del room (client-side, con skeleton).
export const getChannelFlow = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    return db.listChannelFlow(channel.id);
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
    await db.deleteMessage(data.id);
    return { ok: true as const };
  });

// Un hilo: el mensaje raíz + sus respuestas.
export const getThread = createServerFn({ method: "GET" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const [root, replies] = await Promise.all([
      db.getMessage(data.messageId),
      db.listThread(data.messageId),
    ]);
    return { root, replies };
  });

export const listChannelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const user = await sessionUser();
  return db.listChannels(user?.sub ?? "", !!user?.isOwner);
});

// Postea al flujo (parentId null) o dentro de un hilo (parentId set).
export const postMessage = createServerFn({ method: "POST" })
  .validator((d: { slug: string; parentId: number | null; body: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { resolvedAgents, detectMention } = await import("../agents.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const body = data.body.trim();
    if (!body) return { ok: false as const };

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
    });
    // Push a los usuarios @tagged (fire-and-forget resiliente).
    await notifyMentions(channel.slug, channel.name, body, name, me?.sub ?? "").catch(() => {});
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
      const root = await db.getMessage(data.parentId);
      if (root?.agent_handle && agents.some((a) => a.handle === root.agent_handle)) {
        agentHandle = root.agent_handle;
        agentParent = data.parentId;
      }
    }
    if (agentHandle !== undefined && agentParent !== undefined) {
      const ag = agents.find((a) => a.handle === agentHandle);
      await db.postAgent(channel.id, agentParent, "👾 pensando…", "status", agentHandle, ag?.name ?? "Ghosty");
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
  .validator((d: { slug: string; parentId: number | null; body: string; sender: string; handle: string }) => d)
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
    await db.clearStatus(channel.id, data.parentId);
    await db.postAgent(channel.id, data.parentId, reply, "msg", data.handle, name);
    return { ok: true as const };
  });
