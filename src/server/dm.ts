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

// Estado del escalón de este DM, para que el CONTROL sepa qué enseñar antes de que
// nadie lo toque. Sin esto el botón era optimista: siempre disponible, y sólo al
// hacer clic te enteraba de que no había nada que hacer — con un alert. Un control
// que no conoce su propio estado convierte cada clic en una apuesta.
export const dmEscalationFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { resolvedAgents, agentEscalation, agentGroupId } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const handle = await db.getDmAgentHandle(data.id);
    const agent = handle ? (await resolvedAgents()).find((a) => a.handle === handle) : null;
    if (!agent) return null;
    const groupId = await agentGroupId(agent, `dm-${data.id}`);
    return await agentEscalation(agent, groupId);
  });

// Baja esta conversación al modelo de fábrica.
//
// ⚠️ Deja burbuja igual que al subir. Nació sin ella —"bajar no cambia nada que la
// persona no acabe de pedir"— pero ese argumento vale idéntico para subir, que sí
// avisaba: la asimetría se lee como que la bajada no ocurrió. Y en una conversación
// donde el modelo cambia, el historial es el único sitio donde queda escrito CUÁNDO.
export const deescalateDmAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, deescalateAgentSession, agentGroupId } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const handle = await db.getDmAgentHandle(data.id);
    const agent = handle ? (await resolvedAgents()).find((a) => a.handle === handle) : null;
    if (!agent) return { ok: false as const };
    const groupId = await agentGroupId(agent, `dm-${data.id}`);
    const res = await deescalateAgentSession(agent, groupId);
    if (!res.ok) return { ok: false as const };

    const { id } = await db.postDmAgent(
      data.id,
      "💨 Listo, volví al modelo rápido. La memoria se conserva.",
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

// Sube ESTA conversación a un modelo más capaz. Mismo esqueleto que el /clear de
// arriba: resuelve el agente del DM, su groupId, y confirma con una burbuja en el
// historial — que el cambio quede escrito importa, porque a partir de aquí el agente
// responde distinto y nadie va a recordar cuándo se pidió.
//
// ⚠️ NO es destructivo (la memoria se conserva; el hilo del runtime es el mismo), así
// que a diferencia de /clear no lleva advertencia previa.
export const escalateDmAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, escalateAgentSession, agentGroupId } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    const handle = await db.getDmAgentHandle(data.id);
    const agent = handle ? (await resolvedAgents()).find((a) => a.handle === handle) : null;
    if (!agent) return { ok: false as const, reason: "no encontré el agente de esta conversación" };

    const groupId = await agentGroupId(agent, `dm-${data.id}`); // == askDmAgentFn
    // `me.sub` viaja para saber QUIÉN escala: es la única señal real de qué
    // conversaciones se quedan cortas, y de ahí saldrán algún día las reglas.
    const res = await escalateAgentSession(agent, groupId, me.sub);
    if (!res.ok) return { ok: false as const, reason: res.reason };

    // El aviso en el chat va SÓLO al subir, no al renovar: el primero informa de un
    // cambio real, el décimo es ruido en la conversación. La renovación ya se ve en el
    // ícono, que es donde vive el contador.
    if (!res.renewed) {
      const { id } = await db.postDmAgent(
        data.id,
        `⚡ Listo, subí a un modelo más capaz por los próximos ${res.turnsLeft ?? 10} mensajes. La memoria se conserva.`,
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
    }
    return { ok: true as const, turnsLeft: res.turnsLeft ?? null };
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
    const { resolvedAgents, runAgentTurn, buildMediaParts, REGLA_VARIOS_ADJUNTOS, quotedContextPrefix, clampQuote, historyContext, gapDesdeUltimaRespuesta, CATCHUP_FETCH, agentGroupId, INJECTED } = await import("../agents.server");
    const me = await sessionUser();
    if (!me || !(await db.isDmMember(data.id, me.sub))) throw new Error("no autorizado");
    const ns = await currentNamespace();
    // Drenando para un despliegue: no arranques un turno que systemd va a matar. Ver chat.ts.
    {
      const { seEstaApagando } = await import("./shutdown.server");
      if (seEstaApagando()) {
        const aviso = "⏸ Estamos actualizando Ghosty en este momento. Vuelve a mandarlo en unos segundos — no se perdió nada.";
        if (data.shellId != null) await db.setMessageBody(data.shellId, aviso).catch(() => {});
        return { ok: false as const, drenando: true as const };
      }
    }
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
    const dmScope = { dmId: data.id };
    const recent = await db.recentContext(dmScope, CATCHUP_FETCH).catch(() => []);
    const { esRecordatorio } = await import("./reminders.server");
    const gap = gapDesdeUltimaRespuesta(recent, esRecordatorio);
    // Ver el gemelo en chat.ts: el COUNT sólo se paga si el fetch volvió lleno.
    let totalGap = gap.length;
    if (recent.length >= CATCHUP_FETCH) {
      const afterId = recent[recent.length - gap.length - 1]?.id ?? null;
      totalGap = await db.countAfter(dmScope, afterId).catch(() => gap.length);
    }
    const history = historyContext(gap, data.body, { totalGap, sender: data.sender });
    // El contexto de conectores ya NO se arma aquí: vive en `runAgentTurn`
    // (agents.server.ts), que lo hace para DMs y canales por igual a partir del
    // `invokerSub` que este mismo archivo le pasa. Estaba sólo en este camino, y los
    // incidentes que lo motivaron ocurrían en canales, donde nunca corría.
    // Media de entrada + RE-ENTREGA. Mismo problema que en canales (ver chat.ts): un
    // turno sin archivos propios dejaba al agente ciego a lo ya adjuntado, aunque
    // siguiera visible en la conversación. En un DM no hay hilo del que colgarse, así
    // que la fuente es el último mensaje humano del scope que traía adjuntos.
    let mediaAtts: { fileId: string; mime: string | null; size: number | null; name: string | null }[] =
      data.attachments ?? [];
    let reentrega = false;
    if (!mediaAtts.length && recent.length) {
      // ⚠️ Sólo los últimos 8, aunque el catch-up ahora traiga 40. Este scan busca el
      // adjunto que se está discutiendo AHORA; ensancharlo a 40 re-entregaría un archivo
      // de hace media conversación como si fuera del turno.
      const conAdj = await db.attachAttachments(recent.slice(-8)).catch(() => []);
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
    // Gemelo del de `chat.ts` — ver allí el porqué de numerar y de incluirlo cuando el
    // turno trae varios adjuntos propios. El incidente que lo motivó fue justo en un DM.
    let manifiesto = "";
    if (reentrega || mediaAtts.length > 1) {
      const lista = mediaAtts
        .map((a, i) => `${i + 1}. ${a.name ?? "(sin nombre)"} (${a.mime ?? "?"}, ${a.size ?? "?"} B)`)
        .join("\n");
      const titulo = reentrega
        ? "Adjuntos de esta conversación, disponibles en este turno"
        : `Adjuntos de este mensaje, en orden (${mediaAtts.length})`;
      const pista = reentrega ? "" : `\n${REGLA_VARIOS_ADJUNTOS}`;
      manifiesto = `[${titulo}]\n${lista}${pista}\n\n`;
    }
    const parts = await buildMediaParts(mediaAtts, { forceUri: reentrega });

    const text = history + manifiesto + quoted;

    // Identidad del artefacto del DM → el agente recibe el artefacto ACTUAL (artifactDocHint)
    // para MODIFICARLO (re-emitir la misma versión), no recrearlo desde cero ni duplicar la card.
    // RETOMAR UN ARTEFACTO (ver el comentario largo en chat.ts). En un DM no hay canal con
    // el que comparar "nació aquí", así que sólo aplican las reglas de pertenencia: ser el
    // dueño del artefacto, o el del workspace.
    // ⚠️ Gemelo de chat.ts: la resolución se RETRASA hasta tener el lock del grupo, o dos
    // turnos concurrentes se llevan versiones distintas del mismo artefacto y el segundo
    // revierte al primero al re-emitirlo. Ver `withGroupLock` en turns.server.ts.
    const resolverArtefactoDelDm = async () => {
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
      // Gemelo de chat.ts: si la última entrega fue un ARCHIVO posterior al artefacto, el
      // antecedente de "modifícalo" es el archivo.
      if (currentDoc) {
        const entrega = await db.getDmDelivery(data.id).catch(() => null);
        if (entrega && entrega.at >= (currentDoc.at ?? 0)) {
          currentDoc.lastFile = { name: entrega.name, mime: entrega.mime };
        }
      }
      return { currentDocId, currentDoc };
    };
    // Igual que en el room: lo mío se interrumpe, lo ajeno se encola (ver turns.server).
    // En un DM 1:1 el invocador siempre es la misma persona, así que aquí la interrupción
    // es la regla y no la excepción.
    // STEER: mi mensaje entra al turno que ya corre (ver chat.ts). En un DM 1:1 es la
    // norma, no la excepción: siempre soy yo el que estaba esperando.
    const turns = await import("./turns.server");
    const steer = turns.hasOwnInflight(groupId, me.sub);
    const controller = new AbortController();
    const flusher = (await import("./body-flush.server")).makeBodyFlusher();
    let registeredId: number | null = null;
    // Cómo se llama la tarea (lo que pidió la persona, recortado) — igual que en rooms; sin
    // esto la fila del panel salía como "Agente · " y encima no se podía abrir.
    const tareaDelTurno = (() => {
      let crudo = text ?? "";
      if (crudo.startsWith("[Adjuntos")) {
        const corte = crudo.indexOf("\n\n");
        crudo = corte === -1 ? "" : crudo.slice(corte + 2);
      }
      crudo = crudo.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
      return crudo.length > 60 ? `${crudo.slice(0, 57)}…` : crudo;
    })();
    const pasoDe = (body: string): string => {
      const m = /```gt-steps[^\n]*\n([\s\S]*?)\n```/.exec(body);
      if (!m) return "";
      try {
        const pasos = (JSON.parse(m[1]) as { steps?: string[] }).steps ?? [];
        return pasos.length ? String(pasos[pasos.length - 1]).slice(0, 120) : "";
      } catch {
        return "";
      }
    };
    // Registrar YA si la cáscara existe (postMessage la crea eager). Registrarlo hasta el
    // primer token dejaba sin botón ni reloj justo la ventana en la que hacen falta: la
    // del "pensando…" antes de que llegue nada.
    const register = (mid: number) => {
      if (registeredId === mid) return;
      registeredId = mid;
      turns.registerTurn({
        ns, messageId: mid, groupId, invokerSub: me.sub, controller,
        announce: (st) => fanout({ t: "turn", ...st }),
        // El DM no tiene channelId: la fila se abre por `dmId` (ver el panel).
        channelId: null, parentId: null, dmId: data.id,
        agent: name, avatar: agent?.avatar ?? "", tarea: tareaDelTurno,
        // Con qué RETOMARLO si muere. Ver chat.ts.
        body: data.body, shellId: data.shellId ?? null, attachments: data.attachments ?? [],
      });
    };
    // Registrar ANTES del lock: un turno en cola tiene que verse en "Trabajando ahora".
    if (data.shellId != null) register(data.shellId);
    const { turnResult, currentDocId, currentDoc } = await turns.withGroupLock(groupId, async () => {
    const { currentDocId, currentDoc } = await resolverArtefactoDelDm();
    const turnResult = await runAgentTurn({
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
      // Mismo tratamiento que en rooms: persistir mientras escribe (si no, un refresh a
      // media respuesta deja la cáscara muda) y anunciar el paso en curso.
      emitBody: (mid, body) => {
        fanout({ t: "message:body", id: mid, body });
        flusher.offer(mid, body);
        const p = pasoDe(body);
        if (p) turns.setTurnStep(ns, mid, p);
      },
    }).catch((e) => {
      // ⚠️ Sin este catch, un turno de DM que revienta quedaba como un rechazo SIN dueño:
      // llegaba a `unhandledRejection`, que re-lanza (shutdown.server.ts) y MATA el proceso
      // — llevándose por delante los turnos en vuelo de todos los tenants. El room lo tenía
      // desde el principio (chat.ts) y aquí faltaba; es la firma del turno perdido del
      // 2026-08-24 (Ley de Obras, 173,590 facturables cobrados sin entregar).
      // Además emite el cierre de la barra: si no, la burbuja se queda con el anillo girando
      // y el reconcile acaba clasificando el fallo como "terminó ✓".
      if (registeredId != null) {
        fanout({ t: "turn", id: registeredId, state: "stopped", position: 1, startedAt: Date.now() });
      }
      throw e;
    }).finally(async () => {
      if (registeredId != null) {
        await flusher.flush(registeredId);
        flusher.done(registeredId);
        turns.finishTurn(ns, registeredId);
      }
    });
    return { turnResult, currentDocId, currentDoc };
    }); // ← withGroupLock
    const { id, reply } = turnResult;
    // Igual que en el room: un fallo de transporte no puede cerrarse como `done`. Ver chat.ts.
    if (turnResult.failure) {
      turns.setTurnOutcome(ns, id, `error: ${turnResult.failure}`);
      // Las tools se persisten SÓLO aquí: una escritura, y justo cuando hacen falta. Si el
      // proceso muere de golpe (deploy) no llegan, y esa ausencia se lee como DESCONOCIDO,
      // no como "ninguna" — ver `turnoMuerto`, que falla cerrado.
      turns.setTurnTools(ns, id, turnResult.toolsCorridas ?? []);
    }

    // Entró a un turno vivo (steer): la respuesta sale por aquella burbuja. Se borra la
    // cáscara eager para no dejar una vacía. Mismo criterio que el room.
    if (reply === INJECTED) {
      // Steer: la cáscara se borra, así que su fila del panel también tiene que irse. En un
      // DM 1:1 el steer es la NORMA, así que sin esto quedaba una fila fantasma por cada
      // corrección que escribes.
      if (registeredId != null) {
        fanout({ t: "turn", id: registeredId, state: "stopped", position: 1, startedAt: Date.now() });
      }
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
        // Gemelo de chat.ts: sella la última entrega de archivo del DM. Ver gt_thread_delivery.
        if (ebFiles.length) {
          const ultimo = ebFiles[ebFiles.length - 1];
          await db
            .setDmDelivery(data.id, { name: ultimo.name || "Archivo", mime: ultimo.mime ?? null })
            .catch(() => {});
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
          }, { keepStatus: true });
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
              // El sobre ya está leído aquí (`env`): un patch cambia BLOQUES, nada más, así
              // que todo lo demás del documento —su marca— se arrastra tal cual.
              previo: env,
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
        }, { keepStatus: true });
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
        const cleaned = bubbleWithoutEbDoc(reply, undefined, { keepStatus: true });
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
        const { publishArtifactVersion, imageGapNotice } = await import("./artifacts");
        const pub = await publishArtifactVersion({
          messageId: id,
          documentId,
          kind: ebdoc.kind,
          title,
          md: ebdoc.md,
          // `undefined` cuando el agente no dijo nada, y eso NO es "con marca": es "lo que
          // ya dijera el documento". Re-emitir un oficio sin repetir la marca no debe
          // devolverle el membrete que alguien pidió quitar.
          unbranded: ebdoc.unbranded,
          visibility: "public",
          ownerSub: me.sub,
          setPointer: (docId) => db.setDmArtifact(data.id, docId),
          notify: () => fanout({ t: "refresh", channelId: null, parentId: null, dmId: data.id }),
        });
        // Gemelo de chat.ts: el hueco se sabe DESPUÉS de publicar. ⚠️ dm.ts siempre se
        // queda atrás de chat.ts — si tocas uno, toca el otro.
        const aviso = imageGapNotice(pub.imagesFailed);
        if (aviso) {
          const conAviso = `${cleaned}\n\n${aviso}`.trim();
          await db.setMessageBody(id, conAviso);
          fanout({ t: "message:body", id, body: conAviso });
        }
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
    } finally {
      // El entregable prometido que no viajó. Va aquí y no en cada rama por lo mismo que
      // el cierre de abajo: es el único punto por el que pasan todas.
      const { warnIfNothingDelivered } = await import("./delivery-gap");
      await warnIfNothingDelivered(id, (body) => fanout({ t: "message:body", id, body })).catch(() => {});
      // Cierre del turno, igual que en rooms y por el mismo motivo: es el único punto por el
      // que pasan todas las ramas del bloque de artefactos. Sin esto la fila del DM se
      // quedaba con el cronómetro corriendo hasta el reconcile del minuto.
      if (registeredId != null) {
        fanout({
          t: "turn", id: registeredId,
          state: controller.signal.aborted ? "stopped" : "done",
          position: 1, startedAt: Date.now(),
        });
      }
    }
    return { ok: true as const };
  });
