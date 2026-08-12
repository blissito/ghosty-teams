// Estado en EasyBits DB (libSQL) — modelo Slack: canal = flujo, threads nacen
// de un mensaje (parent_id). Compute stateless, historial durable.
import { dbq, dbqMany, num, type Row } from "./dbq.server";

export type Channel = {
  id: number;
  slug: string;
  name: string;
  is_private: number;
  icon: string | null;
  description?: string | null;
  archived?: number;
  created_by?: string | null;
  // Evento abierto: la comunidad entra por liga sin cuenta ni asiento. Ver
  // "salas de evento" en schema.server.ts. `public_access` NO es `is_private=0`:
  // ese cero es "todo el workspace", esto es "internet".
  call_mode?: "webinar" | "taller" | null;
  call_share_slug?: string | null;
  call_livekit_url?: string | null;
  call_title?: string | null;
  public_access?: number;
  agent_enabled?: number;
  /** Desde cuándo es público. El camino público NO sirve nada anterior a esto. */
  public_since?: number | null;
  /** ¿La sala de video está abierta a la comunidad? Lo decide el dueño. */
  call_open?: number;
  /** Cuándo empieza el evento (epoch UTC). NULL = siempre abierto, sin hora. */
  starts_at?: number | null;
  /** La grabación ya subida a storage, y cuándo se grabó. */
  call_recording_url?: string | null;
  call_recorded_at?: number | null;
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
    call_mode: (r.call_mode as Channel["call_mode"]) ?? null,
    call_share_slug: r.call_share_slug ?? null,
    call_livekit_url: r.call_livekit_url ?? null,
    call_title: r.call_title ?? null,
    public_access: num(r.public_access),
    agent_enabled: num(r.agent_enabled),
    public_since: r.public_since == null ? null : num(r.public_since),
    call_open: num(r.call_open),
    starts_at: r.starts_at == null ? null : num(r.starts_at),
    call_recording_url: r.call_recording_url ?? null,
    call_recorded_at: r.call_recorded_at == null ? null : num(r.call_recorded_at),
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
export type ReactionAgg = { emoji: string; count: number; mine: boolean; subs: string[] };
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
  forwarded_from?: string | null; // reenviado: autor original (rótulo "Reenviado")
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
  waveform?: string | null;    // nota de voz: 64 amplitudes (0..100) en base64 → onda PTT
  duration_ms?: number | null; // nota de voz: duración en ms → "0:12"
};

// Artefacto: doc/pdf/imagen que el agente genera y se abre en el panel del room.
// kind gatea el modo del panel: "html" (editor colab embebido), "pdf", "image".
export type Artifact = {
  id: number;
  messageId: number; // mensaje ancla en gc_artifacts → guardado de ediciones del Canvas
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
    forwarded_from: (r.forwarded_from as string | null) ?? null,
  };
}

// Marca un mensaje como REENVIADO (guarda el autor original) — lo usa el forward al copiar.
export async function setForwardedFrom(messageId: number, originalAuthor: string): Promise<void> {
  await dbq("UPDATE gc_messages SET forwarded_from = ? WHERE id = ?", [originalAuthor, messageId]);
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
  const byMsg = new Map<number, Map<string, { count: number; mine: boolean; subs: string[] }>>();
  for (const r of rows) {
    const mid = num(r.message_id);
    const emoji = r.emoji!;
    if (!byMsg.has(mid)) byMsg.set(mid, new Map());
    const em = byMsg.get(mid)!;
    const cur = em.get(emoji) ?? { count: 0, mine: false, subs: [] };
    cur.count++;
    if (r.user_sub === userSub) cur.mine = true;
    if (r.user_sub) cur.subs.push(r.user_sub); // quién reaccionó → tooltip de hover
    em.set(emoji, cur);
  }
  return msgs.map((m) => {
    const em = byMsg.get(m.id);
    if (!em) return m;
    return { ...m, reactions: [...em.entries()].map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine, subs: v.subs })) };
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
/**
 * Busca en los rooms visibles. Con `threadRootId`, sólo dentro de ESE hilo.
 *
 * ⚠️ Antes esto filtraba `AND m.parent_id IS NULL` "para que el resultado exista en el
 * flujo" — o sea que TODA respuesta dentro de un hilo era invisible al buscador. Justo
 * donde vive el trabajo largo (un contrato revisado a lo largo de 20 mensajes) no se podía
 * buscar nada. Se quitó el 2026-07-31; los hits de hilo se abren en su hilo.
 *
 * Un hilo NO tiene columna propia: es `parent_id = <id del mensaje raíz>`, y la raíz misma
 * se incluye por `id` (índice `gc_messages(parent_id)`).
 */
