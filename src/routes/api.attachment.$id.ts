import { createFileRoute } from "@tanstack/react-router";

// ── Proxy de lectura de adjuntos (Fase 4) ───────────────────────────────────
// GET /api/attachment/:fileId → autentica con gc_session, re-mintea el readUrl
// firmado de EasyBits (TTL ~1h) y redirige (302). Así los objetos son privados
// (solo miembros con sesión los ven) y nunca guardamos una URL que expira.
// El <img src="/api/attachment/:id"> del render pega aquí; el browser cachea el
// redirect < TTL.
export const Route = createFileRoute("/api/attachment/$id")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { id: string } }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        const { mintReadUrl } = await import("../server/easybits-files.server");
        const url = await mintReadUrl(params.id);
        if (!url) return new Response("not found", { status: 404 });

        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            // Cachea el redirect por debajo del TTL del signed URL (~1h).
            "Cache-Control": "private, max-age=3000",
          },
        });
      },
    },
  },
});
