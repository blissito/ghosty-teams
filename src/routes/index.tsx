import { createFileRoute, redirect } from "@tanstack/react-router";
import { me } from "../server/auth";
import { getSetup } from "../server/setup";
import { listChannelsFn } from "../server/chat";

export const Route = createFileRoute("/")({
  loader: async () => {
    const user = await me();
    // Owner sin configurar → wizard. Todos los demás → chat.
    if (user?.isOwner) {
      const setup = await getSetup();
      if (!setup.hasAgent) throw redirect({ to: "/setup" });
    }
    const channels = await listChannelsFn();
    throw redirect({ to: "/c/$slug", params: { slug: channels[0]?.slug ?? "general" } });
  },
});
