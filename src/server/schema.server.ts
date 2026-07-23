import { dbq } from "../dbq.server";
import { currentNamespace } from "./tenant.server";

// Migraciones ADITIVAS e idempotentes de Fases 1-4. Las tablas base gc_* las crea
// el provisioner de Formmy; aquí solo SUMAMOS columnas/tablas nuevas, seguro de
// correr en cada arranque. Nada destructivo.
//
// RESILIENCIA (incidente 2026-07-05): el backend de DB de EasyBits puede devolver
// 500 transitorios ("Unexpected Server Error"). Antes memoizábamos migrate() con
// `done ??=` y tragábamos errores por-sentencia → si la DB flapeaba en el PRIMER
// request, las migraciones se saltaban y NUNCA se reintentaban en ese proceso
// (columnas/tablas faltantes → 500 en toda query nueva). Ahora: (1) NO memoizamos
// el fallo — si algo falla, `done` se resetea y el siguiente request reintenta;
// (2) migrate() acumula fallos y LANZA al final, para que ese reset ocurra. Como
// todo es idempotente (IF NOT EXISTS / ADD COLUMN guardado por hasColumn), reintentar
// es seguro y converge en cuanto la DB responde.
// MULTITENANT: memo POR NAMESPACE. Una sola caja sirve a muchos workspaces en el
// mismo proceso; un memo global (`let done`) hacía que el PRIMER workspace fijara
// `done` y los DEMÁS se saltaran sus migraciones → tablas/columnas faltantes →
// 500 (`no such column`) en workspaces recién provisionados. Keyed por `ns`, cada
// tenant corre (y reintenta ante fallo) sus propias migraciones idempotentes.
const done = new Map<string, Promise<void>>();
export async function ensureSchema(): Promise<void> {
  const ns = await currentNamespace();
  let p = done.get(ns);
  if (!p) {
    p = migrate().catch((e) => {
      done.delete(ns); // no cachear el fallo → reintenta en el próximo request
      throw e;
    });
    done.set(ns, p);
  }
  return p;
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  // Propaga si falla (DB caída) → se registra como fallo → reintento.
  const rows = await dbq(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === col);
}

