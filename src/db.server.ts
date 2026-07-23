// Estado en EasyBits DB (libSQL) — modelo Slack: canal = flujo, threads nacen
// de un mensaje (parent_id). Compute stateless, historial durable.
import { dbq, num, type Row } from "./dbq.server";

export type Channel = {
  id: number;
  slug: string;
  name: string;
  is_private: number;
  icon: string | null;
  description?: string | null;
  archived?: number;
  created_by?: string | null;
  threads?: Message[]; // hilos raíz (adjuntados por getChannelView para el sidebar)
};

function toChannel(r: Row): Channel {
  return {
    id: num(r.id),
    slug: r.slug!,
    name: r.name!,
    is_private: num(r.is_private),
    icon: r.icon,
    description: r.description ?? null,
    archived: num(r.archived),
    created_by: r.created_by,
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "room"
  );
}
export type ReactionAgg = { emoji: string; count: number; mine: boolean };
export type Message = {
  id: number;
  channel_id: number;
  parent_id: number | null;
  sender: string;
  sender_sub?: string | null; // sub estable del autor (authz de editar/borrar); null en legacy/agentes
  avatar: string;
  body: string;
  kind: "msg" | "status";
  mentions_ghosty: number;
  agent_handle: string | null;
  created_at: number;
  reply_count?: number;
  topic?: string;
  dm_id?: number | null;
  edited_at?: number | null;
  reactions?: ReactionAgg[];
  starred?: boolean; // marcado por el usuario actual (personal)
  pinned?: boolean;  // fijado en su room (visible para todos)
  attachments?: Attachment[]; // adjuntos (EasyBits), Fase 4
  artifact?: Artifact | null; // doc/pdf que PRODUCE el agente (abre en el panel)
  // Quote-reply: cita a otro mensaje. Snapshot denormalizado (autor+extracto) → el
  // render y el agente la ven sin join y sobrevive al borrado del original.
  quoted_id?: number | null;
  quoted_author?: string | null;
  quoted_excerpt?: string | null;
};

export type Attachment = {
  id: number;
  file_id: string;
  mime: string | null;
  size: number | null;
  name: string | null;
  thumb_file_id?: string | null; // derivado WebP para render inline (null = usa el original)
  width?: number | null;  // dims intrínsecas → el render reserva el alto exacto (0 layout-shift)
  height?: number | null;
};

// Artefacto: doc/pdf/imagen que el agente genera y se abre en el panel del room.
// kind gatea el modo del panel: "html" (editor colab embebido), "pdf", "image".
export type Artifact = {
  id: number;
  kind: string;
  url: string;
  title: string | null;
  md?: string | null; // markdown fuente (kind:"doc") / CSV (sheet) / HTML (artifact) → render local
  src?: string | null; // URL pública S3 (kind:"artifact" → enlace compartible)
};

export const GHOSTY_RE = /@ghosty\b/i;

// El handle "ghosty" siempre existe (el agente del wizard). Reservado.
export const GHOSTY_HANDLE = "ghosty";

function toMessage(r: Row): Message {
  return {
    id: num(r.id),
    channel_id: num(r.channel_id),
    parent_id: r.parent_id == null ? null : num(r.parent_id),
    sender: r.sender!,
    sender_sub: (r.sender_sub as string | null) ?? null,
    avatar: r.avatar ?? "",
    body: r.body!,
    kind: (r.kind as "msg" | "status") ?? "msg",
    mentions_ghosty: num(r.mentions_ghosty),
    agent_handle: r.agent_handle ?? null,
    created_at: num(r.created_at),
    reply_count: r.reply_count == null ? undefined : num(r.reply_count),
    topic: r.topic ?? "general",
    dm_id: r.dm_id == null ? null : num(r.dm_id),
    edited_at: r.edited_at == null ? null : num(r.edited_at),
    quoted_id: r.quoted_id == null ? null : num(r.quoted_id),
    quoted_author: (r.quoted_author as string | null) ?? null,
    quoted_excerpt: (r.quoted_excerpt as string | null) ?? null,
  };
}

// ── Reacciones + edición ──
// Toggle: si ya reaccioné con ese emoji lo quito; si no, lo pongo. Devuelve el nuevo total.
export async function toggleReaction(
  messageId: number,
  userSub: string,
  emoji: string
): Promise<{ op: "add" | "remove"; count: number }> {
  const existing = await dbq(
    "SELECT 1 FROM gc_reactions WHERE message_id = ? AND user_sub = ? AND emoji = ?",
    [messageId, userSub, emoji]
  );
  let op: "add" | "remove";
  if (existing.length) {
    await dbq("DELETE FROM gc_reactions WHERE message_id = ? AND user_sub = ? AND emoji = ?", [
      messageId,
      userSub,
      emoji,
    ]);
    op = "remove";
  } else {
    await dbq(
      "INSERT INTO gc_reactions (message_id, user_sub, emoji) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [messageId, userSub, emoji]
    );
    op = "add";
  }
  const c = await dbq("SELECT COUNT(*) AS c FROM gc_reactions WHERE message_id = ? AND emoji = ?", [
    messageId,
    emoji,
  ]);
  return { op, count: num(c[0]?.c) };
}

// Agrega las reacciones de un lote de mensajes (1 query, evita N+1 sobre HTTP).
export async function attachReactions(msgs: Message[], userSub: string): Promise<Message[]> {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT message_id, emoji, user_sub FROM gc_reactions WHERE message_id IN (${ph})`,
    ids
  );
  const byMsg = new Map<number, Map<string, { count: number; mine: boolean }>>();
  for (const r of rows) {
    const mid = num(r.message_id);
    const emoji = r.emoji!;
    if (!byMsg.has(mid)) byMsg.set(mid, new Map());
    const em = byMsg.get(mid)!;
    const cur = em.get(emoji) ?? { count: 0, mine: false };
    cur.count++;
    if (r.user_sub === userSub) cur.mine = true;
    em.set(emoji, cur);
  }
  return msgs.map((m) => {
    const em = byMsg.get(m.id);
    if (!em) return m;
    return { ...m, reactions: [...em.entries()].map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })) };
  });
}

// Agrega los flags personales/de-room (star mío, pin del room) a un lote (2 queries).
export async function attachStarPin(msgs: Message[], userSub: string): Promise<Message[]> {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const [starRows, pinRows] = await Promise.all([
    dbq(`SELECT message_id FROM gc_stars WHERE user_sub = ? AND message_id IN (${ph})`, [userSub, ...ids]),
    dbq(`SELECT message_id FROM gc_pins WHERE message_id IN (${ph})`, ids),
  ]);
  const starred = new Set(starRows.map((r) => num(r.message_id)));
  const pinned = new Set(pinRows.map((r) => num(r.message_id)));
  return msgs.map((m) => ({ ...m, starred: starred.has(m.id), pinned: pinned.has(m.id) }));
}

// ── Buscador (Fase 2.4) ─────────────────────────────────────────────────────
// LIKE universal (sin depender de FTS5). Escapamos %/_ para tratar la query como
// texto literal. Top-level (parent_id NULL) para que el resultado exista en el flujo.
function likeArg(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

export type RoomHit = Message & { slug: string; roomName: string };
export async function searchRoomMessages(channelIds: number[], q: string): Promise<RoomHit[]> {
  if (!channelIds.length || !q.trim()) return [];
  const ph = channelIds.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT m.*, ch.slug AS _slug, ch.name AS _rname
       FROM gc_messages m JOIN gc_channels ch ON ch.id = m.channel_id
      WHERE m.kind = 'msg' AND m.dm_id IS NULL AND m.parent_id IS NULL
        AND m.channel_id IN (${ph}) AND m.body LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT 40`,
    [...channelIds, likeArg(q)]
  );
  return rows.map((r) => ({ ...toMessage(r), slug: r._slug!, roomName: r._rname! }));
}

