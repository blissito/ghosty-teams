import { createServerFn } from "@tanstack/react-start";

// ── Estudio de artefactos / Documentos del team ──────────────────────────────
// Lista TODOS los documentos del team en un solo lugar (patrón Zulip "Uploaded
// files" + tiles Cowork): los GENERADOS por el agente (gc_artifacts: doc/sheet/
// office/html — el eb-doc en vivo) y los SUBIDOS por el usuario (gc_attachments:
// pdf/office arrojados al chat, ya en EasyBits privado). Cada uno se abre en el
// ArtifactPanel (visor). No inventa storage: reusa las tablas que ya existen.

export type TeamDocument = {
  key: string;
  source: "generated" | "uploaded";
  kind: "doc" | "sheet" | "office" | "pdf" | "html" | "image" | "file";
  title: string;
  channelId: number;
  channelName: string | null;
  channelSlug: string | null;
  /** DM del que viene el documento. Presente SÓLO para los de un mensaje directo.
   *  No se reutiliza `channelId` con un id sintético: alimenta también `threadRootId`
   *  y la clave de agrupación, y un valor inventado se propaga a sitios que esperan
   *  un canal real. */
  dmId?: number;
  /** Quién MÁS ve este documento. Decide la marca del grupo.
   *
   *  - `"solo"`    — nadie más: un DM con el agente.
   *  - `"conmigo"` — un DM 1:1: `audienceNames` trae a la otra persona.
   *  - `"privado"` — un canal privado: lo ven sus miembros, que no se enumeran aquí.
   *  - ausente     — canal público, sin marca.
   *
   *  Son cuatro estados y no un booleano porque «Sólo tú», «Tú y Rodrigo» y «Privado»
   *  dicen cosas distintas. Colapsarlos —rotular «Sólo tú» un DM de dos, o un canal
   *  privado con miembros— es exactamente el error que hace que alguien comparta de más
   *  creyendo que no lo ve nadie. */
  audience?: "solo" | "conmigo" | "privado";
  /** Los OTROS del DM. Sólo con `audience: "conmigo"`. */
  audienceNames?: string[];
  messageId: number;
  threadRootId: number; // raíz del hilo del mensaje (parent_id ?? id) → alcance "Este hilo"
  createdAt: number;
  versions?: number; // generados: cuántas veces se re-emitió el MISMO documentId
  // subidos:
  fileId?: string;
  mime?: string;
  size?: number;
  // generados:
  documentId?: string;
  md?: string;
};

const OFFICE_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
];

function uploadedKind(mime: string, name: string): TeamDocument["kind"] {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (OFFICE_MIMES.includes(mime) || /\.(docx?|xlsx?|pptx?)$/i.test(name)) return "office";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return "image";
  return "file";
}

/** El ALCANCE de lectura de una persona: los canales que puede ver y los DMs de los que
 *  es miembro, más la etiqueta de cada DM para pintar el grupo.
 *
 *  ⚠️ Los DMs faltaban, y por eso «Documentos» mentía. Un mensaje de DM tiene
 *  `channel_id` = **0** (entero, no NULL), así que fallaba las DOS ramas del filtro: ni
 *  está en la lista de canales, ni es NULL. La rama de `owner_sub` se escribió para
 *  artefactos HUÉRFANOS —cuyo mensaje se borró— y por eso pide NULL; nunca contempló los
 *  DMs. Medido en descti el 2026-08-24: 6 de sus 9 documentos (el expediente LANUA
 *  entero) no se listaban para NADIE, ni para quien los subió.
 *
 *  El alcance de un DM es su MEMBRESÍA, no `owner_sub`: los dos participantes ya ven el
 *  documento en el hilo, así que listárselo sólo a quien lo subió dejaría al otro sin
 *  verlo en el panel teniéndolo delante. Y los adjuntos ni siquiera guardan dueño:
 *  cuelgan del mensaje.
 *
 *  `listDmConversations` ya viene acotada al usuario (`JOIN gc_dm_members … WHERE
 *  mm.user_sub = ?`), así que el muro ético lo pone ella. */
