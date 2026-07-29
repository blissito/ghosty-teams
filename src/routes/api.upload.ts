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
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        // Segunda puerta: un producto hermano del ecosistema (Ghosty Tasks) firmando con
        // GHOSTY_PARTNER_SECRET. Su cookie no cruza subdominios, y sin esto tendría que
        // montar su propio bucket o mandarle la imagen al agente en base64 —
        // duplicando storage o inflando el contexto del turno.
        //
        // Se firma `ts.upload` (el cuerpo es multipart y no se puede canonicalizar
        // barato) con ventana de 300s: es permiso para subir UN archivo, ahora.
        if (!s.data.user) {
          const secret = process.env.GHOSTY_PARTNER_SECRET;
          const url = new URL(request.url);
          const ts = url.searchParams.get("ts") ?? "";
          const sig = url.searchParams.get("sig") ?? "";
          let ok = false;
          if (secret && ts && sig) {
            const crypto = await import("node:crypto");
            const expected = crypto.createHmac("sha256", secret).update(`${ts}.upload`).digest("hex");
            const a = Buffer.from(sig);
            const b = Buffer.from(expected);
            ok =
              a.length === b.length &&
              crypto.timingSafeEqual(a, b) &&
              Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
          }
          if (!ok) return new Response("unauthorized", { status: 401 });
        }

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

        const isImage = (file.type || "").startsWith("image/");
        try {
          if (isImage) {
            // Imagen → pipeline con thumbnail WebP (sirve el derivado inline; original para
            // vista completa / agente). Devuelve thumbFileId (o null si no aplica/sharp ausente).
            const { processAndStoreImage } = await import("../server/image.server");
            const up = await processAndStoreImage({
              blob: file,
              contentType: file.type || "application/octet-stream",
              fileName: file.name || `file-${file.size}`,
            });
            return Response.json(up);
          }
          const { uploadToEasyBits } = await import("../server/easybits-files.server");
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