export async function searchDmMessages(userSub: string, q: string): Promise<Message[]> {
  if (!q.trim()) return [];
  const rows = await dbq(
    `SELECT m.* FROM gc_messages m
       JOIN gc_dm_members dm ON dm.conversation_id = m.dm_id AND dm.user_sub = ?
      WHERE m.kind = 'msg' AND m.dm_id IS NOT NULL AND m.body LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT 20`,
    [userSub, likeArg(q)]
  );
  return rows.map(toMessage);
}

// Adjunta los archivos (EasyBits) de cada mensaje en un lote (1 query).
export async function attachAttachments(msgs: Message[]): Promise<Message[]> {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT id, message_id, file_id, mime, size, name, thumb_file_id, width, height FROM gc_attachments
      WHERE message_id IN (${ph}) ORDER BY id`,
    ids
  );
  if (!rows.length) return msgs;
  const byMsg = new Map<number, Attachment[]>();
  for (const r of rows) {
    const mid = num(r.message_id);
    const a: Attachment = {
      id: num(r.id),
      file_id: r.file_id!,
      mime: r.mime ?? null,
      size: r.size == null ? null : num(r.size),
      name: r.name ?? null,
      thumb_file_id: (r.thumb_file_id as string | null) ?? null,
      width: r.width == null ? null : num(r.width),
      height: r.height == null ? null : num(r.height),
    };
    const arr = byMsg.get(mid) ?? [];
    if (arr.length === 0) byMsg.set(mid, arr);
    arr.push(a);
  }
  return msgs.map((m) => (byMsg.has(m.id) ? { ...m, attachments: byMsg.get(m.id) } : m));
}

// Inserta los adjuntos de un mensaje recién creado.
export async function createAttachments(
  messageId: number,
  files: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null }[]
): Promise<void> {
  for (const f of files) {
    await dbq(
      `INSERT INTO gc_attachments (message_id, file_id, mime, size, name, thumb_file_id, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, f.fileId, f.mime, f.size, f.name, f.thumbFileId ?? null, f.width ?? null, f.height ?? null]
    );
  }
}

// Lee los file_ids (original + thumb) de un mensaje (para borrar el objeto al eliminarlo).
export async function attachmentFileIds(messageId: number): Promise<string[]> {
  const rows = await dbq(`SELECT file_id, thumb_file_id FROM gc_attachments WHERE message_id = ?`, [messageId]);
  return rows.flatMap((r) => [r.file_id, r.thumb_file_id].filter(Boolean) as string[]);
}

// Adjunta el artefacto (doc/pdf del agente) de cada mensaje en un lote (1 query).
export async function attachArtifacts(msgs: Message[]): Promise<Message[]> {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT id, message_id, kind, url, title, md, src FROM gc_artifacts
      WHERE message_id IN (${ph}) ORDER BY id`,
    ids
  );
  if (!rows.length) return msgs;
  const byMsg = new Map<number, Artifact>();
  for (const r of rows) {
    // 1 artefacto por mensaje (el último gana si hubiera varios).
    byMsg.set(num(r.message_id), {
      id: num(r.id),
      kind: r.kind!,
      url: r.url!,
      title: r.title ?? null,
      md: r.md ?? null,
      src: r.src ?? null,
    });
  }
  return msgs.map((m) => (byMsg.has(m.id) ? { ...m, artifact: byMsg.get(m.id) } : m));
}

// Inserta el artefacto de un mensaje del agente.
export async function createArtifact(
  messageId: number,
  a: { kind: string; url: string; title?: string | null; md?: string | null; src?: string | null }
): Promise<void> {
  await dbq(
    `INSERT INTO gc_artifacts (message_id, kind, url, title, md, src) VALUES (?, ?, ?, ?, ?, ?)`,
    [messageId, a.kind, a.url, a.title ?? null, a.md ?? null, a.src ?? null]
  );
}

// Artefacto vivo ACTUAL (doc = markdown | sheet = csv) por su documentId local. Última
// versión gana. Es la verdad que se re-inyecta al agente al modificar → re-emite el
// artefacto completo con el cambio.
export async function getDoc(
  documentId: string
): Promise<{ kind: "doc" | "sheet" | "artifact"; md: string } | null> {
  const rows = await dbq(
    `SELECT kind, md FROM gc_artifacts
      WHERE url = ? AND kind IN ('doc','sheet','artifact') AND md IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [documentId]
  );
  const r = rows[0];
  return r?.md ? { kind: r.kind as "doc" | "sheet" | "artifact", md: r.md } : null;
}

// Solo el contenido (para el export .docx del route). Delega en getDoc.
export async function getDocMarkdown(documentId: string): Promise<string | null> {
  return (await getDoc(documentId))?.md ?? null;
}

// ── Identidad conversacional del artefacto vivo (Fase 1 edit-in-place) ──────────
// conv_key = `${channelId}:${parentId ?? "root"}` → documentId del artefacto ACTUAL.
function convKey(channelId: number, parentId?: number | null): string {
  return `${channelId}:${parentId ?? "root"}`;
}
export async function getThreadArtifact(
  channelId: number,
  parentId?: number | null
): Promise<string | null> {
  const rows = await dbq("SELECT document_id FROM gc_thread_artifact WHERE conv_key = ?", [
    convKey(channelId, parentId),
  ]);
  return (rows[0]?.document_id as string) ?? null;
}
export async function setThreadArtifact(
  channelId: number,
  parentId: number | null | undefined,
  documentId: string
): Promise<void> {
  await dbq(
    `INSERT INTO gc_thread_artifact (conv_key, document_id, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(conv_key) DO UPDATE SET document_id = excluded.document_id, updated_at = excluded.updated_at`,
    [convKey(channelId, parentId), documentId]
  );
}

// Enriquece un lote con TODO lo de display: reacciones + star/pin + adjuntos + artefacto.
export async function attachMeta(msgs: Message[], userSub: string): Promise<Message[]> {
  return attachArtifacts(await attachAttachments(await attachStarPin(await attachReactions(msgs, userSub), userSub)));
}

// ── VIEWS (Fase 2.1): inbox/recent/mentions/starred ─────────────────────────
// Un "hit" de vista es un Message + contexto para hacerlo clickable: si trae slug
// es de un room; si trae dm_id (ya en Message) es de un DM.
export type ViewHit = Message & { slug?: string; roomName?: string };

export async function getUserHandle(sub: string): Promise<string | null> {
  const rows = await dbq("SELECT handle FROM gc_users WHERE sub = ?", [sub]);
  return rows[0]?.handle ?? null;
}

// Destacados (star) del usuario, con contexto de room cuando aplica.
export async function listStarredHits(userSub: string): Promise<ViewHit[]> {
  const rows = await dbq(
    `SELECT m.*, ch.slug AS _slug, ch.name AS _rname
       FROM gc_messages m
       JOIN gc_stars s ON s.message_id = m.id AND s.user_sub = ?
       LEFT JOIN gc_channels ch ON ch.id = m.channel_id AND m.dm_id IS NULL
      WHERE m.kind = 'msg'
      ORDER BY s.created_at DESC LIMIT 100`,
    [userSub]
  );
  return rows.map((r) => ({ ...toMessage(r), slug: r._slug ?? undefined, roomName: r._rname ?? undefined }));
}

