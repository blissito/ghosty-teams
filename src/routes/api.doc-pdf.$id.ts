import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-pdf/:id?v=<versionId>&name=<título> → el PDF de un documento.
//
// Nuevo: hasta hoy el único "PDF" era el diálogo de imprimir del navegador
// (`src/lib/doc-print.ts`), que se queda como está para quien quiera la copia tal-como-se-ve.
//
// El motor es `render-svc` (Chromium), el servicio de la flota que YA hace HTML→PDF y vive
// hibernado hasta que alguien lo llama. Se le manda el documento renderizado desde sus
// BLOQUES con su propia hoja de papel, así que el PDF sale con la tipografía y el ritmo del
// documento, no con el layout de otra librería.
export const Route = createFileRoute("/api/doc-pdf/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name") || "documento";

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();

        const { resolveExportDoc, docBlocks, docUnbranded } = await import("../server/doc-access.server");
        const doc = await resolveExportDoc(params.id, url.searchParams.get("v"), me);
        if (!doc) return new Response("not found", { status: 404 });
        // Una hoja de cálculo no se imprime por este camino: bajaría una tabla sin sentido.
        if (doc.kind !== "doc") return new Response("not a document", { status: 400 });

        const { blocksToPrintHtml, htmlToPdf } = await import("../server/doc-export.server");
        // `null` = sin membrete ni colores del espacio: `brandHeader` y `brandPrintCss`
        // devuelven cadena vacía y el papel sale limpio.
        const html = await blocksToPrintHtml(
          await docBlocks(doc.md),
          doc.title || name,
          docUnbranded(doc.md) ? null : undefined,
        );
        const pdf = await htmlToPdf(html);
        // Sin motor de respaldo a propósito: un segundo generador daría un PDF distinto al
        // de siempre, y "a veces se ve de otra forma" es peor que "ahora no se pudo".
        if (!pdf) return new Response("render unavailable", { status: 502 });

        return new Response(new Uint8Array(pdf), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}.pdf"`,
            "Cache-Control": "private, no-store",
          },
        });
      },
    },
  },
});
