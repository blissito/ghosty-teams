import { createFileRoute } from "@tanstack/react-router";

// ── Los assets de marca, servidos por nosotros ──────────────────────────────
//
// ⚠️ Existe porque NO hay ninguna URL directa que sirva estos objetos:
//   · `t3.storage.dev/ghosty-teams-public/<key>` responde **403** a un anónimo — el
//     bucket "público" de Tigris no está abierto;
//   · `artefacto.ghosty.studio/<key>` responde **200 pero con text/html** — ese vhost
//     sirve ARTEFACTOS, no objetos, y para cualquier ruta devuelve una página. Un `<img>`
//     apuntando ahí recibe HTML y no pinta nada: exactamente el logo que no se veía.
//
// Lo abre gente SIN sesión (quien responde un formulario), así que no lleva auth. Sólo
// sirve del bucket PÚBLICO y sólo claves `t3/…`, que es donde ponemos a propósito lo que
// ya decidimos publicar; no puede alcanzar el bucket privado ni salirse de ese prefijo.

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", woff2: "font/woff2",
};

export const Route = createFileRoute("/api/brand-asset/$")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { _splat?: string } }) => {
        const key = decodeURIComponent(params._splat ?? "");
        // Sin `..` y sólo bajo `t3/`: el prefijo es la frontera de lo publicable.
        if (!key.startsWith("t3/") || key.includes("..")) {
          return new Response("not found", { status: 404 });
        }
        const storage = await import("../server/storage.server");
        if (!storage.storageConfigured()) return new Response("storage off", { status: 503 });
        const bytes = await storage.getBytes(key, "public");
        if (!bytes) return new Response("not found", { status: 404 });
        const ext = key.split(".").pop()?.toLowerCase() ?? "";
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            // La clave lleva un uuid, así que el contenido es inmutable: se cachea fuerte.
            "Cache-Control": "public, max-age=31536000, immutable",
            // El formulario público lo pide desde un iframe de origen OPACO.
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
