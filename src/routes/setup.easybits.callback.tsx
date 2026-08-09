import { createFileRoute, redirect } from "@tanstack/react-router";
import { finishEasybitsConnect } from "../server/setup";

// Callback del OAuth de EasyBits → intercambia el code y vuelve al chat. Antes volvía
// al wizard de /setup, que ya no existe (borrado el 2026-08-09): apuntar ahí sería un
// rebote extra por el redirect que dejó la ruta índice.
export const Route = createFileRoute("/setup/easybits/callback")({
  validateSearch: (s: Record<string, unknown>) => ({
    code: typeof s.code === "string" ? s.code : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (deps.code && deps.state) {
      await finishEasybitsConnect({ data: { code: deps.code, state: deps.state } });
    }
    throw redirect({ to: "/c/$slug", params: { slug: "general" } });
  },
});
