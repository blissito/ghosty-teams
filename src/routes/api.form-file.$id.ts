import { createFileRoute } from "@tanstack/react-router";

// GET /api/form-file/<fileId> → el archivo que subió quien respondió un formulario.
//
// Exige SESIÓN y autoriza por pertenencia real: el dueño del formulario, o alguien que
// puede ver el room donde caen sus respuestas. El original de EasyBits resolvía esto
// fabricando un contexto con permisos de escritura para saltarse la autorización; aquí no
// hay atajo: si no se puede comprobar, es 404.
//
// 404 —no 403— cuando no hay permiso: un 403 confirmaría que el archivo existe. Es el mismo
// criterio del link compartido de artefactos.
export const Route = createFileRoute("/api/form-file/$id")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { id: string } }) => {
        const notFound = () => new Response("not found", { status: 404 });
        // El fileId es una key del bucket; llega URL-encoded porque trae barras.
        const fileId = decodeURIComponent(params.id || "");
        if (!fileId) return notFound();

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();
        if (!me) return new Response("unauthorized", { status: 401 });

        const { dbq, num } = await import("../dbq.server");
        const rows = await dbq(
          `SELECT ff.name, ff.mime, f.channel_id, f.owner_sub
             FROM gt_form_files ff JOIN gt_forms f ON f.id = ff.form_id
            WHERE ff.file_id = ? LIMIT 1`,
          [fileId]
        );
        const row = rows[0];
        if (!row) return notFound();

        if (row.owner_sub !== me.sub) {
          const db = await import("../db.server");
          const chans = await dbq("SELECT * FROM gc_channels WHERE id = ?", [num(row.channel_id)]);
          if (!chans[0]) return notFound();
          const ok = await db.canSeeChannel(
            // toChannel no está exportado; canSeeChannel sólo mira `id` e `is_private`.
            { id: num(chans[0].id), is_private: num(chans[0].is_private) } as never,
            me.sub,
            !!me.isOwner
          );
          if (!ok) return notFound();
        }

        const storage = await import("../server/storage.server");
        const bytes = await storage.getBytes(fileId, "private");
        if (!bytes) return notFound();

        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "Content-Type": row.mime || "application/octet-stream",
            // `inline` para poder ver un PDF sin descargarlo; el nombre saneado ya viene
            // de la subida, así que no hay nada que inyectar en la cabecera.
            "Content-Disposition": `inline; filename="${(row.name || "archivo").replace(/["\\\r\n]/g, "")}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
