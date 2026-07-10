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

export const listTeamDocumentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { sessionUser } = await import("./chat");
  const me = await sessionUser();
  if (!me) return [] as TeamDocument[];
  const { dbq, num } = await import("../dbq.server");
  const db = await import("../db.server");

  // Muro ético (matter-centric): solo docs de rooms que ESTE user puede ver — mismo
  // scope que la lista de canales (is_private=0 OR owner OR miembro). Sin esto un
  // invitado vería docs de casos ajenos.
  const channels = await db.listChannels(me.sub, !!me.isOwner).catch(() => []);
  const chanIds = channels.map((c) => c.id);
  if (!chanIds.length) return [] as TeamDocument[];
  const ph = chanIds.map(() => "?").join(",");

  // Generados por el agente (eb-doc/eb-sheet/office/html committed a gc_artifacts).
  const generated = await dbq(
    `SELECT a.id, a.kind, a.url, a.title, a.md, a.message_id, m.channel_id, m.parent_id,
            m.created_at, c.name AS room_name, c.slug AS room_slug
       FROM gc_artifacts a
       JOIN gc_messages m ON m.id = a.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE m.channel_id IN (${ph})
      ORDER BY m.created_at DESC`,
    chanIds
  ).catch(() => []);

  // Subidos por el usuario (arrojados al chat → EasyBits privado).
  const uploaded = await dbq(
    `SELECT att.id, att.file_id, att.mime, att.size, att.name, att.message_id, m.channel_id, m.parent_id,
            m.created_at, c.name AS room_name, c.slug AS room_slug
       FROM gc_attachments att
       JOIN gc_messages m ON m.id = att.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE m.channel_id IN (${ph})
      ORDER BY m.created_at DESC`,
    chanIds
  ).catch(() => []);

  // Raíz del hilo del mensaje: un reply → su parent_id; un top-level → su propio id.
  const rootOf = (parentId: string | null, messageId: string | null) =>
    parentId != null ? num(parentId) : num(messageId);

  const docs: TeamDocument[] = [];

  // Dedup por documentId: en EasyBits un doc ES uno solo que versiona. Cada re-emisión
  // del MISMO documentId es OTRA fila en gc_artifacts (una por mensaje) → aquí colapsamos
  // a UN tile (la última versión, porque viene DESC por created_at) contando versiones.
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
      channelId: num(g.channel_id),
      channelName: g.room_name ?? null,
      channelSlug: g.room_slug ?? null,
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
      channelId: num(u.channel_id),
      channelName: u.room_name ?? null,
      channelSlug: u.room_slug ?? null,
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
