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

/**
 * Clave de conversación de la FLOTA para un canal. **Una por room, siempre.**
 *
 * El room es UNA conversación y los hilos son presentación: el agente responde dentro de
 * un hilo (ver `postMessage`), pero su memoria no se parte por hilo.
 *
 * ⚠️ Vive aquí, en un solo sitio, porque estaba repetida en cuatro —tres ramas de
 * `postMessage` y el fallback de `askAgent`— y ésa es exactamente la forma en que dos
 * caminos empiezan a discrepar. Mismo criterio que `agentGroupId` en agents.server.ts.
 *
 * ⚠️ El valor literal NO se toca: cambiarlo le borra la memoria a todas las conversaciones
 * vivas, porque el runtime keya por `(fleetAgentId, groupId)` y no hay migración posible
 * desde esta app — el estado está del otro lado.
 */
const FLEET_THREAD = "flow";

// Push a los usuarios cuyos @handle aparecen en el mensaje (excluye al autor).
// Soporta menciones grupales (@all/@channel) que abarcan a toda la audiencia.
async function notifyMentions(
  ns: string,
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
  }, ns);
}

// Publica un evento a la audiencia de un mensaje: si es DM → a cada miembro
// (ch.user); si es de room → al room. Unifica delete/edit/react para rooms y DMs.
async function publishToAudience(
  ns: string,
  msg: { channel_id: number; dm_id?: number | null },
  ev: RtEvent
): Promise<void> {
  const bus = await import("./bus.server");
  if (msg.dm_id != null) {
    const db = await import("../db.server");
    for (const sub of await db.getDmMembers(msg.dm_id)) bus.publish(bus.ch.user(ns, sub), ev);
  } else {
    bus.publish(bus.ch.room(ns, msg.channel_id), ev);
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
    ...us.map((u) => ({ handle: u.handle, name: u.name, avatar: u.avatar, kind: "user" as const, sub: u.sub })),
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
/**
 * Detener un turno de agente en vuelo. Corta la conexión con el worker, que al notarlo
 * cierra su generador y SUELTA el lock de la sesión → el siguiente de la cola arranca.
 *
 * Sólo lo detiene quien lo pidió: en un canal todos ven la burbuja, pero cortar el
 * trabajo que otro encargó es una acción sobre esa persona.
 */
export const stopTurnFn = createServerFn({ method: "POST" })
  .validator((d: { messageId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    const { stopTurn } = await import("./turns.server");
    if (stopTurn(data.messageId, me?.sub ?? null)) return { ok: true as const };

    // No hay turno vivo con ese id. Puede ser una carrera normal (el clic llegó cuando ya
    // terminaba) o una cáscara HUÉRFANA: el registro vive en memoria, así que un reinicio
    // del server se lleva sus turnos y deja burbujas en "pensando…" para siempre. Si el
    // mensaje sigue vacío, cerrarlo es exactamente lo que el usuario está pidiendo.
    const db = await import("../db.server");
    const msg = await db.getMessage(data.messageId).catch(() => null);
    if (!msg || (msg.body ?? "").trim()) return { ok: false as const };
    const body = "⏹ Detenido.";
    await db.setMessageBody(data.messageId, body);
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    if (msg.dm_id) bus.publish(bus.ch.dm(ns, msg.dm_id), { t: "message:body", id: data.messageId, body });
    else if (msg.channel_id) bus.publish(bus.ch.room(ns, msg.channel_id), { t: "message:body", id: data.messageId, body });
    return { ok: true as const };
  });

export const listUsersFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const { listWorkspaceUsers } = await import("../users.server");
  return listWorkspaceUsers();
});

// Preferencias de notificación por correo (opt-out). GET lee, POST setea.
export const getNotifyPrefsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return { emailNotifs: false };
  const db = await import("../db.server");
  return { emailNotifs: await db.getEmailNotifs(me.sub) };
});
export const setEmailNotifsFn = createServerFn({ method: "POST" })
  .validator((d: { on: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const db = await import("../db.server");
    await db.setEmailNotifs(me.sub, data.on);
    return { ok: true as const };
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
      const { currentNamespace } = await import("./tenant.server");
      const ns = await currentNamespace();
      bus.publish(bus.ch.user(ns, data.sub), { t: "expelled" } as never);
    } catch { /* best-effort */ }
    return { ok: true as const };
  });

// Shell del room (sidebar + meta), SIN el flujo → el loader es ligero y el
// flujo carga client-side con skeleton (apertura inmediata). Filtra visibilidad.
export const getChannelView = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    // Auto-cura el schema de teams existentes (aditivo, idempotente, memoizado).
    const _t0 = performance.now();
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
    console.log(`[fn getChannelView ${Math.round(performance.now() - _t0)}ms] rooms=${channels.length}`);
    return { channels, channel };
  });

