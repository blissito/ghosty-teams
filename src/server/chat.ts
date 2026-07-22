import { createServerFn } from "@tanstack/react-start";
import type { RtEvent } from "./bus.server";
import type { SessionUser } from "../users.server";

// Server functions — modelo Slack. El pool_ token nunca toca el browser.

export async function sessionUser() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{
    user?: { sub: string; name: string; avatar: string; isOwner: boolean };
  }>(sessionConfig());
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
    // En un room PRIVADO, no filtrar por membresía filtraría info (excerpt + deep
    // link inservible) a no-miembros. Solo notifica a quienes pueden ver el room.
    if (isPrivate) {
      const members = new Set(await db.listChannelMembers(channelId));
      targets = targets.filter((s) => members.has(s));
    }
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

// Perfil propio (Ajustes → perfil): nombre visible + avatar. Actualiza gc_users y
// RE-SELLA la sesión con el user mergeado → me() refleja el cambio sin re-login.
// El avatar se sube antes por /api/upload (→ /api/attachment/<fileId>); aquí solo
// se persiste la URL. upsertUser ya no pisa estos campos en logins posteriores.
export const updateMyProfileFn = createServerFn({ method: "POST" })
  .validator((d: {
    name?: string; avatar?: string;
    statusEmoji?: string | null; statusText?: string | null;
    title?: string | null; pronouns?: string | null; bio?: string | null;
  }) => d)
  .handler(async ({ data }) => {
    const { useSession } = await import("@tanstack/react-start/server");
    const { sessionConfig } = await import("./session.server");
    const s = await useSession<{ user?: SessionUser }>(sessionConfig());
    const user = s.data.user;
    if (!user) throw new Error("no autenticado");

    const name = data.name?.trim().slice(0, 60);
    const rawAvatar = data.avatar?.trim();
    const users = await import("../users.server");
    const cap = (v: string | null | undefined, n: number) =>
      v === undefined ? undefined : v === null ? null : v.trim().slice(0, n);

    const patch: Parameters<typeof users.updateProfile>[1] = {};
    if (name) {
      // El authz de mensajes se apoya en el display name (msg.sender === user.name):
      // dos usuarios con el mismo nombre → uno editaría/borraría los mensajes del otro.
      if (await users.isNameTakenByOther(user.sub, name)) {
        throw new Error("Ese nombre ya está en uso");
      }
      patch.name = name; // nombre vacío = se conserva el actual
    }
    if (rawAvatar !== undefined) {
      // Solo aceptamos el path servido por nosotros (/api/attachment/<id>, del /api/upload)
      // o vacío (quitar). Evita URLs externas (tracking pixel: filtra la IP de cada
      // viewer) o data: URLs — el avatar se pinta como <img src> a todos los que te ven.
      if (rawAvatar !== "" && !rawAvatar.startsWith("/api/attachment/")) {
        throw new Error("Avatar inválido");
      }
      patch.avatar = rawAvatar;
    }
    // Perfil enriquecido (estilo Slack): status/título/pronombres/bio. Caps razonables.
    patch.statusEmoji = cap(data.statusEmoji, 16);
    patch.statusText = cap(data.statusText, 80);
    patch.title = cap(data.title, 80);
    patch.pronouns = cap(data.pronouns, 40);
    patch.bio = cap(data.bio, 400);

    await users.updateProfile(user.sub, patch);

    // La sesión solo lleva la identidad base (name/avatar); status/etc viven en el
    // directorio (listWorkspaceUsers) que el cliente refresca.
    const next: SessionUser = { ...user, ...(patch.name ? { name: patch.name } : {}), ...(patch.avatar !== undefined ? { avatar: patch.avatar || "" } : {}) };
    await s.update({ user: next });
    return { ok: true as const, user: next };
  });

// Directorio de miembros (mapa vivo sub→perfil): resuelve avatars en TODOS lados
// (mensajes viejos, sidebar) y alimenta el drawer de perfil. GET, cualquier member.
export const listUsersFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const { listWorkspaceUsers } = await import("../users.server");
  return listWorkspaceUsers();
});