// Menciones a @handle en rooms visibles (Zulip: las menciones son de canal).
export async function listMentionHits(handle: string, channelIds: number[]): Promise<ViewHit[]> {
  if (!handle || !channelIds.length) return [];
  const ph = channelIds.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT m.*, ch.slug AS _slug, ch.name AS _rname
       FROM gc_messages m JOIN gc_channels ch ON ch.id = m.channel_id
      WHERE m.kind = 'msg' AND m.dm_id IS NULL AND m.channel_id IN (${ph})
        AND m.body LIKE ? ESCAPE '\\'
      ORDER BY m.created_at DESC LIMIT 60`,
    [...channelIds, likeArg("@" + handle)]
  );
  return rows.map((r) => ({ ...toMessage(r), slug: r._slug!, roomName: r._rname! }));
}

// Recientes: último mensaje por conversación (rooms visibles + DMs propios), mezclados.
export async function listRecentHits(userSub: string, channelIds: number[]): Promise<ViewHit[]> {
  const out: ViewHit[] = [];
  if (channelIds.length) {
    const ph = channelIds.map(() => "?").join(",");
    const roomRows = await dbq(
      `SELECT m.*, ch.slug AS _slug, ch.name AS _rname
         FROM gc_messages m JOIN gc_channels ch ON ch.id = m.channel_id
         JOIN (SELECT channel_id, MAX(id) AS mid FROM gc_messages
                WHERE dm_id IS NULL AND kind = 'msg' AND parent_id IS NULL
                  AND channel_id IN (${ph}) GROUP BY channel_id) x ON x.mid = m.id`,
      channelIds
    );
    for (const r of roomRows) out.push({ ...toMessage(r), slug: r._slug!, roomName: r._rname! });
  }
  const dmRows = await dbq(
    `SELECT m.* FROM gc_messages m
       JOIN gc_dm_members dm ON dm.conversation_id = m.dm_id AND dm.user_sub = ?
       JOIN (SELECT dm_id, MAX(id) AS mid FROM gc_messages
              WHERE dm_id IS NOT NULL AND kind = 'msg' GROUP BY dm_id) x ON x.mid = m.id`,
    [userSub]
  );
  for (const r of dmRows) out.push({ ...toMessage(r) });
  return out.sort((a, b) => b.created_at - a.created_at);
}

// Star (personal): toggle. Devuelve el nuevo estado.
export async function toggleStar(userSub: string, messageId: number): Promise<{ starred: boolean }> {
  const existing = await dbq(
    "SELECT 1 FROM gc_stars WHERE user_sub = ? AND message_id = ?",
    [userSub, messageId]
  );
  if (existing.length) {
    await dbq("DELETE FROM gc_stars WHERE user_sub = ? AND message_id = ?", [userSub, messageId]);
    return { starred: false };
  }
  await dbq(
    "INSERT INTO gc_stars (user_sub, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [userSub, messageId]
  );
  return { starred: true };
}

// Los mensajes marcados por el usuario (para la vista Starred, Fase 2.1).
export async function listStarred(userSub: string): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.* FROM gc_messages m
       JOIN gc_stars s ON s.message_id = m.id
      WHERE s.user_sub = ? AND m.kind = 'msg'
      ORDER BY s.created_at DESC`,
    [userSub]
  );
  return rows.map(toMessage);
}

// Pin (room-level): toggle. channel_id se guarda como TEXT (consistencia con scopes).
export async function togglePin(
  channelId: number,
  messageId: number,
  pinnedBy: string
): Promise<{ pinned: boolean }> {
  const existing = await dbq(
    "SELECT 1 FROM gc_pins WHERE channel_id = ? AND message_id = ?",
    [String(channelId), messageId]
  );
  if (existing.length) {
    await dbq("DELETE FROM gc_pins WHERE channel_id = ? AND message_id = ?", [String(channelId), messageId]);
    return { pinned: false };
  }
  await dbq(
    "INSERT INTO gc_pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [String(channelId), messageId, pinnedBy]
  );
  return { pinned: true };
}

// Los mensajes fijados de un room (barra en el header), más recientes primero.
export async function listPinned(channelId: number): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.* FROM gc_messages m
       JOIN gc_pins p ON p.message_id = m.id
      WHERE p.channel_id = ?
      ORDER BY p.created_at DESC`,
    [String(channelId)]
  );
  return rows.map(toMessage);
}

// Mute (silenciar un scope): toggle + listado (para el sidebar y el gating de push).
export async function toggleMute(
  userSub: string,
  scope: "room" | "dm",
  scopeId: number
): Promise<{ muted: boolean }> {
  const existing = await dbq(
    "SELECT 1 FROM gc_mutes WHERE user_sub = ? AND scope = ? AND scope_id = ?",
    [userSub, scope, String(scopeId)]
  );
  if (existing.length) {
    await dbq("DELETE FROM gc_mutes WHERE user_sub = ? AND scope = ? AND scope_id = ?", [
      userSub,
      scope,
      String(scopeId),
    ]);
    return { muted: false };
  }
  await dbq(
    "INSERT INTO gc_mutes (user_sub, scope, scope_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [userSub, scope, String(scopeId)]
  );
  return { muted: true };
}

// Scopes silenciados por el usuario (para pintar dimmed y suprimir badge/push).
export async function listMutes(userSub: string): Promise<{ scope: string; scope_id: string }[]> {
  const rows = await dbq("SELECT scope, scope_id FROM gc_mutes WHERE user_sub = ?", [userSub]);
  return rows.map((r) => ({ scope: r.scope!, scope_id: r.scope_id! }));
}

// ¿Están silenciados estos subs para este scope? (filtra recipients de push.)
export async function filterMutedOut(
  subs: string[],
  scope: "room" | "dm",
  scopeId: number
): Promise<string[]> {
  if (!subs.length) return subs;
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT user_sub FROM gc_mutes WHERE scope = ? AND scope_id = ? AND user_sub IN (${ph})`,
    [scope, String(scopeId), ...subs]
  );
  const muted = new Set(rows.map((r) => r.user_sub!));
  return subs.filter((s) => !muted.has(s));
}

// Editar mensaje (autor u owner; marca edited_at).
export async function editMessage(id: number, body: string): Promise<void> {
  await dbq("UPDATE gc_messages SET body = ?, edited_at = unixepoch() WHERE id = ?", [body, id]);
}

// Persiste el body final de una respuesta de agente que llegó por streaming. NO
// toca edited_at (no es una edición del autor, es el reply que terminó de fluir) →
// no muestra "(editado)". El body autoritativo permite el catch-up por cursor.
export async function setMessageBody(id: number, body: string): Promise<void> {
  await dbq("UPDATE gc_messages SET body = ? WHERE id = ?", [body, id]);
}

// ── Agentes (multi-agente): el "ghosty" implícito del wizard + estos extra ──
export type Agent = {
  id: number;
  handle: string;
  name: string;
  kind: "fleet" | "webhook";
  fleet_id: string | null;
  fleet_token: string | null;
  webhook_url: string | null;
  avatar: string | null;
  system_prompt: string | null;
  enabled: number;
  created_by: string | null;
};

function toAgent(r: Row): Agent {
  return {
    id: num(r.id),
    handle: r.handle!,
    name: r.name!,
    kind: (r.kind as "fleet" | "webhook") ?? "fleet",
    fleet_id: r.fleet_id,
    fleet_token: r.fleet_token,
    webhook_url: r.webhook_url,
    avatar: r.avatar,
    system_prompt: r.system_prompt ?? null,
    enabled: num(r.enabled),
    created_by: r.created_by,
  };
}

