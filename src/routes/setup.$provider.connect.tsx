import { createFileRoute, redirect } from "@tanstack/react-router";
import { startConnectFn } from "../server/connectors";

// Inicia el OAuth per-user de un conector (Calendly, …) y redirige a authorize.
// Genérico por $provider (data-driven sobre connectors/registry.ts). Las rutas
// estáticas setup.easybits.* ganan sobre este comodín.
export const Route = createFileRoute("/setup/$provider/connect")({
  loader: async ({ params }) => {
    let url: string;
    try {
      ({ url } = await startConnectFn({ data: { provider: params.provider } }));
    } catch {
      // Proveedor no configurado en el box (p.ej. falta CALENDLY_CLIENT_ID) o error al
      // armar el authorize URL. NO dejamos que el throw caiga en el layout/boundary:
      // volvemos al chat (antes esto terminaba mostrando el wizard deprecado de setup).
      throw redirect({ to: "/c/$slug", params: { slug: "general" } });
    }
    throw redirect({ href: url });
  },
});
