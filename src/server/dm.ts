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

// El agente responde dentro del DM, con streaming first-class (igual que en rooms:
// cáscara perezosa al primer token → deltas → body final). Media de entrada = los
// adjuntos del usuario como FileParts. Contrato: docs/AGENT-MEDIA-CONTRACT.md.
export const askDmAgentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id: number;
      body: string;
      sender: string;
      handle: string;
      attachments?: { fileId: string; mime: string; size: number; name: string }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, runAgentTurn, buildMediaParts } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    const name = agent?.name ?? "Ghosty";
    const members = await db.getDmMembers(data.id);
    const fanout = (ev: Parameters<typeof bus.publish>[1]) => {
      for (const sub of members) bus.publish(bus.ch.user(sub), ev);
    };

    const parts = await buildMediaParts(data.attachments ?? []);
    const groupId = `ghosty-chat-${data.handle}-dm-${data.id}`; // memoria por-agente

    const { id, reply } = await runAgentTurn({
      agent,
      handle: data.handle,
      groupId,
      sender: data.sender,
      text: data.body,
      parts,
      createShell: async () => {
        const clearedIds = await db.clearDmStatus(data.id);
        for (const sid of clearedIds)
          fanout({ t: "message:deleted", id: sid, channelId: null, parentId: null, dmId: data.id });
        const { id } = await db.postDmAgent(data.id, "", "msg", data.handle, name, agent?.avatar ?? "");
        const shell = await db.getMessage(id);
        if (shell) fanout({ t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) => fanout({ t: "message:delta", id: mid, chunk, channelId: null, parentId: null, dmId: data.id }),
      emitBody: (mid, body) => fanout({ t: "message:body", id: mid, body }),
    });

    await db.setMessageBody(id, reply);
    fanout({ t: "message:body", id, body: reply });

    // Artefacto vivo en DM: si el agente generó un ```eb-doc```/```eb-sheet```, lo limpiamos
    // de la burbuja y lo commiteamos LOCAL (misma verdad markdown/csv que en el room). En DM
    // no cableamos identidad por-hilo → cada artefacto es una card nueva (co-edición diferida).
    try {
      const { extractEbDoc, draftTitle, bubbleWithoutEbDoc } = await import("../lib/ebdoc");
      const { randomUUID } = await import("node:crypto");
      const ebdoc = extractEbDoc(reply);
      if (ebdoc?.closed && ebdoc.md.trim()) {
        const cleaned = bubbleWithoutEbDoc(reply);
        await db.setMessageBody(id, cleaned);
        fanout({ t: "message:body", id, body: cleaned });
        await db.createArtifact(id, {
          kind: ebdoc.kind,
          url: `${ebdoc.kind}_${randomUUID()}`,
          title: draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle),
          md: ebdoc.md,
        });
        fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id });
      }
    } catch (e) {
      console.error("[dm artifact] commit failed", e);
    }
    return { ok: true as const };
  });
