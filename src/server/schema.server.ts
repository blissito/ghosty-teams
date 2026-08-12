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
        // Mismo patrón, misma razón: fuera de un request no hay host del que deducir el
        // tenant, así que los namespaces vivos se registran aquí — que es el "arranque" de
        // este workspace en este proceso.
        try {
          const { armFormWebhooks } = await import("./forms/webhooks.server");
          armFormWebhooks(ns);
        } catch { /* best-effort */ }
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
  // 1 mientras el agente ESCRIBE. La pone el escritor con throttle del streaming y la quita
  // cualquier escritura autoritativa del cuerpo. Sin esto, tras el cambio a persistencia
  // incremental un turno huérfano (deploy a media respuesta) ya no queda con el cuerpo
  // VACÍO, así que `sweepOrphans` dejaba de reconocerlo y la burbuja se quedaba
  // "trabajando" para siempre.
  await addColumn("gc_messages", "streaming", "INTEGER NOT NULL DEFAULT 0");
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
  // Papelera para los SUBIDOS (2026-08-03). Misma semántica que en gc_artifacts.
  //
  // Al principio la papelera era sólo para lo REDACTADO por el agente, con el argumento de
  // que un archivo subido "vive con su mensaje". Se probó y no se sostiene: en un caso
  // real la mitad del panel son los .docx que subió la persona, y no poder quitarlos deja
  // el expediente lleno de ruido — que fue justo lo que se reportó.
  await addColumn("gc_attachments", "archived_at", "INTEGER");
  await addColumn("gc_attachments", "purge_at", "INTEGER");
  await exec("CREATE INDEX IF NOT EXISTS gc_attachments_purge ON gc_attachments(purge_at)");
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
  //   share_role  QUÉ puede hacer quien llega por el link: 'view' (default) | 'comment' |
  //               'edit'. Antes el acceso era binario —ver el documento— y la co-edición
  //               colgaba de un token de EDICIÓN aparte, así que compartir una liga era
  //               todo-o-nada. Vive junto a las otras tres columnas de compartir: en la
  //               fila RAÍZ, resuelta con shareRootFor(). null = 'view' (las filas previas
  //               a esta columna se compartieron para leer, no para editar).
  await addColumn("gc_artifacts", "share_role", "TEXT");
  // Quiénes co-editaron en la sesión que produjo esta versión (JSON de `sub`). Es el
  // primer escalón de "¿quién escribió qué?": atribución por SESIÓN, no por párrafo.
  await addColumn("gc_artifacts", "authors", "TEXT");
  // ── Papelera (2026-08-03) ────────────────────────────────────────────────────
  //   archived_at  unix; NULL = vivo. El documento sale del panel y su liga pública
  //                deja de servir, pero se puede restaurar.
  //   purge_at     unix; cuándo se borra DE VERDAD. Se sella al archivar.
  //
  // Antes no había forma de quitar un documento: la única vía era borrar el mensaje que
  // lo produjo, y eso lo destruía en duro, sin retención y sin aviso. Un documento es el
  // entregable —con liga, versiones y export—, así que merece una papelera propia y no
  // colgar de un mensaje de chat.
  //
  // ⚠️ Van en TODAS las filas del documento, no sólo en una: un documento son N filas con
  // el mismo `url` (cada publicación es un INSERT). Las consultas van `WHERE url = ?`.
  //
  // ⚠️ La fila RAÍZ (la más vieja) sigue siendo especial: ahí viven share_slug/
  // share_visibility/share_role. Archivar la marca como privada pero NO la borra ni le
  // quita el slug — sin el slug no se podría restaurar el acceso al recuperarla.
  await addColumn("gc_artifacts", "archived_at", "INTEGER");
  await addColumn("gc_artifacts", "purge_at", "INTEGER");
  // Índice para el barrido de purga: busca por fecha, no por documento.
  //
  // ⚠️ `exec`, NO `dbq` directo. Las sentencias se ACUMULAN en `pending` y sólo salen en
  // el `flush`; un `dbq` se salta la cola y corre ANTES que los ALTER de arriba, así que
  // el índice se creaba sobre una columna que todavía no existía y el arranque reportaba
  // "1 fallos" sin decir cuál.
  await exec("CREATE INDEX IF NOT EXISTS gc_artifacts_purge ON gc_artifacts(purge_at)");
  // Caducidad de una invitación nominal (unix, NULL = sin fecha). "Puede comentar hasta
  // el 15" es lo que pide el trabajo con clientes: el acceso se da para algo concreto y
  // debería apagarse solo cuando eso termina.
  await addColumn("gc_doc_invites", "expires_at", "INTEGER");

  // Invitación NOMINAL a co-editar un documento: el segundo nivel de compartir.
  //
  // El enlace abierto (`share_role`) da acceso pero NO identidad: quien entra escribe el
  // nombre que quiera. Aquí el token viaja a UN correo concreto, así que quien lo abre ES
  // esa persona — atribuible sin obligarla a crearse cuenta. Es el patrón de Google
  // (visitor sharing con PIN al correo) y de Figma (guests por correo).
  //
  //   token      secreto de la liga; único, es la credencial
  //   role       nivel de ESTA invitación (puede diferir del enlace abierto)
  //   revoked_at retirar el acceso sin borrar el rastro de que se invitó
  //   used_at    primera vez que se abrió (para "invitada, aún no entra")
  await exec(`CREATE TABLE IF NOT EXISTS gc_doc_invites (
    id          INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL,
    email       TEXT NOT NULL,
    name        TEXT,
    role        TEXT NOT NULL DEFAULT 'edit',
    token       TEXT NOT NULL,
    invited_by  TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    used_at     INTEGER,
    revoked_at  INTEGER
  )`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS gc_doc_invites_token ON gc_doc_invites(token)`);
  await exec(`CREATE INDEX IF NOT EXISTS gc_doc_invites_doc ON gc_doc_invites(document_id)`);
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

  // Última entrega de ARCHIVO del agente en una conversación (un PDF de `pdf-doc`, un
  // .docx, un .xlsx — todo lo que llega por ```eb-file```).
  //
  // Existe porque `gc_thread_artifact` sólo conoce doc/sheet/artifact: un archivo no mueve
  // ese puntero, así que tras entregar un PDF el hilo seguía "apuntando" al último
  // artefacto HTML. Un "brandéalo" a continuación parcheaba ESE artefacto —una landing de
  // diez minutos antes— en vez de regenerar el PDF (medido el 2026-08-08). Con esto,
  // `artifactDocHint` puede comparar fechas y decirle al agente qué entregó de último.
  //
  // Misma `conv_key` que gc_thread_artifact (`<canal>:<hilo>` o `dm:<id>`) a propósito: es
  // la misma identidad conversacional y así las dos se leen juntas sin traducir claves.
  await exec(`CREATE TABLE IF NOT EXISTS gt_thread_delivery (
    conv_key   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    mime       TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
  // Alcance WORKSPACE (2026-08-08): la misma tabla guarda la memoria del workspace —
  // hechos de la empresa compartidos entre rooms y agentes. scope_key='ws' (imposible
  // en el formato 'ch:'/'dm:', no colisiona) y agent_handle='' (compartida). Con título
  // estilo índice MEMORY.md; source_ref apunta al origen (mensaje/adjunto destilado).
  // UNA memoria con dos niveles, no dos sistemas: mismas tools, mismo bloque en el turno.
  await addColumn("gt_agent_memory", "title", "TEXT");
  await addColumn("gt_agent_memory", "source_ref", "TEXT");

  // Documentos fuente de la memoria (patrón DESCTI): un manual/PDF soltado en /memory se
  // registra aquí, viaja al DM del agente para destilarse, y las notas que salen llevan
  // source_ref='doc:<id>'. El archivo vive en storage como cualquier adjunto (file_id);
  // borrar la fila NO borra las notas — el conocimiento destilado sobrevive a su fuente.
  await exec(`CREATE TABLE IF NOT EXISTS gt_memory_docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    mime        TEXT,
    size        INTEGER,
    dm_id       INTEGER,
    uploaded_by TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

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
  // Conexión DEL EQUIPO: la conectó una persona pero la usa todo el workspace. Es el
  // modelo "workspace connection" de ClickUp/Notion/Linear, y lo que hace que un cliente
  // conecte su Sentry UNA vez y podamos ayudarle sin que nos dé cuenta en su Sentry.
  // `0` = personal, o sea el comportamiento de siempre: nada cambia para quien no la use.
  await addColumn("gc_user_connectors", "shared", "INTEGER NOT NULL DEFAULT 0");

  // Bitácora de compartir/dejar de compartir. Existe porque staff y owner pueden compartir
  // la conexión de OTRO —es lo que destraba el caso de alguien ausente— y una cuenta ajena
  // usándose por el equipo no puede quedar sin rastro de quién lo autorizó y cuándo.
  await exec(`CREATE TABLE IF NOT EXISTS gt_connector_shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    actor_sub  TEXT NOT NULL,
    owner_sub  TEXT NOT NULL,
    provider   TEXT NOT NULL,
    shared     INTEGER NOT NULL
  )`);
  await exec("CREATE INDEX IF NOT EXISTS gt_connector_shares_at ON gt_connector_shares(at)");

  // Webhooks ENTRANTES que hemos dado de alta en la cuenta de un proveedor (hoy: alertas
  // de Sentry hacia un canal). Es el gemelo de `gt_form_hooks`, y existe por la misma
  // razón: un recurso que vive FUERA necesita fila propia o no se puede deshacer.
  //
  // ⚠️ Sin esto, desconectar el conector dejaba el webhook vivo en el Sentry del cliente
  // para siempre: se revoca el token y con él se pierde la única forma de quitarlo. Se
  // guardan `org` y `project` porque son exactamente lo que hace falta para desregistrarlo,
  // y `owner_sub` porque es la cuenta que lo sostiene (que puede no ser quien lo pidió,
  // cuando se usó una conexión compartida).
  await exec(`CREATE TABLE IF NOT EXISTS gt_connector_hooks (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    owner_sub  TEXT NOT NULL,
    channel_id INTEGER NOT NULL,
    org        TEXT NOT NULL,
    project    TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(
    "CREATE INDEX IF NOT EXISTS gt_connector_hooks_owner ON gt_connector_hooks(owner_sub, provider)"
  );
  await exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS gt_connector_hooks_uniq ON gt_connector_hooks(provider, channel_id, org, project)"
  );

  // Los repos que un room declara suyos. Es la FRONTERA del conector de GitHub, no una
  // comodidad: sin esto, en cualquier room el agente podía leer cualquier repo al que
  // alcanzara el token de quien preguntó, y volcarlo a gente que en GitHub no tiene ese
  // acceso. Con la fila, el agente sólo ve estos repos; sin ninguna fila, no ve ninguno.
  //
  // Es el modelo de hilos ("the repository linked to that specific channel"), del
  // /github subscribe de Slack y del default repository de Copilot. Varios por room a
  // propósito: un equipo chico toca 2-3 repos en el mismo canal y forzar 1:1 crea canales
  // basura.
  //
  // ⚠️ Esto ESTRECHA, nunca amplía: conectar un repo no le da acceso a nadie. Quién puede
  // tocarlo lo sigue decidiendo GitHub, con el token de cada quien.
  //
  // `connected_by` no es bitácora: la lista de repos depende de la INSTALACIÓN de la App de
  // cada persona, así que dos miembros del mismo room ven conjuntos distintos. Cuando a uno
  // le sale 404 sobre un repo que otro conectó, es la única forma de decirle de quién es la
  // instalación en vez de dejarle creer que el repo no existe.
  await exec(`CREATE TABLE IF NOT EXISTS gt_room_repos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id   INTEGER NOT NULL,
    repo         TEXT NOT NULL,
    connected_by TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS gt_room_repos_uniq ON gt_room_repos(channel_id, repo)"
  );
  await exec("CREATE INDEX IF NOT EXISTS gt_room_repos_chan ON gt_room_repos(channel_id)");

  // El tablero de Ghosty Tasks que este room viene usando. Se escribe SOLA la primera vez
  // que una petición resuelve uno ahí: no hay nada que configurar antes de que sirva.
  //
  // ⚠️ Es un DEFAULT recordado, **no una frontera** — al revés que `gt_room_repos`, que sí lo
  // es. Aquí se quiere que varios rooms miren tableros distintos sin cerrarle la puerta a
  // ninguno: nombrar otro en el turno lo pisa. Lo que evita el abuso es que Tasks aplica
  // `requireProjectMember` con el `sub` de quien invocó, así que el room puede nombrar un
  // tablero y aun así no enseñárselo a quien no es miembro.
  //
  // `project_id` apunta a `task_projects`, que vive en ESTA MISMA base: Teams y Tasks
  // comparten namespace. Sin FK a propósito — el esquema de Tasks lo crea su propio
  // `ensureSchema()`, que puede no haber corrido todavía en un workspace que nunca abrió el
  // tablero, y una FK a una tabla inexistente rompería la migración de Teams.
  await exec(`CREATE TABLE IF NOT EXISTS gt_room_board (
    channel_id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    set_by     TEXT NOT NULL,
    at         INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

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

  // ── Formularios NATIVOS de intake ────────────────────────────────────────────
  // Sustituyen el puente a EasyBits Forms (`gc_expediente_forms` + el webhook firmado),
  // que nunca funcionó: nadie insertaba el mapeo form→canal, así que todo submit salía
  // "unmapped" y /forms siempre estaba vacío.
  //
  // El formulario público ES un artefacto (`kind:"artifact"`, share "link"): el HTML vive en
  // `gc_artifacts.md` y la liga que se reparte es /artefacto/<slug>. Esta tabla NO duplica
  // eso — guarda a QUÉ conversación pertenece, su schema de campos y sus contadores.
  //
  // `ns` es la única columna redundante con "la DB ya es por workspace", y es imprescindible:
  // el formulario se responde desde el host de artefactos y desde un iframe de origen opaco,
  // donde el subdominio NO identifica al tenant. Va firmada en el token del formulario y el
  // endpoint entra con `withNamespace(ns, …)`.
  await exec(`CREATE TABLE IF NOT EXISTS gt_forms (
    id                TEXT PRIMARY KEY,
    ns                TEXT NOT NULL,
    channel_id        INTEGER NOT NULL,
    topic             TEXT NOT NULL DEFAULT 'general',
    anchor_message_id INTEGER,
    title             TEXT NOT NULL,
    schema_json       TEXT NOT NULL,
    intro             TEXT,
    thanks            TEXT,
    owner_sub         TEXT,
    agent_handle      TEXT,
    agent_name        TEXT,
    agent_avatar      TEXT,
    document_id       TEXT,
    share_slug        TEXT,
    origin            TEXT,
    status            TEXT NOT NULL DEFAULT 'open',
    submission_count  INTEGER NOT NULL DEFAULT 0,
    last_submitted_at INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gt_forms_chan ON gt_forms(channel_id)`);

  // La HOJA de respuestas: UN artefacto por formulario que crece con cada respuesta, en vez
  // de un documento por respuesta (a las 100 nadie abre 100 archivos). Se REconstruye entera
  // desde gt_form_submissions en cada envío: la verdad es la tabla y la hoja una proyección.
  //
  // ⚠️ Va por `addColumn` y NO dentro del CREATE de arriba: `CREATE TABLE IF NOT EXISTS` no
  // toca una tabla que YA existe, así que en cualquier tenant con formularios ya creados las
  // columnas nunca habrían aparecido — y el SELECT las pide, o sea que TODO submit
  // respondía 500. Pasó en producción el 2026-07-29, con el formulario ya repartido.
  await addColumn("gt_forms", "sheet_document_id", "TEXT");
  await addColumn("gt_forms", "sheet_message_id", "INTEGER");
  // Idioma del formulario público. Se fija al crearlo porque su HTML se HORNEA al publicar
  // y quien responde lo abre sin cookie ni sesión (iframe de origen opaco): no hay nada que
  // mirar en tiempo de lectura. Default 'es' → los formularios que ya existen no cambian.
  await addColumn("gt_forms", "locale", "TEXT NOT NULL DEFAULT 'es'");
  // La FICHA por respuesta: un documento con lo que contestó UNA persona. 'off' | 'auto'.
  //
  // Nace apagada a propósito. Existió automática (3242eca) y se quitó (9b06121) porque
  // duplicaba en cada envío el trabajo que ya hace la hoja y llenaba el hilo de tarjetas
  // que nadie abría. Vuelve porque para un expediente sí se quiere el documento de UNA
  // respuesta — pero bajo demanda, y colgado del hilo de la hoja en vez de al lado de ella.
  await addColumn("gt_forms", "ficha_mode", "TEXT NOT NULL DEFAULT 'off'");
  // Días que vive un borrador de "guardar y continuar". 0 = APAGADO, y es el default: un
  // enlace de reanudación es un bearer sobre un intake a medio llenar, así que un formulario
  // sensible simplemente no tiene esa superficie a menos que se pida.
  await addColumn("gt_forms", "draft_ttl_days", "INTEGER NOT NULL DEFAULT 0");

  // Las respuestas. `data_json` = sólo los campos VISIBLES (un campo oculto por showIf no
  // tiene respuesta que registrar). La IP se guarda HASHEADA: sirve para el rate limit y
  // para investigar abuso, no para identificar a quien contesta.
  await exec(`CREATE TABLE IF NOT EXISTS gt_form_submissions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id           TEXT NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_hash           TEXT,
    data_json         TEXT NOT NULL,
    files_json        TEXT,
    message_id        INTEGER,
    ficha_document_id TEXT,
    idem_key          TEXT
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS gt_form_subs_form ON gt_form_submissions(form_id, id DESC)`);
  // El mensaje donde vive la ficha. `ficha_document_id` ya existía (es de 3242eca); éste
  // hacía falta para poder abrirla sin recorrer el hilo.
  await addColumn("gt_form_submissions", "ficha_message_id", "INTEGER");
  // La idempotencia REAL: el cliente manda la misma `_idem` en cada reintento, así que un
  // doble clic o un retry de red no pueden crear dos respuestas ni dos fichas.
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS gt_form_subs_idem ON gt_form_submissions(idem_key)`);

  // Archivos que sube quien responde. La respuesta guarda sólo el `file_id` (la key del
  // bucket PRIVADO); aquí vive su metadata, que es lo único en lo que confiamos para
  // nombrar el archivo en la ficha — el nombre lo manda un tercero y acaba impreso en un
  // expediente. También es la tabla que AUTORIZA la descarga: sin una fila que ate el
  // archivo a un formulario, nadie puede pedirlo.
  await exec(`CREATE TABLE IF NOT EXISTS gt_form_files (
    file_id    TEXT PRIMARY KEY,
    form_id    TEXT NOT NULL,
    field      TEXT NOT NULL,
    name       TEXT,
    mime       TEXT,
    size       INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Rate limit en la DB, no en memoria del proceso: un límite in-process no sobrevive un
  // deploy ni sirve con más de un proceso, y era justo el agujero del original (que además
  // se SALTABA el límite cuando no podía leer la IP).
  /**
   * Turnos de agente. El registro que hasta el 2026-08-03 vivía SÓLO en memoria del proceso.
   *
   * Cada hot-deploy —y hubo una docena en un día— se llevaba los turnos vivos: el worker
   * seguía trabajando, la burbuja se quedaba esperando y el resultado se perdía sin que nadie
   * se enterara. De ahí salieron un documento terminado que nunca se publicó y dos turnos en
   * los que el agente juraba haber entregado algo inexistente.
   *
   * ⚠️ La tabla NO reemplaza al mapa en memoria: el `AbortController` es del proceso, así que
   * el mapa sigue siendo quien puede CORTAR un turno y la tabla es quien SABE que existe. Al
   * arrancar, todo lo que quedó `running` de otro proceso es huérfano por definición.
   */
  await exec(`CREATE TABLE IF NOT EXISTS gt_turns (
    message_id  INTEGER PRIMARY KEY,
    group_id    TEXT NOT NULL,
    invoker_sub TEXT,
    channel_id  INTEGER,
    parent_id   INTEGER,
    agent       TEXT,
    avatar      TEXT,
    tarea       TEXT,
    paso        TEXT,
    state       TEXT NOT NULL DEFAULT 'running',
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    outcome     TEXT
  )`);
  // Para el barrido de huérfanos al arrancar y para listar lo vivo sin recorrer la tabla.
  await exec("CREATE INDEX IF NOT EXISTS gt_turns_state ON gt_turns(state, started_at)");

  // Borradores de "guardar y continuar". Un intake patrimonial son 60+ preguntas y hoy quien
  // lo abandona pierde todo.
  //
  // ⚠️ La fila NO se puede leer con el `draft_id` a secas: se entra con un token FIRMADO que
  // viaja en el fragmento de la URL. Enumerar la tabla no da lectura, y el fragmento no llega
  // al servidor (ni a los logs de acceso, ni al `Referer`). `expires_at` es obligatorio: un
  // intake a medio llenar no puede quedarse ahí para siempre.
  await exec(`CREATE TABLE IF NOT EXISTS gt_form_drafts (
    draft_id   TEXT PRIMARY KEY,
    form_id    TEXT NOT NULL,
    ip_hash    TEXT,
    data_json  TEXT NOT NULL,
    step       INTEGER NOT NULL DEFAULT 0,
    writes     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  )`);
  await exec("CREATE INDEX IF NOT EXISTS gt_form_drafts_exp ON gt_form_drafts(expires_at)");
  // Para el tope de borradores vivos por IP, que es lo que impide llenar la tabla.
  await exec("CREATE INDEX IF NOT EXISTS gt_form_drafts_ip ON gt_form_drafts(form_id, ip_hash)");

  // Salida a otro sistema. Cada vertical tiene su CRM, y es lo que vuelve integrable un
  // producto multi-vertical sin escribir una línea por cliente.
  //
  // ⚠️ `enabled` nace en 0 SIEMPRE y sólo lo prende el dueño autenticado tras un ping
  // firmado que conteste 2xx. El riesgo real de esto no es técnico: es mandar un intake
  // médico a la URL equivocada, en automático y para siempre. El agente PROPONE la URL; no
  // la habilita.
  //
  // El secreto es POR HOOK. `GHOSTY_PARTNER_SECRET` no se le entrega a un tercero jamás —
  // es la raíz de auth del IdP, del token del formulario y del hash de las IPs.
  await exec(`CREATE TABLE IF NOT EXISTS gt_form_hooks (
    id              TEXT PRIMARY KEY,
    form_id         TEXT NOT NULL,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 0,
    include_files   INTEGER NOT NULL DEFAULT 0,
    disabled_reason TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec("CREATE INDEX IF NOT EXISTS gt_form_hooks_form ON gt_form_hooks(form_id)");

  // Una fila por (hook, respuesta). El UNIQUE ES la idempotencia: un reintento nuestro
  // nunca puede crear dos entregas, y el tercero puede confiar en el `Delivery` como clave.
  // Es el `gt_email_log` de esto, pero con estado.
  await exec(`CREATE TABLE IF NOT EXISTS gt_form_deliveries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_id       TEXT NOT NULL,
    submission_id INTEGER NOT NULL,
    form_id       TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    last_status   INTEGER,
    last_error    TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS gt_form_deliv_once ON gt_form_deliveries(hook_id, submission_id)"
  );
  // El barrido pide exactamente esto: lo pendiente que ya toca.
  await exec("CREATE INDEX IF NOT EXISTS gt_form_deliv_due ON gt_form_deliveries(state, next_at)");

  await exec(`CREATE TABLE IF NOT EXISTS gt_form_rate (
    form_id      TEXT NOT NULL,
    bucket       TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (form_id, bucket, window_start)
  )`);

  // Webhooks ENTRANTES (hoy: alertas de Sentry). Dos tablas chicas con un trabajo cada una.
  //
  // Idempotencia: Sentry reintenta las entregas y una alerta repetida en un canal es ruido
  // que se nota de inmediato. La clave es el id del evento del proveedor, no un hash del
  // cuerpo — el mismo evento puede llegar con metadatos distintos.
  await exec(`CREATE TABLE IF NOT EXISTS gt_hook_seen (
    event_id TEXT PRIMARY KEY,
    at       INTEGER NOT NULL
  )`);
  await exec("CREATE INDEX IF NOT EXISTS gt_hook_seen_at ON gt_hook_seen(at)");

  // Tope de escritura. Un despliegue roto genera miles de eventos en minutos y sin esto el
  // canal queda enterrado. Es por CANAL, no por proveedor: lo que hay que proteger es la
  // conversación de la gente.
  await exec(`CREATE TABLE IF NOT EXISTS gt_hook_rate (
    channel_id   INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, window_start)
  )`);

  // ── WhatsApp Business ─────────────────────────────────────────────────────────
  // Un número conectado por Formmy (que es el BSP: tiene el App Secret de Meta y la
  // Integration con el token). De su lado sólo guardamos lo necesario para reconocer
  // la entrega y para pedirle a Formmy que envíe: NUNCA el token de Meta.
  //
  // `room_id` es el room DESTINO, elegido al conectar. `acting_sub` es en nombre de
  // quién trabaja el agente cuando escribe un desconocido — un contacto de WhatsApp no
  // tiene sesión, así que sin esto un turno saldría sin conectores y sin nadie que
  // pueda detenerlo. Se llena aquí y lo consume la fase de respuesta.
  await exec(`CREATE TABLE IF NOT EXISTS gt_wa_channels (
    integration_id TEXT PRIMARY KEY,
    phone          TEXT NOT NULL,
    channel_secret TEXT NOT NULL,
    room_id        INTEGER NOT NULL,
    agent_handle   TEXT,
    acting_sub     TEXT,
    created_at     INTEGER NOT NULL
  )`);

  // ── CADENA (migración de un número que ya tenía dueño) ───────────────────────
  // `Integration.externalAgentUrl` de Formmy es UNO por integración: apuntarlo aquí deja
  // mudo a quien contestaba antes. Con estas dos columnas el hook publica en el room Y
  // reenvía el body VERBATIM al destino anterior con SU secreto, así nadie se queda mudo
  // durante la convivencia. Vacío = sin cadena, que es el caso normal.
  //
  // ⚠️ Columnas nuevas por addColumn, NUNCA dentro del CREATE TABLE de arriba: una tabla
  // que ya existe no se re-crea y el campo no aparecería jamás.
  await addColumn("gt_wa_channels", "chain_url", "TEXT");
  await addColumn("gt_wa_channels", "chain_secret", "TEXT");

  // Un HILO por contacto. `thread_id` es el mensaje raíz (la cabecera del contacto);
  // cada mensaje que llega cuelga de él como respuesta.
  //
  // La clave es (integration_id, phone) y no el teléfono solo: dos números conectados
  // pueden hablar con el MISMO contacto, y compartir hilo mezclaría dos conversaciones
  // distintas en la misma pantalla.
  await exec(`CREATE TABLE IF NOT EXISTS gt_wa_threads (
    integration_id TEXT NOT NULL,
    phone          TEXT NOT NULL,
    thread_id      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (integration_id, phone)
  )`);

  // Estado de atención de cada conversación. Por `addColumn`: la tabla ya existe en los
  // tenants vivos y un CREATE TABLE IF NOT EXISTS no la re-crearía.
  //
  // `paused_until` = alguien del equipo tomó la conversación y el agente se calla. **Con
  // fecha, nunca un booleano**: una pausa que no caduca convierte "atiendo yo esto" en un
  // cliente abandonado en silencio semanas después. Lo despausa el tiempo o una persona.
  await addColumn("gt_wa_threads", "paused_until", "INTEGER");
  await addColumn("gt_wa_threads", "paused_by", "TEXT");
  await addColumn("gt_wa_threads", "last_message_at", "INTEGER");
  await addColumn("gt_wa_threads", "contact_name", "TEXT");

  // Límite de turnos por contacto (ver whatsapp/rate.server.ts). Gemela de gt_form_rate.
  await exec(`CREATE TABLE IF NOT EXISTS gt_wa_rate (
    bucket       TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
  )`);

  // Bitácora de los correos que manda el AGENTE (tool `email_send`). Append-only y aparte
  // del log de SES: un envío saliente a terceros, con nuestro dominio en el From y texto
  // escrito por un modelo, tiene que poder reconstruirse ante un reporte de abuso — quién lo
  // pidió, a quién fue y si llevaba adjunto. `console.log` no es una respuesta a eso.
  await exec(`CREATE TABLE IF NOT EXISTS gt_email_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sub        TEXT NOT NULL,
    to_addrs   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    attached   TEXT,
    ok         INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_email_log_sub ON gt_email_log (sub, created_at)`);

  // La MARCA del workspace. Varios kits, uno activo — un despacho lleva un kit por cliente
  // y quien sólo tiene marca propia nace con uno.
  //
  // Se guarda MUY poco a propósito: cuatro colores, dos fuentes y los logos. Todo lo demás
  // (capas de superficie, bordes, color de TEXTO, modo oscuro) se deriva en
  // `src/lib/brand-tokens.ts`, que es isomorfo y por eso el panel pinta exactamente lo que
  // se hornea. Capturar el texto en la fila es justo el bug de EasyBits: su
  // `brandKitToDirection` lo tiene fijo en "#1a1a1a" y un kit oscuro sale ilegible.
  //
  // Del logo se guarda la KEY del bucket público, no la URL: `publicUrl(key)` al leer, así
  // un cambio de endpoint de storage no deja las filas apuntando a ninguna parte.
  await exec(`CREATE TABLE IF NOT EXISTS gt_brand_kits (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    colors_json   TEXT NOT NULL,
    fonts_json    TEXT,
    logo_key      TEXT,
    logo_dark_key TEXT,
    mood          TEXT,
    is_active     INTEGER,
    created_by    TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  // ⚠️ El índice parcial hace IMPOSIBLE el estado de dos kits activos. En EasyBits el
  // `isDefault` se sostiene con dos writes sin transacción (brandKitOperations.ts:53-58) y
  // dos pestañas activando a la vez dejan la marca indeterminada. Por eso `is_active` admite
  // NULL en vez de `NOT NULL DEFAULT 0`: en SQLite los NULL no chocan en un UNIQUE, así que
  // sólo la fila con 1 participa del índice.
  await exec("CREATE UNIQUE INDEX IF NOT EXISTS gt_brand_active ON gt_brand_kits(is_active) WHERE is_active = 1");

  // ── Salas de evento (webinar y taller) ─────────────────────────────────────
  // Un room del workspace puede ser la puerta de un evento abierto: la comunidad
  // entra por liga, sin cuenta y sin ocupar asiento.
  //
  // ⚠️ `public_access` NO es `is_private = 0`. Ese cero significa hoy "lo ve todo
  // el WORKSPACE", que es una frontera distinta y mucho más estrecha que "lo ve
  // internet". Son tres estados y sobrecargar la columna vieja abriría canales
  // internos al mundo por accidente.
  await addColumn("gc_channels", "call_mode", "TEXT");          // webinar | taller | NULL (room normal)
  await addColumn("gc_channels", "call_share_slug", "TEXT");    // la liga pública
  await addColumn("gc_channels", "call_livekit_url", "TEXT");   // a qué caja va; NULL = la de siempre
  await addColumn("gc_channels", "call_title", "TEXT");         // el nombre del evento, no el del room
  await addColumn("gc_channels", "public_access", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("gc_channels", "agent_enabled", "INTEGER NOT NULL DEFAULT 0");
  // ⚠️ DESDE CUÁNDO es público, y por qué importa: sin esto, convertir en abierto un room
  // que ya existía publicaba TODO lo que el equipo había escrito ahí antes. El camino
  // público servía los últimos 200 mensajes del room sin ningún corte de fecha, y con
  // cualquier workspace pudiendo abrir rooms, eso es una fuga esperando a pasar.
  //
  // Se sella la PRIMERA vez que se abre y no se vuelve a tocar: cerrar y reabrir no puede
  // regalar el intervalo en que estuvo cerrado.
  await addColumn("gc_channels", "public_since", "INTEGER");
  // ¿La sala de video está abierta a la comunidad? Lo decide el dueño y es aparte de
  // `public_access`: la caja de LiveKit se puede apagar entre eventos, o dejar encendida
  // como un canal de voz de Discord. Apagado = ni se ofrece el botón. Un botón que lleva
  // a una sala muerta es peor que no tener botón.
  await addColumn("gc_channels", "call_open", "INTEGER NOT NULL DEFAULT 0");
  // Cuándo empieza (epoch, UTC). NULL = room siempre abierto, sin evento — que es un caso
  // legítimo y no un dato faltante: un canal de comunidad no tiene hora.
  //
  // ⚠️ Se guarda en UTC y se pinta en el reloj de CADA visitante. Un webinar se anuncia a
  // gente de varias zonas horarias, y una hora en el huso del dueño es una hora equivocada
  // para casi todos los demás.
  await addColumn("gc_channels", "starts_at", "INTEGER");
  // La grabación, YA SUBIDA. Vive aquí y no en la caja porque la caja hiberna y el janitor
  // la recicla a las 72 h: sin esto, la grabación de un webinar desaparece el fin de semana.
  await addColumn("gc_channels", "call_recording_url", "TEXT");
  await addColumn("gc_channels", "call_recorded_at", "INTEGER");
  // Grabación EN CURSO. Va en la DB y no en la memoria del navegador de quien la empezó:
  // si recarga, si entra otro que también modera, o si abre el room en el teléfono, todos
  // tienen que ver lo MISMO. Un botón que dice "Grabar" mientras se está grabando es cómo
  // se acaba con dos grabaciones, o con una que nadie detiene.
  await addColumn("gc_channels", "call_recording_by", "TEXT");
  await addColumn("gc_channels", "call_recording_since", "INTEGER");
  // Las filas que YA estaban abiertas cuando llegó esta columna se sellan ahora mismo. Es
  // el lado seguro del error: se pierde de vista lo que la comunidad escribió antes de la
  // migración, pero no se publica nada que estuviera dentro.
  await exec(
    "UPDATE gc_channels SET public_since = unixepoch() WHERE public_access = 1 AND public_since IS NULL"
  );
  await exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS gc_channels_share ON gc_channels(call_share_slug) WHERE call_share_slug IS NOT NULL"
  );

  // Quién se registró. Es la lista del evento (y la que se pasa al CRM), y de paso
  // la única forma de cortarle el paso a alguien: el baneo es por correo.
  await exec(`CREATE TABLE IF NOT EXISTS gt_event_registrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    guest_sub   TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER,
    ip_hash     TEXT,
    banned      INTEGER NOT NULL DEFAULT 0
  )`);
  // ⚠️ Las grabaciones son MUCHAS, y por eso son una TABLA. `call_recording_url` es un
  // solo campo: la segunda grabación pisaba a la primera y su enlace desaparecía aunque el
  // MP4 siguiera en storage. Pasó el 2026-08-12 con dos grabaciones seguidas.
  //
  // Se guarda la CLAVE, no la URL: una URL firmada caduca a los 7 días y guardarla es
  // guardar algo que dejará de funcionar sin que nadie se entere. Se firma al leer.
  await exec(`CREATE TABLE IF NOT EXISTS gt_event_recordings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    transcript_key TEXT,
    bytes       INTEGER,
    started_at  INTEGER,
    ended_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    by_name     TEXT
  )`);
  // ⚠️ El nombre DENTRO de la caja, explícito. No se puede deducir de `storage_key`: la
  // clave es `t3/<uuid>-<archivo>` y el uuid lleva guiones, así que cualquier intento de
  // partirla acaba recortando el nombre. Hace falta para ir a buscar el transcript después.
  await addColumn("gt_event_recordings", "box_file", "TEXT");
  await exec("CREATE INDEX IF NOT EXISTS gt_event_rec_ch ON gt_event_recordings(channel_id, ended_at)");

  // Una persona, una fila por evento: si vuelve a registrarse se actualiza, no se
  // duplica — un registro duplicado inflaría la lista y rompería el baneo.
  await exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS gt_event_reg_uniq ON gt_event_registrations(channel_id, email)"
  );
  await exec(
    "CREATE INDEX IF NOT EXISTS gt_event_reg_ch ON gt_event_registrations(channel_id, id DESC)"
  );
  // ── Correo VERIFICADO ───────────────────────────────────────────────────────
  // El registro nació sin verificar nada: cualquiera ponía un correo inventado y entraba.
  // Eso hacía dos cosas mal a la vez — el baneo por correo se saltaba escribiendo otro, y
  // la lista de asistentes (que es el objetivo comercial de un room abierto: una lista de
  // suscriptores) quedaba llena de basura.
  //
  // Código de 6 dígitos en la MISMA página, no magic link: una liga por correo abre una
  // pestaña nueva y la persona pierde el room donde estaba, que en un evento en vivo es
  // justo cuando peor cae.
  //
  // ⚠️ Se guarda el HASH, no el código. Es un secreto de un solo uso, y la lista de
  // asistentes es de las tablas que más se leen a mano.
  await addColumn("gt_event_registrations", "verify_code_hash", "TEXT");
  await addColumn("gt_event_registrations", "verify_expires_at", "INTEGER");
  await addColumn("gt_event_registrations", "verify_attempts", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("gt_event_registrations", "verified_at", "INTEGER");
  // ⚠️ Las filas ANTERIORES a esto se dan por verificadas: se registraron cuando no había
  // nada que verificar, y dejarlas sin sellar les cerraría la puerta a personas que ya
  // habían entrado. La lista limpia empieza a contar desde aquí.
  await exec(
    "UPDATE gt_event_registrations SET verified_at = created_at WHERE verified_at IS NULL"
  );

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
