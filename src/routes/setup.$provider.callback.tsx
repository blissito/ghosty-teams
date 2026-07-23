import { createFileRoute, redirect } from "@tanstack/react-router";
import { finishConnectFn } from "../server/connectors";

// Callback per-tenant (subdominio del workspace): intercambia code→token, persiste para el
// usuario, y vuelve al chat señalando el resultado en el query (?connected=<p> | ?conn_error=
// <p>) → el shell abre Ajustes en Integraciones + toast + confetti. Al relay del apex lo
// precede: aquí SÍ hay sesión + cookies + namespace. Ver routes/oauth.$provider.callback.
export const Route = createFileRoute("/setup/$provider/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    code: typeof s.code === "string" ? s.code : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    let ok = false;
    if (deps.code && deps.state) {
      const r = await finishConnectFn({ data: { provider: params.provider, code: deps.code, state: deps.state } });
      ok = !!(r as { ok?: boolean })?.ok;
    }
    const key = ok ? "connected" : "conn_error";
    throw redirect({ href: `/c/general?${key}=${encodeURIComponent(params.provider)}` });
  },
});