async function readScope(me: { sub: string; isOwner?: boolean | number | null }) {
  const db = await import("../db.server");
  const [channels, dms] = await Promise.all([
    db.listChannels(me.sub, !!me.isOwner).catch(() => []),
    db.listDmConversations(me.sub).catch(() => []),
  ]);
  // Etiqueta del grupo: el agente si el DM es con uno, si no la persona del otro lado.
  //
  // `audience` es QUIÉN MÁS lo ve, y tiene que decir la verdad: un DM con el agente sólo
  // lo ve esta persona, pero uno con Rodrigo lo ven dos. Rotular «Sólo tú» un DM de dos
  // es la clase de error que hace que alguien comparta de más creyendo que no.
  const dmLabel = new Map<number, string>();
  const dmAudience = new Map<number, string[]>();
  for (const c of dms) {
    const otros = c.members.map((m) => m.name || m.email).filter(Boolean) as string[];
    dmLabel.set(c.id, c.title || otros.join(", ") || "Mensaje directo");
    // Un DM con un agente no tiene humanos del otro lado: `agent_handle` lo marca.
    dmAudience.set(c.id, c.agent_handle ? [] : otros);
  }
  const chanPrivate = new Map<number, boolean>();
  for (const c of channels) chanPrivate.set(c.id, !!c.is_private);
  return {
    chanIds: channels.map((c) => c.id),
    dmIds: dms.map((c) => c.id),
    dmLabel,
    dmAudience,
    chanPrivate,
  };
}

/** Las dos ramas del alcance, ya en SQL. Devuelve `null` si la persona no ve NADA —
 *  ahí el llamador corta antes de consultar.
 *
 *  ⚠️ `IN ()` con lista vacía es error de sintaxis en SQLite, así que cada rama sólo se
 *  emite si tiene elementos. */
function scopeSql(
  chanIds: number[],
  dmIds: number[]
): { sql: string; args: (number | string)[] } | null {
  const parts: string[] = [];
  const args: (number | string)[] = [];
  if (chanIds.length) {
    parts.push(`m.channel_id IN (${chanIds.map(() => "?").join(",")})`);
    args.push(...chanIds);
  }
  if (dmIds.length) {
    parts.push(`m.dm_id IN (${dmIds.map(() => "?").join(",")})`);
    args.push(...dmIds);
  }
  if (!parts.length) return null;
  return { sql: `(${parts.join(" OR ")})`, args };
}

