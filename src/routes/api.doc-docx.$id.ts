import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-docx/:id → descarga el .docx de un artefacto DOC. Autentica con gc_session
// (solo miembros) y proxea el export de EasyBits con la platform key (ebFetch) → streamea
// el binario. Así el botón "Descargar" del panel baja el Word sin exponer la key.
export const Route = createFileRoute("/api/doc-docx/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        const { ebFetch } = await import("../server/easybits-files.server");
        const res = await ebFetch(`/api/v2/documents/${encodeURIComponent(params.id)}/docx`, { method: "GET" });
        if (!res.ok || !res.body) return new Response("export failed", { status: 502 });

        const name = new URL(request.url).searchParams.get("name") || "documento";
        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}.docx"`,
          },
        });
      },
    },
  },
});
