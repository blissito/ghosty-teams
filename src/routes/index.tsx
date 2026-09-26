import { createFileRoute, redirect } from "@tanstack/react-router";
import { listChannelsFn } from "../server/chat";
import { takeLanding } from "../server/auth";
import { createServerFn } from "@tanstack/react-start";

/** Cookie `gt_last_room` (la escribe el room al abrirse). */
export const LAST_ROOM_COOKIE = "gt_last_room";
const lastRoomFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getCookie } = await import("@tanstack/react-start/server");
  const v = getCookie(LAST_ROOM_COOKIE) ?? "";
  return /^[a-z0-9-]{1,80}$/.test(v) ? v : null;
});

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
    // El último room que se tuvo abierto (cookie que escribe c.$slug.tsx), si sigue visible.
    // Sin él, Inicio (`home`, ver el foco inicial en c.$slug.tsx).
    const last = await lastRoomFn().catch(() => null);
    if (last && channels.some((c) => c.slug === last)) throw redirect({ to: "/c/$slug", params: { slug: last } });
    throw redirect({ to: "/c/$slug", params: { slug: channels[0]?.slug ?? "general" }, search: { home: 1 } });
  },
});
