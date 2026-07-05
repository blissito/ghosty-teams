import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Buscador (Fase 2.4) ─────────────────────────────────────────────────────
// LIKE universal (fallback siempre disponible; FTS5 oportunista queda como mejora
// futura). Respeta visibilidad: sólo rooms que el usuario ve + sus DMs. Los hits
// de room traen slug/nombre (clickables); los de DM sólo el dm_id (el cliente ya
// tiene los títulos de sus conversaciones).

export const searchMessagesFn = createServerFn({ method: "GET" })
  .validator((d: { q: string }) => d)
  .handler(async ({ data }) => {
    const q = data.q.trim();
    if (q.length < 2) return { rooms: [], dms: [] };
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return { rooms: [], dms: [] };
    const visible = await db.listChannels(me.sub, !!me.isOwner);
    const [rooms, dms] = await Promise.all([
      db.searchRoomMessages(visible.map((c) => c.id), q),
      db.searchDmMessages(me.sub, q),
    ]);
    return { rooms, dms };
  });