export async function searchRoomMessages(
  channelIds: number[],
  q: string,
  opts?: { threadRootId?: number }
): Promise<RoomHit[]> {
  if (!channelIds.length || !q.trim()) return [];
  const ph = channelIds.map(() => "?").join(",");
  const root = opts?.threadRootId;
  const rows = await dbq(
    `SELECT m.*, ch.slug AS _slug, ch.name AS _rname
       FROM gc_messages m JOIN gc_channels ch ON ch.id = m.channel_id
      WHERE m.kind = 'msg' AND m.dm_id IS NULL
        AND m.channel_id IN (${ph}) AND m.body LIKE ? ESCAPE '\\'
        ${root ? "AND (m.parent_id = ? OR m.id = ?)" : ""}
      ORDER BY m.created_at DESC LIMIT 40`,
    root ? [...channelIds, likeArg(q), root, root] : [...channelIds, likeArg(q)]
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
    `SELECT id, message_id, file_id, mime, size, name, thumb_file_id, width, height, waveform, duration_ms FROM gc_attachments
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
      waveform: (r.waveform as string | null) ?? null,
      duration_ms: r.duration_ms == null ? null : num(r.duration_ms),
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
  files: { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null; waveform?: string | null; durationMs?: number | null }[]
): Promise<void> {
  for (const f of files) {
    await dbq(
      `INSERT INTO gc_attachments (message_id, file_id, mime, size, name, thumb_file_id, width, height, waveform, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, f.fileId, f.mime, f.size, f.name, f.thumbFileId ?? null, f.width ?? null, f.height ?? null, f.waveform ?? null, f.durationMs ?? null]
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
      messageId: num(r.message_id),
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
// ── Memoria del agente por conversación ─────────────────────────────────────────
// Ver el comentario de `gt_agent_memory` en schema.server.ts para el porqué del alcance.

export type AgentNote = { id: number; note: string; createdBy: string | null; updatedAt: number };

/**
 * Clave de alcance. Por ROOM o DM, nunca por hilo.
 *
 * La excepción es `memoryScope`, que pisa a los dos: un hilo de WhatsApp vive DENTRO de un
 * room pero es la conversación de un contacto. Sin él, el agente mezclaría a ese cliente con
 * los demás contactos del número y con lo que el equipo habla en el room.
 */
export function memoryScopeKey(d: { channelId?: number | null; dmId?: number | null; memoryScope?: string | null }): string | null {
  if (d.memoryScope) return d.memoryScope;
  if (d.dmId != null) return `dm:${d.dmId}`;
  if (d.channelId != null) return `ch:${d.channelId}`;
  return null;
}

/**
 * Topes de la memoria. Existen porque las notas se inyectan en el texto de CADA turno: sin
 * techo, la memoria se convierte con el tiempo en un impuesto de contexto que nadie ve.
 * Al llegar al límite se FALLA con un mensaje útil en vez de podar en silencio — perder una
 * convención sin avisar es peor que negarse a guardar la siguiente.
 */
export const MEMORY_MAX_NOTES = 40;
export const MEMORY_MAX_CHARS = 240;

export async function listAgentMemory(scopeKey: string, handle: string): Promise<AgentNote[]> {
  const rows = await dbq(
    `SELECT id, note, created_by, updated_at FROM gt_agent_memory
       WHERE scope_key = ? AND agent_handle = ? ORDER BY id ASC`,
    [scopeKey, handle]
  );
  return rows.map((r) => ({
    id: num(r.id),
    note: String(r.note ?? ""),
    createdBy: (r.created_by as string | null) ?? null,
    updatedAt: num(r.updated_at),
  }));
}

export async function addAgentMemory(
  scopeKey: string,
  handle: string,
  note: string,
  createdBy: string | null
): Promise<number> {
  const rows = await dbq(
    `INSERT INTO gt_agent_memory (scope_key, agent_handle, note, created_by)
       VALUES (?, ?, ?, ?) RETURNING id`,
    [scopeKey, handle, note, createdBy]
  );
  return num(rows[0]?.id);
}

/** El scope va en el WHERE: un id no debe poder editar la nota de otra conversación. */
export async function updateAgentMemory(
  id: number,
  scopeKey: string,
  handle: string,
  note: string
): Promise<boolean> {
  const rows = await dbq(
    `UPDATE gt_agent_memory SET note = ?, updated_at = unixepoch()
       WHERE id = ? AND scope_key = ? AND agent_handle = ? RETURNING id`,
    [note, id, scopeKey, handle]
  );
  return rows.length > 0;
}

export async function deleteAgentMemory(id: number, scopeKey: string, handle: string): Promise<boolean> {
  const rows = await dbq(
    `DELETE FROM gt_agent_memory WHERE id = ? AND scope_key = ? AND agent_handle = ? RETURNING id`,
    [id, scopeKey, handle]
  );
  return rows.length > 0;
}

// ── Memoria del WORKSPACE ───────────────────────────────────────────────────────
// Misma tabla, alcance 'ws': hechos de la empresa compartidos entre rooms y agentes
// (agent_handle=''). Con título porque al turno sólo viaja el ÍNDICE (título + hook)
// y el agente lee la nota completa con memory_read — patrón MEMORY.md/DESCTI.

export const WS_MEMORY_SCOPE = "ws";
export const WS_MEMORY_MAX_NOTES = 200;
export const WS_MEMORY_MAX_CHARS = 600;
export const WS_MEMORY_TITLE_MAX = 80;

export type WorkspaceNote = {
  id: number;
  title: string;
  note: string;
  createdBy: string | null;
  sourceRef: string | null;
  updatedAt: number;
};

function rowToWorkspaceNote(r: Row): WorkspaceNote {
  return {
    id: num(r.id),
    title: String(r.title ?? ""),
    note: String(r.note ?? ""),
    createdBy: (r.created_by as string | null) ?? null,
    sourceRef: (r.source_ref as string | null) ?? null,
    updatedAt: num(r.updated_at),
  };
}

export async function listWorkspaceMemory(): Promise<WorkspaceNote[]> {
  const rows = await dbq(
    `SELECT id, title, note, created_by, source_ref, updated_at FROM gt_agent_memory
       WHERE scope_key = ? ORDER BY id ASC`,
    [WS_MEMORY_SCOPE]
  );
  return rows.map(rowToWorkspaceNote);
}

export async function getWorkspaceMemory(id: number): Promise<WorkspaceNote | null> {
  const rows = await dbq(
    `SELECT id, title, note, created_by, source_ref, updated_at FROM gt_agent_memory
       WHERE id = ? AND scope_key = ?`,
    [id, WS_MEMORY_SCOPE]
  );
  return rows.length ? rowToWorkspaceNote(rows[0]) : null;
}

export async function addWorkspaceMemory(
  title: string,
  note: string,
  createdBy: string | null,
  sourceRef: string | null = null
): Promise<number> {
  const rows = await dbq(
    `INSERT INTO gt_agent_memory (scope_key, agent_handle, title, note, created_by, source_ref)
       VALUES (?, '', ?, ?, ?, ?) RETURNING id`,
    [WS_MEMORY_SCOPE, title, note, createdBy, sourceRef]
  );
  return num(rows[0]?.id);
}

export async function updateWorkspaceMemory(
  id: number,
  fields: { title?: string; note?: string; sourceRef?: string }
): Promise<boolean> {
  const sets: string[] = ["updated_at = unixepoch()"];
  const args: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    args.push(fields.title);
  }
  if (fields.note !== undefined) {
    sets.push("note = ?");
    args.push(fields.note);
  }
  if (fields.sourceRef !== undefined) {
    sets.push("source_ref = ?");
    args.push(fields.sourceRef);
  }
  const rows = await dbq(
    `UPDATE gt_agent_memory SET ${sets.join(", ")} WHERE id = ? AND scope_key = ? RETURNING id`,
    [...args, id, WS_MEMORY_SCOPE]
  );
  return rows.length > 0;
}

export async function deleteWorkspaceMemory(id: number): Promise<boolean> {
  const rows = await dbq(
    `DELETE FROM gt_agent_memory WHERE id = ? AND scope_key = ? RETURNING id`,
    [id, WS_MEMORY_SCOPE]
  );
  return rows.length > 0;
}

// ── Documentos fuente de la memoria (gt_memory_docs) ────────────────────────────

export type MemoryDoc = {
  id: number;
  fileId: string;
  name: string;
  mime: string | null;
  size: number | null;
  dmId: number | null;
  uploadedBy: string | null;
  createdAt: number;
  noteCount: number;
};

export async function listMemoryDocs(): Promise<MemoryDoc[]> {
  const rows = await dbq(
    `SELECT d.id, d.file_id, d.name, d.mime, d.size, d.dm_id, d.uploaded_by, d.created_at,
            (SELECT COUNT(*) FROM gt_agent_memory m
              WHERE m.scope_key = '${WS_MEMORY_SCOPE}' AND m.source_ref = 'doc:' || d.id) AS note_count
       FROM gt_memory_docs d ORDER BY d.id DESC`
  );
  return rows.map((r) => ({
    id: num(r.id),
    fileId: String(r.file_id ?? ""),
    name: String(r.name ?? ""),
    mime: (r.mime as string | null) ?? null,
    size: r.size != null ? num(r.size) : null,
    dmId: r.dm_id != null ? num(r.dm_id) : null,
    uploadedBy: (r.uploaded_by as string | null) ?? null,
    createdAt: num(r.created_at),
    noteCount: num(r.note_count),
  }));
}

export async function addMemoryDoc(d: {
  fileId: string;
  name: string;
  mime: string | null;
  size: number | null;
  dmId: number | null;
  uploadedBy: string | null;
}): Promise<number> {
  const rows = await dbq(
    `INSERT INTO gt_memory_docs (file_id, name, mime, size, dm_id, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [d.fileId, d.name, d.mime, d.size, d.dmId, d.uploadedBy]
  );
  return num(rows[0]?.id);
}

export async function deleteMemoryDoc(id: number): Promise<boolean> {
  const rows = await dbq(`DELETE FROM gt_memory_docs WHERE id = ? RETURNING id`, [id]);
  return rows.length > 0;
}

export async function getMemoryDoc(id: number): Promise<MemoryDoc | null> {
  const all = await listMemoryDocs();
  return all.find((d) => d.id === id) ?? null;
}

/** Todas las notas de room/DM con la etiqueta de su conversación, para la curaduría en /memory. */
export type RoomNoteRow = {
  id: number;
  note: string;
  agentHandle: string;
  scopeKey: string;
  label: string;
  updatedAt: number;
};

export async function listAllRoomMemory(): Promise<RoomNoteRow[]> {
  const rows = await dbq(
    `SELECT m.id, m.note, m.agent_handle, m.scope_key, m.updated_at, c.slug AS channel_slug
       FROM gt_agent_memory m
       LEFT JOIN gc_channels c ON m.scope_key = 'ch:' || c.id
      WHERE m.scope_key != ? ORDER BY m.scope_key, m.id`,
    [WS_MEMORY_SCOPE]
  );
  return rows.map((r) => ({
    id: num(r.id),
    note: String(r.note ?? ""),
    agentHandle: String(r.agent_handle ?? ""),
    scopeKey: String(r.scope_key ?? ""),
    label: r.channel_slug ? `#${r.channel_slug}` : "DM",
    updatedAt: num(r.updated_at),
  }));
}

/**
 * La versión MÁS RECIENTE de un documento: su fila y si ya era una edición humana.
 *
 * Existe para que los guardados humanos consecutivos se escriban ENCIMA en vez de
 * insertar una fila cada vez. `pruneArtifactVersions` conserva 20 versiones por
 * documento, así que un autoguardado cada 2.5s se comía en un minuto todas las
 * versiones del agente — y por eso el autosave tenía un techo de una por minuto, que
 * dejaba a la persona escribiendo hasta 60s sin ninguna señal de guardado.
 */
export async function latestDocVersion(
  documentId: string
): Promise<{ id: number; messageId: number; title: string | null; humanEdited: boolean } | null> {
  const rows = await dbq(
    `SELECT id, md, message_id, title FROM gc_artifacts WHERE url = ? AND kind = 'doc' ORDER BY id DESC LIMIT 1`,
    [documentId]
  );
  if (!rows[0]) return null;
  const md = (rows[0].md as string | null) ?? "";
  // `messageId`/`title` los necesita el cierre de sesión de co-edición: publicar la
  // versión exige colgarla del MISMO mensaje, o el artefacto se desancla del hilo.
  return {
    id: num(rows[0].id),
    messageId: num(rows[0].message_id),
    title: (rows[0].title as string | null) ?? null,
    humanEdited: /"humanEdited"\s*:\s*true/.test(md),
  };
}