export const listTeamDocumentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { sessionUser } = await import("./chat");
  const me = await sessionUser();
  if (!me) return [] as TeamDocument[];
  const { dbq, num } = await import("../dbq.server");

  // Muro ético (matter-centric): solo docs de rooms que ESTE user puede ver y de DMs de
  // los que es miembro. Sin esto un invitado vería docs de casos ajenos.
  //
  // ⚠️ El corte por lista vacía mira LAS DOS: antes bastaba con quedarse sin canales para
  // devolver nada, y alguien que sólo tiene DMs se iba con las manos vacías.
  const scope = await readScope(me);
  const { chanIds, dmIds } = scope;
  const where = scopeSql(chanIds, dmIds);
  if (!where) return [] as TeamDocument[];

  // Generados por el agente (eb-doc/eb-sheet/office/html committed a gc_artifacts).
  // ⚠️ `archived_at IS NULL`: la papelera no se lista aquí (ver listArchivedDocumentsFn).
  //
  // ⚠️ Y el JOIN a gc_messages es LEFT, no INNER. Con INNER, un documento cuyo mensaje se
  // borró desaparecía del panel **mientras sus filas seguían vivas y su liga pública
  // seguía sirviendo** — o sea, invisible pero accesible, que es lo peor de los dos
  // mundos. Con LEFT sigue listado y se puede archivar de verdad.
  //
  // ⚠️ Pero un huérfano NO puede listársele a cualquiera: sin mensaje no hay canal, y sin
  // canal el muro ético de arriba no aplica. Se acota a SU DUEÑO — así el documento sigue
  // siendo recuperable por quien lo hizo sin exponer casos ajenos a los demás.
  const generated = await dbq(
    `SELECT a.id, a.kind, a.url, a.title, a.md, a.message_id, m.channel_id, m.dm_id, m.parent_id,
            COALESCE(m.created_at, a.created_at) AS created_at, c.name AS room_name, c.slug AS room_slug
       FROM gc_artifacts a
       LEFT JOIN gc_messages m ON m.id = a.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE a.archived_at IS NULL
        AND (${where.sql} OR (m.channel_id IS NULL AND a.owner_sub = ?))
      ORDER BY created_at DESC`,
    [...where.args, me.sub]
  ).catch(() => []);

  // Subidos por el usuario (arrojados al chat → EasyBits privado).
  const uploaded = await dbq(
    `SELECT att.id, att.file_id, att.mime, att.size, att.name, att.message_id, m.channel_id, m.dm_id, m.parent_id,
            m.created_at, c.name AS room_name, c.slug AS room_slug
       FROM gc_attachments att
       JOIN gc_messages m ON m.id = att.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE att.archived_at IS NULL AND ${where.sql}
      ORDER BY m.created_at DESC`,
    where.args
  ).catch(() => []);

  // Raíz del hilo del mensaje: un reply → su parent_id; un top-level → su propio id.
  const rootOf = (parentId: string | null, messageId: string | null) =>
    parentId != null ? num(parentId) : num(messageId);

  const docs: TeamDocument[] = [];

  // Dedup por documentId: en EasyBits un doc ES uno solo que versiona. Cada re-emisión
  // del MISMO documentId es OTRA fila en gc_artifacts (una por mensaje) → aquí colapsamos
  // a UN tile (la última versión, porque viene DESC por created_at) contando versiones.
  // Un documento de DM no tiene canal: su "caso" es la conversación. `channelName` se
  // llena con la etiqueta del DM para que el grupo se pinte igual que un room.
  const anclaje = (channelId: unknown, dmIdRaw: unknown, roomName: unknown, roomSlug: unknown) => {
    const dmId = dmIdRaw != null ? num(dmIdRaw as never) : 0;
    if (dmId) {
      return {
        channelId: 0,
        dmId,
        channelName: scope.dmLabel.get(dmId) ?? "Mensaje directo",
        channelSlug: null,
        ...(() => {
          const otros = scope.dmAudience.get(dmId) ?? [];
          return otros.length
            ? { audience: "conmigo" as const, audienceNames: otros }
            : { audience: "solo" as const };
        })(),
      };
    }
    const cid = num(channelId as never);
    return {
      channelId: cid,
      dmId: undefined,
      channelName: (roomName as string) ?? null,
      channelSlug: (roomSlug as string) ?? null,
      // Un canal privado también se marca: hasta hoy la página no distinguía «General»
      // de «Gestión Estratégica», que es privado. Los DMs sólo lo hicieron evidente.
      // `undefined` en un canal público → sin marca.
      audience: scope.chanPrivate.get(cid) ? ("privado" as const) : undefined,
    };
  };

  const seenDoc = new Map<string, TeamDocument>();
  for (const g of generated) {
    const docId = (g.url && String(g.url)) || `g${g.id}`;
    const prev = seenDoc.get(docId);
    if (prev) {
      prev.versions = (prev.versions ?? 1) + 1;
      continue;
    }
    const kind = (g.kind as TeamDocument["kind"]) || "doc";
    const doc: TeamDocument = {
      key: `g${g.id}`,
      source: "generated",
      kind,
      title: g.title || "Documento",
      ...anclaje(g.channel_id, g.dm_id, g.room_name, g.room_slug),
      messageId: num(g.message_id),
      threadRootId: rootOf(g.parent_id, g.message_id),
      createdAt: num(g.created_at),
      versions: 1,
      documentId: g.url ?? undefined,
      md: g.md ?? undefined,
    };
    seenDoc.set(docId, doc);
    docs.push(doc);
  }

  for (const u of uploaded) {
    const mime = u.mime ?? "";
    const name = u.name ?? "";
    const kind = uploadedKind(mime, name);
    // Solo documentos (pdf/office); imágenes/audio/otros no van al estudio de docs.
    if (kind === "file") continue;
    docs.push({
      key: `u${u.id}`,
      source: "uploaded",
      kind,
      title: name || "Archivo",
      ...anclaje(u.channel_id, u.dm_id, u.room_name, u.room_slug),
      messageId: num(u.message_id),
      threadRootId: rootOf(u.parent_id, u.message_id),
      createdAt: num(u.created_at),
      fileId: u.file_id ?? undefined,
      mime,
      size: u.size != null ? num(u.size) : undefined,
    });
  }

  docs.sort((a, b) => b.createdAt - a.createdAt);
  return docs;
});