export async function listAgents(): Promise<Agent[]> {
  const rows = await dbq("SELECT * FROM gc_agents ORDER BY id");
  return rows.map(toAgent);
}

export async function getAgentByHandle(handle: string): Promise<Agent | null> {
  const rows = await dbq("SELECT * FROM gc_agents WHERE handle = ?", [handle.toLowerCase()]);
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function getAgentById(id: number): Promise<Agent | null> {
  const rows = await dbq("SELECT * FROM gc_agents WHERE id = ?", [id]);
  return rows[0] ? toAgent(rows[0]) : null;
}

// Inserta el @ghosty del wizard como fila real (bypass del guard de handle reservado)
// para que use el MISMO CRUD/panel que los demás. Idempotente por handle único.
export async function ensureGhostyAgentRow(input: {
  fleetId: string;
  fleetToken: string;
  name: string;
  systemPrompt: string | null;
  createdBy: string;
}): Promise<Agent> {
  const existing = await getAgentByHandle(GHOSTY_HANDLE);
  if (existing) {
    // Refresca el token/id por si el owner reconfiguró la flota en el wizard.
    if (existing.fleet_id !== input.fleetId || existing.fleet_token !== input.fleetToken) {
      await updateAgent(existing.id, { fleetId: input.fleetId, fleetToken: input.fleetToken });
      return { ...existing, fleet_id: input.fleetId, fleet_token: input.fleetToken };
    }
    return existing;
  }
  const rows = await dbq(
    `INSERT INTO gc_agents (handle, name, kind, fleet_id, fleet_token, avatar, system_prompt, created_by)
     VALUES (?, ?, 'fleet', ?, ?, '/ghosty.svg', ?, ?) RETURNING *`,
    [GHOSTY_HANDLE, input.name.slice(0, 40), input.fleetId, input.fleetToken, input.systemPrompt, input.createdBy]
  );
  return toAgent(rows[0]);
}

export async function createAgent(input: {
  handle: string;
  name: string;
  kind: "fleet" | "webhook";
  fleetId?: string | null;
  fleetToken?: string | null;
  webhookUrl?: string | null;
  avatar?: string | null;
  systemPrompt?: string | null;
  createdBy: string;
}): Promise<Agent> {
  const handle = slugify(input.handle).replace(/-/g, "");
  const rows = await dbq(
    `INSERT INTO gc_agents (handle, name, kind, fleet_id, fleet_token, webhook_url, avatar, system_prompt, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      handle,
      input.name.slice(0, 40),
      input.kind,
      input.fleetId ?? null,
      input.fleetToken ?? null,
      input.webhookUrl ?? null,
      input.avatar ?? null,
      input.systemPrompt ?? null,
      input.createdBy,
    ]
  );
  return toAgent(rows[0]);
}

export async function updateAgent(
  id: number,
  patch: {
    name?: string;
    handle?: string;
    fleetId?: string;
    fleetToken?: string;
    webhookUrl?: string;
    avatar?: string | null;
    systemPrompt?: string | null;
    enabled?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), args.push(patch.name.slice(0, 40)));
  if (patch.handle !== undefined) (sets.push("handle = ?"), args.push(patch.handle));
  if (patch.fleetId !== undefined) (sets.push("fleet_id = ?"), args.push(patch.fleetId));
  if (patch.fleetToken !== undefined) (sets.push("fleet_token = ?"), args.push(patch.fleetToken));
  if (patch.webhookUrl !== undefined) (sets.push("webhook_url = ?"), args.push(patch.webhookUrl));
  if (patch.avatar !== undefined) (sets.push("avatar = ?"), args.push(patch.avatar));
  if (patch.systemPrompt !== undefined) (sets.push("system_prompt = ?"), args.push(patch.systemPrompt));
  if (patch.enabled !== undefined) (sets.push("enabled = ?"), args.push(patch.enabled ? 1 : 0));
  if (!sets.length) return;
  args.push(id);
  await dbq(`UPDATE gc_agents SET ${sets.join(", ")} WHERE id = ?`, args);
}

// ── Colaboradores de agente (slice 4): pueden EDITAR la config, no ver secret ──
export async function addAgentCollaborator(agentId: number, userSub: string): Promise<void> {
  await dbq(
    "INSERT INTO gc_agent_collaborators (agent_id, user_sub) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [agentId, userSub]
  );
}
export async function removeAgentCollaborator(agentId: number, userSub: string): Promise<void> {
  await dbq("DELETE FROM gc_agent_collaborators WHERE agent_id = ? AND user_sub = ?", [agentId, userSub]);
}
export async function isAgentCollaborator(agentId: number, userSub: string): Promise<boolean> {
  const rows = await dbq(
    "SELECT 1 FROM gc_agent_collaborators WHERE agent_id = ? AND user_sub = ?",
    [agentId, userSub]
  );
  return !!rows[0];
}
export async function listAgentCollaboratorsInfo(agentId: number): Promise<MemberInfo[]> {
  const rows = await dbq(
    `SELECT u.sub, u.name, u.email, u.avatar
       FROM gc_agent_collaborators c JOIN gc_users u ON u.sub = c.user_sub
      WHERE c.agent_id = ?`,
    [agentId]
  );
  return rows.map((r) => ({ sub: r.sub!, name: r.name ?? "", email: r.email ?? "", avatar: r.avatar ?? "" }));
}
// Ids de agentes donde el usuario es colaborador (para listar los que puede editar).
export async function listCollaboratorAgentIds(userSub: string): Promise<number[]> {
  const rows = await dbq("SELECT agent_id FROM gc_agent_collaborators WHERE user_sub = ?", [userSub]);
  return rows.map((r) => num(r.agent_id));
}

export async function deleteAgent(id: number): Promise<void> {
  await dbq("DELETE FROM gc_agent_collaborators WHERE agent_id = ?", [id]);
  await dbq("DELETE FROM gc_agents WHERE id = ?", [id]);
}

// ── Web Push: suscripciones por usuario ──
export async function savePushSub(
  userSub: string,
  sub: { endpoint: string; p256dh: string; auth: string }
): Promise<void> {
  await dbq(
    `INSERT INTO gc_push_subs (user_sub, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_sub = excluded.user_sub, p256dh = excluded.p256dh, auth = excluded.auth`,
    [userSub, sub.endpoint, sub.p256dh, sub.auth]
  );
}

export async function deletePushSub(endpoint: string): Promise<void> {
  await dbq("DELETE FROM gc_push_subs WHERE endpoint = ?", [endpoint]);
}

export type StoredPushSub = { endpoint: string; p256dh: string; auth: string };
export async function listPushSubsForUsers(subs: string[]): Promise<StoredPushSub[]> {
  if (!subs.length) return [];
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT endpoint, p256dh, auth FROM gc_push_subs WHERE user_sub IN (${ph})`,
    subs
  );
  return rows.map((r) => ({ endpoint: r.endpoint!, p256dh: r.p256dh!, auth: r.auth! }));
}

// Rooms visibles para el user: públicos, o privados donde es miembro, o todos si owner.
export async function listChannels(userSub: string, isOwner: boolean): Promise<Channel[]> {
  // Archivados fuera del sidebar (columna dormida hasta Fase 4). COALESCE por si
  // la fila es previa a la migración (NULL → 0).
  const rows = await dbq(
    `SELECT * FROM gc_channels
      WHERE COALESCE(archived, 0) = 0
        AND (is_private = 0 OR ? = 1
         OR id IN (SELECT channel_id FROM gc_channel_members WHERE user_sub = ?))
      ORDER BY id`,
    [isOwner ? 1 : 0, userSub]
  );
  return rows.map(toChannel);
}

export async function getChannel(slug: string): Promise<Channel | null> {
  const rows = await dbq("SELECT * FROM gc_channels WHERE slug = ?", [slug]);
  return rows[0] ? toChannel(rows[0]) : null;
}

export async function canSeeChannel(ch: Channel, userSub: string, isOwner: boolean): Promise<boolean> {
  if (ch.is_private === 0 || isOwner) return true;
  const { rows } = await dbqRaw(
    "SELECT 1 FROM gc_channel_members WHERE channel_id = ? AND user_sub = ?",
    [ch.id, userSub]
  );
  return rows.length > 0;
}

// helper que devuelve rows crudas (para EXISTS checks)
async function dbqRaw(sql: string, args: unknown[] = []) {
  const rows = await dbq(sql, args);
  return { rows };
}

// ── Rooms CRUD ──
export async function createChannel(input: {
  name: string;
  description?: string;
  icon?: string;
  isPrivate: boolean;
  createdBy: string;
}): Promise<Channel> {
  let base = slugify(input.name);
  let slug = base;
  // slug único
  for (let i = 2; (await getChannel(slug)) != null; i++) slug = `${base}-${i}`;
  const rows = await dbq(
    `INSERT INTO gc_channels (slug, name, description, is_private, icon, created_by)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [slug, input.name.slice(0, 40), input.description?.slice(0, 280) || null, input.isPrivate ? 1 : 0, input.icon ?? null, input.createdBy]
  );
  const ch = toChannel(rows[0]);
  if (ch.is_private) await addChannelMember(ch.id, input.createdBy);
  return ch;
}

export async function updateChannel(
  id: number,
  patch: {
    name?: string;
    icon?: string | null;
    isPrivate?: boolean;
    description?: string | null;
    archived?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), args.push(patch.name.slice(0, 40)));
  if (patch.icon !== undefined) (sets.push("icon = ?"), args.push(patch.icon));
  if (patch.isPrivate !== undefined) (sets.push("is_private = ?"), args.push(patch.isPrivate ? 1 : 0));
  if (patch.description !== undefined)
    (sets.push("description = ?"), args.push(patch.description ? patch.description.slice(0, 280) : null));
  if (patch.archived !== undefined) (sets.push("archived = ?"), args.push(patch.archived ? 1 : 0));
  if (!sets.length) return;
  args.push(id);
  await dbq(`UPDATE gc_channels SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function deleteChannel(id: number): Promise<void> {
  await dbq("DELETE FROM gc_messages WHERE channel_id = ?", [id]);
  await dbq("DELETE FROM gc_channel_members WHERE channel_id = ?", [id]);
  await dbq("DELETE FROM gc_channels WHERE id = ?", [id]);
}

export async function listChannelMembers(channelId: number): Promise<string[]> {
  const rows = await dbq("SELECT user_sub FROM gc_channel_members WHERE channel_id = ?", [channelId]);
  return rows.map((r) => r.user_sub!);
}

export async function addChannelMember(channelId: number, userSub: string): Promise<void> {
  await dbq(
    "INSERT INTO gc_channel_members (channel_id, user_sub) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [channelId, userSub]
  );
}

export async function removeChannelMember(channelId: number, userSub: string): Promise<void> {
  await dbq("DELETE FROM gc_channel_members WHERE channel_id = ? AND user_sub = ?", [channelId, userSub]);
}

export async function getUserSubByEmail(email: string): Promise<string | null> {
  const rows = await dbq("SELECT sub FROM gc_users WHERE email = ?", [email.trim().toLowerCase()]);
  return rows[0]?.sub ?? null;
}

// Emails de una lista de subs (para notificar por correo). Omite banned, sin email, y
// quienes desactivaron el correo (email_notifs=0, opt-out en Ajustes → Notificaciones).
export async function emailsForSubs(subs: string[]): Promise<{ sub: string; email: string; name: string }[]> {
  if (!subs.length) return [];
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(`SELECT sub, email, name FROM gc_users WHERE sub IN (${ph}) AND email IS NOT NULL AND COALESCE(banned,0)=0 AND COALESCE(email_notifs,0)=1`, subs);
  return rows.map((r) => ({ sub: r.sub!, email: r.email!, name: r.name ?? "" })).filter((r) => r.email.includes("@"));
}

// Preferencia de correo del usuario (para el toggle). Default OFF (opt-in).
export async function getEmailNotifs(sub: string): Promise<boolean> {
  const rows = await dbq("SELECT COALESCE(email_notifs,0) AS en FROM gc_users WHERE sub=?", [sub]);
  return num(rows[0]?.en ?? "0") === 1;
}
export async function setEmailNotifs(sub: string, on: boolean): Promise<void> {
  await dbq("UPDATE gc_users SET email_notifs=? WHERE sub=?", [on ? 1 : 0, sub]);
}

export type MemberInfo = { sub: string; name: string; email: string; avatar: string };
export async function listChannelMembersInfo(channelId: number): Promise<MemberInfo[]> {
  const rows = await dbq(
    `SELECT u.sub, u.name, u.email, u.avatar
       FROM gc_channel_members m JOIN gc_users u ON u.sub = m.user_sub
      WHERE m.channel_id = ?`,
    [channelId]
  );
  return rows.map((r) => ({ sub: r.sub!, name: r.name ?? "", email: r.email ?? "", avatar: r.avatar ?? "" }));
}

// Flujo principal del canal: mensajes top-level (parent_id NULL) + nº de respuestas.
// Con `topic` filtra al eje Zulip; sin él devuelve el room completo (compat).
export async function listChannelFlow(channelId: number, topic?: string): Promise<Message[]> {
  const filter = topic ? "AND m.topic = ?" : "";
  const args: unknown[] = topic ? [channelId, topic] : [channelId];
  const rows = await dbq(
    `SELECT m.*, (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL ${filter}
      ORDER BY m.created_at ASC`,
    args
  );
  return rows.map(toMessage);
}

// Topics del room (eje Zulip): distintos topics de mensajes top-level, con conteo
// y actividad reciente, para pintar los submenús colapsables del sidebar.
export type TopicInfo = { topic: string; count: number; last_at: number };
export async function listTopics(channelId: number): Promise<TopicInfo[]> {
  const rows = await dbq(
    `SELECT topic, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM gc_messages
      WHERE channel_id = ? AND parent_id IS NULL
      GROUP BY topic
      ORDER BY last_at DESC`,
    [channelId]
  );
  return rows.map((r) => ({ topic: r.topic ?? "general", count: num(r.count), last_at: num(r.last_at) }));
}

// Todos los hilos del canal (mensajes raíz que tienen respuestas) — para no
// enterrarlos. Ordenados por actividad reciente.
// Hilos raíz de VARIOS canales en UNA query → el loader los adjunta a cada room
// para que el sidebar los muestre sin depender de haber visitado cada room.
export async function listThreadRootsForChannels(
  channelIds: number[]
): Promise<Map<number, Message[]>> {
  const out = new Map<number, Message[]>();
  if (!channelIds.length) return out;
  const ph = channelIds.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT m.*,
            (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count,
            (SELECT MAX(created_at) FROM gc_messages c WHERE c.parent_id = m.id) AS last_at
       FROM gc_messages m
      WHERE m.channel_id IN (${ph}) AND m.parent_id IS NULL
        AND EXISTS (SELECT 1 FROM gc_messages c WHERE c.parent_id = m.id)
      ORDER BY last_at DESC`,
    channelIds
  );
  for (const r of rows) {
    const m = toMessage(r);
    const arr = out.get(m.channel_id) ?? [];
    arr.push(m);
    out.set(m.channel_id, arr);
  }
  return out;
}

export async function listThreadRoots(channelId: number): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.*,
            (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count,
            (SELECT MAX(created_at) FROM gc_messages c WHERE c.parent_id = m.id) AS last_at
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL
        AND EXISTS (SELECT 1 FROM gc_messages c WHERE c.parent_id = m.id)
      ORDER BY last_at DESC`,
    [channelId]
  );
  return rows.map(toMessage);
}

// Borra un mensaje. Si es raíz de hilo, borra también sus respuestas.
export async function deleteMessage(id: number): Promise<void> {
  // Borra el mensaje + TODAS sus respuestas (hilo completo) sin dejar residuo: primero
  // las tablas satélite que referencian message_id (mientras las filas aún existen para
  // el subquery), luego los mensajes. Cubre attachments, reacciones, stars, pins y
  // artefactos del root y de cada respuesta.
  const scope = "message_id = ? OR message_id IN (SELECT id FROM gc_messages WHERE parent_id = ?)";
  for (const table of ["gc_attachments", "gc_reactions", "gc_stars", "gc_pins", "gc_artifacts"]) {
    await dbq(`DELETE FROM ${table} WHERE ${scope}`, [id, id]);
  }
  await dbq("DELETE FROM gc_messages WHERE id = ? OR parent_id = ?", [id, id]);
}

export async function getMessage(id: number): Promise<Message | null> {
  const rows = await dbq("SELECT * FROM gc_messages WHERE id = ?", [id]);
  return rows[0] ? toMessage(rows[0]) : null;
}

// Catch-up (lo que hace lossless el realtime): todos los mensajes del room con
// id > sinceId (flujo + respuestas de hilo), para rellenar huecos al reconectar.
export async function listMessagesSince(channelId: number, sinceId: number): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.*, (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.id > ?
      ORDER BY m.id ASC`,
    [channelId, sinceId]
  );
  return rows.map(toMessage);
}

// Un hilo: las respuestas de un mensaje.
export async function listThread(parentId: number): Promise<Message[]> {
  const rows = await dbq(
    "SELECT * FROM gc_messages WHERE parent_id = ? ORDER BY created_at ASC",
    [parentId]
  );
  return rows.map(toMessage);
}

export async function createMessage(input: {
  channelId: number;
  parentId: number | null;
  sender: string;
  senderSub?: string | null; // sub estable del autor (authz); null si no lo postea un user
  avatar?: string;
  body: string;
  agentHandle?: string | null; // qué agente fue mencionado (null = ninguno)
  topic?: string; // eje Zulip; las respuestas heredan el del root (lo resuelve chat.ts)
  quotedId?: number | null; // quote-reply: id + snapshot del mensaje citado
  quotedAuthor?: string | null;
  quotedExcerpt?: string | null;
}): Promise<{ id: number }> {
  const handle = input.agentHandle ?? null;
  const topic = (input.topic ?? "general").trim() || "general";
  const rows = await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, sender_sub, avatar, body, kind, mentions_ghosty, agent_handle, topic, quoted_id, quoted_author, quoted_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, 'msg', ?, ?, ?, ?, ?, ?) RETURNING id`,
    [input.channelId, input.parentId, input.sender, input.senderSub ?? null, input.avatar ?? "", input.body, handle ? 1 : 0, handle, topic, input.quotedId ?? null, input.quotedAuthor ?? null, input.quotedExcerpt ?? null]
  );
  return { id: num(rows[0].id) };
}

// Rastro de una quick-call (📞 inició → terminó) como mensaje kind:"status" (línea
// de sistema en el timeline, persistente). senderSub=null (evento de sistema).
// Devuelve el id para poder actualizar el body al colgar. Sirve para canal o DM.
export async function createCallStatus(
  scope: { channelId: number } | { dmId: number },
  sender: string,
  avatar: string,
  body: string
): Promise<{ id: number }> {
  const rows =
    "channelId" in scope
      ? await dbq(
          `INSERT INTO gc_messages (channel_id, parent_id, sender, sender_sub, avatar, body, kind, mentions_ghosty, topic)
           VALUES (?, NULL, ?, NULL, ?, ?, 'status', 0, 'general') RETURNING id`,
          [scope.channelId, sender, avatar, body]
        )
      : await dbq(
          `INSERT INTO gc_messages (channel_id, parent_id, sender, sender_sub, avatar, body, kind, mentions_ghosty, dm_id)
           VALUES (0, NULL, ?, NULL, ?, ?, 'status', 0, ?) RETURNING id`,
          [sender, avatar, body, scope.dmId]
        );
  return { id: num(rows[0].id) };
}

// Un agente postea (respuesta o status "pensando") en el mismo contexto.
// sender = nombre visible del agente; agentHandle marca el mensaje como suyo.
export async function postAgent(
  channelId: number,
  parentId: number | null,
  body: string,
  kind: "msg" | "status",
  agentHandle: string,
  sender: string,
  topic = "general", // hereda el topic del root del hilo (lo pasa chat.ts)
  avatar = "" // avatar del agente → se ve en el chat
): Promise<{ id: number }> {
  const rows = await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, avatar, body, kind, mentions_ghosty, agent_handle, topic)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
    [channelId, parentId, sender, avatar, body, kind, agentHandle, topic]
  );
  return { id: num(rows[0].id) };
}

// ── Mensajes directos (DMs) ─────────────────────────────────────────────────
// Referencia Zulip: sección "Direct messages" por participantes, 1:1 y grupos.
// Reusamos gc_messages con dm_id (channel_id = 0 centinela → nunca se filtra a un
// room real, porque listChannelFlow/listMessagesSince filtran por channel_id real).
export type DmConversation = {
  id: number;
  is_group: number;
  title: string | null;
  last_at: number | null;
  members: MemberInfo[]; // los OTROS (excluye al usuario actual)
  agent_handle: string | null; // DM 1:1 con un agente de la flota (null = entre personas)
};

// Abre (o reusa) una conversación con estos subs. member_key = subs ordenados →
// dedupe 1:1 y grupos. Idempotente/carrera-safe vía UNIQUE(member_key).
export async function openDmConversation(subs: string[], createdBy: string): Promise<number> {
  const unique = [...new Set(subs.filter(Boolean))].sort();
  if (unique.length < 2) throw new Error("un DM necesita al menos 2 participantes");
  const key = unique.join(",");
  await dbq(
    `INSERT INTO gc_dm_conversations (is_group, created_by, member_key)
     VALUES (?, ?, ?) ON CONFLICT(member_key) DO NOTHING`,
    [unique.length > 2 ? 1 : 0, createdBy, key]
  );
  const rows = await dbq("SELECT id FROM gc_dm_conversations WHERE member_key = ?", [key]);
  const id = num(rows[0].id);
  for (const s of unique) {
    await dbq(
      "INSERT INTO gc_dm_members (conversation_id, user_sub) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [id, s]
    );
  }
  return id;
}

// Conversaciones del usuario, con los OTROS participantes y la última actividad,
// ordenadas por reciente (las vacías al final).
export async function listDmConversations(userSub: string): Promise<DmConversation[]> {
  const convs = await dbq(
    `SELECT c.id, c.is_group, c.title, c.agent_handle,
            (SELECT MAX(created_at) FROM gc_messages m WHERE m.dm_id = c.id) AS last_at
       FROM gc_dm_conversations c
       JOIN gc_dm_members mm ON mm.conversation_id = c.id
      WHERE mm.user_sub = ?
      ORDER BY last_at DESC`,
    [userSub]
  );
  if (!convs.length) return [];
  const ids = convs.map((r) => num(r.id));
  const ph = ids.map(() => "?").join(",");
  const memberRows = await dbq(
    `SELECT dm.conversation_id, u.sub, u.name, u.email, u.avatar
       FROM gc_dm_members dm JOIN gc_users u ON u.sub = dm.user_sub
      WHERE dm.conversation_id IN (${ph})`,
    ids
  );
  const byConv = new Map<number, MemberInfo[]>();
  for (const r of memberRows) {
    if (r.sub === userSub) continue; // solo los otros
    const cid = num(r.conversation_id);
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sub: r.sub!, name: r.name ?? "", email: r.email ?? "", avatar: r.avatar ?? "" });
  }
  // DMs de agente: el "otro" es un agente (no un gc_user) → resolvemos su name/avatar de
  // gc_agents para que la UI lo muestre como miembro sintético, sin cambios en el render.
  const agentHandles = [...new Set(convs.map((r) => r.agent_handle).filter(Boolean))] as string[];
  const agentByHandle = new Map<string, { name: string; avatar: string }>();
  if (agentHandles.length) {
    const ph2 = agentHandles.map(() => "?").join(",");
    const arows = await dbq(`SELECT handle, name, avatar FROM gc_agents WHERE handle IN (${ph2})`, agentHandles);
    for (const a of arows) agentByHandle.set(a.handle!, { name: a.name ?? a.handle!, avatar: a.avatar ?? "" });
  }
  return convs.map((r) => {
    const handle = r.agent_handle ?? null;
    const members = handle
      ? [{
          sub: `agent:${handle}`,
          name: agentByHandle.get(handle)?.name ?? (handle === "ghosty" ? "Ghosty" : handle),
          email: "",
          avatar: agentByHandle.get(handle)?.avatar ?? "",
        }]
      : byConv.get(num(r.id)) ?? [];
    return {
      id: num(r.id),
      is_group: num(r.is_group),
      title: r.title,
      last_at: r.last_at == null ? null : num(r.last_at),
      members,
      agent_handle: handle,
    };
  });
}