/** Reescribe el contenido de UNA versión (guardado humano sobre la suya). */
export async function overwriteArtifactMd(id: number, md: string): Promise<void> {
  await dbq(`UPDATE gc_artifacts SET md = ? WHERE id = ?`, [md, id]);
}

export async function createArtifact(
  messageId: number,
  a: {
    kind: string;
    url: string;
    title?: string | null;
    md?: string | null;
    src?: string | null;
    ownerSub?: string | null;
    /**
     * Quién tocó el documento en la sesión que produjo ESTA versión (`sub` de cada uno).
     * Sólo lo llena la co-edición: una versión del agente tiene un autor obvio, una
     * sesión de sala no — y "¿quién escribió esto?" empieza por aquí.
     */
    authors?: string[] | null;
  }
  // El id de la fila recién insertada. Es lo que deja al editor FIJAR la versión que
  // acaba de escribir: sin él, leer en voz alta o revisar la ortografía tenían que pedir
  // "la última", y en un hilo con dos documentos la última es el OTRO documento.
): Promise<number> {
  const rows = await dbq(
    `INSERT INTO gc_artifacts (message_id, kind, url, title, md, src, owner_sub, authors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      messageId,
      a.kind,
      a.url,
      a.title ?? null,
      a.md ?? null,
      a.src ?? null,
      a.ownerSub ?? null,
      a.authors?.length ? JSON.stringify(a.authors) : null,
    ]
  );
  return num(rows[0]?.id);
}

// ── Compartir: la RAÍZ del documento ────────────────────────────────────────────
// Cada publicación es una fila nueva con el mismo `url`, así que las columnas de
// compartir viven en la más VIEJA — es la única que sobrevive a las versiones.
// Espejo de getDoc(), que toma la más nueva.
export type ShareRoot = {
  id: number;
  url: string;
  title: string | null;
  ownerSub: string | null;
  visibility: "private" | "link";
  /** Qué puede hacer quien llega por el link. null histórico = "view". */
  role: DocRole;
  slug: string | null;
  sharedArtifactId: number | null;
};

/** Los tres niveles de acceso a un documento. Ordenados de menor a mayor. */
export type DocRole = "view" | "comment" | "edit";

export function toDocRole(v: unknown): DocRole {
  return v === "edit" || v === "comment" ? v : "view";
}

function toShareRoot(r: any): ShareRoot {
  return {
    id: num(r.id),
    url: r.url ?? "",
    title: r.title ?? null,
    ownerSub: r.owner_sub ?? r.msg_sender_sub ?? null,
    visibility: r.share_visibility === "link" ? "link" : "private",
    role: toDocRole(r.share_role),
    slug: r.share_slug ?? null,
    sharedArtifactId: r.shared_artifact_id != null ? num(r.shared_artifact_id) : null,
  };
}

const SHARE_ROOT_COLS = `a.id, a.url, a.title, a.owner_sub, a.share_visibility, a.share_role,
    a.share_slug, a.shared_artifact_id, m.sender_sub AS msg_sender_sub`;

export async function shareRootFor(documentId: string): Promise<ShareRoot | null> {
  const rows = await dbq(
    `SELECT ${SHARE_ROOT_COLS} FROM gc_artifacts a
      LEFT JOIN gc_messages m ON m.id = a.message_id
      WHERE a.url = ? ORDER BY a.id ASC LIMIT 1`,
    [documentId]
  );
  return rows[0] ? toShareRoot(rows[0]) : null;
}

export async function shareRootBySlug(slug: string): Promise<ShareRoot | null> {
  const rows = await dbq(
    `SELECT ${SHARE_ROOT_COLS} FROM gc_artifacts a
      LEFT JOIN gc_messages m ON m.id = a.message_id
      WHERE a.share_slug = ? LIMIT 1`,
    [slug]
  );
  return rows[0] ? toShareRoot(rows[0]) : null;
}

/**
 * ¿Puede ESTA conversación adoptar el artefacto de ese slug? Devuelve su documentId, o
 * null si no.
 *
 * Existe porque un artefacto sólo se podía editar en el hilo donde nació: pegar su link en
 * otra conversación no servía de nada. El agente lee la URL pública SIN sesión, así que
 * `resolveSharedArtifact` lo trata como visitante anónimo y un documento privado le
 * contesta 404 — correcto para "compartir hacia afuera", inútil para "sigue trabajando en
 * esto". Adoptarlo mueve el puntero del hilo (`setThreadArtifact`), y de ahí en adelante el
 * camino que ya existe re-inyecta el contenido al turno.
 *
 * DELIBERADAMENTE NO mira `share_visibility`: esa propiedad gobierna el enlace público, que
 * es otro problema. Acá la pregunta es de pertenencia, no de difusión.
 *
 * Permite en tres casos:
 *   · Quien pide es el DUEÑO del artefacto (`owner_sub`) — puede llevárselo donde quiera.
 *   · El artefacto NACIÓ EN ESTE ROOM (incluidos sus hilos, porque `gc_messages.channel_id`
 *     es el mismo). Quien postea en el room ya ve ese artefacto en el historial.
 *   · Quien pide es el DUEÑO DEL WORKSPACE. No es una excepción que abramos acá: en este
 *     producto el owner YA ve todos los rooms, incluidos los privados — ver `canSeeChannel`
 *     y `listChannels`, que hacen `is_private = 0 OR isOwner`. Omitirlo lo dejaría con
 *     menos acceso del que el resto de la app ya le concede.
 *
 * O sea que ninguna de las tres otorga un privilegio nuevo: sólo dejan adoptar lo que el
 * solicitante ya podía ver. Todo lo demás se niega — en particular un artefacto nacido en
 * un room privado ajeno pedido por alguien que no es dueño de nada.
 *
 * El aislamiento CROSS-TENANT no se comprueba acá porque es estructural: hay una base por
 * workspace (namespace por subdominio, ver dbq.server.ts), así que un slug de otro tenant
 * sencillamente no existe en esta consulta.
 */
export async function adoptableArtifact(
  slug: string,
  opts: { requesterSub: string | null; channelId?: number | null; isWorkspaceOwner?: boolean }
): Promise<string | null> {
  if (!slug) return null;
  const rows = await dbq(
    `SELECT a.url, a.owner_sub, m.channel_id FROM gc_artifacts a
       LEFT JOIN gc_messages m ON m.id = a.message_id
      WHERE a.share_slug = ? LIMIT 1`,
    [slug]
  );
  const r = rows[0];
  if (!r?.url) return null;

  if (opts.isWorkspaceOwner) return r.url;
  const esDueño = !!opts.requesterSub && r.owner_sub === opts.requesterSub;
  const nacióAquí =
    opts.channelId != null && r.channel_id != null && num(r.channel_id) === opts.channelId;

  return esDueño || nacióAquí ? r.url : null;
}

/**
 * Saca el slug de artefacto que venga en un mensaje: URL completa (con `?v=`), la ruta
 * `/artefacto/<slug>` suelta, o el slug pelado si el usuario copió sólo eso.
 *
 * Si hay varios, gana el ÚLTIMO: es el que la persona acaba de pegar, no el que quedó
 * arriba de una conversación larga.
 */
export function slugDeArtefactoEn(texto: string): string | null {
  if (!texto) return null;
  const encontrados = [...texto.matchAll(/\/artefacto\/([A-Za-z0-9_-]{6,})/g)].map((m) => m[1]);
  return encontrados.length ? encontrados[encontrados.length - 1]! : null;
}

// El documentId al que pertenece una key de storage (para que el link viejo
// /t3/<key> pueda mandarse a su página con permisos en vez de servir el HTML
// crudo). `src` se guardó como "<base>/<key sin el prefijo t3/>", así que el
// sufijo es lo estable entre las dos formas del link.
export async function documentIdForStorageKey(key: string): Promise<string | null> {
  const bare = key.replace(/^(?:t3\/)+/, "");
  if (!bare) return null;
  const rows = await dbq(
    `SELECT url FROM gc_artifacts WHERE kind = 'artifact' AND src LIKE ? ORDER BY id DESC LIMIT 1`,
    [`%${bare}`]
  );
  return rows[0]?.url ?? null;
}

export async function setShareOnRoot(
  rootId: number,
  patch: {
    visibility?: "private" | "link";
    slug?: string;
    sharedArtifactId?: number | null;
    /** Qué puede HACER quien llega por el link: ver, comentar o editar. */
    role?: DocRole;
  }
): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [];
  if (patch.visibility !== undefined) {
    sets.push("share_visibility = ?");
    args.push(patch.visibility);
  }
  if (patch.role !== undefined) {
    sets.push("share_role = ?");
    args.push(patch.role);
  }
  if (patch.slug !== undefined) {
    sets.push("share_slug = ?");
    args.push(patch.slug);
  }
  if (patch.sharedArtifactId !== undefined) {
    sets.push("shared_artifact_id = ?");
    args.push(patch.sharedArtifactId);
  }
  if (!sets.length) return;
  args.push(rootId);
  await dbq(`UPDATE gc_artifacts SET ${sets.join(", ")} WHERE id = ?`, args);
}

// Versiones de un documento, de la más vieja a la más nueva (Version 1 = la primera).
export type ArtifactVersion = {
  id: number;
  title: string | null;
  createdAt: number;
  /** `sub` de quienes co-editaron en la sesión que dejó esta versión. Vacío = versión del agente. */
  authors: string[];
};
/** `authors` es JSON en una columna nueva: una fila vieja (o corrupta) no debe romper el historial. */
function leerAutores(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function listArtifactVersions(documentId: string): Promise<ArtifactVersion[]> {
  const rows = await dbq(
    `SELECT id, title, created_at, authors FROM gc_artifacts
      WHERE url = ? AND md IS NOT NULL ORDER BY id ASC`,
    [documentId]
  );
  return rows.map((r: any) => ({
    id: num(r.id),
    title: r.title ?? null,
    createdAt: num(r.created_at),
    authors: leerAutores(r.authors),
  }));
}

/**
 * RETENCIÓN. Cada publicación deja una fila con el HTML completo MÁS un objeto en
 * el bucket, y el agente republica el artefacto entero en cada corrección — un
 * documento trabajado un rato deja decenas de copias que nadie va a abrir.
 *
 * Conserva las `keep` versiones más nuevas y devuelve el `src` de las que se
 * borraron para que el llamador tire también su objeto.
 *
 * Tres filas NUNCA se borran, y cada una por su razón:
 * - la RAÍZ (la más vieja), porque ahí viven las columnas de compartir;
 * - la CONGELADA (`shared_artifact_id`), porque es exactamente lo que el link
 *   compartido promete entregar;
 * - la ÚLTIMA, que es el documento vivo.
 */
export async function pruneArtifactVersions(
  documentId: string,
  keep = 20
): Promise<string[]> {
  const rows = await dbq(
    `SELECT id, src FROM gc_artifacts WHERE url = ? ORDER BY id ASC`,
    [documentId]
  );
  if (rows.length <= keep) return [];
  const root = await shareRootFor(documentId);
  const protectedIds = new Set<number>([
    num(rows[0].id),
    num(rows[rows.length - 1].id),
    ...(root?.sharedArtifactId ? [root.sharedArtifactId] : []),
  ]);
  // Las candidatas son las más VIEJAS por encima del cupo; las protegidas se saltan
  // sin consumir cupo (no vaya a ser que proteger la raíz borre una versión útil).
  const doomed = rows
    .filter((r: any) => !protectedIds.has(num(r.id)))
    .slice(0, Math.max(0, rows.length - keep));
  if (!doomed.length) return [];
  await dbq(
    `DELETE FROM gc_artifacts WHERE id IN (${doomed.map(() => "?").join(",")})`,
    doomed.map((r: any) => num(r.id))
  );
  return doomed.map((r: any) => r.src).filter((s: any): s is string => !!s);
}

// Una versión concreta (para servir la congelada en el link público).
export async function getArtifactVersion(
  id: number
): Promise<{ id: number; url: string; title: string | null; md: string | null; src: string | null; createdAt: number } | null> {
  const rows = await dbq(
    `SELECT id, url, title, md, src, created_at FROM gc_artifacts WHERE id = ? LIMIT 1`,
    [id]
  );
  const r = rows[0];
  return r
    ? {
        id: num(r.id),
        url: r.url ?? "",
        title: r.title ?? null,
        md: r.md ?? null,
        src: r.src ?? null,
        createdAt: num(r.created_at),
      }
    : null;
}

// Artefacto vivo ACTUAL (doc = markdown | sheet = csv) por su documentId local. Última
// versión gana. Es la verdad que se re-inyecta al agente al modificar → re-emite el
// artefacto completo con el cambio.
export async function getDoc(
  documentId: string
): Promise<{
  kind: "doc" | "sheet" | "artifact";
  md: string;
  src?: string | null;
  // Se devuelve porque quien recibe este objeto suele necesitar volver a nombrar el
  // documento (p.ej. para acuñar su enlace `/artefacto/<slug>`) y hasta hoy tenía que
  // arrastrar el id por separado desde el call site.
  documentId?: string;
  // Cuándo se publicó esta versión. Se devuelve para poder compararla contra la última
  // entrega de ARCHIVO del hilo (`gt_thread_delivery`): si el archivo es más nuevo, el
  // hint del turno no debe presentar este artefacto como "lo último que entregaste".
  at?: number;
  // Lo llena el CALL SITE (chat.ts / dm.ts) cuando esa comparación sale a favor del
  // archivo; `getDoc` nunca lo escribe. Vive en este tipo para que el objeto viaje entero
  // hasta `artifactDocHint` sin una firma extra en cuatro capas.
  lastFile?: { name: string; mime: string | null } | null;
} | null> {
  const rows = await dbq(
    `SELECT kind, md, src, created_at FROM gc_artifacts
      WHERE url = ? AND kind IN ('doc','sheet','artifact') AND md IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [documentId]
  );
  const r = rows[0];
  return r?.md
    ? { kind: r.kind as "doc" | "sheet" | "artifact", md: r.md, src: r.src ?? null, documentId, at: Number(r.created_at) }
    : null;
}

