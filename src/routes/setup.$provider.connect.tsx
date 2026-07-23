import { createFileRoute, redirect } from "@tanstack/react-router";
import { startConnectFn } from "../server/connectors";

// Inicia el OAuth per-user de un conector (Calendly, …) y redirige a authorize.
// Genérico por $provider (data-driven sobre connectors/registry.ts). Las rutas
// estáticas setup.easybits.* ganan sobre este comodín.
export const Route = createFileRoute("/setup/$provider/connect")({
  loader: async ({ params }) => {
    const { url } = await startConnectFn({ data: { provider: params.provider } });
    throw redirect({ href: url });
  },
});
