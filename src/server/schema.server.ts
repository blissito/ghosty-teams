import { dbq } from "../dbq.server";

// Migraciones ADITIVAS e idempotentes de Fase 1. Las tablas base gc_* las crea el
// provisioner de Formmy; aquí solo SUMAMOS columnas/tablas nuevas, de forma segura
// para correr en cada arranque (memoizado). Nada destructivo.
let done: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  return (done ??= migrate());
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  try {
    const rows = await dbq(`PRAGMA table_info(${table})`);
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

async function addColumn(table: string, col: string, decl: string): Promise<void> {
  if (await hasColumn(table, col)) return;
  try {
    await dbq(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  } catch {
    /* carrera / ya existe — idempotente */
  }
}

async function migrate(): Promise<void> {
  // Topics (Zulip): eje primario; se CONSERVA parent_id (agente + reply-chains).
  await addColumn("gc_messages", "topic", "TEXT NOT NULL DEFAULT 'general'");
  // DMs: reusar gc_messages con dm_id nullable (hereda todo el pipeline).
  await addColumn("gc_messages", "dm_id", "INTEGER");
  // Editar: marca de tiempo de última edición.
  await addColumn("gc_messages", "edited_at", "INTEGER");

  await dbq(`CREATE INDEX IF NOT EXISTS gc_messages_chan_topic
             ON gc_messages(channel_id, topic, created_at)`);
  await dbq(`CREATE INDEX IF NOT EXISTS gc_messages_dm
             ON gc_messages(dm_id, created_at)`);

  await dbq(`CREATE TABLE IF NOT EXISTS gc_reactions (
    message_id INTEGER NOT NULL,
    user_sub   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_sub, emoji)
  )`);
  await dbq(`CREATE INDEX IF NOT EXISTS gc_reactions_msg ON gc_reactions(message_id)`);

  await dbq(`CREATE TABLE IF NOT EXISTS gc_reads (
    user_sub     TEXT NOT NULL,
    scope        TEXT NOT NULL,          -- 'room' | 'dm'
    scope_id     TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, scope, scope_id)
  )`);

  await dbq(`CREATE TABLE IF NOT EXISTS gc_dm_conversations (
    id         INTEGER PRIMARY KEY,
    is_group   INTEGER NOT NULL DEFAULT 0,
    title      TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    member_key TEXT UNIQUE               -- subs ordenados → dedupe 1:1 y grupos
  )`);
  await dbq(`CREATE TABLE IF NOT EXISTS gc_dm_members (
    conversation_id INTEGER NOT NULL,
    user_sub        TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_sub)
  )`);

  // Fase 2: star (personal), pin (room-level, owner), mute (silencia un scope).
  await dbq(`CREATE TABLE IF NOT EXISTS gc_stars (
    user_sub   TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_sub, message_id)
  )`);
  await dbq(`CREATE INDEX IF NOT EXISTS gc_stars_user ON gc_stars(user_sub, created_at)`);
  await dbq(`CREATE TABLE IF NOT EXISTS gc_pins (
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by  TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (channel_id, message_id)
  )`);
  await dbq(`CREATE TABLE IF NOT EXISTS gc_mutes (
    user_sub TEXT NOT NULL,
    scope    TEXT NOT NULL,               -- 'room' | 'dm'
    scope_id TEXT NOT NULL,
    PRIMARY KEY (user_sub, scope, scope_id)
  )`);

  // Fase 4: adjuntos. Solo guardamos el fileId de EasyBits (storage privado); el
  // readUrl firmado se re-mintea on-demand vía /api/attachment/:id.
  await dbq(`CREATE TABLE IF NOT EXISTS gc_attachments (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL,
    file_id    TEXT NOT NULL,
    mime       TEXT,
    size       INTEGER,
    name       TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await dbq(`CREATE INDEX IF NOT EXISTS gc_attachments_msg ON gc_attachments(message_id)`);

  // Fase 4: descripción + archivado de rooms.
  await addColumn("gc_channels", "description", "TEXT");
  await addColumn("gc_channels", "archived", "INTEGER NOT NULL DEFAULT 0");

  // Fase 4: emojis custom del workspace (imágenes en EasyBits, guardamos file_id).
  // Se reaccionan/renderizan como `:name:` → <img> vía /api/attachment/:file_id.
  await dbq(`CREATE TABLE IF NOT EXISTS gc_emojis (
    name       TEXT PRIMARY KEY,
    file_id    TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}