// Solo el contenido (para el export .docx del route). Delega en getDoc.
export async function getDocMarkdown(documentId: string): Promise<string | null> {
  return (await getDoc(documentId))?.md ?? null;
}

// ── Identidad conversacional del artefacto vivo (Fase 1 edit-in-place) ──────────
// conv_key → documentId del artefacto ACTUAL de la conversación.
//
// conv_key = `${channelId}:${parentId ?? "root"}` → documentId del artefacto ACTUAL.
//
// ⚠️ ES POR HILO, y NO se comparte con el room. Estuvo unas horas siendo `:root` fijo el
// 2026-08-03 y fue un error: al pasar al modelo Zulip se hizo del room la MEMORIA (bien:
// evita una sesión por mensaje) y de paso el DOCUMENTO (mal). Son cosas distintas — la
// memoria es lo que el agente recuerda; el documento es cuál artefacto se está editando,
// y ése pertenece a la conversación, no al canal.
//
// El daño fue inmediato y silencioso: un hilo NUEVO heredaba el documento de cualquier
// conversación anterior del room, así que el agente contestaba sobre un documento que
// nadie le había dado. Visto en vivo: le pidieron agregar un hecho a una denuncia recién
// subida y respondió que "ya está incorporado (bloques n18-n24)" — de otro documento.
//
// Con el modelo Zulip esto además ya no hace falta: el artefacto nace DENTRO del hilo
// (el mensaje del agente cuelga de la raíz), así que los turnos siguientes de ese hilo
// comparten `parentId` y encuentran su puntero. Y si no lo encontraran, el respaldo por
// `message_id` de `resolveThreadArtifact` los cubre.
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
/**
 * El artefacto que el agente debe considerar "el de esta conversación", resolviendo el
 * caso que rompía la edición: el artefacto nace en un mensaje del ROOM (conv_key
 * `<canal>:root`) y la charla sigue en el HILO de ese mensaje (`<canal>:<id>`), que no
 * tiene puntero. El agente se quedaba sin el HTML y pedía que se lo pegaran a mano —
 * justo lo que la edición quirúrgica vino a evitar.
 *
 * El puntero explícito manda. Si no hay, se busca el artefacto anclado al mensaje RAÍZ
 * del hilo o a cualquier mensaje dentro de él: eso es exacto (`gc_artifacts.message_id`),
 * no una adivinanza sobre el room entero.
 */
