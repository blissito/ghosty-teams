import { createFileRoute } from "@tanstack/react-router";
import { DEFAULT_ROLE_COLORS, factoryAvatarSvg, isFactoryAvatarRole } from "../utils/factory-avatar";

// GET /api/factory-avatar/<rol>.svg?c=<rrggbb> → la flamita del rol con ese color.
// Pública a propósito: es una figura y un color, nada del espacio. El color va en la URL,
// así que cada combinación es inmutable y se cachea para siempre.
export const Route = createFileRoute("/api/factory-avatar/$file")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { file: string }; request: Request }) => {
        const role = params.file.replace(/\.svg$/, "");
        if (!isFactoryAvatarRole(role) || !params.file.endsWith(".svg")) return new Response("not found", { status: 404 });
        const c = new URL(request.url).searchParams.get("c");
        const color = c == null ? DEFAULT_ROLE_COLORS[role] : `#${c}`;
        let svg: string;
        try {
          svg = factoryAvatarSvg(color);
        } catch {
          return new Response("bad color", { status: 400 });
        }
        return new Response(svg, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
