import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Mensajes directos (DMs) ─────────────────────────────────────────────────
// Referencia Zulip: conversaciones directas 1:1 y de grupo. Reusan gc_messages
// (dm_id) → heredan optimistic, markdown, reacciones, edición y @ghosty-en-DM.
// Realtime: se publica a ch.user(sub) de CADA miembro (el stream ya está suscrito
// a su propio ch.user), así llega exactamente una vez por miembro y el emisor
// descarta su eco por nonce. Durabilidad la da libSQL (igual que los rooms).

// Notifica a los demás miembros del DM (un DM es un ping directo, sin @mención).
// Pasa por la capa agnóstica (Web Push hoy; email mañana, sin tocar aquí).
async function notifyDm(
  dmId: number,
  members: string[],
  senderSub: string,
  senderName: string,
  body: string
): Promise<void> {
  const db = await import("../db.server");
  // Silencio (mute): quien silenció este DM no recibe push.
  const targets = await db.filterMutedOut(
    members.filter((s) => s !== senderSub),
    "dm",
    dmId
  );
  if (!targets.length) return;
  const { notify } = await import("./notify.server");
  const excerpt = body.length > 120 ? body.slice(0, 117) + "…" : body;
  await notify({
    kind: "dm",
    recipients: targets,
    // Los DMs son estado-cliente dentro de /c/$slug (como los hilos) → el deep-link
    // directo a un DM es un follow-up; por ahora el push abre la app.
    title: `${senderName} te escribió`,
    body: excerpt,
    url: `/`,
  });
}

// Abre (o reusa) un DM con un usuario (o varios → grupo). Devuelve el id.
export const openDmFn = createServerFn({ method: "POST" })
  .validator((d: { subs: string[] }) => d)
  .handler(async ({ data }) => {
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autorizado");
    const subs = [...new Set([me.sub, ...data.subs].filter(Boolean))];
    if (subs.length < 2) throw new Error("elige al menos un destinatario");
    const id = await db.openDmConversation(subs, me.sub);
    return { id };
  });

// Lista las conversaciones directas del usuario (para la sección del sidebar).
export const listDmsFn = createServerFn({ method: "GET" }).handler(async () => {
  await (await import("./schema.server")).ensureSchema().catch(() => {});
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return [];
  return db.listDmConversations(me.sub);
});

// El flujo de un DM (client-side, con skeleton). Autoriza por membresía.
export const getDmFlowFn = createServerFn({ method: "GET" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) return null;
    const members = await db.listDmConversations(me.sub);
    const conv = members.find((c) => c.id === data.id) ?? null;
    const flow = await db.attachMeta(await db.listDmFlow(data.id), me.sub);
    return { conv, flow };
  });

// Postea a un DM. Publica a cada miembro (ch.user) y dispara @ghosty si lo taggean.
export const postDmMessageFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id: number;
      body: string;
      nonce?: string;
      attachments?: { fileId: string; mime: string; size: number; name: string }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, detectMention } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const body = data.body.trim();
    const files = data.attachments ?? [];
    if (!body && files.length === 0) return { ok: false as const };

    const agents = await resolvedAgents();
    const mentioned = detectMention(body, agents.map((a) => a.handle));
    const { id } = await db.createDmMessage({
      dmId: data.id,
      sender: me.name,
      avatar: me.avatar,
      body,
      agentHandle: mentioned,
    });
    if (files.length) await db.createAttachments(id, files);
    let created = await db.getMessage(id);
    if (created && files.length) [created] = await db.attachAttachments([created]);
    const members = await db.getDmMembers(data.id);
    // Realtime: una vez por miembro (incluye al emisor → dedupe por nonce).
    if (created)
      for (const sub of members)
        bus.publish(bus.ch.user(sub), { t: "message:new", msg: created, nonce: data.nonce });
    await notifyDm(data.id, members, me.sub, me.name, body).catch(() => {});

    // @agente en un DM → responde inline en el mismo DM.
    if (mentioned) {
      const ag = agents.find((a) => a.handle === mentioned);
      await db.postDmAgent(data.id, "👾 pensando…", "status", mentioned, ag?.name ?? "Ghosty");
      for (const sub of members)
        bus.publish(bus.ch.user(sub), { t: "refresh", channelId: null, parentId: null, dmId: data.id });
    }
    return {
      ok: true as const,
      id,
      needsAgent: mentioned != null,
      agentHandle: mentioned ?? null,
    };
  });

// El agente responde dentro del DM. Limpia el "pensando" y publica el refresh.
export const askDmAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; body: string; sender: string; handle: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, callAgentBackend } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    let reply: string;
    let name = "Ghosty";
    if (!agent) {
      reply = `👾 @${data.handle} no está conectado. El owner lo configura en Ajustes → Agentes.`;
    } else {
      name = agent.name;
      const groupId = `ghosty-chat-dm-${data.id}`;
      reply = await callAgentBackend(agent, groupId, data.sender, data.body);
    }
    await db.clearDmStatus(data.id);
    await db.postDmAgent(data.id, reply, "msg", data.handle, name);
    const members = await db.getDmMembers(data.id);
    for (const sub of members)
      bus.publish(bus.ch.user(sub), { t: "refresh", channelId: null, parentId: null, dmId: data.id });
    return { ok: true as const };
  });