// ── Papelera de documentos (2026-08-03) ──────────────────────────────────────
//
// Archivar, no borrar. Un documento es el ENTREGABLE —tiene liga compartible, versiones,
// export y edición colaborativa— y hasta hoy no había forma de quitarlo: la única vía era
// borrar el mensaje que lo produjo, y eso lo destruía en duro, sin retención y sin aviso.
//
// ⚠️ Se archiva el DOCUMENTO, no una fila. Un documento son N filas con el mismo `url`
// (cada publicación es un INSERT, ver createArtifact). Todo va `WHERE url = ?`.

/** Cuánto vive un documento en la papelera antes de borrarse de verdad. */
const RETENCION_DIAS = 30;

/**
 * Lo que hace que "archivar" signifique algo, y no sólo esconder la tarjeta.
 *
 * Tres efectos, y los tres hacen falta:
 *  1. sella `archived_at`/`purge_at` en TODAS las filas del documento;
 *  2. **corta el acceso público** — sin esto la liga `/artefacto/<slug>` seguiría
 *     sirviendo y el usuario creería que lo quitó (es el agujero que ya tenía el borrado
 *     por mensaje: el documento desaparecía del panel y su liga seguía viva);
 *  3. **suelta el puntero de conversación** — si no, el agente sigue creyendo que ése es
 *     "el documento de esta conversación" y un "modifícalo" apunta a la nada
 *     (`resolveThreadArtifact` devuelve el puntero explícito sin comprobar que exista).
 *
 * ⚠️ El `share_slug` NO se borra: se conserva para poder devolver el acceso al restaurar.
 * Sólo se marca privado, que es reversible.
 */
export const archiveDocumentFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }) => {
    const { requireShareOwner } = await import("./artifacts");
    const { dbq } = await import("../dbq.server");
    const { root } = await requireShareOwner(data.documentId); // authz: dueño o workspace owner
    const ahora = Math.floor(Date.now() / 1000);
    const purgeAt = ahora + RETENCION_DIAS * 86400;
    await dbq(`UPDATE gc_artifacts SET archived_at = ?, purge_at = ? WHERE url = ?`, [
      ahora, purgeAt, data.documentId,
    ]);
    // Corta el acceso público. Se guarda la visibilidad previa en la raíz para poder
    // devolverla tal cual al restaurar — degradar a privado y luego "restaurar a público"
    // a ciegas sería peor que no restaurar nada.
    await dbq(
      `UPDATE gc_artifacts SET share_visibility = 'archived:' || COALESCE(share_visibility, 'private') WHERE id = ?`,
      [root.id],
    );
    await dbq(`DELETE FROM gc_thread_artifact WHERE document_id = ?`, [data.documentId]);
    return { ok: true as const, purgeAt };
  });

/** Devuelve el documento al panel y le restituye la visibilidad que tenía. */
export const restoreDocumentFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }) => {
    const { requireShareOwner } = await import("./artifacts");
    const { dbq } = await import("../dbq.server");
    const { root } = await requireShareOwner(data.documentId);
    await dbq(`UPDATE gc_artifacts SET archived_at = NULL, purge_at = NULL WHERE url = ?`, [
      data.documentId,
    ]);
    // Deshace el prefijo `archived:`. Si la fila no lo trae (archivada por una versión
    // anterior de este código, o tocada a mano) se queda como está: mejor dejarla privada
    // que adivinar y volver público algo que quizá no lo era.
    const prev = String(root.visibility ?? "");
    if (prev.startsWith("archived:")) {
      const restaurada = prev.slice("archived:".length);
      await dbq(`UPDATE gc_artifacts SET share_visibility = ? WHERE id = ?`, [
        restaurada === "private" ? null : restaurada, root.id,
      ]);
    }
    return { ok: true as const };
  });

