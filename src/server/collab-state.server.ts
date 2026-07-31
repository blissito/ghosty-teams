// Persistencia del estado Yjs de un documento — en GTeams, no en EasyBits.
//
// No hace falta tabla ni bucket nuevos: el sobre del documento (`gc_artifacts.md`) ya
// reservaba `yUpdate` (base64) exactamente para esto. Vive en la ÚLTIMA versión, que es
// el documento vivo — el mismo criterio que `getDoc()`.
//
// Quién escribe aquí: el sidecar Hocuspocus vía `PUT /api/collab/:docId/state`, debounced
// después de las ediciones. NO el browser: antes cada cliente hacía su propio snapshot y
// dos editores competían por la misma fila.
import { parseDocEnvelope, serializeDocEnvelope } from "../lib/doc-blocks";

/** Estado Yjs guardado, o `null` si el doc nunca se co-editó (el editor lo siembra). */
export async function loadYState(documentId: string): Promise<Uint8Array | null> {
  const db = await import("../db.server");
  const md = await db.getDocMarkdown(documentId);
  const env = parseDocEnvelope(md);
  if (!env?.yUpdate) return null;
  const buf = Buffer.from(env.yUpdate, "base64");
  return buf.byteLength ? new Uint8Array(buf) : null;
}

/**
 * Guarda el estado Yjs en el sobre de la versión viva.
 *
 * Sólo toca `yUpdate`: los bloques los sigue escribiendo el camino normal del documento.
 * Un doc sin sobre (fila legacy con markdown pelado) se envuelve al vuelo conservando su
 * texto como `sourceMd`, para no perder contenido de gente real.
 */
export async function saveYState(documentId: string, state: Uint8Array): Promise<void> {
  const db = await import("../db.server");
  const version = await db.latestDocVersion(documentId);
  if (!version) return;

  const md = await db.getDocMarkdown(documentId);
  const env = parseDocEnvelope(md);
  const yUpdate = Buffer.from(state).toString("base64");

  const next = env
    ? { ...env, yUpdate }
    : { blocks: [], sourceMd: md ?? "", yUpdate };
  await db.overwriteArtifactMd(version.id, serializeDocEnvelope(next));
}
