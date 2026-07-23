import { createFileRoute, redirect } from "@tanstack/react-router";
import { relayConnectorFn } from "../server/connectors";

// Relay GLOBAL del OAuth per-user (multi-tenant). Es el redirect_uri ÚNICO registrado en
// el provider (Calendly): https://teams.ghosty.studio/oauth/$provider/callback. El apex
// no tiene sesión ni tenant, así que aquí NO se cierra el OAuth: se lee el workspace de
// origen del state firmado y se rebota a su subdominio, donde /setup/$provider/callback
// intercambia el code con sesión + cookies + namespace. Ver server/connectors.ts.
export const Route = createFileRoute("/oauth/$provider/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    code: typeof s.code === "string" ? s.code : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    if (!deps.code || !deps.state) throw redirect({ to: "/" });
    const { target } = await relayConnectorFn({
      data: { provider: params.provider, code: deps.code, state: deps.state },
    });
    throw redirect({ href: target });
  },
});
