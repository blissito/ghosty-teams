import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-docx/:id?v=<versionId>&name=<título> → el .docx de un documento.
//
// Se genera AQUÍ, desde los BLOQUES, con el exportador oficial de BlockNote. Antes pasaba
// por markdown y por el `md-to-docx` de EasyBits, y ese camino tenía un problema que no se
// podía arreglar desde este lado: markdown no puede expresar una tabla SIN bordes, así que
// cuatro firmas lado a lado bajaban con la rejilla puesta en Word. Desde los bloques el
// mapeo de columnas ya sale con los bordes en nil.
//
// `?v` importa: el panel enseña la versión que abriste, y hasta hoy el botón bajaba SIEMPRE
// la última. El permiso lo resuelve `resolveExportDoc` con el mismo criterio que el panel
// (dueño, miembro del room, o artefacto compartido por liga).
export const Route = createFileRoute("/api/doc-docx/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name") || "documento";

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();

        const { resolveExportDoc, docBlocks, docUnbranded } = await import("../server/doc-access.server");
        const doc = await resolveExportDoc(params.id, url.searchParams.get("v"), me);
        // 404 también cuando falta permiso: un 403 confirmaría que el documento existe.
        if (!doc) return new Response("not found", { status: 404 });

        try {
          const { blocksToDocx } = await import("../server/doc-export.server");
          // `null` = este documento se pidió sin la marca del espacio. Se decide con el
          // MISMO lector que el PDF (`docUnbranded`), o los dos formatos del mismo
          // documento saldrían distintos.
          const buf = await blocksToDocx(
            await docBlocks(doc.md),
            doc.title || name,
            docUnbranded(doc.md) ? null : undefined,
          );
          return new Response(new Uint8Array(buf), {
            status: 200,
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "Content-Disposition": `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}.docx"`,
              "Cache-Control": "private, no-store",
            },
          });
        } catch (e) {
          console.error("[doc-docx] export falló", e);
          return new Response("export failed", { status: 502 });
        }
      },
    },
  },
});