// El flujo del room (client-side, con skeleton). Adjunta reacciones (1 query).
// Con `topic` filtra al eje Zulip; sin él devuelve el room completo (compat).
export const getChannelFlow = createServerFn({ method: "GET" })
  .validator((d: { slug: string; topic?: string }) => d)
  .handler(async ({ data }) => {
    const _t0 = performance.now();
    const db = await import("../db.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) return [];
    const user = await sessionUser();
    const out = await db.attachMeta(await db.listChannelFlow(channel.id, data.topic), user?.sub ?? "");
    console.log(`[fn getChannelFlow ${Math.round(performance.now() - _t0)}ms] msgs=${out.length}`);
    return out;
  });

/**
 * Turnos de agente EN VUELO. El cliente lo pide al montar para sembrar su mapa `turns`.
 *
 * El estado de un turno llega por SSE (`t:"turn"`), pero un evento no se puede volver a
 * escuchar: quien recarga a media respuesta se queda sin cronómetro, sin botón Detener y
 * sin ninguna señal de que el agente sigue trabajando.
 */
// ⚠️ POST y no GET: un GET lo puede cachear el navegador o un proxy, y esta lista cambia
// cada pocos segundos — servir una respuesta vieja enseñaría un agente que ya terminó, o
// escondería uno que acaba de arrancar. No es idempotencia lo que se busca aquí, es frescura.
export const getLiveTurnsFn = createServerFn({ method: "POST" }).handler(async () => {
  const turns = await import("./turns.server");
  // Ya no consulta NADA: el estado del turno lleva su propio contexto (agente, tarea, paso)
  // desde que se registra. Antes hacía 2 consultas por turno vivo —el mensaje y su padre— y
  // el cliente lo llamaba cada 8s por pestaña abierta. Hoy esto es sólo el reconcile.
  return turns.allLiveTurnStates();
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
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    await publishToAudience(ns, msg, {
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
    // Asegura columnas nuevas (p.ej. gc_attachments.waveform/duration_ms) ANTES de
    // hidratar adjuntos: un usuario con sesión viva puede abrir un room y disparar
    // este catch-up ANTES de cualquier login/envío en el proceso recién deployado.
    // Idempotente + cacheado (done) → costo ~0 tras la 1ª vez.
    await (await import("./schema.server")).ensureSchema().catch(() => {});
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
    const { currentNamespace } = await import("./tenant.server");
    const user = await sessionUser();
    if (!user) return { ok: false as const };
    const ns = await currentNamespace();
    if (data.dmId != null) {
      for (const sub of await db.getDmMembers(data.dmId)) {
        if (sub === user.sub) continue;
        bus.publish(bus.ch.user(ns, sub), {
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
    bus.publish(bus.ch.room(ns, channel.id), {
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
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    await publishToAudience(ns, msg, {
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
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    await publishToAudience(ns, msg, {
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
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const { resolvedAgents, detectMentions, quoteExcerpt } = await import("../agents.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const ns = await currentNamespace();
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
    if (created) bus.publish(bus.ch.room(ns, channel.id), { t: "message:new", msg: created, nonce: data.nonce });
    // Push a los usuarios @tagged (fire-and-forget resiliente).
    await notifyMentions(ns, channel.slug, channel.id, channel.name, body, name, me?.sub ?? "", channel.is_private === 1).catch(() => {});
    // ¿Qué agentes responden y dónde? (multi-mención: cada @tagged responde)
    //
    // MODELO ZULIP (2026-08-03): la respuesta del agente NACE SIEMPRE EN UN HILO, colgada
    // del mensaje que la pidió. En el flujo queda tu mensaje con "1 respuesta"; el hilo se
    // abre solo y ahí aterriza el streaming.
    //
    // Son DOS perillas y van en direcciones OPUESTAS — confundirlas es de donde salió el
    // bug de hoy:
    //
    //   · `parent`      = DÓNDE SE PINTA. Ahora `data.parentId ?? id` → nace en hilo.
    //   · `fleetThread` = CLAVE DE MEMORIA de la flota. Ahora **siempre "flow"**.
    //
    // Antes `fleetThread` valía `String(parentId)` dentro de un hilo, así que seguir la
    // conversación en el hilo abría una sesión NUEVA del agente: workspace distinto, sin
    // los adjuntos y sin memoria del turno anterior. Comprobado en vivo el 2026-08-03 —
    // le pasaron 5 .docx en el room, contestó bien, y en el hilo respondió que no
    // encontraba los datos. No los perdió: nunca los tuvo.
    //
    // El room es UNA conversación y los hilos son presentación. Por eso la clave no
    // depende del hilo: así no hay dos claves que puedan divergir, no se paga un agente
    // por mensaje ni arranque en frío por turno (que es lo que "flow" vino a evitar), y
    // los rooms existentes conservan su memoria sin migración.
    //
    // Contrapartida asumida: dos hilos del mismo room comparten memoria.
    //
    // Referencia: Slack keya por `thread_ts ?? ts` (la raíz del intercambio) y sus bots
    // responden siempre en hilo; Zulip mete todo mensaje en un topic y el problema no
    // puede ocurrir. Nosotros teníamos flujo-continuo + hilos-aislados sin regla que los
    // uniera, que es la peor de las tres.
    //
    // "Nacer en hilo" ya existió y se quitó en b3f9530 por UX ("el agente conversa en el
    // room"). Aquel commit movió `parentFor` y dejó `fleetThread` quieto; éste mueve las
    // dos, que es lo que permite la UX sin pagar la sesión por mensaje.
    const respondents: { handle: string; parent: number | null; fleetThread: string; shellId: number }[] = [];
    if (mentionedList.length) {
      const parentFor = data.parentId ?? id; // top-level → abre hilo bajo TU mensaje
      for (const h of mentionedList) respondents.push({ handle: h, parent: parentFor, fleetThread: FLEET_THREAD, shellId: 0 });
    } else if (data.parentId !== null && parent?.agent_handle && agents.some((a) => a.handle === parent.agent_handle)) {
      respondents.push({ handle: parent.agent_handle, parent: data.parentId, fleetThread: FLEET_THREAD, shellId: 0 });
    } else if (quoted?.agent_handle && quoted.sender_sub == null && agents.some((a) => a.handle === quoted.agent_handle)) {
      // Citar el mensaje ESCRITO POR un agente (sin re-@mención) = responderle → ese agente
      // contesta en el MISMO contexto. `sender_sub == null` distingue un mensaje AUTORADO por
      // el agente (postAgent no setea sub) de un mensaje de un HUMANO que sólo TAGUEÓ al agente
      // (ese lleva agent_handle + sender_sub del humano): citar ese último NO debe disparar al
      // agente (como Slack/Discord: el bot sólo responde si lo @mencionas en el mensaje NUEVO).
      // La cita ya viaja al agente por askAgent (superficie WABA).
      const parentFor = data.parentId ?? id;
      respondents.push({ handle: quoted.agent_handle, parent: parentFor, fleetThread: FLEET_THREAD, shellId: 0 });
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
      if (shell) bus.publish(bus.ch.room(ns, channel.id), { t: "message:new", msg: shell });
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
      quotedId?: number | null; // id del citado → cita COMPLETA (no el excerpt)
      attachments?: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null }[];
    }) => d
  )
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const { resolvedAgents, runAgentTurn, buildMediaParts, quotedContextPrefix, clampQuote, historyContext, gapDesdeUltimaRespuesta, agentGroupId, INJECTED } = await import("../agents.server");
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const channel = await db.getChannel(data.slug);
    if (!channel) throw new Error("Canal no encontrado");
    const ns = await currentNamespace();
    const agent = (await resolvedAgents()).find((a) => a.handle === data.handle);
    const name = agent?.name ?? "Ghosty";

    // Root del hilo (si aplica): fuente del topic heredado y del contexto sembrado (abajo).
    const root = data.parentId != null ? await db.getMessage(data.parentId) : null;
    // El reply es una respuesta de hilo (parentId no-null); hereda el topic del root.
    const topic = data.topic ?? (data.parentId != null ? root?.topic ?? "general" : undefined);

    // Continuidad de contexto en hilos: sembramos el mensaje RAÍZ en el PRIMER turno de
    // agente del hilo, para que referencias como "esa db" tengan referente.
    //
    // ⚠️ Ya NO es la red que era. Se escribió porque un hilo abría groupId nuevo y el
    // worker arrancaba con memoria VACÍA; desde que la clave es una por room (FLEET_THREAD)
    // eso no pasa. Se conserva porque sigue sirviendo cuando el hilo cuelga de un mensaje
    // viejo que quedó fuera del contexto del worker.
    //
    // ⚠️ Y el guard del root PROPIO es nuevo y necesario: con el modelo Zulip el agente
    // nace colgado del mensaje que lo invocó, así que en su primer turno el root ES este
    // mismo mensaje — sembrarlo duplicaría el texto ("[Contexto del hilo…]" seguido del
    // mismo cuerpo).
    //
    // Se detecta comparando el CUERPO porque `askAgent` no recibe el id del mensaje que
    // disparó el turno, sólo el del padre. Es una comparación, no una heurística fina: si
    // dos mensajes distintos del mismo hilo tuvieran cuerpo idéntico, lo único que pasa es
    // que se omite la siembra — que es el lado seguro del error.
    let text = data.body;
    if (data.parentId != null && root && (root.body ?? "").trim() !== data.body.trim()) {
      const replies = await db.listThread(data.parentId).catch(() => []);
      const priorAgentTurn = replies.some((m) => m.agent_handle && m.kind === "msg" && (m.body ?? "").trim());
      const rootBody = (root.body ?? "").trim();
      if (!priorAgentTurn && rootBody) {
        const ctx = rootBody.length > 2000 ? rootBody.slice(0, 2000) + "…" : rootBody;
        text = `[Contexto del hilo — mensaje raíz de ${root.sender || "el remitente"}]\n${ctx}\n\n[Mensaje]\n${data.body}`;
      }
    }
    // Quote-reply: si el usuario citó un mensaje, embébelo en el texto del turno (patrón
    // WABA) → el agente SIEMPRE ve a qué se responde, aunque no esté en su memoria. Con el
    // id del citado mandamos su cuerpo COMPLETO (no el excerpt de 220 chars).
    let quoteCite = data.quotedExcerpt ?? null;
    if (data.quotedId != null) {
      const qm = await db.getMessage(data.quotedId).catch(() => null);
      if (qm?.body?.trim()) quoteCite = clampQuote(qm.body);
    }
    if (quoteCite?.trim()) {
      text = quotedContextPrefix(data.quotedAuthor ?? "", quoteCite, text);
    }
    // Catch-up del scope: en un CANAL solo te invocan al @mencionarte, así que entre menciones
    // hay mensajes (sin tag) que el agente NUNCA vio en su sesión. El worker ya tiene SUS
    // turnos (resume+compact); le inyectamos los mensajes POSTERIORES a su última respuesta en
    // este scope (el "gap"), acotado por historyContext. Si nunca respondió aquí (sesión
    // fresca), el gap = lo reciente = seed inicial. Corre cada turno pero está acotado al gap
    // → eficiente cuando está al día (gap = solo el turno actual → historyContext lo filtra).
    {
      // ⚠️ Scope del ROOM, no del hilo. Con el modelo Zulip toda respuesta del agente vive
      // en un hilo, así que acotar el gap a `parentId` lo calcularía sobre un hilo casi
      // vacío y el agente perdería lo que se dijo en el room entre menciones — que es
      // justo lo que este bloque existe para recuperar. La memoria es una por room
      // (FLEET_THREAD), así que el gap tiene que mirar lo mismo.
      const scope = { channelId: channel.id };
      const recent = await db.recentContext(scope, 8).catch(() => []);
      const { esRecordatorio } = await import("./reminders.server");
      const history = historyContext(gapDesdeUltimaRespuesta(recent, esRecordatorio), data.body);
      if (history) text = history + text;
    }

    // Media de entrada: los adjuntos del usuario → FileParts (uri firmada / bytes).
    //
    // RE-ENTREGA en hilos: arriba se re-siembra con cuidado todo el contexto de TEXTO
    // (cuerpo del root, cita, gap del scope) pero la media no entraba en esa
    // reconstrucción. Un "continua" llega sin adjuntos → el agente respondía "no hay
    // archivos adjuntos disponibles en este turno" con el expediente completo visible
    // ahí arriba en la UI, y cualquier trabajo de varios turnos sobre documentos
    // quedaba ciego a partir del segundo. Cuando el turno no trae archivos propios,
    // reponemos los del mensaje raíz del hilo, siempre por uri firmada.
    let mediaAtts: { fileId: string; mime: string | null; size: number | null; name: string | null }[] =
      data.attachments ?? [];
    let reentrega = false;
    if (!mediaAtts.length && data.parentId != null && root) {
      const [rootFull] = await db.attachAttachments([root]).catch(() => [root]);
      const prev = (rootFull?.attachments ?? []).map((a) => ({
        fileId: a.file_id, mime: a.mime, size: a.size, name: a.name,
      }));
      if (prev.length) { mediaAtts = prev; reentrega = true; }
    }
    // El manifiesto va en el texto para que sepa QUÉ tiene sin abrir todo: con un
    // expediente grande, enumerar es más barato que descubrir.
    if (reentrega) {
      const lista = mediaAtts.map((a) => `- ${a.name ?? "(sin nombre)"} (${a.mime ?? "?"}, ${a.size ?? "?"} B)`).join("\n");
      text = `[Adjuntos del hilo, disponibles en este turno]\n${lista}\n\n` + text;
    }
    const parts = await buildMediaParts(mediaAtts, { forceUri: reentrega });

    // Streaming first-class: la cáscara (body vacío) se crea al primer token → el
    // "pensando…" se mantiene durante la latencia del agente. Contrato §1.2.
    // groupId incluye el HANDLE → memoria por-agente (sin esto dos agentes en el mismo
    // hilo comparten conversación y se contaminan).
    // Clave de flota DESACOPLADA del hilo de UI (ver postMessage): una por room.
    //
    // ⚠️ El fallback ya NO deriva del parentId. Derivarlo era el bug: un cliente que no
    // mandara `fleetThread` abría una sesión por hilo, sin adjuntos ni memoria. Ante la
    // duda, la clave del room es la respuesta correcta — como mucho comparte contexto de
    // más; la otra rama perdía el contexto entero en silencio.
    const fleetThread = data.fleetThread ?? FLEET_THREAD;
    const groupId = await agentGroupId(agent ?? { handle: data.handle }, `${channel.slug}-${fleetThread}`);
    // Identidad conversacional durable: el documentId (local) del artefacto ACTUAL de este
    // hilo + su contenido fuente (doc=markdown | sheet=csv). El contenido se re-inyecta al
    // turno → al modificar, el agente re-emite el artefacto COMPLETO (misma vía de streaming
    // que al crear); el documentId preserva la identidad (nueva versión, no card nueva)
    // aunque el worker recicle su sesión.
    // resolve* y no get*: el artefacto suele nacer en el ROOM y la conversación seguir en
    // el HILO de ese mensaje, que no tiene puntero propio (ver resolveThreadArtifact).
    const poster = await sessionUser(); // el que postea/mencionó este turno = invocador

    // RETOMAR UN ARTEFACTO DE OTRA CONVERSACIÓN. Si el mensaje trae el link de un
    // artefacto, se ADOPTA en este hilo antes de resolver el puntero. Sin esto, pegar el
    // link no servía de nada: el agente intentaba leer la URL pública SIN sesión, y un
    // documento privado le contestaba 404 ("ese link no me da acceso"), así que pedía que
    // le pegaran el HTML a mano.
    //
    // Adoptar = mover el puntero del hilo. De ahí en adelante todo el camino de abajo ya
    // existía: resolveThreadArtifact lo encuentra, getDoc trae el contenido y se re-inyecta
    // al turno, de modo que "modifícalo" produce una nueva VERSIÓN del mismo documento en
    // vez de una tarjeta nueva.
    //
    // La autorización vive en db.adoptableArtifact: dueño, o nacido en este room. Un link
    // que no cumpla se ignora en silencio — el agente sigue con el artefacto que ya tuviera
    // el hilo, que es mejor que abortar el turno por un link que quizá era sólo una cita.
    const slugPegado = db.slugDeArtefactoEn(data.body ?? "");
    if (slugPegado) {
      const adoptado = await db
        .adoptableArtifact(slugPegado, {
          requesterSub: poster?.sub ?? null,
          channelId: channel.id,
          isWorkspaceOwner: !!poster?.isOwner,
        })
        .catch(() => null);
      if (adoptado) {
        await db.setThreadArtifact(channel.id, data.parentId, adoptado).catch(() => {});
      }
    }

    const currentDocId = await db.resolveThreadArtifact(channel.id, data.parentId).catch(() => null);
    const currentDoc = currentDocId ? await db.getDoc(currentDocId).catch(() => null) : null;

    // INTERRUMPIR lo mío, encolar lo ajeno. Si el que escribe es el mismo que tiene un
    // turno corriendo en este flow, casi siempre está corrigiendo ("mejor en html") y
    // dejarlo en cola convierte la corrección en una respuesta tardía. El turno de otra
    // persona no se toca: el canal es compartido, ese trabajo no es suyo.
    // STEER en vez de interrumpir: si mi turno anterior sigue vivo, este mensaje se mete
    // AHÍ (el worker lo empuja a la misma sesión del SDK) y la respuesta sale por la
    // burbuja que ya estoy mirando. Antes se mataba el turno: la corrección llegaba, pero
    // tirando a la basura todo lo que el agente llevaba hecho.
    const turns = await import("./turns.server");
    const steer = turns.hasOwnInflight(groupId, poster?.sub);

    const controller = new AbortController();
    const flusher = (await import("./body-flush.server")).makeBodyFlusher();
    const announce = (st: import("./turns.server").TurnState) =>
      bus.publish(bus.ch.room(ns, channel.id), { t: "turn", ...st });
    let registeredId: number | null = null;
    // Último paso narrado por el agente, sacado del bloque ```gt-steps``` que él mismo emite.
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
    // Cómo se LLAMA la tarea: lo que pidió la persona, recortado. Cursor nombra así cada fila
    // de su panel ("Live stock ticker") en vez de con el nombre del agente, y es lo que hace
    // que una lista de tres agentes se pueda leer de un vistazo.
    const tareaDelTurno = (() => {
      const crudo = (text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
      if (!crudo) return "";
      return crudo.length > 60 ? `${crudo.slice(0, 57)}…` : crudo;
    })();
    // Registrar YA si la cáscara existe (postMessage la crea eager). Registrarlo hasta el
    // primer token dejaba sin botón ni reloj justo la ventana en la que hacen falta: la
    // del "pensando…" antes de que llegue nada.
    const register = (mid: number) => {
      if (registeredId === mid) return;
      registeredId = mid;
      // El contexto viaja CON el turno: así el evento `turn` basta para pintar la barra y el
      // cliente no tiene que preguntar por el mensaje y su padre cada pocos segundos.
      turns.registerTurn({
        messageId: mid, groupId, invokerSub: poster?.sub ?? null, controller, announce,
        channelId: channel.id, parentId: data.parentId ?? null,
        agent: name, avatar: agent?.avatar ?? "",
        tarea: tareaDelTurno,
      });
    };
    if (data.shellId != null) register(data.shellId);
    // finally: un turno que revienta no puede quedarse registrado como vivo — tendría a
    // los siguientes eternamente "en espera" detrás de un fantasma.
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
      invokerSub: poster?.sub, // sus tools de conectores (per-invocador, no del owner)
      inject: steer,
      // Destino de las tools nativas: este canal, este topic, este agente.
      dest: { channelId: channel.id, parentId: data.parentId ?? undefined, topic: topic ?? "general", handle: data.handle, name, avatar: agent?.avatar ?? "" },
      createShell: async () => {
        // Caja caliente: la cáscara ya fue creada EAGER por postMessage → reutiliza su id
        // (cero borrar/recrear, cero parpadeo). Fallback (cliente sin shellId): créala aquí.
        if (data.shellId != null) return data.shellId;
        const { id } = await db.postAgent(channel.id, data.parentId, "", "msg", data.handle, name, topic ?? "general", agent?.avatar ?? "");
        const shell = await db.getMessage(id);
        if (shell) bus.publish(bus.ch.room(ns, channel.id), { t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) =>
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:delta", id: mid, chunk, channelId: channel.id, parentId: data.parentId }),
      // Checklist incremental: reemplaza el body con la lista re-pintada (previas ✓, actual ⚡).
      // Además PERSISTE con throttle: sin esto, un refresh a media respuesta deja una cáscara
      // muda aunque el worker siga trabajando (el bus no tiene buffer).
      emitBody: (mid, body) => {
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id: mid, body });
        flusher.offer(mid, body);
        // El PASO en curso viaja con el estado del turno. Antes el cliente lo sacaba del
        // cuerpo preguntando cada pocos segundos; aquí ya lo tenemos delante y es gratis.
        const p = pasoDe(body);
        if (p) turns.setTurnStep(mid, p);
      },
    }).finally(async () => {
      if (registeredId != null) {
        // Lo último pintado queda en DB pase lo que pase: si el proceso muere aquí, el
        // mensaje conserva lo que el usuario ya había visto en vez de volver a la cáscara.
        await flusher.flush(registeredId);
        flusher.done(registeredId);
        turns.finishTurn(registeredId);
      }
    });

    // Persiste el body final (autoritativo, sin marcar "editado") y reconcilia por si
    // se perdió algún delta (el bus es best-effort). NUNCA persistas un body VACÍO:
    // deepseek/ghosty-gc a veces cierra el turno en blanco → se guardaba "" en la DB y
    // el mensaje quedaba vacío (y reaparecía vacío al refetch, borrando lo streameado).
    const { id, reply } = turnResult;
    // El mensaje entró a un turno vivo: acá no hay nada que escribir. La cáscara que
    // postMessage creó eager se borra, o quedarían dos burbujas para una sola respuesta.
    if (reply === INJECTED) {
      if (data.shellId != null) {
        await db.deleteMessage(data.shellId).catch(() => {});
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:deleted", id: data.shellId, channelId: channel.id, parentId: data.parentId ?? null });
      }
      return { ok: true, steered: true };
    }
    const finalBody = reply.trim() ? reply : "(sin respuesta)";
    await db.setMessageBody(id, finalBody);
    bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: finalBody });

    // Si el reply referencia un documento EasyBits, lo volvemos ARTEFACTO: minteamos
    // el editor colab embebible y lo colgamos del mensaje → aparece como card que
    // abre el panel del room. Best-effort: si algo falla, el mensaje queda normal.
    // (Slice 3 del contrato: reemplazar este scraping por eventos artifact del SSE.)
    try {
      const { detectArtifact, mintCollabEmbed, resolveFileKind } = await import("./easybits-documents.server");
      const { extractEbDoc, extractEbPatches, isSameDocument, draftTitle, bubbleWithoutEbDoc, extractAskUser, stripAskUser, extractAllEbAudio, stripEbAudio, extractAllEbFile, stripEbFile } = await import("../lib/ebdoc");
      const { randomUUID } = await import("node:crypto");

      // Nota de voz: el agente emitió ```eb-audio``` (voice.mjs sintetizó + publicó el
      // ogg). Re-subimos el audio a nuestro storage y lo colgamos como adjunto → burbuja
      // de nota de voz con onda. Best-effort: si el fetch/upload falla, queda el texto.
      // ⚠️ TODOS los bloques, y los dos tipos en la MISMA pasada. Antes se tomaba sólo el
      // primer audio y se hacía `return` — un turno con dos notas de voz publicaba una y
      // dejaba la otra CRUDA en el chat (el fence sobrevivía en el body y Markdown lo
      // pintaba como bloque de código con la URL firmada del .ogg). Y como el bloque de
      // archivos venía después de ese `return`, un turno con audio + PDF perdía el PDF.
      const ebAudios = extractAllEbAudio(reply);
      const ebFiles = extractAllEbFile(reply);
      if (ebAudios.length || ebFiles.length) {
        const cleaned = stripEbFile(stripEbAudio(reply));
        await db.setMessageBody(id, cleaned);
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: cleaned });
        const { attachPublished, safeFileName } = await import("./published-attach.server");
        let algo = false;
        // En serie y no en paralelo: el orden de los adjuntos es el orden en que el agente
        // los emitió, y es el que el usuario leyó en la prosa ("primero el encabezado…").
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
        if (algo) bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
        return { ok: true as const };
      }

      // Artefacto vivo con identidad + versiones: el agente generó/re-generó un doc de prosa
      // (```eb-doc```, markdown) o una hoja (```eb-sheet```, csv), streameado EN VIVO al panel
      // (igual al crear que al editar). Al cerrarse lo commiteamos LOCAL: el contenido es la
      // verdad (columna gc_artifacts.md). El documentId se conserva si el hilo ya tenía uno
      // (misma identidad = nueva versión) o se acuña uno nuevo (v1). Sin EasyBits: el panel
      // renderiza el contenido local y el próximo "modifícalo" re-inyecta esta versión.
      // EDICIÓN QUIRÚRGICA: el turno trae uno o más ```eb-patch``` en vez del artefacto
      // entero. Se aplican por DOM sobre la versión actual (el resto del documento —
      // scripts, estilos, estructura — sobrevive intacto) y se publica una versión nueva.
      // Fallo VISIBLE por diseño: lo que no aplica se loguea con su nodeId y su motivo, y
      // si NO aplica nada no se crea versión (el artefacto anterior sigue en pie) — una
      // capa de contención muda escondería que el modo patch está roto.
      const patches = extractEbPatches(reply);

      // DOCUMENTO parcheado por BLOQUES. Mismo protocolo (```eb-patch``` por dirección) y
      // misma disciplina que el artefacto HTML, pero se aplica por splice sobre el árbol
      // de bloques: el full-HTML de BlockNote repite el mismo data-id en dos divs
      // anidados, así que el camino por DOM (applyPatches/stampIds) lo corrompería.
      if (patches.length && patches.every((p) => p.closed) && currentDoc?.kind === "doc" && currentDocId) {
        const { parseDocEnvelope } = await import("../lib/doc-blocks");
        const env = parseDocEnvelope(currentDoc.md);
        if (env) {
          const { applyBlockPatches } = await import("../lib/doc-patch");
          const { mdToBlocks, blocksToMd } = await import("./doc-blocks.server");
          const t0 = performance.now();
          const res = await applyBlockPatches(env.blocks, patches, { parse: mdToBlocks });
          console.log(
            `[gt-patch] doc msg=${id} pedidos=${patches.length} aplicados=${res.applied.length} ` +
              `fallidos=${res.failed.length} ${Math.round(performance.now() - t0)}ms` +
              (res.failed.length ? ` → ${res.failed.map((f) => `${f.ref}:${f.reason}`).join(",")}` : "")
          );
          const cleaned = bubbleWithoutEbDoc(reply, {
            applied: res.applied.length,
            failed: res.failed.map((f) => `${f.ref}: ${f.reason}`),
          }, { keepStatus: true });
          await db.setMessageBody(id, cleaned);
          bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: cleaned });
          if (res.applied.length) {
            // El `sourceMd` del agente ya no describe el documento tras el patch, así que
            // se re-deriva de los bloques: es el único momento en que se paga ese salto.
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
              ownerSub: poster?.sub ?? null,
              setPointer: (docId) => db.setThreadArtifact(channel.id, data.parentId, docId),
              notify: () =>
                bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId }),
            });
            return { ok: true as const };
          }
          // Nada aplicó → el documento anterior queda intacto y el bubble ya lo dice.
          return { ok: true as const };
        }
        // Fila legacy (markdown, sin bloques): no hay direcciones que resolver. Cae al
        // camino de siempre — el agente re-emite completo y ESA versión ya nace con
        // bloques, así que el siguiente turno sí puede ser quirúrgico.
      }

      if (patches.length && patches.every((p) => p.closed) && currentDoc?.kind === "artifact" && currentDocId) {
        const { applyPatches } = await import("../lib/artifact-patch");
        const { serverParseOpts } = await import("./artifact-dom.server");
        const t0 = performance.now();
        const res = applyPatches(currentDoc.md, patches, await serverParseOpts());
        console.log(
          `[gt-patch] msg=${id} pedidos=${patches.length} aplicados=${res.applied.length} ` +
            `fallidos=${res.failed.length} ${Math.round(performance.now() - t0)}ms` +
            (res.failed.length ? ` → ${res.failed.map((f) => `${f.nodeId}:${f.reason}`).join(",")}` : "")
        );
        const cleaned = bubbleWithoutEbDoc(reply, {
          applied: res.applied.length,
          failed: res.failed.map((f) => `${f.nodeId}: ${f.reason}`),
        }, { keepStatus: true });
        await db.setMessageBody(id, cleaned);
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: cleaned });
        if (res.applied.length) {
          const { publishArtifactVersion } = await import("./artifacts");
          await publishArtifactVersion({
            messageId: id,
            documentId: currentDocId,
            kind: "artifact",
            title: draftTitle(res.html, "artifact"),
            md: res.html,
            ownerSub: poster?.sub ?? null,
            setPointer: (docId) => db.setThreadArtifact(channel.id, data.parentId, docId),
            notify: () =>
              bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId }),
          });
          return { ok: true as const };
        }
        // Ningún patch aplicó → el artefacto anterior queda intacto; el bubble ya lo dice
        // (bubbleWithoutEbDoc recibió el resultado) y el log de arriba dice por qué.
        return { ok: true as const };
      }

      const ebdoc = extractEbDoc(reply);
      if (ebdoc?.closed && ebdoc.md.trim()) {
        const cleaned = bubbleWithoutEbDoc(reply, undefined, { keepStatus: true });
        await db.setMessageBody(id, cleaned);
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: cleaned });
        // ¿Versión del artefacto del hilo, o documento nuevo? Ver isSameDocument: antes
        // se reusaba el puntero SIEMPRE, así que todo lo que se pidiera después caía
        // como versión de lo anterior.
        const documentId =
          currentDocId && isSameDocument(ebdoc, currentDoc)
            ? currentDocId
            : `${ebdoc.kind}_${randomUUID()}`;
        const title = draftTitle(ebdoc.md, ebdoc.kind, ebdoc.fenceTitle);
        // Publicación por el camino ÚNICO (mismo que la edición humana del Canvas): siembra
        // los `data-id` del artefacto (dirección para el próximo ```eb-patch```), sube el HTML
        // a storage como enlace compartible, INSERTa la versión, apunta el hilo y refresca.
        const { publishArtifactVersion } = await import("./artifacts");
        await publishArtifactVersion({
          messageId: id,
          documentId,
          kind: ebdoc.kind, // "doc" | "sheet" | "artifact"
          title,
          md: ebdoc.md,
          ownerSub: poster?.sub ?? null,
          setPointer: (docId) => db.setThreadArtifact(channel.id, data.parentId, docId),
          notify: () =>
            bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId }),
        });
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
        bus.publish(bus.ch.room(ns, channel.id), { t: "message:body", id, body: cleaned });
        await db.createArtifact(id, {
          kind: "ask-user",
          url: "",
          title: ask.question || null,
          md: JSON.stringify(ask.options),
        });
        bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
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
      if (found) bus.publish(bus.ch.room(ns, channel.id), { t: "refresh", channelId: channel.id, parentId: data.parentId });
    } catch (e) {
      console.error("[artifact] detect/mint failed", e);
    } finally {
      // ⚠️ UN SOLO punto de enganche. El bloque de arriba tiene SIETE ramas y cada una hace
      // su propio `return`: colgar esto rama por rama garantiza que alguna se quede sin
      // aviso. El `finally` es el único sitio por el que pasan todas.
      await avisarFinDeTurno({
        ns, messageId: id, channelId: channel.id, channelSlug: channel.slug,
        parentId: data.parentId ?? null, invokerSub: poster?.sub ?? null,
        agente: name, tarea: tareaDelTurno,
      }).catch(() => {});
    }
    return { ok: true as const };
  });

