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
  ns: string,
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
  }, ns);
}

// Abre (o reusa) un DM con un usuario (o varios → grupo). Devuelve el id.
export const openDmFn = createServerFn({ method: "POST" })
  .validator((d: { subs?: string[]; agentHandle?: string }) => d)
  .handler(async ({ data }) => {
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) throw new Error("no autorizado");
    // DM 1:1 con un agente de la flota: cada mensaje enruta a ese agente (sin @mención).
    if (data.agentHandle) {
      const handle = data.agentHandle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!handle) throw new Error("agente inválido");
      const id = await db.openAgentDm(handle, me.sub);
      return { id };
    }
    const subs = [...new Set([me.sub, ...(data.subs ?? [])].filter(Boolean))];
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
      quotedId?: number | null; // quote-reply
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, detectMention, quoteExcerpt } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const body = data.body.trim();
    const files = data.attachments ?? [];
    if (!body && files.length === 0) return { ok: false as const };

    // Quote-reply: snapshot autoritativo del citado (mismo criterio que en rooms).
    const quoted = data.quotedId != null ? await db.getMessage(data.quotedId).catch(() => null) : null;

    const agents = await resolvedAgents();
    // DM 1:1 con un agente → cada mensaje enruta a ESE agente (sin @mención). Si no,
    // se detecta @mención normal. El handle del DM gana.
    const dmAgent = await db.getDmAgentHandle(data.id);
    const mentioned = (dmAgent && agents.some((a) => a.handle === dmAgent) ? dmAgent : null)
      ?? detectMention(body, agents.map((a) => a.handle));
    const { id } = await db.createDmMessage({
      dmId: data.id,
      sender: me.name,
      senderSub: me.sub,
      avatar: me.avatar,
      body,
      agentHandle: mentioned,
      quotedId: quoted?.id ?? null,
      quotedAuthor: quoted?.sender ?? null,
      quotedExcerpt: quoted ? quoteExcerpt(quoted.body ?? "") : null,
    });
    if (files.length) await db.createAttachments(id, files);
    let created = await db.getMessage(id);
    if (created && files.length) [created] = await db.attachAttachments([created]);
    const members = await db.getDmMembers(data.id);
    // Realtime: una vez por miembro (incluye al emisor → dedupe por nonce).
    if (created)
      for (const sub of members)
        bus.publish(bus.ch.user(ns, sub), { t: "message:new", msg: created, nonce: data.nonce });
    await notifyDm(ns, data.id, members, me.sub, me.name, body).catch(() => {});

    // @agente en un DM → responde inline en el mismo DM. Caja caliente: la cáscara del
    // agente se crea EAGER (kind:"msg" VACÍA, con avatar+nombre) aquí → aparece al instante
    // y PERMANECE; askDmAgentFn streamea sobre este mismo id. Sin "pensando…" que borrar.
    let shellId: number | null = null;
    if (mentioned) {
      const ag = agents.find((a) => a.handle === mentioned);
      const { id: sid } = await db.postDmAgent(data.id, "", "msg", mentioned, ag?.name ?? "Ghosty", ag?.avatar ?? "");
      shellId = sid;
      const shell = await db.getMessage(sid);
      if (shell) for (const sub of members) bus.publish(bus.ch.user(ns, sub), { t: "message:new", msg: shell });
    }
    return {
      ok: true as const,
      id,
      needsAgent: mentioned != null,
      agentHandle: mentioned ?? null,
      shellId,
    };
  });

