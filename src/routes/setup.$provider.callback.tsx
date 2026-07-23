import { createFileRoute, redirect } from "@tanstack/react-router";
import { finishConnectFn } from "../server/connectors";

// Callback del OAuth per-user: intercambia code→token, persiste para el usuario, y
// vuelve al chat. La conexión queda guardada (gc_user_connectors); el panel de
// Integraciones refleja el estado al reabrirlo.
export const Route = createFileRoute("/setup/$provider/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    code: typeof s.code === "string" ? s.code : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    if (deps.code && deps.state) {
      await finishConnectFn({ data: { provider: params.provider, code: deps.code, state: deps.state } });
    }
    throw redirect({ to: "/" });
  },
});
