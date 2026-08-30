import { createFileRoute, redirect } from "@tanstack/react-router";
import { listChannelsFn } from "../server/chat";
import { takeLanding } from "../server/auth";

export const Route = createFileRoute("/")({
  loader: async () => {
    // __root.beforeLoad ya garantiza sesión (si no, redirige a /login). Aquí solo
    // mandamos al chat directo — humanos primero. El agente @ghosty es OPCIONAL y se
    // configura desde Ajustes; NUNCA bloquea la entrada. (Antes el owner sin agente
    // caía en /setup, un wizard acoplado a EasyBits/Formmy con un fetch sin timeout →
    // colgaba el primer login. Eliminado del camino crítico.)
    // Invitación a un room: el destino quedó sellado en la sesión al completar el login
    // (auth.ts). Si el redirect directo se perdió por el camino, se cobra aquí.
    const landing = await takeLanding().catch(() => null);
    if (landing) throw redirect({ to: "/c/$slug", params: { slug: landing } });
    const channels = await listChannelsFn();
    throw redirect({ to: "/c/$slug", params: { slug: channels[0]?.slug ?? "general" } });
  },
});