// Comando /clear en un DM con agente: rota la sesión del agente (arranca sin memoria)
// y deja una burbuja de confirmación del agente. Idempotente/best-effort. El cliente
// muestra la ADVERTENCIA antes de invocar esto (acción destructiva: borra el contexto).
export const clearDmAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, resetAgentSession } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const handle = await db.getDmAgentHandle(data.id);
    const agent = handle ? (await resolvedAgents()).find((a) => a.handle === handle) : null;
    if (!agent) return { ok: false as const };

    const groupId = `ghosty-chat-${agent.handle}-dm-${data.id}`; // == askDmAgentFn
    await resetAgentSession(agent, groupId);

    // Burbuja del agente confirmando el reset (queda en el historial del DM).
    const { id } = await db.postDmAgent(
      data.id,
      "🧹 Listo, borré la memoria de esta conversación. Empezamos de cero.",
      "msg",
      agent.handle,
      agent.name ?? "Ghosty",
      agent.avatar ?? ""
    );
    const msg = await db.getMessage(id);
    if (msg) {
      const members = await db.getDmMembers(data.id);
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), { t: "message:new", msg });
    }
    return { ok: true as const };
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
      shellId?: number; // caja caliente: cáscara ya creada por postDmMessageFn
      quotedAuthor?: string | null; // quote-reply: superficie para el agente
      quotedExcerpt?: string | null;
      quotedId?: number | null; // id del mensaje citado → cita COMPLETA (no el excerpt)
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, runAgentTurn, buildMediaParts, quotedContextPrefix, clampQuote, historyContext } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    const name = agent?.name ?? "Ghosty";
    const members = await db.getDmMembers(data.id);
    const fanout = (ev: Parameters<typeof bus.publish>[1]) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    };

    const parts = await buildMediaParts(data.attachments ?? []);
    const groupId = `ghosty-chat-${data.handle}-dm-${data.id}`; // memoria por-agente
    // Quote-reply: embebe la cita en el texto (superficie WABA → el agente siempre la ve).
    // Si tenemos el id del citado, mandamos su cuerpo COMPLETO (no el excerpt de 220 chars)
    // → "dame tips sobre ESTO" tiene el contenido real. Fallback al excerpt.
    let quoteCite = data.quotedExcerpt ?? null;
    if (data.quotedId != null) {
      const qm = await db.getMessage(data.quotedId).catch(() => null);
      if (qm?.body?.trim()) quoteCite = clampQuote(qm.body);
    }
    const quoted = quoteCite?.trim()
      ? quotedContextPrefix(data.quotedAuthor ?? "", quoteCite, data.body)
      : data.body;
    // Catch-up (mismo modelo que en canales): el worker ya tiene SUS turnos (resume+compact);
    // le inyectamos solo los mensajes POSTERIORES a su última respuesta en este DM (el "gap").
    // En un DM 1:1 normalmente responde a todo → el gap = solo el turno actual → historyContext
    // lo filtra → sin inyección (eficiente). Si acumuló mensajes sin verlos (o sesión fresca),
    // el gap los trae. La cita completa SÍ va por-turno.
    const recent = await db.recentContext({ dmId: data.id }, 25).catch(() => []);
    let lastAgentIdx = -1;
    recent.forEach((m, i) => { if (m.agent_handle && (m.body ?? "").trim()) lastAgentIdx = i; });
    const history = historyContext(recent.slice(lastAgentIdx + 1), data.body);
    // Conectores per-user (DM 1:1): el DM tiene UN solo humano (`me`), identidad inequívoca.
    // GENÉRICO y escalable — dm.ts NO sabe de Calendly ni de ningún conector: el builder
    // itera los conectados del usuario y concatena su `ambientContext` (contrato uniforme).
    // Va en el TEXTO del turno (variable por-turno, patrón quote/artifactDocHint), best-effort.
    let calHint = "";
    try {
      const { buildConnectorContext } = await import("./connectors/context.server");
      calHint = await buildConnectorContext(me.sub, data.sender || "el usuario", data.body || "");
    } catch {}
    const text = history + calHint + quoted;

    // Identidad del artefacto del DM → el agente recibe el artefacto ACTUAL (artifactDocHint)
    // para MODIFICARLO (re-emitir la misma versión), no recrearlo desde cero ni duplicar la card.
    const currentDocId = await db.getDmArtifact(data.id).catch(() => null);
    const currentDoc = currentDocId ? await db.getDoc(currentDocId).catch(() => null) : null;
    const { id, reply } = await runAgentTurn({
      agent,
      handle: data.handle,
      groupId,
      sender: data.sender,
      text,
      parts,
      currentDoc,
      invokerSub: me.sub, // DM 1:1: el humano del DM es el invocador → sus tools de conectores
      createShell: async () => {
        // Caja caliente: la cáscara ya fue creada EAGER por postDmMessageFn → reutiliza su
        // id. Fallback (cliente sin shellId): créala aquí.
        if (data.shellId != null) return data.shellId;
        const { id } = await db.postDmAgent(data.id, "", "msg", data.handle, name, agent?.avatar ?? "");
        const shell = await db.getMessage(id);
        if (shell) fanout({ t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) => fanout({ t: "message:delta", id: mid, chunk, channelId: null, parentId: null, dmId: data.id }),
      emitBody: (mid, body) => fanout({ t: "message:body", id: mid, body }),
    });

    // Nunca persistas un body VACÍO (deepseek cierra el turno en blanco a veces) → el
    // mensaje quedaba vacío. Mismo guard que el room (chat.ts).
    const finalBody = reply.trim() ? reply : "(sin respuesta)";
    await db.setMessageBody(id, finalBody);
    fanout({ t: "message:body", id, body: finalBody });

    // Artefacto vivo en DM: si el agente generó un ```eb-doc```/```eb-sheet```, lo limpiamos
    // de la burbuja y lo commiteamos LOCAL (misma verdad markdown/csv que en el room). En DM
    // no cableamos identidad por-hilo → cada artefacto es una card nueva (co-edición diferida).
    try {
      const { extractEbDoc, draftTitle, bubbleWithoutEbDoc, extractAskUser, stripAskUser, extractEbAudio, stripEbAudio } = await import("../lib/ebdoc");
      const { randomUUID } = await import("node:crypto");

      // Nota de voz en DM: mismo protocolo que el room (```eb-audio``` → adjunto audio).
      const ebAudio = extractEbAudio(reply);
      if (ebAudio) {
        const cleaned = stripEbAudio(reply);
        await db.setMessageBody(id, cleaned);
        fanout({ t: "message:body", id, body: cleaned });
        try {
          const { uploadToEasyBits } = await import("./easybits-files.server");
          const r = await fetch(ebAudio.url);
          if (!r.ok) throw new Error(`fetch audio ${r.status}`);
          const bytes = Buffer.from(await r.arrayBuffer());
          const up = await uploadToEasyBits({
            blob: new Blob([bytes], { type: ebAudio.mime || "audio/ogg" }),
            contentType: ebAudio.mime || "audio/ogg",
            fileName: "voz.ogg",
          });
          await db.createAttachments(id, [{
            fileId: up.fileId, mime: up.mime || "audio/ogg", size: up.size ?? bytes.length,
            name: "Nota de voz", waveform: ebAudio.waveform ?? null, durationMs: ebAudio.durationMs ?? null,
          }]);
          fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id });
        } catch (e) {
          console.error("[voice][dm] attach failed", e);
        }
        return { ok: true as const };
      }
      const ebdoc = extractEbDoc(reply);
      if (ebdoc?.closed && ebdoc.md.trim()) {
        const cleaned = bubbleWithoutEbDoc(reply);
        await db.setMessageBody(id, cleaned);
        fanout({ t: "message:body", id, body: cleaned });
        // Reusa el documentId existente del DM (misma identidad = nueva versión, MISMA card)
        // o acuña uno v1 → sin duplicados. Parea con el room (chat.ts).
        const documentId = currentDocId ?? `${ebdoc.kind}_${randomUUID()}`;
        const title = draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle);
        // Artefacto HTML → publícalo a S3 público como enlace compartible (igual que el room).
        let src: string | null = null;
        if (ebdoc.kind === "artifact") {
          try {
            const storage = await import("./storage.server");
            if (storage.storageConfigured()) {
              const put = await storage.put({
                blob: new Blob([ebdoc.md], { type: "text/html" }),
                contentType: "text/html; charset=utf-8",
                fileName: `${(title || "artefacto").slice(0, 60)}.html`,
                visibility: "public",
              });
              const base = process.env.ARTIFACT_PUBLIC_BASE?.replace(/\/$/, "");
              src = base ? `${base}/${put.key}` : storage.publicUrl(put.key);
            }
          } catch (e) {
            console.error("[artifact][dm] publish failed", e);
          }
        }
        await db.createArtifact(id, {
          kind: ebdoc.kind,
          url: documentId,
          title,
          md: ebdoc.md,
          src,
        });
        await db.setDmArtifact(data.id, documentId).catch(() => {});
        fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id });
      } else {
        // ask-user: pregunta con opciones clicables (mismo formato que en el room).
        const ask = extractAskUser(reply);
        if (ask) {
          const cleaned = stripAskUser(reply);
          await db.setMessageBody(id, cleaned);
          fanout({ t: "message:body", id, body: cleaned });
          await db.createArtifact(id, {
            kind: "ask-user",
            url: "",
            title: ask.question || null,
            md: JSON.stringify(ask.options),
          });
          fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id });
        }
      }
    } catch (e) {
      console.error("[dm artifact] commit failed", e);
    }
    return { ok: true as const };
  });
