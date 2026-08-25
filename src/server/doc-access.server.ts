// Quién puede DESCARGAR un documento, y de QUÉ versión.
//
// Los dos huecos que esto cierra, y que existían desde que hay export:
//
// 1. **La versión.** `getDocMarkdown` devuelve siempre la ÚLTIMA, así que el botón de Word
//    bajaba la versión viva aunque el panel estuviera mostrando la 3 o una congelada. El
//    resto del producto ya resuelve esto por `?v` (`/artefacto/<slug>/raw`); la descarga
//    era la excepción.
// 2. **El permiso.** Bastaba tener sesión: cualquier miembro del workspace podía bajar el
//    documento de un room privado al que no pertenece, sabiendo el documentId.
//
// El criterio es el MISMO que el del panel, no uno nuevo: eres el dueño, o eres alguien que
// puede ver el room donde vive el mensaje del artefacto, o el artefacto está compartido por
// liga (y entonces también sirve sin sesión, igual que `/artefacto/<slug>`).
import { parseDocEnvelope, type DocBlock } from "../lib/doc-blocks";

export type ExportDoc = {
  documentId: string;
  versionId: number;
  title: string | null;
  kind: "doc" | "sheet" | "artifact";
  /** El contenido crudo de la fila (sobre `v:1`, CSV o HTML según `kind`). */
  md: string;
};

/**
 * Resuelve la versión a exportar y el permiso. Devuelve `null` tanto si no existe como si
 * no hay acceso: el llamador responde 404 en los dos casos, porque un 403 confirmaría que
 * el documento existe.
 *
 * `v` viene del panel y puede llegar como NÚMERO (el router parsea los search params como
 * JSON — la trampa ya documentada de `?v`), así que se normaliza aquí.
 */
export async function resolveExportDoc(
  documentId: string,
  v: string | number | null | undefined,
  me: { sub: string; isOwner: boolean } | null
): Promise<ExportDoc | null> {
  const db = await import("../db.server");

  const versions = await db.listArtifactVersions(documentId);
  if (!versions.length) return null;

  const wanted = v == null || v === "" || v === "latest" ? null : Number(v);
  const chosen =
    wanted != null && Number.isFinite(wanted)
      ? (versions.find((x) => x.id === wanted) ?? versions[versions.length - 1])
      : versions[versions.length - 1];

  if (!(await puedeVer(documentId, me))) return null;

  const full = await db.getArtifactVersion(chosen.id);
  if (!full?.md) return null;

  // El `kind` vive en la fila, no en la versión que devuelve getArtifactVersion.
  const kind = (await db.getDoc(documentId))?.kind ?? "doc";
  return { documentId, versionId: full.id, title: full.title, kind, md: full.md };
}

/**
 * QUÉ puede hacer alguien con un documento: `view` | `comment` | `edit`, o `null` si ni
 * siquiera puede verlo. Es la fuente única del permiso de co-edición — la usa el
 * endpoint que autentica al sync server (Yjs), donde el solo-lectura tiene que aplicarse
 * en el SERVIDOR: el cliente siempre puede intentar escribir.
 *
 * El criterio reusa `puedeVer` (mismo que el panel y la descarga) y sólo decide el NIVEL:
 * el dueño y el superusuario editan; un miembro que puede ver el room edita, porque el
 * documento es del equipo; quien llega por liga recibe lo que dice `share_role`, que por
 * omisión es `view` (las ligas previas a esta columna se compartieron para leer).
 */
export async function resolveDocRole(
  documentId: string,
  me: { sub: string; isOwner: boolean } | null
): Promise<import("../db.server").DocRole | null> {
  const db = await import("../db.server");
  const root = await db.shareRootFor(documentId);
  if (!root) return null;

  if (me) {
    if (root.ownerSub && root.ownerSub === me.sub) return "edit";
    if (me.isOwner) return "edit";
    // Miembro del room donde vive el documento → es del equipo, edita.
    if (await canReachDocument(documentId, me)) return "edit";
  }
  // Lo único que queda es la liga. OJO: tener sesión NO basta — un miembro del
  // workspace ajeno al room llega aquí y debe quedarse con lo que da el enlace, no
  // con `edit`.
  return root.visibility === "link" ? root.role : null;
}