/** La papelera: qué hay y cuánto le queda. Mismo muro ético que el panel. */
export const listArchivedDocumentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { sessionUser } = await import("./chat");
  const me = await sessionUser();
  if (!me) return [] as ArchivedDocument[];
  const { dbq, num } = await import("../dbq.server");
  // MISMO alcance que el listado vivo, DMs incluidos. Si aquí se quedara sólo con los
  // canales, un documento de DM se podría archivar y luego no aparecería en la papelera:
  // irrecuperable hasta que lo purgue la retención.
  const { chanIds, dmIds } = await readScope(me);
  const where = scopeSql(chanIds, dmIds);
  // Una fila por DOCUMENTO (MIN(id) = la raíz), no una por versión: si no, la papelera
  // mostraría el mismo documento veinte veces.
  const rows = await dbq(
    `SELECT MIN(a.id) AS id, a.url, MAX(a.title) AS title, MAX(a.kind) AS kind,
            MAX(a.archived_at) AS archived_at, MAX(a.purge_at) AS purge_at,
            MAX(c.name) AS room_name, MAX(c.slug) AS room_slug
       FROM gc_artifacts a
       LEFT JOIN gc_messages m ON m.id = a.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE a.archived_at IS NOT NULL
        AND (${where ? where.sql : "0"} OR (m.channel_id IS NULL AND a.owner_sub = ?))
      GROUP BY a.url
      ORDER BY MAX(a.archived_at) DESC`,
    [...(where ? where.args : []), me.sub]
  ).catch(() => []);
  const ahora = Math.floor(Date.now() / 1000);
  return rows.map((r: any) => ({
    documentId: String(r.url),
    title: r.title ?? "Documento",
    kind: String(r.kind ?? "doc"),
    roomName: r.room_name ?? null,
    roomSlug: r.room_slug ?? null,
    archivedAt: num(r.archived_at),
    purgeAt: num(r.purge_at),
    // Lo que la persona necesita para decidir. Se calcula aquí y no en el cliente para
    // que la tool del agente y la UI digan exactamente el mismo número.
    diasRestantes: Math.max(0, Math.ceil((num(r.purge_at) - ahora) / 86400)),
  })) as ArchivedDocument[];
});

export type ArchivedDocument = {
  documentId: string;
  title: string;
  kind: string;
  roomName: string | null;
  roomSlug: string | null;
  archivedAt: number;
  purgeAt: number;
  diasRestantes: number;
};


/**
 * Archiva un ARCHIVO SUBIDO (gc_attachments). Gemelo de archiveDocumentFn.
 *
 * ⚠️ Va aparte y no unificado con el de artefactos porque son cosas distintas: un subido
 * no tiene versiones, ni liga compartible, ni puntero de conversación. Meterlos en una
 * sola función obligaría a ramificar por tipo en cada paso y a fingir un `documentId` que
 * no existe.
 *
 * Autorización: quien subió el archivo (el autor del mensaje) o el dueño del workspace —
 * el mismo criterio de `deleteMessageFn`, que es la vía por la que hoy se quitan.
 */
export const archiveUploadFn = createServerFn({ method: "POST" })
  .validator((d: { attachmentId: number }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { dbq, num } = await import("../dbq.server");
    const rows = await dbq(
      `SELECT att.id, m.sender_sub, m.sender FROM gc_attachments att
         LEFT JOIN gc_messages m ON m.id = att.message_id
        WHERE att.id = ?`,
      [data.attachmentId],
    );
    if (!rows.length) throw new Error("archivo no encontrado");
    const r = rows[0] as any;
    // Mismo fallback que deleteMessageFn: los mensajes viejos no tienen sender_sub y se
    // compara por nombre. Sin el fallback, nadie podría quitar un archivo de esa época.
    const suyo = r.sender_sub ? r.sender_sub === me.sub : r.sender === me.name;
    if (!suyo && !me.isOwner) throw new Error("no puedes archivar este archivo");
    const ahora = Math.floor(Date.now() / 1000);
    await dbq(`UPDATE gc_attachments SET archived_at = ?, purge_at = ? WHERE id = ?`, [
      ahora, ahora + RETENCION_DIAS * 86400, num(r.id),
    ]);
    return { ok: true as const };
  });

export const restoreUploadFn = createServerFn({ method: "POST" })
  .validator((d: { attachmentId: number }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { dbq } = await import("../dbq.server");
    await dbq(`UPDATE gc_attachments SET archived_at = NULL, purge_at = NULL WHERE id = ?`, [
      data.attachmentId,
    ]);
    return { ok: true as const };
  });