// Abre (o reusa) un DM 1:1 con un AGENTE de la flota. member_key único por (user, agente)
// → no colisiona con DMs entre personas. Guarda agent_handle → cada mensaje enruta al agente.
export async function openAgentDm(agentHandle: string, createdBy: string): Promise<number> {
  const key = `agent:${createdBy}:${agentHandle}`;
  await dbq(
    `INSERT INTO gc_dm_conversations (is_group, created_by, member_key, agent_handle)
     VALUES (0, ?, ?, ?) ON CONFLICT(member_key) DO NOTHING`,
    [createdBy, key, agentHandle]
  );
  const rows = await dbq("SELECT id FROM gc_dm_conversations WHERE member_key = ?", [key]);
  const id = num(rows[0].id);
  await dbq(
    "INSERT INTO gc_dm_members (conversation_id, user_sub) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [id, createdBy]
  );
  return id;
}

// El agent_handle de un DM (null = entre personas). Para enrutar cada mensaje al agente.
export async function getDmAgentHandle(convId: number): Promise<string | null> {
  const rows = await dbq("SELECT agent_handle FROM gc_dm_conversations WHERE id = ?", [convId]);
  return rows[0]?.agent_handle ?? null;
}

export async function getDmMembers(convId: number): Promise<string[]> {
  const rows = await dbq("SELECT user_sub FROM gc_dm_members WHERE conversation_id = ?", [convId]);
  return rows.map((r) => r.user_sub!);
}

