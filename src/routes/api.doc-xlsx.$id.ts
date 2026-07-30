import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-xlsx/:id?v=<versionId> → descarga el .xlsx de un artefacto SHEET.
// `id` = documentId LOCAL. El CSV FUENTE vive en gc_artifacts.md (la verdad). Lo convertimos
// a .xlsx con SheetJS EN EL SERVER (ya es dependencia, sin round-trip a nadie).
//
// `?v` y el permiso van por `resolveExportDoc`, igual que el .docx y el PDF: antes bajaba
// siempre la última versión y bastaba tener sesión — o sea que un miembro del workspace
// podía bajarse la hoja de un room privado al que no pertenece sabiendo el documentId.
export const Route = createFileRoute("/api/doc-xlsx/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name") || "hoja";

        const { sessionUser } = await import("../server/chat");
        const me = await sessionUser();
        const { resolveExportDoc } = await import("../server/doc-access.server");
        const doc = await resolveExportDoc(params.id, url.searchParams.get("v"), me);
        if (!doc) return new Response("not found", { status: 404 });
        const csv = doc.md;

        const XLSX = await import("xlsx");
        // SheetJS parsea el CSV (autodetección) → workbook → bytes .xlsx, envueltos en Blob
        // (BodyInit válido; ni Buffer de Node ni Uint8Array tipan como BodyInit aquí).
        const wb = XLSX.read(csv, { type: "string" });
        const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
        const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        // cast: Uint8Array<ArrayBufferLike> no satisface BlobPart en estos libs (TS 5.7+),
        // pero es un BlobPart válido en runtime.
        return new Response(new Blob([bytes as unknown as BlobPart], { type: mime }), {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}.xlsx"`,
          },
        });
      },
    },
  },
});
