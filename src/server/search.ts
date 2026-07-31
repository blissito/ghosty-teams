import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Buscador (Fase 2.4) ─────────────────────────────────────────────────────
// LIKE universal (fallback siempre disponible; FTS5 oportunista queda como mejora
// futura). Respeta visibilidad: sólo rooms que el usuario ve + sus DMs. Los hits
// de room traen slug/nombre (clickables); los de DM sólo el dm_id (el cliente ya
// tiene los títulos de sus conversaciones).

export const searchMessagesFn = createServerFn({ method: "GET" })
  .validator((d: { q: string; threadRootId?: number }) => d)
  .handler(async ({ data }) => {
    const q = data.q.trim();
    if (q.length < 2) return { rooms: [], dms: [] };
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return { rooms: [], dms: [] };
    const visible = await db.listChannels(me.sub, !!me.isOwner);
    // Buscando DENTRO de un hilo no se consultan los DMs: la pregunta es "dónde dije esto
    // en esta conversación", y una respuesta de otro lado sólo sería ruido. El scope de
    // canales sigue siendo el de siempre, así que un threadRootId ajeno no devuelve nada.
    const threadRootId = data.threadRootId;
    const [rooms, dms] = await Promise.all([
      db.searchRoomMessages(visible.map((c) => c.id), q, { threadRootId }),
      threadRootId ? Promise.resolve([]) : db.searchDmMessages(me.sub, q),
    ]);
    return { rooms, dms };
  });