export async function isDmMember(convId: number, userSub: string): Promise<boolean> {
  const rows = await dbq(
    "SELECT 1 FROM gc_dm_members WHERE conversation_id = ? AND user_sub = ?",
    [convId, userSub]
  );
  return rows.length > 0;
}

// El flujo de un DM: sus mensajes (planos, sin hilos). channel_id = 0 los aísla.
export async function listDmFlow(dmId: number): Promise<Message[]> {
  const rows = await dbq(
    "SELECT * FROM gc_messages WHERE dm_id = ? ORDER BY created_at ASC",
    [dmId]
  );
  return rows.map(toMessage);
}

export async function createDmMessage(input: {
  dmId: number;
  sender: string;
  senderSub?: string | null; // sub estable del autor (authz); null si no lo postea un user
  avatar?: string;
  body: string;
  agentHandle?: string | null;
  quotedId?: number | null; // quote-reply (mismo snapshot que en rooms)
  quotedAuthor?: string | null;
  quotedExcerpt?: string | null;
}): Promise<{ id: number }> {
  const handle = input.agentHandle ?? null;
  const rows = await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, sender_sub, avatar, body, kind, mentions_ghosty, agent_handle, dm_id, quoted_id, quoted_author, quoted_excerpt)
     VALUES (0, NULL, ?, ?, ?, ?, 'msg', ?, ?, ?, ?, ?, ?) RETURNING id`,
    [input.sender, input.senderSub ?? null, input.avatar ?? "", input.body, handle ? 1 : 0, handle, input.dmId, input.quotedId ?? null, input.quotedAuthor ?? null, input.quotedExcerpt ?? null]
  );
  return { id: num(rows[0].id) };
}

// Un agente postea (status "pensando" o respuesta) dentro de un DM.
export async function postDmAgent(
  dmId: number,
  body: string,
  kind: "msg" | "status",
  agentHandle: string,
  sender: string,
  avatar = ""
): Promise<{ id: number }> {
  const rows = await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, avatar, body, kind, mentions_ghosty, agent_handle, dm_id)
     VALUES (0, NULL, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
    [sender, avatar, body, kind, agentHandle, dmId]
  );
  return { id: num(rows[0].id) };
}

// Borra los "pensando…" del DM y devuelve sus ids (para message:deleted sin revalidar).
export async function clearDmStatus(dmId: number): Promise<number[]> {
  const rows = await dbq("DELETE FROM gc_messages WHERE dm_id = ? AND kind = 'status' RETURNING id", [dmId]);
  return rows.map((r) => num(r.id));
}

// ── No-leídos / read-state (Fase 1.5) ───────────────────────────────────────
// gc_reads(user_sub, scope, scope_id, last_read_at): marca hasta cuándo el usuario
// leyó cada scope. Unread = mensajes 'msg' con created_at > last_read_at. El badge
// del room cuenta el flujo top-level (parent_id NULL, lo que se ve); el del DM,
// todos sus mensajes. Los 'status' (pensando…) son efímeros y NO cuentan.

export type UnreadCount = { id: number; unread: number };

// Cuenta no-leídos de TODOS los rooms del usuario en UNA query (no por-room).
export async function unreadByRoom(userSub: string): Promise<UnreadCount[]> {
  const rows = await dbq(
    `SELECT m.channel_id AS id, COUNT(*) AS unread
       FROM gc_messages m
       LEFT JOIN gc_reads r
         ON r.user_sub = ? AND r.scope = 'room' AND r.scope_id = CAST(m.channel_id AS TEXT)
      WHERE m.dm_id IS NULL AND m.parent_id IS NULL AND m.kind = 'msg'
        AND m.created_at > COALESCE(r.last_read_at, 0)
        AND NOT EXISTS (SELECT 1 FROM gc_mutes mu
              WHERE mu.user_sub = ? AND mu.scope = 'room'
                AND mu.scope_id = CAST(m.channel_id AS TEXT))
      GROUP BY m.channel_id`,
    [userSub, userSub]
  );
  return rows.map((r) => ({ id: num(r.id), unread: num(r.unread) }));
}

// Cuenta no-leídos de los DMs del usuario en UNA query.
export async function unreadByDm(userSub: string): Promise<UnreadCount[]> {
  const rows = await dbq(
    `SELECT m.dm_id AS id, COUNT(*) AS unread
       FROM gc_messages m
       JOIN gc_dm_members dm ON dm.conversation_id = m.dm_id AND dm.user_sub = ?
       LEFT JOIN gc_reads r
         ON r.user_sub = ? AND r.scope = 'dm' AND r.scope_id = CAST(m.dm_id AS TEXT)
      WHERE m.dm_id IS NOT NULL AND m.kind = 'msg'
        AND m.created_at > COALESCE(r.last_read_at, 0)
        AND NOT EXISTS (SELECT 1 FROM gc_mutes mu
              WHERE mu.user_sub = ? AND mu.scope = 'dm'
                AND mu.scope_id = CAST(m.dm_id AS TEXT))
      GROUP BY m.dm_id`,
    [userSub, userSub, userSub]
  );
  return rows.map((r) => ({ id: num(r.id), unread: num(r.unread) }));
}

// Marca un scope como leído hasta AHORA (idempotente; nunca retrocede).
// last_read_at (segundos) del usuario para un scope, o 0 si nunca lo leyó.
// Capturado ANTES de marcar leído → sirve de frontera para el divisor "nuevos".
export async function getLastRead(
  userSub: string,
  scope: "room" | "dm",
  scopeId: number
): Promise<number> {
  const rows = await dbq(
    `SELECT last_read_at FROM gc_reads WHERE user_sub = ? AND scope = ? AND scope_id = ?`,
    [userSub, scope, String(scopeId)]
  );
  return rows.length ? num(rows[0].last_read_at) : 0;
}

export async function markRead(userSub: string, scope: "room" | "dm", scopeId: number): Promise<void> {
  await dbq(
    `INSERT INTO gc_reads (user_sub, scope, scope_id, last_read_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_sub, scope, scope_id)
       DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    [userSub, scope, String(scopeId)]
  );
}

