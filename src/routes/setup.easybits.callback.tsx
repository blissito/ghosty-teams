import { createFileRoute, redirect } from "@tanstack/react-router";
import { finishEasybitsConnect } from "../server/setup";

// Callback del OAuth de EasyBits → intercambia y vuelve al wizard.
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
    throw redirect({ to: "/setup" });
  },
});
