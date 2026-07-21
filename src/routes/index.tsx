import { createFileRoute, redirect } from "@tanstack/react-router";
import { listChannelsFn } from "../server/chat";

export const Route = createFileRoute("/")({
  loader: async () => {
    // __root.beforeLoad ya garantiza sesión (si no, redirige a /login). Aquí solo
    // mandamos al chat directo — humanos primero. El agente @ghosty es OPCIONAL y se
    // configura desde Ajustes; NUNCA bloquea la entrada. (Antes el owner sin agente
    // caía en /setup, un wizard acoplado a EasyBits/Formmy con un fetch sin timeout →
    // colgaba el primer login. Eliminado del camino crítico.)
    const channels = await listChannelsFn();
    throw redirect({ to: "/c/$slug", params: { slug: channels[0]?.slug ?? "general" } });
  },
});