// ── Novedades / anuncios ("What's New") — SET de vistas per-usuario ──────────
// El CONTENIDO de las novedades es GLOBAL y vive en gs (control-plane, modelo
// Announcement). Aquí guardamos el SET de ids (cuid de gs) que el usuario YA VIO. La
// galería en Teams muestra las publicadas que NO estén en el set.
export async function getSeenAnnouncementIds(userSub: string): Promise<string[]> {
  const rows = await dbq(
    "SELECT announcement_id FROM gt_announcement_seen WHERE user_sub = ?",
    [userSub]
  );
  return rows.map((r) => r.announcement_id!).filter(Boolean);
}

// Marca vista UNA novedad (idempotente). Se llama al pasar cada card de la galería.
export async function markAnnouncementSeen(userSub: string, id: string): Promise<void> {
  await dbq(
    `INSERT INTO gt_announcement_seen (user_sub, announcement_id)
     VALUES (?, ?) ON CONFLICT(user_sub, announcement_id) DO NOTHING`,
    [userSub, id]
  );
}

// Reset: olvida TODO lo visto por un usuario (las novedades le vuelven a salir).
export async function resetAnnouncementsSeen(userSub: string): Promise<void> {
  await dbq("DELETE FROM gt_announcement_seen WHERE user_sub = ?", [userSub]);
}

