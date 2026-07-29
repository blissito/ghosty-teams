import { createFileRoute } from "@tanstack/react-router";

// GET /api/doc-docx/:id → descarga el .docx de un artefacto DOC. `id` = documentId LOCAL.
// El markdown FUENTE vive en gc_artifacts.md (la verdad); lo compilamos a .docx con el
// endpoint stateless md-to-docx de EasyBits (no almacena doc allá) y streameamos el binario.
// Autentica con gc_session (solo miembros); la platform key nunca sale al cliente.
export const Route = createFileRoute("/api/doc-docx/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        const name = new URL(request.url).searchParams.get("name") || "documento";
        const db = await import("../db.server");
        // `gc_artifacts.md` de un doc es un SOBRE con el árbol de bloques, no markdown.
        // `docMarkdown` devuelve el `sourceMd` del agente cuando nadie lo ha editado, y
        // sólo lo deriva de los bloques cuando ya hay edición humana — así el .docx no
        // paga la pérdida del round-trip sin necesidad. Las filas legacy pasan tal cual.
        const { docMarkdown } = await import("../server/doc-blocks.server");
        const raw = await db.getDocMarkdown(params.id).catch(() => null);
        const md = raw ? await docMarkdown(raw) : null;
        if (!md) return new Response("not found", { status: 404 });

        const { mdToDocx } = await import("../server/easybits-documents.server");
        const doc = await mdToDocx(md, name);
        if (!doc) return new Response("export failed", { status: 502 });
        const res = await fetch(doc.fileUrl);
        if (!res.ok || !res.body) return new Response("export failed", { status: 502 });

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
