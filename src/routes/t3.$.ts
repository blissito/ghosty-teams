import { createFileRoute } from "@tanstack/react-router";

// GET /t3/<uuid>-name.html → sirve el HTML de un ARTEFACTO publicado, branded bajo
// artefacto.ghosty.studio (Caddy reverse_proxy → este app). PÚBLICO por definición
// (sin gc_session): un artefacto es un enlace compartible. El objeto vive en el bucket
// PRIVADO de Tigris (el "público" de Tigris no sirve objetos sin firma → AccessDenied);
// el app lo lee firmado y lo re-emite. Seguridad: `Content-Security-Policy: sandbox`
// fuerza origen opaco → el HTML no-confiable del agente NO puede tocar cookies/DOM de
// ghosty.studio. Fallback al bucket público para artefactos legacy (publicados antes
// del cambio a privado). Admin/revocación: borrar el objeto → 404.
export const Route = createFileRoute("/t3/$")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { _splat?: string } }) => {
        const splat = params._splat ?? "";
        if (!splat || splat.includes("..")) return new Response("not found", { status: 404 });
        const key = `t3/${splat}`;
        const storage = await import("../server/storage.server");
        if (!storage.storageConfigured()) return new Response("storage off", { status: 503 });
        const bytes =
          (await storage.getBytes(key, "private")) ??
          (await storage.getBytes(key, "public").catch(() => null));
        if (!bytes) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Aísla el documento standalone (origen opaco) — igual que el iframe in-Teams.
            "Content-Security-Policy":
              "sandbox allow-scripts allow-forms allow-popups allow-modals; base-uri 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "public, max-age=300",
          },
        });
      },
    },
  },
});