export async function resolveThreadArtifact(
  channelId: number,
  parentId?: number | null
): Promise<string | null> {
  const pointer = await getThreadArtifact(channelId, parentId);
  if (pointer) return pointer;
  if (parentId == null) return null;
  const rows = await dbq(
    `SELECT a.url FROM gc_artifacts a
       JOIN gc_messages m ON m.id = a.message_id
      WHERE (a.message_id = ? OR m.parent_id = ?)
        AND a.kind IN ('doc','sheet','artifact') AND a.md IS NOT NULL
      ORDER BY a.id DESC LIMIT 1`,
    [parentId, parentId]
  );
  return (rows[0]?.url as string) ?? null;
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

// ── Última entrega de ARCHIVO de la conversación ──────────────────────────────
// Un `eb-file` (PDF, .docx, .xlsx) NO es un artefacto y por eso no mueve
// `gc_thread_artifact`. Se registra aparte para que el hint del turno siguiente sepa que
// lo ÚLTIMO que se entregó fue un archivo y no el artefacto HTML viejo del hilo.
export type ThreadDelivery = { name: string; mime: string | null; at: number };

export async function getThreadDelivery(
  channelId: number,
  parentId?: number | null
): Promise<ThreadDelivery | null> {
  return deliveryByKey(convKey(channelId, parentId));
}
export async function setThreadDelivery(
  channelId: number,
  parentId: number | null | undefined,
  file: { name: string; mime?: string | null }
): Promise<void> {
  await setDeliveryByKey(convKey(channelId, parentId), file);
}
export async function getDmDelivery(dmId: number): Promise<ThreadDelivery | null> {
  return deliveryByKey(`dm:${dmId}`);
}
export async function setDmDelivery(dmId: number, file: { name: string; mime?: string | null }): Promise<void> {
  await setDeliveryByKey(`dm:${dmId}`, file);
}

async function deliveryByKey(key: string): Promise<ThreadDelivery | null> {
  const rows = await dbq("SELECT name, mime, updated_at FROM gt_thread_delivery WHERE conv_key = ?", [key]);
  const r = rows[0];
  return r ? { name: r.name as string, mime: (r.mime as string) ?? null, at: Number(r.updated_at) } : null;
}
async function setDeliveryByKey(key: string, file: { name: string; mime?: string | null }): Promise<void> {
  await dbq(
    `INSERT INTO gt_thread_delivery (conv_key, name, mime, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(conv_key) DO UPDATE SET name = excluded.name, mime = excluded.mime, updated_at = excluded.updated_at`,
    [key, file.name, file.mime ?? null]
  );
}

// Igual que get/setThreadArtifact pero para un DM (channel_id=0 colisiona en convKey → clave
// propia `dm:<id>`). Da IDENTIDAD al artefacto del DM: al modificarlo se reusa el MISMO
// documentId (nueva versión, misma card) en vez de crear un duplicado y regenerar de cero.
export async function getDmArtifact(dmId: number): Promise<string | null> {
  const rows = await dbq("SELECT document_id FROM gc_thread_artifact WHERE conv_key = ?", [`dm:${dmId}`]);
  return (rows[0]?.document_id as string) ?? null;
}
export async function setDmArtifact(dmId: number, documentId: string): Promise<void> {
  await dbq(
    `INSERT INTO gc_thread_artifact (conv_key, document_id, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(conv_key) DO UPDATE SET document_id = excluded.document_id, updated_at = excluded.updated_at`,
    [`dm:${dmId}`, documentId]
  );
}
// Suelta el artefacto vivo del DM. SOLO para el /clear EXPLÍCITO del usuario ("borrar
// memoria"): sin esto el puntero sobrevive al reset y el siguiente "hazme una landing"
// edita el documento ANTERIOR (nueva versión de la misma card) en vez de nacer limpio —
// el usuario cree que empezó de cero y no fue así. OJO: el reciclado AUTOMÁTICO de sesión
// del worker NO debe llamar esto; ahí el puntero es justo lo que preserva la identidad
// del artefacto (ver comentario en server/chat.ts sobre documentId).
export async function clearDmArtifact(dmId: number): Promise<void> {
  await dbq("DELETE FROM gc_thread_artifact WHERE conv_key = ?", [`dm:${dmId}`]);
}

// Enriquece un lote con TODO lo de display: reacciones + star/pin + adjuntos + artefacto.
export async function attachMeta(msgs: Message[], userSub: string): Promise<Message[]> {
  if (!msgs.length) return msgs;
  // UN SOLO round-trip para las 5 consultas de display (antes: 5 viajes SERIADOS al
  // sqld, cada uno con un IN(...) de TODOS los mensajes del room → el arranque de
  // `general` pagaba 5× la latencia sobre el historial completo).
  const ids = msgs.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const [reacRows, starRows, pinRows, attRows, artRows] = await dbqMany([
    { sql: `SELECT message_id, emoji, user_sub FROM gc_reactions WHERE message_id IN (${ph})`, args: ids },
    { sql: `SELECT message_id FROM gc_stars WHERE user_sub = ? AND message_id IN (${ph})`, args: [userSub, ...ids] },
    { sql: `SELECT message_id FROM gc_pins WHERE message_id IN (${ph})`, args: ids },
    { sql: `SELECT id, message_id, file_id, mime, size, name, thumb_file_id, width, height, waveform, duration_ms
              FROM gc_attachments WHERE message_id IN (${ph}) ORDER BY id`, args: ids },
    { sql: `SELECT id, message_id, kind, url, title, md, src FROM gc_artifacts
              WHERE message_id IN (${ph}) ORDER BY id`, args: ids },
  ]);

  const reactions = new Map<number, Map<string, { count: number; mine: boolean; subs: string[] }>>();
  for (const r of reacRows) {
    const mid = num(r.message_id);
    let em = reactions.get(mid);
    if (!em) { em = new Map(); reactions.set(mid, em); }
    const cur = em.get(r.emoji!) ?? { count: 0, mine: false, subs: [] };
    cur.count++;
    if (r.user_sub === userSub) cur.mine = true;
    if (r.user_sub) cur.subs.push(r.user_sub);
    em.set(r.emoji!, cur);
  }
  const starred = new Set(starRows.map((r) => num(r.message_id)));
  const pinned = new Set(pinRows.map((r) => num(r.message_id)));
  const atts = new Map<number, Attachment[]>();
  for (const r of attRows) {
    const mid = num(r.message_id);
    const arr = atts.get(mid) ?? [];
    if (!arr.length) atts.set(mid, arr);
    arr.push({
      id: num(r.id),
      file_id: r.file_id!,
      mime: r.mime ?? null,
      size: r.size == null ? null : num(r.size),
      name: r.name ?? null,
      thumb_file_id: (r.thumb_file_id as string | null) ?? null,
      width: r.width == null ? null : num(r.width),
      height: r.height == null ? null : num(r.height),
      waveform: (r.waveform as string | null) ?? null,
      duration_ms: r.duration_ms == null ? null : num(r.duration_ms),
    });
  }
  const arts = new Map<number, Artifact>();
  for (const r of artRows) {
    arts.set(num(r.message_id), {
      id: num(r.id),
      messageId: num(r.message_id),
      kind: r.kind!,
      url: r.url!,
      title: r.title ?? null,
      md: r.md ?? null,
      src: r.src ?? null,
    });
  }

  return msgs.map((m) => {
    const out: Message = { ...m, starred: starred.has(m.id), pinned: pinned.has(m.id) };
    const em = reactions.get(m.id);
    if (em) out.reactions = [...em.entries()].map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine, subs: v.subs }));
    const a = atts.get(m.id);
    if (a) out.attachments = a;
    const art = arts.get(m.id);
    if (art) out.artifact = art;
    return out;
  });
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
/** Qué produjo un turno: su artefacto (si lo hay) y cuántos archivos colgó. Una consulta cada uno. */
export async function turnOutcomeCounts(messageId: number): Promise<{ documentId: string | null; versions: number; files: number }> {
  const [art] = await dbq("SELECT url FROM gc_artifacts WHERE message_id = ? AND md IS NOT NULL ORDER BY id DESC LIMIT 1", [messageId]);
  const documentId = (art?.url as string | undefined) ?? null;
  // Las versiones de un documento son las filas que comparten `url` (identidad del documento).
  const versions = documentId
    ? Number((await dbq("SELECT COUNT(*) AS n FROM gc_artifacts WHERE url = ? AND md IS NOT NULL", [documentId]))[0]?.n ?? 1)
    : 0;
  const files = Number((await dbq("SELECT COUNT(*) AS n FROM gc_attachments WHERE message_id = ?", [messageId]))[0]?.n ?? 0);
  return { documentId, versions, files };
}

export async function setMessageBody(id: number, body: string): Promise<void> {
  // Escritura AUTORITATIVA → el mensaje deja de estar en streaming. Es lo que distingue un
  // turno terminado de uno que el proceso dejó a medias al reiniciarse.
  await dbq("UPDATE gc_messages SET body = ?, streaming = 0 WHERE id = ?", [body, id]);
}

