import { createServerFn } from "@tanstack/react-start";

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
    const db = await import("../db.server");

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

    // Publicar el HTML a storage (COPIA del bloque de chat.ts al cerrar un artifact):
    // bucket PRIVADO firmado, expuesto por el link branded ARTIFACT_PUBLIC_BASE (Caddy→
    // ruta /t3/$ del app) o URL firmada si no hay base. Sin storage: `src` queda null y
    // el panel igual renderiza el HTML local.
    let src: string | null = null;
    try {
      const storage = await import("./storage.server");
      if (storage.storageConfigured()) {
        const title = data.title ?? "Artefacto";
        const put = await storage.put({
          blob: new Blob([data.html], { type: "text/html" }),
          contentType: "text/html; charset=utf-8",
          fileName: `${title.slice(0, 60)}.html`,
          visibility: "private",
        });
        const base = process.env.ARTIFACT_PUBLIC_BASE?.replace(/\/$/, "");
        src = base
          ? `${base}/${put.key.replace(/^t3\//, "")}`
          : storage.signedUrl(put.key, 604800, "private");
      }
    } catch (e) {
      console.error("[artifact] publish failed", e);
    }

    // Nueva versión (INSERT). Mismo documentId (url) = misma identidad → la card re-fetchea
    // la última. `md` = HTML fuente (render srcDoc + re-emit al agente).
    await db.createArtifact(messageId, {
      kind: "artifact",
      url: data.documentId,
      title: data.title ?? "Artefacto",
      md: data.html,
      src,
    });

    // Refrescar la card del room + puntero del hilo (best-effort — la edición no depende
    // de esto). Localizamos el canal/hilo del mensaje ancla para publicar el refresh.
    try {
      const rows = await dbq(`SELECT channel_id, parent_id FROM gc_messages WHERE id = ?`, [messageId]);
      const channelId = num(rows[0]?.channel_id);
      const parentId = rows[0]?.parent_id != null ? num(rows[0].parent_id) : null;
      if (channelId) {
        await db.setThreadArtifact(channelId, parentId, data.documentId).catch(() => {});
        const bus = await import("./bus.server");
        const { currentNamespace } = await import("./tenant.server");
        const ns = await currentNamespace();
        bus.publish(bus.ch.room(ns, channelId), { t: "refresh", channelId, parentId });
      }
    } catch {
      /* best-effort */
    }

    return { ok: true as const, src };
  });
