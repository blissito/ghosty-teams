// El documento DE ESTA conversación, y su liga pública.
//
// Compartido por las tools que tocan documentos (`email_send`, `doc_share`). El invariante
// que sostiene: **el `documentId` nunca viaja en los argumentos de una tool**. Sale del `dest`
// firmado en el tool-token, así que el modelo no puede alcanzar el documento de otra
// conversación inventándose un id — ni para leerlo, ni para mandarlo por correo, ni para
// repartir acceso a él.
import type { ToolDest } from "./tool-token.server";

export async function documentoDelTurno(dest: ToolDest | null): Promise<string | null> {
  if (!dest) return null;
  const db = await import("../../db.server");
  if (dest.dmId) return db.getDmArtifact(dest.dmId);
  if (dest.channelId) return db.getThreadArtifact(dest.channelId, null);
  return null;
}

/**
 * Liga pública del documento, publicándolo si hacía falta.
 *
 * ⚠️ Publicar NO es un detalle de implementación: pasa el documento a "cualquiera con el
 * enlace". Por eso devuelve `publicado`, para que la tool se lo diga al agente y el agente al
 * usuario. Si ya era público no se toca nada — y el slug **no rota** nunca (revocar es volver
 * a privado, no cambiar de dirección: si rotara, cada liga ya repartida moriría en silencio).
 */
export async function ligaDelDocumento(
  documentId: string,
  sub: string
): Promise<{ url: string; titulo: string; publicado: boolean } | { error: string }> {
  const db = await import("../../db.server");
  const { resolveDocRole } = await import("../doc-access.server");

  // Mismo criterio que compartir desde la UI: sólo quien puede editar publica.
  const role = await resolveDocRole(documentId, { sub, isOwner: false });
  if (role !== "edit") return { error: "no tienes permiso para compartir este documento" };

  const root = await db.shareRootFor(documentId);
  if (!root) return { error: "no encuentro ese documento" };

  let slug = root.slug;
  let publicado = false;
  if (root.visibility !== "link" || !slug) {
    slug = slug || crypto.randomUUID();
    await db.setShareOnRoot(root.id, { visibility: "link", slug });
    publicado = root.visibility !== "link";
  }
  const { publicBase } = await import("../notify.server");
  return { url: `${publicBase()}/artefacto/${slug}`, titulo: root.title || "Documento", publicado };
}
