import { dbq, dbqManySettled } from "../dbq.server";
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
    p = migrate()
      .then(async () => {
        // El tick de recordatorios se arma LAZY, como el reaper de quick-calls: aquí es
        // donde sabemos que este tenant existe y ya tiene su tabla. Import dinámico para
        // no crear un ciclo (reminders → db.server → schema).
        try {
          const { armReminders } = await import("./reminders.server");
          armReminders(ns);
        } catch { /* el tick es best-effort: no puede tumbar las migraciones */ }
        // Barrido de cáscaras huérfanas: un reinicio se lleva los turnos en vuelo (el
        // registro es en memoria) y deja sus burbujas en "pensando…" para siempre. Aquí
        // es el "arranque" de este tenant, así que aquí se limpian.
        try {
          const { sweepOrphans } = await import("./turns.server");
          await sweepOrphans();
        } catch { /* limpieza best-effort */ }
      })
      .catch((e) => {
        done.delete(ns); // no cachear el fallo → reintenta en el próximo request
        throw e;
      });
    done.set(ns, p);
  }
  return p;
}

async function migrate(): Promise<void> {
  const fails: string[] = [];
  const _t0 = performance.now();
  let _rtt = 0;
  // PERF (2026-07-24): migrate() hacía ~100 round-trips SECUENCIALES al sqld (53 DDL +
  // un PRAGMA por columna), y corre DENTRO del primer request de cada proceso/namespace
  // → el primer usuario tras cada deploy pagaba decenas de segundos de TTFB (medido: 26s
  // en getChannelView, con las queries del room en 60ms). Ahora:
  //   · las sentencias sin lectura se ACUMULAN y se mandan en UN solo pipeline;
  //   · el PRAGMA de cada tabla se lee UNA vez y se cachea.
  // El ORDEN se conserva: cualquier lectura hace flush de lo pendiente antes.
  const pending: string[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    _rtt++;
    try {
      const out = await dbqManySettled(batch.map((sql) => ({ sql })));
      out.forEach((r, i) => {
        if (!r.ok) fails.push(`${batch[i].slice(0, 48)}… → ${String(r.error).slice(0, 90)}`);
      });
    } catch (e) {
      fails.push(`batch(${batch.length}) → ${String(e).slice(0, 90)}`);
    }
  };
  const exec = async (sql: string) => {
    pending.push(sql);
  };
  const cols = new Map<string, Set<string>>();
  const tableColumns = async (table: string): Promise<Set<string>> => {
    const hit = cols.get(table);
    if (hit) return hit;
    await flush(); // el PRAGMA debe ver los CREATE/ALTER previos
    _rtt++;
    const rows = await dbq(`PRAGMA table_info(${table})`);
    const set = new Set(rows.map((r) => r.name!).filter(Boolean));
    cols.set(table, set);
    return set;
  };
  const addColumn = async (table: string, col: string, decl: string) => {
    let has: boolean;
    try {
      has = (await tableColumns(table)).has(col);
    } catch (e) {
      // No pudimos leer el esquema (DB caída) → fallo, para forzar reintento.
      fails.push(`PRAGMA ${table} → ${String(e).slice(0, 90)}`);
      return;
    }
    if (has) return;
    cols.get(table)?.add(col); // la cache refleja el ALTER que acabamos de encolar
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
  // Reenviar (forward estilo WhatsApp): al reenviar un mensaje a otro canal/DM se copia su
  // contenido; este campo guarda el AUTOR original para pintar el rótulo "Reenviado".
  await addColumn("gc_messages", "forwarded_from", "TEXT");

  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_chan_topic
              ON gc_messages(channel_id, topic, created_at)`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_dm
              ON gc_messages(dm_id, created_at)`);
  // listChannelFlow filtra channel_id y ORDENA por created_at SIN predicado de topic →
  // el índice (channel_id, topic, created_at) solo servía de prefijo y sqlite tenía que
  // materializar + ORDER BY todo el room. Con este el flujo sale ya ordenado del índice.
  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_chan_created
              ON gc_messages(channel_id, created_at)`);
  // reply_count de listChannelFlow es un subquery correlacionado COUNT(*) WHERE parent_id=m.id
  // → sin este índice era un full-scan de gc_messages POR CADA mensaje top-level (O(M×N)):
  // causa raíz del arranque lentísimo de rooms grandes (general). Con el índice = lookup.
  await exec(`CREATE INDEX IF NOT EXISTS gc_messages_parent
              ON gc_messages(parent_id)`);

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
  // Preferencia: recibir notificaciones por CORREO (menciones/DM offline). Default OFF (opt-in):
  // el usuario las activa desde Ajustes → Notificaciones. (Antes era opt-out/DEFAULT 1; en DBs
  // vivas la columna ya existe → addColumn no la re-altera, el flip a existentes va por UPDATE
  // guardado con flag en gc_config, ver más abajo.)
  await addColumn("gc_users", "email_notifs", "INTEGER NOT NULL DEFAULT 0");

  // Thumbnail WebP de adjuntos-imagen (se sirve inline; el original queda para full/agente).
  await addColumn("gc_attachments", "thumb_file_id", "TEXT");
  // Dimensiones intrínsecas de la imagen (px) → el render reserva el alto EXACTO antes
  // de cargar (aspect-ratio) → 0 layout-shift al abrir el canal (scroll aterriza al fondo
  // sin que las imágenes empujen). NULL en adjuntos viejos / no-imagen → fallback min-h.
  await addColumn("gc_attachments", "width", "INTEGER");
  await addColumn("gc_attachments", "height", "INTEGER");
  // Nota de voz (adjunto audio): onda de amplitud (64 bytes 0..100, base64) que dibuja
  // la burbuja tipo PTT + duración en ms para el "0:12". NULL en adjuntos no-audio.
  await addColumn("gc_attachments", "waveform", "TEXT");
  await addColumn("gc_attachments", "duration_ms", "INTEGER");

  // Agentes slice 1: persona/prompt por agente (se antepone/envía al backend para
  // que cada agente hable distinto). gc_agents la crea el provisioner; aquí sumamos.
  await addColumn("gc_agents", "system_prompt", "TEXT");

  // DÓNDE CORRE CADA AGENTE. Antes se elegía por TENANT (gc_config.agent_runtime_url),
  // o sea que todos los agentes de un workspace iban al mismo runtime — y un
  // workspace puede tener legítimamente los dos: uno nacido en EasyBits y otro
  // creado en Ghosty Studio. Con el switch por tenant, prenderlo mandaba también
  // al de EasyBits a un runtime donde su id no existe, y no prenderlo condenaba al
  // de Studio a uno que no le inyecta GS_TTS_URL. Ninguno de los dos es un error:
  // son runtimes distintos, y pronto habrá más (otra nube, local).
  //
  //   runtime      = CÓMO se autentica ("gs-native" | "easybits" | …)
  //   runtime_url  = A DÓNDE ir. Sólo para runtimes externos; en "gs-native" se
  //                  IGNORA (ver runtimeFor en agents.server.ts: firmamos con el
  //                  secreto de partner y no se le mandan firmas a un host que no
  //                  sea el nuestro).
  //
  // NULL = comportamiento viejo (la cadena por tenant), para no cambiarle la
  // conducta a ninguna fila existente.
  await addColumn("gc_agents", "runtime", "TEXT");
  await addColumn("gc_agents", "runtime_url", "TEXT");

  // group_ns=1 → la clave de conversación lleva el namespace del workspace (ver
  // agentGroupId). Las filas viejas quedan NULL y conservan el formato de
  // siempre: cambiárselo les borraría la memoria a todas las conversaciones
  // vivas. Sólo hace falta para agentes COMPARTIDOS entre workspaces, que son
  // los que nacen de aquí en adelante.
  await addColumn("gc_agents", "group_ns", "INTEGER");

  // Backfill por la forma del id, que delata el origen sin ambigüedad: los de
  // EasyBits son ObjectId de Mongo (24 hex), los de Studio cuid. Se hace por regla
  // y NO consultando a Studio: una migración no puede depender de que otro sistema
  // esté vivo. Los `webhook` no tienen fleet_id y se quedan en NULL, que es lo
  // correcto — un webhook ya es "corre en otro lado" por definición.
  await exec(`UPDATE gc_agents SET runtime =
    CASE WHEN fleet_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
              THEN 'easybits' ELSE 'gs-native' END
    WHERE runtime IS NULL AND fleet_id IS NOT NULL AND fleet_id <> ''`);

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
  // `src` = URL pública del objeto en S3 (kind:"artifact" → HTML publicado, enlace compartible).
  // El render in-Teams usa `md` (HTML fuente) vía iframe srcDoc; `src` es la puerta pública.
  await addColumn("gc_artifacts", "src", "TEXT");
  // Compartir (link público con permisos y versión congelada). OJO: estas cuatro
  // columnas viven SÓLO en la fila MÁS VIEJA de cada `url` — la raíz del documento —
  // porque cada publicación es un INSERT nuevo (nunca UPDATE) y el compartir es del
  // documento, no de la versión. Resolverlas con `shareRootFor()`, no con `getDoc()`,
  // que devuelve la última.
  //   share_visibility  null|'private' = sólo el dueño · 'link' = cualquiera con el link
  //   share_slug        uuid de la URL pública /a/<slug>; se genera al primer share
  //   shared_artifact_id id de la versión CONGELADA que ve quien tiene el link;
  //                     null = Latest (editar después sí cambia lo que el otro ve)
  //   owner_sub         dueño; las filas previas a esto lo tienen null y se cae al
  //                     join message_id → gc_messages.sender_sub
  await addColumn("gc_artifacts", "share_visibility", "TEXT");
  await addColumn("gc_artifacts", "share_slug", "TEXT");
  await addColumn("gc_artifacts", "shared_artifact_id", "INTEGER");
  await addColumn("gc_artifacts", "owner_sub", "TEXT");
  await exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS gc_artifacts_share ON gc_artifacts(share_slug)`,
  );

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
  // Novedades ("What's New"): el CONTENIDO es GLOBAL y vive en el control-plane gs
  // (modelo Announcement, redactado por admins de sistema). Aquí guardamos el SET de
  // novedades que cada usuario YA VIO (una fila por (user, announcement)). La galería
  // muestra las publicadas que NO estén en el set; al pasar cada card se inserta aquí.
  await exec(`CREATE TABLE IF NOT EXISTS gt_announcement_seen (
    user_sub        TEXT NOT NULL,
    announcement_id TEXT NOT NULL,
    seen_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_sub, announcement_id)
  )`);

  // MEMORIA del agente por conversación: las convenciones que la gente le dicta ("de ahora
  // en adelante los títulos en ##", "el ofendido se llama X", "así firma el despacho").
  //
  // Vive AQUÍ y no en un CLAUDE.md dentro de la caja por dos razones. El workspace del worker
  // es de la SESIÓN, así que un `/clear` rota el sessionUuid y se llevaría las notas — y una
  // convención del despacho no debe morir con la conversación. Y un archivo dentro de una VM
  // no se puede inspeccionar: nadie podría ver qué recuerda el agente ni corregir una nota
  // equivocada, que en un flujo legal acaba saliendo dentro de un escrito.
  //
  // `scope_key` = 'ch:<channelId>' | 'dm:<dmId>'. Por ROOM, NO por hilo: la sesión del agente
  // sí es por hilo (`slug-flow` vs `slug-<parentId>`, ver agentGroupId), así que una memoria
  // por hilo se perdería al abrir el siguiente — justo lo contrario de lo que se pidió. Ojo:
  // esa granularidad NO coincide con la del groupId, y es deliberado.
  //
  // Por AGENTE (dos agentes en un room tienen trabajos distintos) y COMPARTIDA entre las
  // personas del room: son convenciones del espacio, no preferencias de cada quien; si fuera
  // por persona habría que dictarlas una vez por miembro y dos podrían contradecirse sin
  // saberlo. Sin columna `ns`: la DB ya es por workspace.
  await exec(`CREATE TABLE IF NOT EXISTS gt_agent_memory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key    TEXT NOT NULL,
    agent_handle TEXT NOT NULL,
    note         TEXT NOT NULL,
    created_by   TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(
    `CREATE INDEX IF NOT EXISTS gt_agent_memory_scope ON gt_agent_memory(scope_key, agent_handle)`
  );

  // Conectores OAuth PER-USER (Calendly y futuros GitHub/Slack/GCal). Modelo Cowork:
  // cada usuario conecta SU cuenta; @ghosty agenda/actúa con el token del que lo invoca.
  // Una fila por (usuario, proveedor). Tokens en la DB del tenant (no en compute), patrón
  // gc_stars/gt_announcement_seen. La def de cada proveedor vive en connectors/registry.ts.
  await exec(`CREATE TABLE IF NOT EXISTS gc_user_connectors (
    user_sub      TEXT NOT NULL,
    provider      TEXT NOT NULL,
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    INTEGER,
    external_id   TEXT,
    meta          TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_sub, provider)
  )`);

  // Última vez que se releyó el userinfo del proveedor. `meta` se capturaba UNA vez al
  // conectar y quedaba congelado para siempre: si el usuario creaba un negocio, cambiaba
  // de rol o de cuenta activa, el agente seguía viendo la foto del día que autorizó.
  // `created_at` no servía de marca (sólo se escribe en el INSERT, nunca en el UPDATE).
  // NULL = nunca refrescado → connectors/meta.server.ts lo trata como vencido, y así las
  // conexiones hechas antes de esta columna se auto-reparan solas.
  await addColumn("gc_user_connectors", "meta_at", "INTEGER");

  // Recordatorios programados. El agente los crea con una tool nativa y un tick del
  // proceso (server/reminders.server.ts) los dispara: cola en DB + poll, el patrón de
  // pg-boss/solid_queue. La verdad NUNCA vive en memoria — un reinicio del server no
  // puede perder un recordatorio, a lo sumo entregarlo tarde.
  //
  // `ns` en la fila porque el tick no tiene request del cual deducir el tenant, y una
  // caja sirve a varios workspaces (ver withNamespace en tenant.server.ts).
  // `channel_id` XOR `dm_id`: se entrega donde se pidió.
  await exec(`CREATE TABLE IF NOT EXISTS gc_reminders (
    id           TEXT PRIMARY KEY,
    ns           TEXT NOT NULL,
    owner_sub    TEXT NOT NULL,
    channel_id   INTEGER,
    dm_id        INTEGER,
    topic        TEXT NOT NULL DEFAULT 'general',
    agent_handle TEXT NOT NULL,
    agent_name   TEXT NOT NULL DEFAULT 'Ghosty',
    agent_avatar TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL,
    due_at       INTEGER NOT NULL,
    repeat       TEXT,
    tz           TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    fired_at     INTEGER,
    canceled_at  INTEGER
  )`);
  // El índice que usa el tick: "lo pendiente que ya venció".
  await exec(`CREATE INDEX IF NOT EXISTS gc_reminders_due ON gc_reminders(fired_at, due_at)`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_reminders_owner ON gc_reminders(owner_sub, due_at)`);

  // ¿Además del mensaje, correo? Se pregunta AL PROGRAMAR y se guarda por recordatorio:
  // querer un correo por el pago de la tarjeta no significa quererlo por todo.
  await addColumn("gc_reminders", "email", "INTEGER NOT NULL DEFAULT 0");

  // Copia del correo a direcciones sueltas (JSON array). Un recordatorio suele ser para
  // más de uno: "factura a Acali" también le sirve a quien la revisa.
  await addColumn("gc_reminders", "email_cc", "TEXT");

  // Zona horaria del usuario, capturada del navegador. Sin esto "mañana a las 9" es
  // ambiguo: todo el tiempo se guarda en epoch UTC y el server no sabe en qué reloj
  // vive quien pide el recordatorio.
  await addColumn("gc_users", "tz", "TEXT");

  // Flip único: correo por default OFF (opt-in). Las filas existentes heredaron el viejo
  // DEFAULT 1 (opt-out silencioso, nadie lo eligió conscientemente) → las apagamos una sola
  // vez, guardado por flag en gc_config. Reversible: el usuario lo reactiva en el panel.
  await flush();
  try {
    const { getConfig, setConfig } = await import("../config.server");
    if ((await getConfig("email_default_off_applied")) !== "1") {
      await exec("UPDATE gc_users SET email_notifs=0 WHERE COALESCE(email_notifs,1)=1");
      await setConfig("email_default_off_applied", "1");
    }
  } catch (e) {
    fails.push(`email_default_off → ${String(e).slice(0, 90)}`);
  }

  await flush();

  console.log(`[ensureSchema ${Math.round(performance.now() - _t0)}ms · ${_rtt} round-trips · ${fails.length} fallos]`);

  // Si algo falló (DB flapeando), LANZA → ensureSchema resetea `done` → reintento.
  if (fails.length) {
    throw new Error(`ensureSchema: ${fails.length} sentencia(s) fallaron, se reintentará: ${fails.join(" | ")}`);
  }
}