/** Escritura PARCIAL del streaming (ver body-flush.server.ts). Marca el mensaje en vuelo. */
export async function setMessageBodyStreaming(id: number, body: string): Promise<void> {
  await dbq("UPDATE gc_messages SET body = ?, streaming = 1 WHERE id = ?", [body, id]);
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
  // Dónde corre este agente. NULL = filas viejas → cae al default del tenant.
  // Ver src/server/agent-runtime.server.ts.
  runtime: string | null;
  runtime_url: string | null;
  /** 1 → su groupId lleva el namespace del workspace. NULL = formato legacy. */
  group_ns: number | null;
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
    runtime: r.runtime ?? null,
    runtime_url: r.runtime_url ?? null,
    group_ns: r.group_ns == null ? null : num(r.group_ns),
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
  /** Dónde va a correr. Lo estampa el camino de alta que lo creó. */
  runtime?: string | null;
  runtimeUrl?: string | null;
  /** Los agentes nuevos nacen con la clave namespaceada; ver agentGroupId. */
  groupNs?: boolean;
}): Promise<Agent> {
  const handle = slugify(input.handle).replace(/-/g, "");
  const rows = await dbq(
    `INSERT INTO gc_agents (handle, name, kind, fleet_id, fleet_token, webhook_url, avatar, system_prompt, created_by, runtime, runtime_url, group_ns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      input.runtime ?? null,
      input.runtimeUrl ?? null,
      input.groupNs ? 1 : null,
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

// `user_sub` viaja de vuelta porque el badge del ícono del PWA es POR PERSONA
// (su total de no-leídos), no por suscripción — ver deliverWebPush.
export type StoredPushSub = { endpoint: string; p256dh: string; auth: string; user_sub: string };
export async function listPushSubsForUsers(subs: string[]): Promise<StoredPushSub[]> {
  if (!subs.length) return [];
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT endpoint, p256dh, auth, user_sub FROM gc_push_subs WHERE user_sub IN (${ph})`,
    subs
  );
  return rows.map((r) => ({ endpoint: r.endpoint!, p256dh: r.p256dh!, auth: r.auth!, user_sub: r.user_sub! }));
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

/**
 * El room por id. Existe para poder autorizar partiendo de un MENSAJE: un mensaje
 * conoce su `channel_id`, no su slug, y `canSeeChannel` necesita la fila entera.
 */
export async function getChannelById(id: number): Promise<Channel | null> {
  if (!id) return null;
  const rows = await dbq("SELECT * FROM gc_channels WHERE id = ?", [id]);
  return rows[0] ? toChannel(rows[0]) : null;
}

// ── Salas de evento ──────────────────────────────────────────────────────────

/** El room detrás de una liga pública. `null` si el slug no existe o ya no es público. */
export async function channelByShareSlug(slug: string): Promise<Channel | null> {
  if (!slug) return null;
  const rows = await dbq(
    "SELECT * FROM gc_channels WHERE call_share_slug = ? AND public_access = 1 AND COALESCE(archived,0) = 0",
    [slug]
  );
  return rows[0] ? toChannel(rows[0]) : null;
}

export async function setChannelEvent(
  channelId: number,
  patch: {
    mode?: "webinar" | "taller" | null;
    shareSlug?: string | null;
    livekitUrl?: string | null;
    title?: string | null;
    publicAccess?: boolean;
    agentEnabled?: boolean;
    callOpen?: boolean;
    startsAt?: number | null;
    recordingUrl?: string | null;
    recordedAt?: number | null;
  }
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); args.push(val); };
  if (patch.mode !== undefined) put("call_mode", patch.mode);
  if (patch.shareSlug !== undefined) put("call_share_slug", patch.shareSlug);
  if (patch.livekitUrl !== undefined) put("call_livekit_url", patch.livekitUrl);
  if (patch.title !== undefined) put("call_title", patch.title);
  if (patch.publicAccess !== undefined) put("public_access", patch.publicAccess ? 1 : 0);
  if (patch.agentEnabled !== undefined) put("agent_enabled", patch.agentEnabled ? 1 : 0);
  if (patch.callOpen !== undefined) put("call_open", patch.callOpen ? 1 : 0);
  if (patch.startsAt !== undefined) put("starts_at", patch.startsAt);
  if (patch.recordingUrl !== undefined) put("call_recording_url", patch.recordingUrl);
  if (patch.recordedAt !== undefined) put("call_recorded_at", patch.recordedAt);
  if (!sets.length) return;
  args.push(channelId);
  await dbq(`UPDATE gc_channels SET ${sets.join(", ")} WHERE id = ?`, args);

  // El sello de apertura, en su propia sentencia y con `IS NULL` en el WHERE: así la
  // PRIMERA apertura lo pone y ninguna posterior lo mueve. Si se recalculara al reabrir,
  // un room cerrado tres meses volvería enseñando sólo lo último — pero si se pisara con
  // la fecha nueva, lo que se habló mientras estaba cerrado quedaría al descubierto. Se
  // conserva el primero, que es el lado seguro.
  if (patch.publicAccess === true) {
    await dbq(
      "UPDATE gc_channels SET public_since = unixepoch() WHERE id = ? AND public_since IS NULL",
      [channelId]
    );
  }
}

export type EventRegistration = {
  id: number;
  name: string;
  email: string;
  created_at: number;
  banned: number;
};

/**
 * Registra (o actualiza) a quien entra por la liga. Devuelve `null` si esa persona
 * está baneada — el baneo es por CORREO porque es lo único estable entre visitas:
 * la cookie se borra y la IP cambia.
 */
export async function registerForEvent(input: {
  channelId: number;
  name: string;
  email: string;
  guestSub: string;
  ipHash: string | null;
}): Promise<{ banned: boolean }> {
  const email = input.email.trim().toLowerCase();
  const rows = await dbq(
    `INSERT INTO gt_event_registrations (channel_id, name, email, guest_sub, ip_hash, last_seen_at)
     VALUES (?,?,?,?,?, unixepoch())
     ON CONFLICT(channel_id, email) DO UPDATE SET
       name = excluded.name, guest_sub = excluded.guest_sub, last_seen_at = unixepoch()
     RETURNING banned`,
    [input.channelId, input.name.trim().slice(0, 60), email, input.guestSub, input.ipHash]
  );
  return { banned: num(rows[0]?.banned) === 1 };
}

/**
 * Arranca (o reintenta) la verificación de un correo: guarda el hash del código y su
 * caducidad, y devuelve si esa persona está baneada.
 *
 * ⚠️ **No toca `guest_sub`.** El `sub` se ata al correo sólo cuando el código se acierta;
 * si se atara aquí, pedir un código para el correo de otro le robaría la sesión a esa
 * persona. Tampoco resetea `verified_at`: quien ya estaba dentro sigue dentro aunque
 * alguien pida un código a su nombre.
 *
 * ⚠️ `verify_attempts` vuelve a 0 con cada código nuevo, que es lo correcto —el tope es
 * por código, no de por vida— pero por eso el **reenvío** tiene que tener su propio
 * límite: sin él, pedir código nuevo sería la forma de reiniciar los intentos.
 */
export async function startEventVerification(input: {
  channelId: number;
  name: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  ipHash: string | null;
}): Promise<{ banned: boolean; alreadyVerified: boolean }> {
  const email = input.email.trim().toLowerCase();
  const rows = await dbq(
    `INSERT INTO gt_event_registrations
       (channel_id, name, email, ip_hash, last_seen_at, verify_code_hash, verify_expires_at, verify_attempts)
     VALUES (?,?,?,?, unixepoch(), ?, ?, 0)
     ON CONFLICT(channel_id, email) DO UPDATE SET
       name = excluded.name,
       last_seen_at = unixepoch(),
       verify_code_hash = excluded.verify_code_hash,
       verify_expires_at = excluded.verify_expires_at,
       verify_attempts = 0
     RETURNING banned, verified_at`,
    [input.channelId, input.name.trim().slice(0, 60), email, input.ipHash, input.codeHash, input.expiresAt]
  );
  return {
    banned: num(rows[0]?.banned) === 1,
    alreadyVerified: rows[0]?.verified_at != null,
  };
}

/** La fila de verificación de un correo, para comprobar el código contra ella. */
export async function eventVerificationRow(
  channelId: number,
  email: string
): Promise<{ verify_code_hash: string | null; verify_expires_at: number | null; verify_attempts: number; banned: number; name: string } | null> {
  const rows = await dbq(
    `SELECT name, banned, verify_code_hash, verify_expires_at, verify_attempts
       FROM gt_event_registrations WHERE channel_id = ? AND email = ? LIMIT 1`,
    [channelId, email.trim().toLowerCase()]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    name: r.name ?? "",
    banned: num(r.banned),
    verify_code_hash: r.verify_code_hash ?? null,
    verify_expires_at: r.verify_expires_at == null ? null : num(r.verify_expires_at),
    verify_attempts: num(r.verify_attempts),
  };
}

