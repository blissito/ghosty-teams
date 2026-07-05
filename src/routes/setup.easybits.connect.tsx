import { createFileRoute, redirect } from "@tanstack/react-router";
import { startEasybitsConnect } from "../server/setup";

// Paso 1 del wizard: inicia OAuth con EasyBits y redirige a authorize.
export const Route = createFileRoute("/setup/easybits/connect")({
  loader: async () => {
    const { url } = await startEasybitsConnect();
    throw redirect({ href: url });
  },
});
