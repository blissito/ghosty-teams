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
      GET: async ({ params, request }: { params: { id: string }; request: Request }) => {
        const { useSession } = await import("@tanstack/react-start/server");
        const { sessionConfig } = await import("../server/session.server");
        const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
        // Segunda puerta: un producto hermano del ecosistema (Ghosty Tasks) firmando
        // con GHOSTY_PARTNER_SECRET. Su servidor pide el avatar de un miembro y la
        // cookie `gc_session` NO viaja entre subdominios (SameSite=lax), así que sin
        // esto la foto de perfil sale rota fuera de Teams. Firma `ts.id`, ±300s: es
        // un permiso de lectura de UN archivo y por cinco minutos.
        if (!s.data.user) {
          const secret = process.env.GHOSTY_PARTNER_SECRET;
          const url = new URL(request.url);
          const ts = url.searchParams.get("ts") ?? "";
          const sig = url.searchParams.get("sig") ?? "";
          let ok = false;
          if (secret && ts && sig) {
            const crypto = await import("node:crypto");
            const expected = crypto.createHmac("sha256", secret).update(`${ts}.${params.id}`).digest("hex");
            const a = Buffer.from(sig);
            const b = Buffer.from(expected);
            ok =
              a.length === b.length &&
              crypto.timingSafeEqual(a, b) &&
              Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
          }
          // Tercera puerta: el archivo YA ES PÚBLICO — un adjunto de un room abierto
          // (posterior a su apertura) o un emoji custom del workspace. Sin esto, a un
          // invitado se le servía el mensaje y se le negaba su imagen, así que los
          // emojis de reacción llegaban rotos y las fotos del room no cargaban.
          if (!ok) {
            const { publicFileAccess } = await import("../server/events/public-files.server");
            ok = await publicFileAccess(params.id);
          }
          if (!ok) return new Response("unauthorized", { status: 401 });
        }

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