/** Un intento fallido. Se cuenta SIEMPRE, aunque el código ya hubiera caducado. */
export async function bumpEventVerifyAttempt(channelId: number, email: string): Promise<void> {
  await dbq(
    "UPDATE gt_event_registrations SET verify_attempts = verify_attempts + 1 WHERE channel_id = ? AND email = ?",
    [channelId, email.trim().toLowerCase()]
  );
}

/**
 * Código acertado: se sella la verificación y AHORA sí se ata el `guest_sub`.
 *
 * El código se borra en el mismo UPDATE: es de un solo uso, y dejarlo permitiría
 * reutilizarlo desde otro navegador durante los diez minutos de su ventana.
 */
export async function confirmEventVerification(input: {
  channelId: number;
  email: string;
  guestSub: string;
}): Promise<void> {
  await dbq(
    `UPDATE gt_event_registrations
        SET verified_at = COALESCE(verified_at, unixepoch()),
            guest_sub = ?,
            verify_code_hash = NULL,
            verify_expires_at = NULL,
            verify_attempts = 0,
            last_seen_at = unixepoch()
      WHERE channel_id = ? AND email = ?`,
    [input.guestSub, input.channelId, input.email.trim().toLowerCase()]
  );
}

export async function listEventRegistrations(channelId: number): Promise<EventRegistration[]> {
  const rows = await dbq(
    "SELECT id, name, email, created_at, banned FROM gt_event_registrations WHERE channel_id = ? ORDER BY id DESC LIMIT 500",
    [channelId]
  );
  return rows.map((r) => ({
    id: num(r.id),
    name: r.name!,
    email: r.email!,
    created_at: num(r.created_at),
    banned: num(r.banned),
  }));
}

export async function canSeeChannel(ch: Channel, userSub: string, isOwner: boolean): Promise<boolean> {
  // ⚠️ Un invitado (`guest:*`) alcanza EXACTAMENTE el room en el que se registró.
  // No basta con que el room sea público: eso le abriría todos los eventos del
  // cliente a la vez, y "público" tampoco puede heredar del is_private=0, que
  // significa "lo ve todo el WORKSPACE" — otra frontera, mucho más estrecha.
  // El permiso sale de SU fila de registro, y un baneo lo cierra de inmediato.
  if (userSub.startsWith("guest:")) {
    if (ch.public_access !== 1) return false;
    const { rows } = await dbqRaw(
      "SELECT 1 FROM gt_event_registrations WHERE channel_id = ? AND guest_sub = ? AND banned = 0",
      [ch.id, userSub]
    );
    return rows.length > 0;
  }
  if (ch.is_private === 0 || isOwner) return true;
  const { rows } = await dbqRaw(
    "SELECT 1 FROM gc_channel_members WHERE channel_id = ? AND user_sub = ?",
    [ch.id, userSub]
  );
  return rows.length > 0;
}

