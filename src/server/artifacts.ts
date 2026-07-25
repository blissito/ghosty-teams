import { createServerFn } from "@tanstack/react-start";
import { stampIds } from "../lib/artifact-ids";

/**
 * Publica una VERSIÓN nueva de un artefacto. Camino ÚNICO para el agente (chat.ts, al
 * cerrar el fence) y para la edición humana (updateArtifactHtmlFn): estaban duplicados
 * literalmente y cualquier arreglo en uno se olvidaba en el otro.
 *
 * Hace, en orden: SEMBRAR los `data-id` (idempotente — es lo que hace direccionable el
 * artefacto para el próximo ```eb-patch```), publicar el HTML a storage (link compartible),
 * INSERT en gc_artifacts (append-only: cada versión es una fila, getDoc toma la última),
 * apuntar el hilo a ese documentId y refrescar el room.
 *
 * Devuelve el HTML finalmente persistido (ya estampado) — el llamador lo necesita para
 * publicarlo al bus / re-inyectarlo al agente.
 */
export async function publishArtifactVersion(args: {
  messageId: number;
  documentId: string;
  kind: "doc" | "sheet" | "artifact";
  title: string | null;
  md: string;
  /** Apunta la conversación a este documentId (room → setThreadArtifact; DM → setDmArtifact). */
  setPointer?: (documentId: string) => Promise<void>;
  /** Avisa a los clientes de que hay versión nueva (cada superficie tiene su fanout). */
  notify?: () => void;
  /** El DM publica el objeto como público; el room, privado firmado. */
  visibility?: "public" | "private";
}): Promise<{ md: string; src: string | null }> {
  const db = await import("../db.server");
  const t0 = performance.now();

  // Solo el HTML tiene nodos que direccionar; doc/sheet son markdown/CSV.
  let md = args.md;
  if (args.kind === "artifact") {
    try {
      const { serverParseOpts } = await import("./artifact-dom.server");
      md = stampIds(args.md, await serverParseOpts());
    } catch (e) {
      // Sin ids el artefacto sigue siendo válido: solo pierde la edición quirúrgica
      // en el siguiente turno (artifactDocHint lo detecta y pide re-emisión completa).
      console.error("[artifact] stampIds failed", e);
    }
  }

  let src: string | null = null;
  if (args.kind === "artifact") {
    try {
      const storage = await import("./storage.server");
      if (storage.storageConfigured()) {
        // Bucket PRIVADO: el "público" de Tigris no sirve objetos sin firma (AccessDenied).
        // La URL branded artefacto.ghosty.studio/<key> la sirve el app (ruta /t3/$) leyendo
        // el objeto firmado → público y permanente.
        const visibility = args.visibility ?? "private";
        const put = await storage.put({
          blob: new Blob([md], { type: "text/html" }),
          contentType: "text/html; charset=utf-8",
          fileName: `${(args.title || "artefacto").slice(0, 60)}.html`,
          visibility,
        });
        // El link branded oculta el prefijo interno `t3/` (Caddy lo re-antepone en el vhost).
        const base = process.env.ARTIFACT_PUBLIC_BASE?.replace(/\/$/, "");
        src =
          visibility === "public"
            ? base
              ? `${base}/${put.key}`
              : storage.publicUrl(put.key)
            : base
              ? `${base}/${put.key.replace(/^t3\//, "")}`
              : storage.signedUrl(put.key, 604800, "private");
      }
    } catch (e) {
      console.error("[artifact] publish failed", e);
    }
  }

  await db.createArtifact(args.messageId, {
    kind: args.kind,
    url: args.documentId,
    title: args.title,
    md,
    src,
  });
  try {
    await args.setPointer?.(args.documentId);
  } catch {
    /* el puntero es una comodidad; la versión ya está guardada */
  }
  try {
    args.notify?.();
  } catch {
    /* best-effort: la versión ya está guardada */
  }
  console.log(
    `[artifact publish] kind=${args.kind} ${Math.round(performance.now() - t0)}ms html=${md.length}b src=${src ? "sí" : "no"}`
  );
  return { md, src };
}

// Guardado de artefactos HTML editados desde el Canvas (editor @ghosty/canvas-editor)
// en el ArtifactPanel. Camino GEMELO al que usa el agente en chat.ts al cerrar un
// eb-doc kind:"artifact": publica el HTML a storage (link compartible) y escribe una
// NUEVA versión en gc_artifacts (INSERT = versión nueva; getDoc toma la última). No
// pasa por el agente — es una edición humana directa sobre el mismo documentId.
export const updateArtifactHtmlFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; html: string; messageId: number; title?: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");

    const { dbq, num } = await import("../dbq.server");

    // Resolver el message_id que ancla el artefacto. El cliente propaga el messageId
    // del ArtifactView; si falta (o es inválido), fallback robusto = la última fila de
    // gc_artifacts con este documentId (todas las versiones cuelgan del mismo mensaje).
    let messageId = data.messageId;
    if (!messageId || messageId <= 0) {
      const rows = await dbq(
        `SELECT message_id FROM gc_artifacts WHERE url = ? ORDER BY id DESC LIMIT 1`,
        [data.documentId]
      );
      messageId = num(rows[0]?.message_id);
    }
    if (!messageId) throw new Error("no se encontró el mensaje del artefacto");

    // Canal/hilo del mensaje ancla (para el puntero del hilo y el refresh del room).
    const rows = await dbq(`SELECT channel_id, parent_id FROM gc_messages WHERE id = ?`, [messageId]);
    const channelId = num(rows[0]?.channel_id);
    const parentId = rows[0]?.parent_id != null ? num(rows[0].parent_id) : null;
    if (!channelId) throw new Error("no se encontró el canal del artefacto");

    // MISMO camino que el agente (publishArtifactVersion): estampa data-id, publica a
    // storage, INSERT de versión, puntero del hilo y refresh. Antes esto era una copia
    // literal del bloque de chat.ts y las dos ramas se iban separando.
    const { src } = await publishArtifactVersion({
      messageId,
      documentId: data.documentId,
      kind: "artifact",
      title: data.title ?? "Artefacto",
      md: data.html,
      setPointer: async (docId) => {
        const db = await import("../db.server");
        await db.setThreadArtifact(channelId, parentId, docId);
      },
      notify: async () => {
        const bus = await import("./bus.server");
        const { currentNamespace } = await import("./tenant.server");
        bus.publish(bus.ch.room(await currentNamespace(), channelId), { t: "refresh", channelId, parentId });
      },
    });
    return { ok: true as const, src };
  });