// ── Emojis custom del workspace (Fase 4) ────────────────────────────────────
// Imágenes en EasyBits (guardamos file_id); se reaccionan como `:name:` y se
// renderizan vía /api/attachment/:file_id. Nombre normalizado (a-z0-9_).
export type CustomEmoji = { name: string; file_id: string; created_by?: string | null };
export async function listCustomEmojis(): Promise<CustomEmoji[]> {
  const rows = await dbq("SELECT name, file_id, created_by FROM gc_emojis ORDER BY name").catch(() => [] as Row[]);
  return rows.map((r) => ({ name: r.name!, file_id: r.file_id!, created_by: (r.created_by as string | null) ?? null }));
}
// Autor de un emoji (para authz de borrado: owner o quien lo creó). null si no existe.
export async function getCustomEmojiCreator(name: string): Promise<string | null> {
  const rows = await dbq("SELECT created_by FROM gc_emojis WHERE name = ?", [name]);
  return (rows[0]?.created_by as string | null) ?? null;
}
export async function addCustomEmoji(name: string, fileId: string, createdBy: string): Promise<void> {
  await dbq(
    `INSERT INTO gc_emojis (name, file_id, created_by) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET file_id = excluded.file_id`,
    [name, fileId, createdBy]
  );
}
export async function removeCustomEmoji(name: string): Promise<string | null> {
  const rows = await dbq("SELECT file_id FROM gc_emojis WHERE name = ?", [name]);
  const fileId = rows[0]?.file_id ?? null;
  await dbq("DELETE FROM gc_emojis WHERE name = ?", [name]);
  return fileId;
}

// Read receipts (Fase 4): quién ha leído hasta un mensaje. Un usuario "leyó" el
// mensaje si su last_read_at del scope es >= created_at del mensaje. Reusa gc_reads
// (no hay tabla nueva). Devuelve los lectores ordenados por recencia de lectura.
export type ReadReceipt = { sub: string; name: string; avatar: string; at: number };
export async function listReadReceipts(
  scope: "room" | "dm",
  scopeId: number,
  createdAt: number
): Promise<ReadReceipt[]> {
  const rows = await dbq(
    `SELECT u.sub, u.name, u.avatar, r.last_read_at
       FROM gc_reads r JOIN gc_users u ON u.sub = r.user_sub
      WHERE r.scope = ? AND r.scope_id = ? AND r.last_read_at >= ?
      ORDER BY r.last_read_at DESC`,
    [scope, String(scopeId), createdAt]
  );
  return rows.map((r) => ({
    sub: r.sub!,
    name: r.name ?? "",
    avatar: r.avatar ?? "",
    at: num(r.last_read_at),
  }));
}

// Borra los "pensando…" (status) de un contexto — al llegar la respuesta real.
// handle opcional: con multi-agente, cada agente limpia SOLO su propio "pensando…"
// (si no, el reply de uno borraría el status de los demás en el mismo hilo).
// Borra los "pensando…" (kind:"status") y devuelve sus ids → el caller emite
// message:deleted para que el cliente los quite SIN revalidar (un revalidate a
// media corriente pisaría los deltas del streaming con el body aún vacío del DB).
export async function clearStatus(
  channelId: number,
  parentId: number | null,
  agentHandle?: string
): Promise<number[]> {
  const hFilter = agentHandle ? " AND agent_handle = ?" : "";
  const hArg = agentHandle ? [agentHandle] : [];
  const rows =
    parentId == null
      ? await dbq(
          `DELETE FROM gc_messages WHERE channel_id = ? AND parent_id IS NULL AND kind = 'status'${hFilter} RETURNING id`,
          [channelId, ...hArg]
        )
      : await dbq(
          `DELETE FROM gc_messages WHERE channel_id = ? AND parent_id = ? AND kind = 'status'${hFilter} RETURNING id`,
          [channelId, parentId, ...hArg]
        );
  return rows.map((r) => num(r.id));
}