// Subs de los miembros EXPLÍCITOS de un canal privado (gc_channel_members) — para timbrar
// la llamada entrante a quien no está viendo el room. Un room público no tiene filas aquí.
export async function getChannelMemberSubs(channelId: number): Promise<string[]> {
  const rows = await dbq("SELECT user_sub FROM gc_channel_members WHERE channel_id = ?", [channelId]);
  return rows.map((r) => r.user_sub!);
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
  await dbq("DELETE FROM gt_room_repos WHERE channel_id = ?", [id]);
  await dbq("DELETE FROM gt_room_board WHERE channel_id = ?", [id]);
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

// ── Repos del room ──
// Los repos que un room declara suyos. Es la frontera del conector de GitHub: el agente
// sólo ve éstos, y en un room sin ninguno no ve ninguno. Ver gt_room_repos en
// server/schema.server.ts para el porqué.

export type RoomRepo = { repo: string; connectedBy: string; createdAt: number };

export async function listRoomRepos(channelId: number): Promise<RoomRepo[]> {
  const rows = await dbq(
    "SELECT repo, connected_by, created_at FROM gt_room_repos WHERE channel_id = ? ORDER BY created_at",
    [channelId]
  );
  return rows.map((r) => ({
    repo: String(r.repo),
    connectedBy: String(r.connected_by),
    createdAt: Number(r.created_at ?? 0),
  }));
}

export async function addRoomRepo(channelId: number, repo: string, sub: string): Promise<void> {
  await dbq(
    "INSERT INTO gt_room_repos (channel_id, repo, connected_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [channelId, repo, sub]
  );
}

// El match es case-insensitive porque GitHub trata "Blissito/GS" y "blissito/gs" como el
// mismo repo: guardarlo con la caja que el usuario tecleó y borrarlo exigiéndola sería
// dejar filas que nadie puede quitar desde la UI.
export async function removeRoomRepo(channelId: number, repo: string): Promise<void> {
  await dbq("DELETE FROM gt_room_repos WHERE channel_id = ? AND LOWER(repo) = LOWER(?)", [
    channelId,
    repo,
  ]);
}

// Para la card del home: un repo por fila con los rooms donde está conectado. Se agrupa por
// repo en minúsculas (mismo motivo que arriba) pero se enseña la caja original.
//
// ⚠️ Mismo filtro de visibilidad que `listChannels`, y no es opcional: el nombre de un repo
// dice en qué anda un room privado. Sin esto, la card del home lo cuenta a todo el
// workspace.
export async function listWorkspaceRoomRepos(
  userSub: string,
  isOwner: boolean
): Promise<{ repo: string; rooms: { id: number; slug: string; name: string }[] }[]> {
  const rows = await dbq(
    `SELECT r.repo AS repo, c.id AS id, c.slug AS slug, c.name AS name
       FROM gt_room_repos r
       JOIN gc_channels c ON c.id = r.channel_id
      WHERE COALESCE(c.archived, 0) = 0
        AND (c.is_private = 0 OR ? = 1
         OR c.id IN (SELECT channel_id FROM gc_channel_members WHERE user_sub = ?))
      ORDER BY r.created_at`,
    [isOwner ? 1 : 0, userSub]
  );
  const byRepo = new Map<string, { repo: string; rooms: { id: number; slug: string; name: string }[] }>();
  for (const r of rows) {
    const repo = String(r.repo);
    const key = repo.toLowerCase();
    let entry = byRepo.get(key);
    if (!entry) byRepo.set(key, (entry = { repo, rooms: [] }));
    entry.rooms.push({ id: Number(r.id), slug: String(r.slug), name: String(r.name) });
  }
  return [...byRepo.values()];
}

export async function getUserSubByEmail(email: string): Promise<string | null> {
  const rows = await dbq("SELECT sub FROM gc_users WHERE email = ?", [email.trim().toLowerCase()]);
  return rows[0]?.sub ?? null;
}

/**
 * Resuelve a quién señala lo que se escribió en el campo de invitar: correo o
 * `@handle`. La gente teclea el handle porque es lo que ve en el chat, y antes eso
 * fallaba con un error que hablaba de otra cosa ("aún no ha entrado a Ghosty Teams").
 */
export async function getUserSubByEmailOrHandle(input: string): Promise<string | null> {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes("@") && !raw.startsWith("@")) return getUserSubByEmail(raw);
  const handle = raw.replace(/^@/, "").toLowerCase();
  const rows = await dbq("SELECT sub FROM gc_users WHERE lower(handle) = ?", [handle]);
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

/**
 * Correos SIN mirar el toggle global — para avisos que el usuario pidió explícitamente
 * (un recordatorio con "sí, mándamelo también por correo"). El toggle es una preferencia
 * por default; un "sí" puntual es más específico que ella. Lo que NO se salta: baneados
 * ni filas sin correo.
 */
export async function emailsForSubsAny(subs: string[]): Promise<{ sub: string; email: string; name: string }[]> {
  if (!subs.length) return [];
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(`SELECT sub, email, name FROM gc_users WHERE sub IN (${ph}) AND email IS NOT NULL AND COALESCE(banned,0)=0`, subs);
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

// Roster VISIBLE de un room, para que CUALQUIER miembro vea quién está (patrón Slack/
// Discord: ver es abierto, gestionar sigue gateado). En un room PRIVADO la membresía es
// explícita (gc_channel_members). En uno PÚBLICO esa tabla está VACÍA por diseño — nadie
// "se une", todos pueden entrar — así que la derivamos de quién ha participado: personas
// distintas con mensajes en el canal. La UI etiqueta ese caso como "activos en el canal"
// para no prometer una membresía que no existe. Se excluyen los mensajes de agentes
// (agent_handle no nulo): el bot no es un miembro más de la lista.
export async function listRoomRoster(ch: Channel): Promise<MemberInfo[]> {
  if (ch.is_private !== 0) return listChannelMembersInfo(ch.id);
  const rows = await dbq(
    `SELECT DISTINCT u.sub, u.name, u.email, u.avatar
       FROM gc_messages m JOIN gc_users u ON u.sub = m.sender_sub
      WHERE m.channel_id = ? AND m.sender_sub IS NOT NULL AND m.agent_handle IS NULL
      ORDER BY u.name`,
    [ch.id]
  );
  return rows.map((r) => ({ sub: r.sub!, name: r.name ?? "", email: r.email ?? "", avatar: r.avatar ?? "" }));
}

// Flujo principal del canal: mensajes top-level (parent_id NULL) + nº de respuestas.
// Con `topic` filtra al eje Zulip; sin él devuelve el room completo (compat).
// PERF (2026-07-24): antes traía TODO el historial top-level → arranque de minutos en
// rooms grandes (general). Ahora el flujo = últimos FLOW_LIMIT mensajes ∪ TODOS los
// roots de hilo. Esa unión es la clave: el intento previo de cap seco reventaba el
// render cuando un hilo quedaba con su root fuera de la ventana. El resto del historial
// queda para scroll-back por cursor (pendiente).
const FLOW_LIMIT = 300;
export async function listChannelFlow(channelId: number, topic?: string): Promise<Message[]> {
  const filter = topic ? "AND m.topic = ?" : "";
  const base: unknown[] = topic ? [channelId, topic] : [channelId];
  const rows = await dbq(
    `SELECT m.*, (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL ${filter}
        AND (
          m.id IN (SELECT id FROM gc_messages
                    WHERE channel_id = ? AND parent_id IS NULL ${topic ? "AND topic = ?" : ""}
                    ORDER BY created_at DESC, id DESC LIMIT ${FLOW_LIMIT})
          OR EXISTS (SELECT 1 FROM gc_messages c WHERE c.parent_id = m.id)
        )
      ORDER BY m.created_at ASC, m.id ASC`,
    [...base, ...base]
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
      ORDER BY last_at DESC LIMIT 400`,
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
      ORDER BY last_at DESC LIMIT 200`,
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
  for (const table of ["gc_attachments", "gc_reactions", "gc_stars", "gc_pins"]) {
    await dbq(`DELETE FROM ${table} WHERE ${scope}`, [id, id]);
  }
  // ⚠️ Los ARTEFACTOS no se borran: se ARCHIVAN (2026-08-03).
  //
  // Antes estaban en la lista de arriba, así que borrar un mensaje del chat DESTRUÍA el
  // documento que había producido — sin retención, sin aviso y sin forma de recuperarlo.
  // Un documento es el entregable (liga compartible, versiones, export, co-edición); no
  // puede morir porque alguien limpie la conversación.
  //
  // Van a la papelera con los mismos 30 días que si los archivaras a mano, así que la
  // recuperación es la de siempre. Y se archiva por DOCUMENTO (`url`), no por fila: si se
  // marcara sólo la fila anclada a este mensaje, las otras versiones del mismo documento
  // quedarían vivas y el documento seguiría medio visible.
  const RETENCION_DIAS = 30;
  const ahora = Math.floor(Date.now() / 1000);
  await dbq(
    `UPDATE gc_artifacts SET archived_at = ?, purge_at = ?
      WHERE archived_at IS NULL AND url IN (SELECT url FROM gc_artifacts WHERE ${scope})`,
    [ahora, ahora + RETENCION_DIAS * 86400, id, id],
  );
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
    "SELECT * FROM gc_messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC",
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
    // Últimos 300 (mismo criterio que el flujo de room: el arranque no puede pagar
    // el historial completo). El resto queda para scroll-back por cursor.
    `SELECT * FROM (SELECT * FROM gc_messages WHERE dm_id = ? ORDER BY created_at DESC, id DESC LIMIT 300)
      ORDER BY created_at ASC, id ASC`,
    [dmId]
  );
  return rows.map(toMessage);
}

// Últimos `limit` mensajes de un scope (DM, room o hilo) en orden CRONOLÓGICO — contexto
// de historial para el agente cuando la memoria de su worker está fría o un turno falló
// (así resuelve "otra vez"/"esto"). Solo kind='msg' (sin tarjetas de llamada/sistema).
export async function recentContext(
  scope: { dmId: number } | { channelId: number; parentId?: number | null },
  limit = 12
): Promise<Message[]> {
  let rows;
  if ("dmId" in scope) {
    rows = await dbq("SELECT * FROM gc_messages WHERE dm_id = ? AND kind = 'msg' ORDER BY created_at DESC LIMIT ?", [scope.dmId, limit]);
  } else if (scope.parentId != null) {
    rows = await dbq("SELECT * FROM gc_messages WHERE parent_id = ? AND kind = 'msg' ORDER BY created_at DESC LIMIT ?", [scope.parentId, limit]);
  } else {
    rows = await dbq("SELECT * FROM gc_messages WHERE channel_id = ? AND parent_id IS NULL AND kind = 'msg' ORDER BY created_at DESC LIMIT ?", [scope.channelId, limit]);
  }
  return rows.map(toMessage).reverse();
}

/**
 * Historial hacia ATRÁS de un scope, paginado. Es lo que consume la tool `chat_history`
 * del agente — el equivalente de `conversations.history` de Slack.
 *
 * `recentContext` de arriba mira la cola y nada más; esto es lo que permite RECORRER. El
 * cursor es el `id` del mensaje más viejo devuelto: la siguiente página es ese `id` como
 * `beforeId`. Se pagina por `id` y no por `created_at` porque dos mensajes del mismo
 * segundo dejarían un hueco o repetirían.
 *
 * Devuelve en orden cronológico, igual que `recentContext`, para que el agente lea de
 * arriba abajo.
 */
export async function historyBefore(
  scope: { dmId: number } | { channelId: number; parentId?: number | null },
  beforeId: number | null,
  limit = 25
): Promise<Message[]> {
  const cur = beforeId && beforeId > 0 ? beforeId : null;
  const tope = Math.max(1, Math.min(limit, 50));
  let rows;
  if ("dmId" in scope) {
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE dm_id = ? AND kind = 'msg' ${cur ? "AND id < ?" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      cur ? [scope.dmId, cur, tope] : [scope.dmId, tope]
    );
  } else if (scope.parentId != null) {
    // Un hilo son sus respuestas MÁS su raíz: sin el `OR id = ?` se pierde justo el
    // mensaje que lo abrió, que suele ser el que trae la petición.
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE (parent_id = ? OR id = ?) AND kind = 'msg' ${cur ? "AND id < ?" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      cur ? [scope.parentId, scope.parentId, cur, tope] : [scope.parentId, scope.parentId, tope]
    );
  } else {
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE channel_id = ? AND parent_id IS NULL AND kind = 'msg' ${cur ? "AND id < ?" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      cur ? [scope.channelId, cur, tope] : [scope.channelId, tope]
    );
  }
  return rows.map(toMessage).reverse();
}

/**
 * Busca texto DENTRO de un scope (la tool `chat_search`).
 *
 * `searchRoomMessages` no sirve aquí: barre todos los rooms visibles, y `searchDmMessages`
 * barre TODOS los DMs de la persona. La tool sólo puede ver la conversación donde
 * invocaron al agente, así que la consulta se acota al scope firmado del token.
 */
export async function searchInScope(
  scope: { dmId: number } | { channelId: number; parentId?: number | null },
  q: string,
  limit = 20
): Promise<Message[]> {
  if (!q.trim()) return [];
  const tope = Math.max(1, Math.min(limit, 20));
  const like = likeArg(q);
  let rows;
  if ("dmId" in scope) {
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE dm_id = ? AND kind = 'msg' AND body LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT ?`,
      [scope.dmId, like, tope]
    );
  } else if (scope.parentId != null) {
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE (parent_id = ? OR id = ?) AND kind = 'msg' AND body LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT ?`,
      [scope.parentId, scope.parentId, like, tope]
    );
  } else {
    // En un canal se busca TAMBIÉN dentro de los hilos: ahí es donde vive el trabajo largo
    // (la misma corrección que se le hizo al buscador humano el 2026-07-31).
    rows = await dbq(
      `SELECT * FROM gc_messages WHERE channel_id = ? AND dm_id IS NULL AND kind = 'msg'
         AND body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
      [scope.channelId, like, tope]
    );
  }
  return rows.map(toMessage).reverse();
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
