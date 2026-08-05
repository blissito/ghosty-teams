import { createFileRoute } from "@tanstack/react-router";

// ── Subida del logo de un brand kit ─────────────────────────────────────────
// POST multipart con campo `file`. Endpoint propio en vez de /api/upload porque
// ése sube TODO como privado (visibility no es parámetro) y un logo tiene que
// vivir en el bucket público: se pinta en un formulario que responde alguien sin
// sesión y en un PDF que se reenvía por correo, donde una URL firmada caducaría.
//
// Sólo el owner: es la identidad visual del workspace.

export const Route = createFileRoute("/api/brand-logo")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { sessionUser } = await import("../server/chat");
        const user = await sessionUser().catch(() => null);
        if (!user?.isOwner) return new Response("unauthorized", { status: 401 });

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("bad request", { status: 400 });
        }
        const file = form.get("file");
        if (!(file instanceof File)) return new Response("no file", { status: 400 });
        if (file.size === 0) return new Response("empty file", { status: 400 });

        try {
          const { putLogo, putFont } = await import("../server/brand.server");
          const storage = await import("../server/storage.server");
          // `kind=font` sube un .woff2 propio del cliente; sin él, un logo.
          const kind = String(form.get("kind") || "logo");
          const put = kind === "font" ? putFont : putLogo;
          const key = await put(
            file,
            file.name || `${kind}-${file.size}`,
            file.type || "application/octet-stream"
          );
          return Response.json({ key, url: storage.publicAssetUrl(key) });
        } catch (err) {
          // El mensaje es del validador de putLogo (tipo, tamaño, storage sin configurar):
          // decir "falló la subida" a secas manda a leer logs por un PNG de 3 MB.
          return new Response((err as Error).message, { status: 400 });
        }
      },
    },
  },
});
