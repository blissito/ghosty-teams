// Purga de la papelera de documentos. Vive en un `.server.ts` APARTE y no en
// documents.ts porque aquélla la importa el cliente (ArtifactPanel) para llamar a las
// serverFn: una función suelta que toca la DB no puede quedar en un módulo alcanzable
// desde el navegador — el plugin de protección de imports de TanStack Start lo rechaza,
// y con razón.
//
// El sufijo `.server.ts` es lo que la mantiene fuera del bundle del cliente.

/**
 * Borra DE VERDAD lo que pasó de `purge_at`. Idempotente: si no corre un día, al
 * siguiente barre lo vencido igual.
 *
 * ⚠️ Se lleva lo que quedaba colgando desde ANTES de esta feature — ninguna de estas
 * tablas tiene FK ni cascada, apuntan por TEXT libre: el puntero de conversación, las
 * invitaciones nominales, y los objetos S3 de cada versión (`src`). Un purgado que sólo
 * borre `gc_artifacts` deja invitaciones vivas a un documento que ya no existe.
 */
export async function purgeExpiredDocuments(): Promise<{ purgados: number }> {
  const { dbq } = await import("../dbq.server");
  const ahora = Math.floor(Date.now() / 1000);
  const vencidos = await dbq(
    `SELECT DISTINCT url FROM gc_artifacts WHERE purge_at IS NOT NULL AND purge_at <= ?`,
    [ahora],
  ).catch(() => []);
  let purgados = 0;
  for (const row of vencidos) {
    const documentId = String((row as any).url);
    // Los objetos S3 primero: si el borrado de la fila fallara, un huérfano en storage es
    // más barato de barrer que una fila que apunta a bytes que ya no están.
    const srcs = await dbq(`SELECT src FROM gc_artifacts WHERE url = ? AND src IS NOT NULL`, [documentId]).catch(() => []);
    if (srcs.length) {
      const storage = await import("./storage.server");
      const { storageKeyFromSrc } = await import("./artifacts");
      for (const s of srcs) {
        const key = storageKeyFromSrc(String((s as any).src ?? ""));
        if (!key) continue;
        // Los dos buckets, mismo criterio que la poda de versiones: la visibilidad es del
        // turno que publicó, no del que borra — un DM publicó público y un room, privado.
        await storage.del(key, "private").catch(() => false);
        await storage.del(key, "public").catch(() => false);
      }
    }
    await dbq(`DELETE FROM gc_doc_invites WHERE document_id = ?`, [documentId]).catch(() => {});
    await dbq(`DELETE FROM gc_thread_artifact WHERE document_id = ?`, [documentId]).catch(() => {});
    await dbq(`DELETE FROM gc_artifacts WHERE url = ?`, [documentId]).catch(() => {});
    purgados++;
  }
  return { purgados };
}