// Búsqueda de miembros (DM picker a escala): server filtra + tope, no baja todo.
export const searchUsersFn = createServerFn({ method: "POST" })
  .validator((d: { query: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { searchWorkspaceUsers } = await import("../users.server");
    return searchWorkspaceUsers(data.query ?? "", Math.min(data.limit ?? 25, 50));
  });

// Expulsar del workspace (owner-only). Marca banned=1 → el login lo rebota. No al owner
// ni a uno mismo. Publica un evento para que el expulsado se entere (best-effort).
export const expelMemberFn = createServerFn({ method: "POST" })
  .validator((d: { sub: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me?.isOwner) throw new Error("solo el owner expulsa");
    if (data.sub === me.sub) throw new Error("no puedes expulsarte");
    const { expelMember } = await import("../users.server");
    await expelMember(data.sub);
    try {
      const bus = await import("./bus.server");
      bus.publish(bus.ch.user(data.sub), { t: "expelled" } as never);
    } catch { /* best-effort */ }
    return { ok: true as const };
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
    // Adjunta los hilos de CADA room (una query) → el sidebar los muestra sin
    // haber visitado cada room y persisten al cambiar de room.
    const byChannel = await db.listThreadRootsForChannels(channels.map((c) => c.id));
    for (const c of channels) c.threads = byChannel.get(c.id) ?? [];
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

// Preview PRIVADO de un .docx (adjunto office subido por el usuario): EasyBits lo convierte
// a HTML (mammoth) server-side y lo devolvemos para renderizar inline en el panel. Sin
// Microsoft, sin CORS. (Los docs que el agente REDACTA ya no pasan por aquí: son markdown
// local — ver askAgent / ArtifactPanel kind:"doc".)
export const officeToHtmlFn = createServerFn({ method: "POST" })
  .validator((d: { url: string }) => d)
  .handler(async ({ data }) => {
    const { officeToHtml } = await import("./easybits-documents.server");
    let url = data.url;
    // Adjunto privado del room (/api/attachment/:fileId): EasyBits no puede hacer fetch
    // de esa URL local y autenticada. Resuélvela a la readUrl FIRMADA del file (mismo
    // objeto EasyBits privado que subió api.upload) para que el preview mammoth funcione.
    const m = url.match(/^\/api\/attachment\/(.+)$/);
    if (m) {
      const { mintReadUrl } = await import("./easybits-files.server");
      const signed = await mintReadUrl(decodeURIComponent(m[1])).catch(() => null);
      if (signed) url = signed;
    }
    const html = await officeToHtml(url);
    return html ? { ok: true as const, html } : { ok: false as const };
  });

// XLSX → CSV para el visor: mammoth es docx-only, así que las hojas de cálculo se
// parsean con SheetJS EN EL SERVER (el adjunto /api/attachment redirige a una URL
// firmada cross-origin que el fetch del browser no puede leer por CORS). Server-side
// resolvemos la URL firmada y leemos los bytes sin CORS. Devuelve la 1ª hoja como CSV.
export const xlsxToCsvFn = createServerFn({ method: "POST" })
  .validator((d: { url: string }) => d)
  .handler(async ({ data }) => {
    let url = data.url;
    const m = url.match(/^\/api\/attachment\/(.+)$/);
    if (m) {
      const { mintReadUrl } = await import("./easybits-files.server");
      const signed = await mintReadUrl(decodeURIComponent(m[1])).catch(() => null);
      if (signed) url = signed;
    }
    try {
      const r = await fetch(url);
      if (!r.ok) return { ok: false as const };
      const buf = Buffer.from(await r.arrayBuffer());
      const XLSX = await import("xlsx");
      const wb = XLSX.read(buf, { type: "buffer" });
      const first = wb.SheetNames[0];
      const ws = first ? wb.Sheets[first] : null;
      const csv = ws ? XLSX.utils.sheet_to_csv(ws) : "";
      return { ok: true as const, csv, sheets: wb.SheetNames };
    } catch {
      return { ok: false as const };
    }
  });

export const deleteMessageFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { useSession } = await import("@tanstack/react-start/server");
    const { sessionConfig } = await import("./session.server");
    const s = await useSession<{ user?: { sub: string; name: string; isOwner: boolean } }>(sessionConfig());
    const user = s.data.user;
    const msg = await db.getMessage(data.id);
    if (!msg) return { ok: false as const };
    // Authz por sub estable (no por el display name, ahora editable → suplantable).
    // Mensajes legacy sin sender_sub caen al chequeo por nombre.
    const owns = msg.sender_sub ? msg.sender_sub === user?.sub : msg.sender === user?.name;
    if (!user?.isOwner && !owns) throw new Error("no autorizado");
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

// Señal efímera de "escribiendo…" (sin DB). Scope = room (+hilo) o DM. En DM se
// publica a ch.user de cada miembro (menos el emisor); en room a ch.room.
export const pingTypingFn = createServerFn({ method: "POST" })
  .validator((d: { slug?: string; dmId?: number; parentId?: number | null }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const user = await sessionUser();
    if (!user) return { ok: false as const };
    if (data.dmId != null) {
      for (const sub of await db.getDmMembers(data.dmId)) {
        if (sub === user.sub) continue;
        bus.publish(bus.ch.user(sub), {
          t: "typing",
          sub: user.sub,
          name: user.name,
          channelId: null,
          dmId: data.dmId,
        });
      }
      return { ok: true as const };
    }
    const channel = data.slug ? await db.getChannel(data.slug) : null;
    if (!channel) return { ok: false as const };
    bus.publish(bus.ch.room(channel.id), {
      t: "typing",
      sub: user.sub,
      name: user.name,
      channelId: channel.id,
      parentId: data.parentId ?? null,
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
    // Authz por sub estable (no por el display name editable). Legacy → por nombre.
    const owns = msg.sender_sub ? msg.sender_sub === user?.sub : msg.sender === user?.name;
    if (!user?.isOwner && !owns) throw new Error("no autorizado");
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
      quotedId?: number | null; // quote-reply: id del mensaje citado
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, detectMentions, quoteExcerpt } = await import("../agents.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const body = data.body.trim();
    const files = data.attachments ?? [];
    if (!body && files.length === 0) return { ok: false as const };

    // Quote-reply: resuelve el mensaje citado y arma el SNAPSHOT (autor + extracto)
    // server-side → autoritativo y robusto (sobrevive si el original se borra luego).
    const quoted = data.quotedId != null ? await db.getMessage(data.quotedId).catch(() => null) : null;
    const quotedAuthor = quoted?.sender ?? null;
    const quotedExcerpt = quoted ? quoteExcerpt(quoted.body ?? "") : null;

    // Topic (eje Zulip): los top-level llevan el topic elegido; las respuestas
    // heredan el del root del hilo (un hilo no cambia de topic a media conversación).
    const parent = data.parentId !== null ? await db.getMessage(data.parentId) : null;
    const topic =
      data.parentId !== null
        ? parent?.topic ?? "general"
        : (data.topic ?? "general").trim() || "general";

    const agents = await resolvedAgents();
    const handles = agents.map((a) => a.handle);
    const mentionedList = detectMentions(body, handles); // TODOS los @tagged, en orden
    const mentioned = mentionedList[0] ?? null; // para el flag agent_handle del mensaje
    const me = await sessionUser();
    const name = me?.name || "invitado";
    const avatar = me?.avatar || "";
    const { id } = await db.createMessage({
      channelId: channel.id,
      parentId: data.parentId,
      sender: name,
      senderSub: me?.sub ?? null,
      avatar,
      body,
      agentHandle: mentioned,
      topic,
      quotedId: quoted?.id ?? null,
      quotedAuthor,
      quotedExcerpt,
    });
    if (files.length) await db.createAttachments(id, files);
    // Realtime: publica el mensaje ya persistido a los suscriptores del room.
    let created = await db.getMessage(id);
    if (created && files.length) [created] = await db.attachAttachments([created]);
    if (created) bus.publish(bus.ch.room(channel.id), { t: "message:new", msg: created, nonce: data.nonce });
    // Push a los usuarios @tagged (fire-and-forget resiliente).
    await notifyMentions(channel.slug, channel.id, channel.name, body, name, me?.sub ?? "", channel.is_private === 1).catch(() => {});
    // ¿Qué agentes responden y dónde? (multi-mención: cada @tagged responde)
    // - @handles en el flujo → responden INLINE en el flujo (parent = null), como una
    //   persona más. NO se abre un hilo (decisión UX: el agente conversa en el room).
    // - @handles dentro de un hilo → mismo hilo (parent = parentId).
    // - mensaje en un hilo de un agente (root.agent_handle) → auto, sin re-tag.
    // fleetThread = clave de conversación de la FLOTA (memoria + worker pegajoso),
    // DESACOPLADA del hilo de UI: los top-level comparten "flow" del canal → UN worker +
    // memoria continua; un hilo abierto a propósito conserva su propia conversación.
    const respondents: { handle: string; parent: number | null; fleetThread: string; shellId: number }[] = [];
    if (mentionedList.length) {
      const parentFor = data.parentId; // top-level → inline (null); en hilo → mismo hilo
      const fleetThread = data.parentId === null ? "flow" : String(data.parentId);
      for (const h of mentionedList) respondents.push({ handle: h, parent: parentFor, fleetThread, shellId: 0 });
    } else if (data.parentId !== null && parent?.agent_handle && agents.some((a) => a.handle === parent.agent_handle)) {
      respondents.push({ handle: parent.agent_handle, parent: data.parentId, fleetThread: String(data.parentId), shellId: 0 });
    } else if (quoted?.agent_handle && agents.some((a) => a.handle === quoted.agent_handle)) {
      // Citar el mensaje de un agente (sin re-@mención) = responderle → ese agente contesta
      // en el MISMO contexto. La cita ya viaja al agente por askAgent (superficie WABA).
      const parentFor = data.parentId;
      const fleetThread = data.parentId === null ? "flow" : String(data.parentId);
      respondents.push({ handle: quoted.agent_handle, parent: parentFor, fleetThread, shellId: 0 });
    }
    // Caja caliente: la cáscara del agente se crea EAGER (kind:"msg" VACÍA, con avatar+nombre)
    // aquí mismo → aparece al instante y PERMANECE; el turno (askAgent) streamea sobre este
    // MISMO id vía message:body/delta. Sin "pensando…" que borrar/recrear → cero parpadeo.
    // El cliente recibe el shellId por respondent y se lo pasa a askAgent.
    for (const r of respondents) {
      const ag = agents.find((a) => a.handle === r.handle);
      const { id: shellId } = await db.postAgent(channel.id, r.parent, "", "msg", r.handle, ag?.name ?? "Ghosty", topic, ag?.avatar ?? "");
      r.shellId = shellId;
      const shell = await db.getMessage(shellId);
      if (shell) bus.publish(bus.ch.room(channel.id), { t: "message:new", msg: shell });
    }
    return {
      ok: true as const,
      id,
      needsAgent: respondents.length > 0,
      respondents, // [{handle, parent, fleetThread, shellId}] → el cliente llama askAgent por cada uno
    };
  });

// El agente responde en el MISMO contexto (flujo o hilo). Limpia el "pensando".
export const askAgent = createServerFn({ method: "POST" })
  .validator(
    (d: {
      slug: string;
      parentId: number | null;
      body: string;
      sender: string;
      handle: string;
      topic?: string;
      fleetThread?: string; // clave de flota (desacoplada del hilo UI; ver postMessage)
      shellId?: number; // caja caliente: cáscara ya creada por postMessage (reutilizar su id)
      quotedAuthor?: string | null; // quote-reply: cita para que el agente SIEMPRE la vea
      quotedExcerpt?: string | null;
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { resolvedAgents, runAgentTurn, buildMediaParts, quotedContextPrefix } = await import("../agents.server");
    const bus = await import("./bus.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    const name = agent?.name ?? "Ghosty";

    // Root del hilo (si aplica): fuente del topic heredado y del contexto sembrado (abajo).
    const root = data.parentId != null ? await db.getMessage(data.parentId) : null;
    // El reply es una respuesta de hilo (parentId no-null); hereda el topic del root.
    const topic = data.topic ?? (data.parentId != null ? root?.topic ?? "general" : undefined);

    // Continuidad de contexto en hilos: un hilo abierto sobre la respuesta de un agente
    // arranca con groupId nuevo (fleetThread=parentId) → memoria del worker VACÍA. En el
    // PRIMER turno de agente del hilo sembramos el mensaje RAÍZ como contexto para que
    // referencias como "esa db" tengan referente (modelo Slack: el hilo muestra su root).
    // La cáscara VACÍA recién creada no cuenta como turno previo (body sin texto).
    let text = data.body;
    if (data.parentId != null && root) {
      const replies = await db.listThread(data.parentId).catch(() => []);
      const priorAgentTurn = replies.some((m) => m.agent_handle && m.kind === "msg" && (m.body ?? "").trim());
      const rootBody = (root.body ?? "").trim();
      if (!priorAgentTurn && rootBody) {
        const ctx = rootBody.length > 2000 ? rootBody.slice(0, 2000) + "…" : rootBody;
        text = `[Contexto del hilo — mensaje raíz de ${root.sender || "el remitente"}]\n${ctx}\n\n[Mensaje]\n${data.body}`;
      }
    }
    // Quote-reply: si el usuario citó un mensaje, embébelo en el texto del turno (patrón
    // WABA) → el agente SIEMPRE ve a qué se responde, aunque no esté en su memoria.
    if (data.quotedExcerpt?.trim()) {
      text = quotedContextPrefix(data.quotedAuthor ?? "", data.quotedExcerpt, text);
    }

    // Media de entrada: los adjuntos del usuario → FileParts (uri firmada / bytes).
    const parts = await buildMediaParts(data.attachments ?? []);

    // Streaming first-class: la cáscara (body vacío) se crea al primer token → el
    // "pensando…" se mantiene durante la latencia del agente. Contrato §1.2.
    // groupId incluye el HANDLE → memoria por-agente (sin esto dos agentes en el mismo
    // hilo comparten conversación y se contaminan).
    // Clave de flota DESACOPLADA del hilo de UI (ver postMessage): top-level → "flow"
    // compartido del canal; reply-en-hilo → su root. Fallback al comportamiento viejo
    // (parentId) si un cliente sin actualizar no manda fleetThread.
    const fleetThread = data.fleetThread ?? (data.parentId != null ? String(data.parentId) : "flow");
    const groupId = `ghosty-chat-${data.handle}-${channel.slug}-${fleetThread}`;
    // Identidad conversacional durable: el documentId (local) del artefacto ACTUAL de este
    // hilo + su contenido fuente (doc=markdown | sheet=csv). El contenido se re-inyecta al
    // turno → al modificar, el agente re-emite el artefacto COMPLETO (misma vía de streaming
    // que al crear); el documentId preserva la identidad (nueva versión, no card nueva)
    // aunque el worker recicle su sesión.
    const currentDocId = await db.getThreadArtifact(channel.id, data.parentId).catch(() => null);
    const currentDoc = currentDocId ? await db.getDoc(currentDocId).catch(() => null) : null;
    const { id, reply } = await runAgentTurn({
      agent,
      handle: data.handle,
      groupId,
      sender: data.sender,
      text,
      parts,
      currentDoc,
      createShell: async () => {
        // Caja caliente: la cáscara ya fue creada EAGER por postMessage → reutiliza su id
        // (cero borrar/recrear, cero parpadeo). Fallback (cliente sin shellId): créala aquí.
        if (data.shellId != null) return data.shellId;
        const { id } = await db.postAgent(channel.id, data.parentId, "", "msg", data.handle, name, topic ?? "general", agent?.avatar ?? "");
        const shell = await db.getMessage(id);
        if (shell) bus.publish(bus.ch.room(channel.id), { t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) =>
        bus.publish(bus.ch.room(channel.id), { t: "message:delta", id: mid, chunk, channelId: channel.id, parentId: data.parentId }),
      // Checklist incremental: reemplaza el body con la lista re-pintada (previas ✓, actual ⚡).
      emitBody: (mid, body) =>
        bus.publish(bus.ch.room(channel.id), { t: "message:body", id: mid, body }),
    });

    // Persiste el body final (autoritativo, sin marcar "editado") y reconcilia por si
    // se perdió algún delta (el bus es best-effort). NUNCA persistas un body VACÍO:
    // deepseek/ghosty-gc a veces cierra el turno en blanco → se guardaba "" en la DB y
    // el mensaje quedaba vacío (y reaparecía vacío al refetch, borrando lo streameado).
    const finalBody = reply.trim() ? reply : "(sin respuesta)";
    await db.setMessageBody(id, finalBody);
    bus.publish(bus.ch.room(channel.id), { t: "message:body", id, body: finalBody });

    // Si el reply referencia un documento EasyBits, lo volvemos ARTEFACTO: minteamos
    // el editor colab embebible y lo colgamos del mensaje → aparece como card que
    // abre el panel del room. Best-effort: si algo falla, el mensaje queda normal.
    // (Slice 3 del contrato: reemplazar este scraping por eventos artifact del SSE.)
    try {
      const { detectArtifact, mintCollabEmbed, resolveFileKind } = await import("./easybits-documents.server");
      const { extractEbDoc, draftTitle, bubbleWithoutEbDoc, extractAskUser, stripAskUser } = await import("../lib/ebdoc");
      const { randomUUID } = await import("node:crypto");

      // Artefacto vivo con identidad + versiones: el agente generó/re-generó un doc de prosa
      // (```eb-doc```, markdown) o una hoja (```eb-sheet```, csv), streameado EN VIVO al panel
      // (igual al crear que al editar). Al cerrarse lo commiteamos LOCAL: el contenido es la
      // verdad (columna gc_artifacts.md). El documentId se conserva si el hilo ya tenía uno
      // (misma identidad = nueva versión) o se acuña uno nuevo (v1). Sin EasyBits: el panel
      // renderiza el contenido local y el próximo "modifícalo" re-inyecta esta versión.
      const ebdoc = extractEbDoc(reply);
      if (ebdoc?.closed && ebdoc.md.trim()) {
        const cleaned = bubbleWithoutEbDoc(reply);
        await db.setMessageBody(id, cleaned);
        bus.publish(bus.ch.room(channel.id), { t: "message:body", id, body: cleaned });
        const documentId = currentDocId ?? `${ebdoc.kind}_${randomUUID()}`;
        await db.createArtifact(id, {
          kind: ebdoc.kind, // "doc" | "sheet"
          url: documentId,
          title: draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle),
          md: ebdoc.md,
        });
        await db.setThreadArtifact(channel.id, data.parentId, documentId).catch(() => {});
        bus.publish(bus.ch.room(channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
        return { ok: true as const };
      }

      // ask-user: pregunta con opciones clicables. Quitamos el fence del bubble y
      // colgamos un artefacto inline; los botones los pinta el surface. La pregunta
      // va en `title`, las opciones (JSON) en `md` (no hay columna dedicada, mismo
      // truco que doc/sheet con `md`). Agnóstico al motor — texto puro.
      const ask = extractAskUser(reply);
      if (ask) {
        const cleaned = stripAskUser(reply);
        await db.setMessageBody(id, cleaned);
        bus.publish(bus.ch.room(channel.id), { t: "message:body", id, body: cleaned });
        await db.createArtifact(id, {
          kind: "ask-user",
          url: "",
          title: ask.question || null,
          md: JSON.stringify(ask.options),
        });
        bus.publish(bus.ch.room(channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
        return { ok: true as const };
      }

      const found = detectArtifact(reply);
      if (found?.type === "doc") {
        // Doc EasyBits → editor colaborativo embebido (co-edición en vivo).
        const embed = await mintCollabEmbed({ slug: found.slug, documentId: found.documentId });
        if (embed) await db.createArtifact(id, { kind: "html", url: embed.embedUrl, title: embed.title });
        // Recuerda este doc como el artefacto ACTUAL del hilo → el próximo "modifícalo"
        // apunta al MISMO documentId aunque el worker recicle su sesión.
        const docId = embed?.documentId || found.documentId;
        if (docId) await db.setThreadArtifact(channel.id, data.parentId, docId).catch(() => {});
      } else if (found?.type === "file") {
        // Kind ROBUSTO por content-type real (HEAD) — la URL no trae ext y el texto no
        // siempre menciona el tipo → office/pdf/imagen se detectan aunque el reply calle.
        const kind = (await resolveFileKind(found.url)) ?? found.kind;
        await db.createArtifact(id, { kind, url: found.url, title: found.title ?? null });
      }
      // Nació una card → refresca el contexto activo para que aparezca colgada del msg.
      if (found) bus.publish(bus.ch.room(channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
    } catch (e) {
      console.error("[artifact] detect/mint failed", e);
    }
    return { ok: true as const };
  });

// Warm seam: el cliente lo dispara fire-and-forget al ELEGIR un @agente en el composer,
// antes de enviar → pre-calienta el turno (resolución del agente + conexión a la flota).
// Best-effort: nunca lanza, nunca bloquea el envío. Ver agents.server warmAgent().
export const warmAgentFn = createServerFn({ method: "POST" })
  .validator((d: { handle: string }) => d)
  .handler(async ({ data }) => {
    const { warmAgent } = await import("../agents.server");
    await warmAgent(data.handle).catch(() => {});
    return { ok: true as const };
  });