async function migrate(): Promise<void> {
  const fails: string[] = [];
  const exec = async (sql: string) => {
    try {
      await dbq(sql);
    } catch (e) {
      fails.push(`${sql.slice(0, 48)}… → ${String(e).slice(0, 90)}`);
    }
  };
  const addColumn = async (table: string, col: string, decl: string) => {
    let has: boolean;
    try {
      has = await hasColumn(table, col);
    } catch (e) {
      // No pudimos leer el esquema (DB caída) → fallo, para forzar reintento.
      fails.push(`PRAGMA ${table} → ${String(e).slice(0, 90)}`);
      return;
    }
    if (has) return;
    await exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };

  // Topics (Zulip): eje primario; se CONSERVA parent_id (agente + reply-chains).
  await addColumn("gc_messages", "topic", "TEXT NOT NULL DEFAULT 'general'");
  // DMs: reusar gc_messages con dm_id nullable (hereda todo el pipeline).
  await addColumn("gc_messages", "dm_id", "INTEGER");
  // Editar: marca de tiempo de última edición.
  await addColumn("gc_messages", "edited_at", "INTEGER");
  // Identidad ESTABLE del autor (sub del IdP). El authz de editar/borrar se apoya en
  // esto — NO en `sender` (display name, ahora editable en Ajustes → perfil, que sería
  // suplantable). Mensajes viejos sin sender_sub caen al chequeo por nombre (legacy).
  await addColumn("gc_messages", "sender_sub", "TEXT");
  // Quote-reply (estilo WhatsApp/WABA): un mensaje puede CITAR a otro. Guardamos el id
  // del citado + un SNAPSHOT denormalizado (autor + extracto) — como el contextInfo.
  // quotedMessage de Baileys: la cita viaja EN el mensaje, así el render y el agente la
  // ven sin un join, y sobrevive aunque el original se borre/edite.
  await addColumn("gc_messages", "quoted_id", "INTEGER");
  await addColumn("gc_messages", "quoted_author", "TEXT");
  await addColumn("gc_messages", "quoted_excerpt", "TEXT");

  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_chan_topic
              ON gc_messages(channel_id, topic, created_at)`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_dm
              ON gc_messages(dm_id, created_at)`);

  await exec(`CREATE TABLE IF NOT EXISTS gc_reactions (
    message_id INTEGER NOT NULL,
    user_sub   TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_sub, emoji)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_reactions_msg ON gc_reactions(message_id)`);

  await exec(`CREATE TABLE IF NOT EXISTS gc_reads (
    user_sub     TEXT NOT NULL,
    scope        TEXT NOT NULL,          -- 'room' | 'dm'
    scope_id     TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, scope, scope_id)
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS gc_dm_conversations (
    id         INTEGER PRIMARY KEY,
    is_group   INTEGER NOT NULL DEFAULT 0,
    title      TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    member_key TEXT UNIQUE               -- subs ordenados → dedupe 1:1 y grupos
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS gc_dm_members (
    conversation_id INTEGER NOT NULL,
    user_sub        TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_sub)
  )`);

  // Fase 2: star (personal), pin (room-level, owner), mute (silencia un scope).
  await exec(`CREATE TABLE IF NOT EXISTS gc_stars (
    user_sub   TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_sub, message_id)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_stars_user ON gc_stars(user_sub, created_at)`);
  await exec(`CREATE TABLE IF NOT EXISTS gc_pins (
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by  TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (channel_id, message_id)
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS gc_mutes (
    user_sub TEXT NOT NULL,
    scope    TEXT NOT NULL,               -- 'room' | 'dm'
    scope_id TEXT NOT NULL,
    PRIMARY KEY (user_sub, scope, scope_id)
  )`);

  // Fase 4: adjuntos. Solo guardamos el fileId de EasyBits (storage privado); el
  // readUrl firmado se re-mintea on-demand vía /api/attachment/:id.
  await exec(`CREATE TABLE IF NOT EXISTS gc_attachments (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL,
    file_id    TEXT NOT NULL,
    mime       TEXT,
    size       INTEGER,
    name       TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_attachments_msg ON gc_attachments(message_id)`);

  // Fase 4: descripción + archivado de rooms.
  await addColumn("gc_channels", "description", "TEXT");
  await addColumn("gc_channels", "archived", "INTEGER NOT NULL DEFAULT 0");
  // DM 1:1 con un agente de la flota: la conversación guarda su @handle → cada mensaje
  // enruta a ese agente (sin necesidad de @mención). null = DM normal entre personas.
  await addColumn("gc_dm_conversations", "agent_handle", "TEXT");

  // Perfil enriquecido (estilo Slack, editable en el drawer): status (emoji + texto),
  // título/rol, pronombres, bio. + `banned` para expulsar del workspace (login lo checa).
  await addColumn("gc_users", "status_emoji", "TEXT");
  await addColumn("gc_users", "status_text", "TEXT");
  await addColumn("gc_users", "title", "TEXT");
  await addColumn("gc_users", "pronouns", "TEXT");
  await addColumn("gc_users", "bio", "TEXT");
  await addColumn("gc_users", "banned", "INTEGER NOT NULL DEFAULT 0");
  // Preferencia: recibir notificaciones por CORREO (menciones/DM offline). Default ON (opt-out).
  await addColumn("gc_users", "email_notifs", "INTEGER NOT NULL DEFAULT 1");

  // Thumbnail WebP de adjuntos-imagen (se sirve inline; el original queda para full/agente).
  await addColumn("gc_attachments", "thumb_file_id", "TEXT");

  // Agentes slice 1: persona/prompt por agente (se antepone/envía al backend para
  // que cada agente hable distinto). gc_agents la crea el provisioner; aquí sumamos.
  await addColumn("gc_agents", "system_prompt", "TEXT");

  // Agentes slice 4: colaboradores de un agente (pueden EDITAR su config, no verlo
  // el secret ni borrar/crear). Espejo de gc_channel_members para rooms privados.
  await exec(`CREATE TABLE IF NOT EXISTS gc_agent_collaborators (
    agent_id INTEGER NOT NULL,
    user_sub TEXT NOT NULL,
    PRIMARY KEY (agent_id, user_sub)
  )`);

  // Fase 4: emojis custom del workspace (imágenes en EasyBits, guardamos file_id).
  await exec(`CREATE TABLE IF NOT EXISTS gc_emojis (
    name       TEXT PRIMARY KEY,
    file_id    TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Artefactos: doc/pdf/imagen que el agente PRODUCE y se abren en el panel del
  // room (no son adjuntos subidos por el user → tabla aparte). 1 por mensaje del
  // agente. url = enlace público openable en iframe; kind gatea el modo del panel.
  // `md` = markdown FUENTE del doc (kind:"doc"), guardado local → es la verdad. El panel
  // lo renderiza sin ir a EasyBits, y al modificar se re-inyecta al agente para que
  // re-emita el documento completo. url = para docs = documentId local (identidad estable
  // por conversación); para archivos = enlace público. kind gatea el modo del panel.
  await exec(`CREATE TABLE IF NOT EXISTS gc_artifacts (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    url        TEXT NOT NULL,
    title      TEXT,
    md         TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_artifacts_msg ON gc_artifacts(message_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_artifacts_doc ON gc_artifacts(url)`);
  // Migración: DBs previas no tienen `md` → añádela (idempotente vía hasColumn).
  await addColumn("gc_artifacts", "md", "TEXT");

  // Identidad conversacional del artefacto "vivo" (Fase 1 edit-in-place): mapea una
  // conversación (channel + thread) al documentId del artefacto ACTUAL, para que
  // "modifícalo" siga apuntando al MISMO documento aunque el worker recicle su sesión.
  // GTeams inyecta este id en el guardrail per-turno → el agente usa artifact_update(id).
  await exec(`CREATE TABLE IF NOT EXISTS gc_thread_artifact (
    conv_key    TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Puente EasyBits Forms → room: mapea un form hospedado (form_id de EasyBits) al
  // canal/expediente donde caen sus respuestas. Poblado al crear el intake desde el
  // room; el webhook inbound (/api/webhook/easybits) resuelve form_id → channel_id.
  await exec(`CREATE TABLE IF NOT EXISTS gc_expediente_forms (
    form_id           TEXT PRIMARY KEY,
    channel_id        INTEGER NOT NULL,
    form_key          TEXT,
    required          INTEGER NOT NULL DEFAULT 1,
    submission_count  INTEGER NOT NULL DEFAULT 0,
    last_submitted_at INTEGER
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_expediente_forms_chan ON gc_expediente_forms(channel_id)`);

  // Novedades ("What's New" estilo Discord/Revolt): anuncios en markdown que el admin
  // redacta/publica; al entrar, si hay uno nuevo (id > last_seen del usuario) se muestra
  // una card. `published`=0 son borradores. El estado "visto" es per-usuario y server-side
  // (calca gc_reads → cross-device, no localStorage).
  // NOTA prefijo: las tablas NUEVAS nacen con `gs_` (las gc_* son legacy de ghosty-chat).
  await exec(`CREATE TABLE IF NOT EXISTS gt_announcements (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    published  INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gt_announcements_pub ON gt_announcements(published, id)`);
  // Ilustración hero (estilo Discord "What's New"): URL pública de la imagen que
  // encabeza la card. Opcional; si falta, la card va sin hero.
  await addColumn("gt_announcements", "hero_image", "TEXT");
  await exec(`CREATE TABLE IF NOT EXISTS gt_announcement_reads (
    user_sub     TEXT PRIMARY KEY,
    last_seen_id INTEGER NOT NULL DEFAULT 0
  )`);

  // Si algo falló (DB flapeando), LANZA → ensureSchema resetea `done` → reintento.
  if (fails.length) {
    throw new Error(`ensureSchema: ${fails.length} sentencia(s) fallaron, se reintentará: ${fails.join(" | ")}`);
  }
}