/**
 * Fin de turno: calcula QUÉ se entregó y avisa a quien lo pidió.
 *
 * El resumen ("1 documento · 3 versiones") se calcula **una vez, aquí**, no en cada refresco
 * de la barra — es el equivalente al "Files added/changed" que Cursor enseña al terminar.
 *
 * El aviso va **sólo al invocador**: el turno es suyo. Avisar al room entero convertiría cada
 * documento en spam para todos. Y respeta el silencio del room, igual que menciones y DMs.
 *
 * ⚠️ `notify()` ya salta el push a quien está ONLINE, así que esto no necesita saber si la
 * persona está mirando: si está dentro, no le llega push (y ve el toast); si se fue, sí.
 */
async function avisarFinDeTurno(a: {
  ns: string; messageId: number; channelId: number; channelSlug: string;
  parentId: number | null; invokerSub: string | null; agente: string; tarea: string;
}): Promise<void> {
  const db = await import("../db.server");
  const turns = await import("./turns.server");

  // Qué produjo: artefacto del mensaje (+ sus versiones) y/o archivos adjuntos.
  let resumen = "";
  try {
    const { documentId, versions, files } = await db.turnOutcomeCounts(a.messageId);
    const partes: string[] = [];
    if (documentId) partes.push(versions > 1 ? `1 documento · ${versions} versiones` : "1 documento");
    if (files) partes.push(files === 1 ? "1 archivo" : `${files} archivos`);
    resumen = partes.join(" · ");
  } catch {
    /* sin resumen: la fila dice "terminó" y ya */
  }
  if (resumen) {
    turns.setTurnOutcome(a.messageId, resumen);
    // ⚠️ El "terminó" ya se anunció antes (el `finally` del turno corre ANTES que el bloque
    // de artefactos), así que el resumen llega tarde por definición: se re-emite el estado
    // con él para que la fila lo recoja. Sin esto, la barra diría "terminó" a secas siempre.
    const bus = await import("./bus.server");
    bus.publish(bus.ch.room(a.ns, a.channelId), {
      t: "turn", id: a.messageId, state: "done", position: 1, startedAt: Date.now(), outcome: resumen,
    });
  }

  if (!a.invokerSub) return;
  // El silencio del room manda, igual que en menciones/DMs/llamadas.
  const destinos = await db.filterMutedOut([a.invokerSub], "room", a.channelId).catch(() => []);
  if (!destinos.length) return;
  const { notify } = await import("./notify.server");
  await notify(
    {
      kind: "turn",
      recipients: destinos,
      title: `${a.agente} terminó`,
      body: [a.tarea, resumen].filter(Boolean).join(" — ") || "Tu agente terminó de trabajar.",
      url: a.parentId != null ? `/c/${a.channelSlug}?thread=${a.parentId}` : `/c/${a.channelSlug}`,
      // Tag estable por mensaje: si el mismo turno avisara dos veces, se reemplaza en vez
      // de apilarse en la bandeja.
      tag: `turn:${a.messageId}`,
    },
    a.ns,
  );
}

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
