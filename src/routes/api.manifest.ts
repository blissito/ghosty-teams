import { createFileRoute } from "@tanstack/react-router";

// ── Manifest PWA POR TENANT ──────────────────────────────────────────────────
// Servido dinámico (no el archivo estático) para que cada workspace instale una
// PWA DISTINGUIBLE: `id` y `name` propios por subdominio. El manifest estático
// (`id:"/"`, mismo name/icons para todos) hacía que (a) todas las instalaciones
// se vieran idénticas y colisionaran, y (b) instalar desde el apex fijara el
// portal en vez del workspace. Como este manifest se sirve DESDE el subdominio
// del workspace, `start_url:"/"` ya abre ESE workspace.
export const Route = createFileRoute("/api/manifest")({
  server: {
    handlers: {
      GET: async () => {
        const { getRequestHeader, getRequestHost } = await import("@tanstack/react-start/server");
        const { slugFromHost } = await import("../server/tenant.server");

        // Mismo criterio de host que tenant.server.currentHost: preferir el
        // x-ghosty-origin que inyecta el ingress, luego el host del request.
        let host = "";
        const origin = getRequestHeader("x-ghosty-origin");
        if (origin) {
          try {
            host = new URL(origin).host;
          } catch {
            /* origin malformado → cae al host del request */
          }
        }
        if (!host) host = getRequestHost() ?? "";

        const slug = slugFromHost(host);
        const pretty = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : null;
        const name = pretty ? `${pretty} · Ghosty` : "Ghosty Teams";

        const manifest = {
          // id ÚNICO por workspace → instalar A y luego B crea DOS PWAs distintas,
          // no una que se pisa. Debe quedar dentro del scope.
          id: slug ? `/?ws=${slug}` : "/",
          name,
          short_name: pretty ?? "Ghosty Teams",
          description: "El chat de equipo con Ghosty: rooms, hilos y agentes que responden.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          theme_color: "#7c3aed",
          background_color: "#14121a",
          icons: [
            { src: "/ghosty-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/ghosty-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/ghosty-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        };

        return new Response(JSON.stringify(manifest), {
          headers: {
            "Content-Type": "application/manifest+json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      },
    },
  },
});
