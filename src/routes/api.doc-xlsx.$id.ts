import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-xlsx/:id → descarga el .xlsx de un artefacto SHEET. `id` = documentId LOCAL.
// El CSV FUENTE vive en gc_artifacts.md (la verdad; ver getDocMarkdown). Lo convertimos a
// .xlsx con SheetJS EN EL SERVER (ya es dependencia, sin round-trip a EasyBits — a diferencia
// del docx que compila md→docx allá). Autentica con gc_session (solo miembros).
export const Route = createFileRoute("/api/doc-xlsx/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        const name = new URL(request.url).searchParams.get("name") || "hoja";
        const db = await import("../db.server");
        const csv = await db.getDocMarkdown(params.id).catch(() => null);
        if (csv == null) return new Response("not found", { status: 404 });

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
