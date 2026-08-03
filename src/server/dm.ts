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
    const { resolvedAgents, quoteExcerpt } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const body = data.body.trim();
    const files = data.attachments ?? [];
    if (!body && files.length === 0) return { ok: false as const };

    // Quote-reply: snapshot autoritativo del citado (mismo criterio que en rooms).
    const quoted = data.quotedId != null ? await db.getMessage(data.quotedId).catch(() => null) : null;

    const agents = await resolvedAgents();
    // DM 1:1 con un agente → cada mensaje enruta a ESE agente (sin @mención).
    // En un DM humano-humano el agente NO participa: aunque alguien escriba @ghosty,
    // no se invoca (la mención queda como texto). Decisión de producto 2026-07-26.
    const dmAgent = await db.getDmAgentHandle(data.id);
    const mentioned = dmAgent && agents.some((a) => a.handle === dmAgent) ? dmAgent : null;
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
    const { resolvedAgents, resetAgentSession, agentGroupId } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const handle = await db.getDmAgentHandle(data.id);
    const agent = handle ? (await resolvedAgents()).find((a) => a.handle === handle) : null;
    if (!agent) return { ok: false as const };

    const groupId = await agentGroupId(agent, `dm-${data.id}`); // == askDmAgentFn
    await resetAgentSession(agent, groupId);
    // El reset rota la sesión del runtime, pero el puntero del artefacto vivo es NUESTRO
    // (tabla local, se relee fresco cada turno en askDmAgentFn) → si no lo soltamos, tras
    // "borré la memoria" el siguiente artefacto sale como VERSIÓN del anterior.
    await db.clearDmArtifact(data.id);

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
    const { resolvedAgents, runAgentTurn, buildMediaParts, quotedContextPrefix, clampQuote, historyContext, gapDesdeUltimaRespuesta, agentGroupId, INJECTED } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    // Sólo DMs humano↔agente: en un DM humano-humano el agente no contesta.
    const dmAgent = await db.getDmAgentHandle(data.id);
    if (!dmAgent || dmAgent !== data.handle) return { ok: false as const };
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    const name = agent?.name ?? "Ghosty";
    const members = await db.getDmMembers(data.id);
    const fanout = (ev: Parameters<typeof bus.publish>[1]) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    };

    const groupId = await agentGroupId(agent ?? { handle: data.handle }, `dm-${data.id}`); // memoria por-agente
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
    const recent = await db.recentContext({ dmId: data.id }, 8).catch(() => []);
    const { esRecordatorio } = await import("./reminders.server");
    const history = historyContext(gapDesdeUltimaRespuesta(recent, esRecordatorio), data.body);
    // Conectores per-user (DM 1:1): el DM tiene UN solo humano (`me`), identidad inequívoca.
    // GENÉRICO y escalable — dm.ts NO sabe de Calendly ni de ningún conector: el builder
    // itera los conectados del usuario y concatena su `ambientContext` (contrato uniforme).
    // Va en el TEXTO del turno (variable por-turno, patrón quote/artifactDocHint), best-effort.
    let calHint = "";
    try {
      const { buildConnectorContext } = await import("./connectors/context.server");
      calHint = await buildConnectorContext(me.sub, data.sender || "el usuario", data.body || "");
    } catch {}
    // Media de entrada + RE-ENTREGA. Mismo problema que en canales (ver chat.ts): un
    // turno sin archivos propios dejaba al agente ciego a lo ya adjuntado, aunque
    // siguiera visible en la conversación. En un DM no hay hilo del que colgarse, así
    // que la fuente es el último mensaje humano del scope que traía adjuntos.
    let mediaAtts: { fileId: string; mime: string | null; size: number | null; name: string | null }[] =
      data.attachments ?? [];
    let reentrega = false;
    if (!mediaAtts.length && recent.length) {
      const conAdj = await db.attachAttachments([...recent]).catch(() => []);
      for (let i = conAdj.length - 1; i >= 0; i--) {
        const m = conAdj[i];
        if (m.agent_handle || !m.attachments?.length) continue;
        mediaAtts = m.attachments.map((a) => ({
          fileId: a.file_id, mime: a.mime, size: a.size, name: a.name,
        }));
        reentrega = true;
        break;
      }
    }
    let manifiesto = "";
    if (reentrega) {
      const lista = mediaAtts.map((a) => `- ${a.name ?? "(sin nombre)"} (${a.mime ?? "?"}, ${a.size ?? "?"} B)`).join("\n");
      manifiesto = `[Adjuntos de esta conversación, disponibles en este turno]\n${lista}\n\n`;
    }
    const parts = await buildMediaParts(mediaAtts, { forceUri: reentrega });

    const text = history + calHint + manifiesto + quoted;

    // Identidad del artefacto del DM → el agente recibe el artefacto ACTUAL (artifactDocHint)
    // para MODIFICARLO (re-emitir la misma versión), no recrearlo desde cero ni duplicar la card.
    // RETOMAR UN ARTEFACTO (ver el comentario largo en chat.ts). En un DM no hay canal con
    // el que comparar "nació aquí", así que sólo aplican las reglas de pertenencia: ser el
    // dueño del artefacto, o el del workspace.
    const slugPegado = db.slugDeArtefactoEn(data.body ?? "");
    if (slugPegado) {
      const adoptado = await db
        .adoptableArtifact(slugPegado, {
          requesterSub: me?.sub ?? null,
          isWorkspaceOwner: !!me?.isOwner,
        })
        .catch(() => null);
      if (adoptado) await db.setDmArtifact(data.id, adoptado).catch(() => {});
    }

    const currentDocId = await db.getDmArtifact(data.id).catch(() => null);
    const currentDoc = currentDocId ? await db.getDoc(currentDocId).catch(() => null) : null;
    // Igual que en el room: lo mío se interrumpe, lo ajeno se encola (ver turns.server).
    // En un DM 1:1 el invocador siempre es la misma persona, así que aquí la interrupción
    // es la regla y no la excepción.
    // STEER: mi mensaje entra al turno que ya corre (ver chat.ts). En un DM 1:1 es la
    // norma, no la excepción: siempre soy yo el que estaba esperando.
    const turns = await import("./turns.server");
    const steer = turns.hasOwnInflight(groupId, me.sub);
    const controller = new AbortController();
    let registeredId: number | null = null;
    // Registrar YA si la cáscara existe (postMessage la crea eager). Registrarlo hasta el
    // primer token dejaba sin botón ni reloj justo la ventana en la que hacen falta: la
    // del "pensando…" antes de que llegue nada.
    const register = (mid: number) => {
      if (registeredId === mid) return;
      registeredId = mid;
      turns.registerTurn({ messageId: mid, groupId, invokerSub: me.sub, controller, announce: (st) => fanout({ t: "turn", ...st }) });
    };
    if (data.shellId != null) register(data.shellId);
    const { id, reply } = await runAgentTurn({
      signal: controller.signal,
      onShell: register,
      agent,
      handle: data.handle,
      groupId,
      sender: data.sender,
      text,
      parts,
      currentDoc,
      invokerSub: me.sub, // DM 1:1: el humano del DM es el invocador → sus tools de conectores
      inject: steer,
      dest: { dmId: data.id, handle: data.handle, name, avatar: agent?.avatar ?? "" },
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
    }).finally(() => {
      if (registeredId != null) turns.finishTurn(registeredId);
    });

    // Entró a un turno vivo (steer): la respuesta sale por aquella burbuja. Se borra la
    // cáscara eager para no dejar una vacía. Mismo criterio que el room.
    if (reply === INJECTED) {
      if (data.shellId != null) {
        await db.deleteMessage(data.shellId).catch(() => {});
        fanout({ t: "message:deleted", id: data.shellId, channelId: null, parentId: null, dmId: data.id });
      }
      return { ok: true, steered: true };
    }
    // Nunca persistas un body VACÍO (deepseek cierra el turno en blanco a veces) → el
    // mensaje quedaba vacío. Mismo guard que el room (chat.ts).
    const finalBody = reply.trim() ? reply : "(sin respuesta)";
    await db.setMessageBody(id, finalBody);
    fanout({ t: "message:body", id, body: finalBody });

    // Artefacto vivo en DM: si el agente generó un ```eb-doc```/```eb-sheet```, lo limpiamos
    // de la burbuja y lo commiteamos LOCAL (misma verdad markdown/csv que en el room). En DM
    // no cableamos identidad por-hilo → cada artefacto es una card nueva (co-edición diferida).
    try {
      const { extractEbDoc, extractEbPatches, isSameDocument, draftTitle, bubbleWithoutEbDoc, extractAskUser, stripAskUser, extractAllEbAudio, stripEbAudio, extractAllEbFile, stripEbFile } = await import("../lib/ebdoc");
      const { randomUUID } = await import("node:crypto");

      // Notas de voz y archivos en DM: mismo protocolo y mismas trampas que el room
      // (ver el comentario largo en chat.ts) — TODOS los bloques, los dos tipos en una
      // sola pasada, o el segundo audio se queda crudo en el chat.
      const ebAudios = extractAllEbAudio(reply);
      const ebFiles = extractAllEbFile(reply);
      if (ebAudios.length || ebFiles.length) {
        const cleaned = stripEbFile(stripEbAudio(reply));
        await db.setMessageBody(id, cleaned);
        fanout({ t: "message:body", id, body: cleaned });
        const { attachPublished, safeFileName } = await import("./published-attach.server");
        let algo = false;
        for (const a of ebAudios) {
          const ok = await attachPublished(id, {
            url: a.url,
            name: "Nota de voz",
            fileName: "voz.ogg",
            mime: a.mime || "audio/ogg",
            waveform: a.waveform,
            durationMs: a.durationMs,
          });
          algo ||= ok;
        }
        for (const f of ebFiles) {
          const ok = await attachPublished(id, {
            url: f.url,
            name: f.name || "Archivo",
            fileName: safeFileName(f.name, "archivo"),
            mime: f.mime || "application/octet-stream",
            thumbUrl: f.thumb,
          });
          algo ||= ok;
        }
        if (algo) fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id });
        return { ok: true as const };
      }
      // EDICIÓN QUIRÚRGICA (mismo contrato que el room): el turno trae ```eb-patch``` en
      // vez del artefacto entero → se aplican por DOM sobre la versión actual. Fallo
      // VISIBLE: lo que no aplica se loguea con su nodeId y, si no aplica nada, no se
      // crea versión y el bubble lo dice.
      const patches = extractEbPatches(reply);

      // DOCUMENTO parcheado por BLOQUES (gemelo de la rama del room en chat.ts). El
      // artefacto HTML se parchea por DOM; un documento, por splice sobre el árbol de
      // bloques — el full-HTML de BlockNote repite el mismo data-id en dos divs
      // anidados y el camino por DOM lo corrompería.
      if (patches.length && patches.every((p) => p.closed) && currentDoc?.kind === "doc" && currentDocId) {
        const { parseDocEnvelope } = await import("../lib/doc-blocks");
        const env = parseDocEnvelope(currentDoc.md);
        if (env) {
          const { applyBlockPatches } = await import("../lib/doc-patch");
          const { mdToBlocks, blocksToMd } = await import("./doc-blocks.server");
          const t0 = performance.now();
          const res = await applyBlockPatches(env.blocks, patches, { parse: mdToBlocks });
          console.log(
            `[gt-patch][dm] doc msg=${id} pedidos=${patches.length} aplicados=${res.applied.length} ` +
              `fallidos=${res.failed.length} ${Math.round(performance.now() - t0)}ms` +
              (res.failed.length ? ` → ${res.failed.map((f) => `${f.ref}:${f.reason}`).join(",")}` : "")
          );
          const cleaned = bubbleWithoutEbDoc(reply, {
            applied: res.applied.length,
            failed: res.failed.map((f) => `${f.ref}: ${f.reason}`),
          });
          await db.setMessageBody(id, cleaned);
          fanout({ t: "message:body", id, body: cleaned });
          if (res.applied.length) {
            // Tras el patch el `sourceMd` del agente ya no describe el documento: se
            // re-deriva de los bloques. Es el único momento en que se paga ese salto.
            const nuevoMd = await blocksToMd(res.blocks).catch(() => env.sourceMd ?? "");
            const { publishArtifactVersion } = await import("./artifacts");
            await publishArtifactVersion({
              messageId: id,
              documentId: currentDocId,
              kind: "doc",
              title: draftTitle(nuevoMd, "doc"),
              md: nuevoMd,
              blocks: res.blocks,
              changedIds: res.changedIds,
              visibility: "public",
              ownerSub: me.sub,
              setPointer: (docId) => db.setDmArtifact(data.id, docId),
              notify: () => fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id }),
            });
          }
          return { ok: true as const };
        }
        // Fila legacy (markdown, sin bloques): sin direcciones que resolver. Cae al camino
        // de siempre; esa re-emisión ya nace con bloques y el turno siguiente sí es quirúrgico.
      }

      if (patches.length && patches.every((p) => p.closed) && currentDoc?.kind === "artifact" && currentDocId) {
        const { applyPatches } = await import("../lib/artifact-patch");
        const { serverParseOpts } = await import("./artifact-dom.server");
        const t0 = performance.now();
        const res = applyPatches(currentDoc.md, patches, await serverParseOpts());
        console.log(
          `[gt-patch][dm] msg=${id} pedidos=${patches.length} aplicados=${res.applied.length} ` +
            `fallidos=${res.failed.length} ${Math.round(performance.now() - t0)}ms` +
            (res.failed.length ? ` → ${res.failed.map((f) => `${f.nodeId}:${f.reason}`).join(",")}` : "")
        );
        const cleaned = bubbleWithoutEbDoc(reply, {
          applied: res.applied.length,
          failed: res.failed.map((f) => `${f.nodeId}: ${f.reason}`),
        });
        await db.setMessageBody(id, cleaned);
        fanout({ t: "message:body", id, body: cleaned });
        if (res.applied.length) {
          const { publishArtifactVersion } = await import("./artifacts");
          await publishArtifactVersion({
            messageId: id,
            documentId: currentDocId,
            kind: "artifact",
            title: draftTitle(res.html, "artifact"),
            md: res.html,
            visibility: "public",
            ownerSub: me.sub,
            setPointer: (docId) => db.setDmArtifact(data.id, docId),
            notify: () => fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id }),
          });
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
        // ¿Versión del artefacto del hilo, o documento nuevo? Ver isSameDocument: antes
        // se reusaba el puntero SIEMPRE, así que todo lo que se pidiera después caía
        // como versión de lo anterior.
        const documentId =
          currentDocId && isSameDocument(ebdoc, currentDoc)
            ? currentDocId
            : `${ebdoc.kind}_${randomUUID()}`;
        const title = draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle);
        // MISMO camino que el room y que el editor humano: estampa los data-id (dirección
        // para el próximo patch), publica a storage, INSERTa la versión y avisa.
        const { publishArtifactVersion } = await import("./artifacts");
        await publishArtifactVersion({
          messageId: id,
          documentId,
          kind: ebdoc.kind,
          title,
          md: ebdoc.md,
          visibility: "public",
          ownerSub: me.sub,
          setPointer: (docId) => db.setDmArtifact(data.id, docId),
          notify: () => fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id }),
        });
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
