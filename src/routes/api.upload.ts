import { createFileRoute } from "@tanstack/react-router";

// ── Subida de adjuntos (Fase 4) ─────────────────────────────────────────────
// POST multipart/form-data con campo `file`. Autentica con gc_session, sube los
// bytes a EasyBits (storage privado) server-side (evita CORS browser→Tigris) y
// devuelve el fileId + metadata. El cliente adjunta esos fileIds al enviar el
// mensaje; el render los sirve vía /api/attachment/:id.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const s = await useSession<{ user?: { sub: string } }>({
          password: process.env.SESSION_SECRET!,
          name: "gc_session",
        });
        if (!s.data.user) return new Response("unauthorized", { status: 401 });

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("bad request", { status: 400 });
        }
        const file = form.get("file");
        if (!(file instanceof File)) return new Response("no file", { status: 400 });
        if (file.size === 0) return new Response("empty file", { status: 400 });
        if (file.size > MAX_BYTES) return new Response("file too large", { status: 413 });

        const { uploadToEasyBits } = await import("../server/easybits-files.server");
        try {
          const up = await uploadToEasyBits({
            blob: file,
            contentType: file.type || "application/octet-stream",
            fileName: file.name || `file-${file.size}`,
          });
          return Response.json(up);
        } catch (err) {
          return new Response(`upload failed: ${(err as Error).message}`, { status: 502 });
        }
      },
    },
  },
});