/** ¿El documento está en un sitio que ESTA persona alcanza? — canal visible, o un DM del
 *  que es miembro.
 *
 *  Es la única fuente del criterio: `resolveDocRole` y `puedeVer` tenían **la misma
 *  consulta duplicada**, así que un arreglo en una dejaba a la otra atrás.
 *
 *  ⚠️ Antes devolvía `true` cuando no encontraba canal, y eso era un agujero: el
 *  `channel_id` de un mensaje de DM es **0**, y no hay `gc_channels` con id 0, así que el
 *  JOIN no casaba y **un documento nacido en un 1:1 privado quedaba editable por
 *  cualquiera con sesión** que tuviera el `documentId`. Se toleró porque ese mismo `true`
 *  sostenía a los documentos sin mensaje (el mensaje se borró), y no se sabía cuántos
 *  eran.
 *
 *  Medido el 2026-08-24 en los 13 tenants: 47 de canal, 44 de DM, **26 huérfanos** — o
 *  sea que no se podía cerrar en seco. Los tres casos se separan:
 *
 *  1. **canal** → `canSeeChannel`, como siempre.
 *  2. **DM** → ¿eres miembro? Es la membresía y NO `owner_sub`: 13 de los 42 documentos
 *     de DM de `business` no tienen dueño registrado, y con la regla del dueño se
 *     habrían vuelto inalcanzables para todos.
 *  3. **huérfano** → `false`. No es un cierre total: `resolveDocRole` y `puedeVer` ya
 *     comprobaron dueño del documento y dueño del workspace ANTES de llegar aquí, y 24
 *     de los 25 huérfanos de `business` conservan su `owner_sub`.
 *
 *  ⚠️ Lo que sí cambia para alguien: quien viniera editando un documento huérfano AJENO
 *  deja de poder, y no hay ningún mensaje que se lo explique. Decidido a propósito el
 *  2026-08-24. */
async function canReachDocument(
  documentId: string,
  me: { sub: string; isOwner: boolean }
): Promise<boolean> {
  const db = await import("../db.server");
  const { dbq, num } = await import("../dbq.server");
  // La fila más VIEJA del documento es la que lo ancla (cada publicación es un INSERT).
  const rows = await dbq(
    `SELECT m.channel_id, m.dm_id, c.is_private FROM gc_artifacts a
       JOIN gc_messages m ON m.id = a.message_id
       LEFT JOIN gc_channels c ON c.id = m.channel_id
      WHERE a.url = ? ORDER BY a.id ASC LIMIT 1`,
    [documentId]
  );
  const row = rows[0];
  if (!row) return false; // huérfano: sin mensaje no hay sitio que comprobar
  const dmId = row.dm_id != null ? num(row.dm_id) : 0;
  if (dmId) return db.isDmMember(dmId, me.sub);
  const channelId = num(row.channel_id);
  if (!channelId) return false; // ni canal ni DM: no hay a qué pertenecer
  return db.canSeeChannel(
    { id: channelId, is_private: num(row.is_private) } as never,
    me.sub,
    me.isOwner
  );
}

async function puedeVer(
  documentId: string,
  me: { sub: string; isOwner: boolean } | null
): Promise<boolean> {
  const db = await import("../db.server");

  const root = await db.shareRootFor(documentId);
  // Compartido por liga: cualquiera, con o sin sesión. Es exactamente lo que promete el
  // enlace público, y negar la descarga mientras se puede ver el contenido sería teatro.
  if (root?.visibility === "link") return true;
  if (!me) return false;
  if (root?.ownerSub && root.ownerSub === me.sub) return true;
  if (me.isOwner) return true;

  // Si no es el dueño: ¿alcanza el sitio donde vive el documento? MISMO criterio que el
  // panel — antes era esta consulta repetida a mano.
  return canReachDocument(documentId, me);
}

/**
 * Los BLOQUES de un documento. Es lo que consumen los exportadores.
 *
 * Una fila legacy (markdown pelado, anterior al sobre `v:1`) se convierte al vuelo: son
 * documentos reales de gente y tienen que seguir bajando.
 */
export async function docBlocks(md: string): Promise<DocBlock[]> {
  const env = parseDocEnvelope(md);
  if (env?.blocks?.length) return env.blocks;
  const { mdToBlocks } = await import("./doc-blocks.server");
  return mdToBlocks(md);
}

/**
 * ¿Este documento se entrega SIN la marca del espacio?
 *
 * Vive aquí y no en cada ruta de export para que **un solo sitio** sepa abrir un sobre:
 * `docBlocks` tira todo lo que no son bloques, así que sin esto cada exportador tendría
 * que volver a parsear el JSON por su cuenta y acabarían discrepando — el PDF sin membrete
 * y el .docx con él.
 *
 * Una fila legacy (markdown pelado) no tiene sobre: lleva marca, como siempre.
 */
export function docUnbranded(md: string): boolean {
  return parseDocEnvelope(md)?.unbranded === true;
}
