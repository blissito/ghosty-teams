// Quién es y qué puede hacer alguien en la sala de un evento.
//
// ⚠️ Esto NO pasa por `sessionUser()` a propósito, y es la decisión más
// importante de todo el módulo. `sessionUser()` es el punto único donde el
// producto decide "eres del workspace", y de él cuelgan la sidebar, los DMs, los
// documentos y el agente. Hacer que un invitado devuelva algo por ahí lo
// convertiría en miembro para TODO el sistema, y el primer descuido dejaría a un
// desconocido leyendo rooms de un cliente. El invitado tiene su propia puerta,
// que sólo abre una cosa.
//
// Un asistente puede ser dos cosas a la vez: puede estar registrado por la liga
// (invitado) o ser del equipo y haber entrado con su sesión (miembro). Los dos
// caminos se resuelven aquí y devuelven la misma forma, para que la página de la
// sala no tenga que saber cuál es cuál.

import type { Channel } from "../../db.server";

export type EventViewer = {
  sub: string;
  name: string;
  /** Miembro del workspace (entró con su sesión) vs invitado por liga. */
  isMember: boolean;
  /** Modera: reparte la palabra, silencia, expulsa, graba. */
  isHost: boolean;
};

/**
 * Resuelve a quien abre la sala de un evento, o `null` si no tiene por qué estar.
 *
 * Orden deliberado: primero la sesión. Si quien abre la liga resulta ser del
 * equipo, entra como él mismo —con su nombre y, si le toca, como host— en vez de
 * como "Invitado", que es lo que pasaría si el registro ganara.
 */
export async function eventViewerFor(ch: Channel): Promise<EventViewer | null> {
  if (!ch.call_mode) return null;

  const { sessionUser } = await import("../chat");
  const me = await sessionUser().catch(() => null);
  if (me) {
    const db = await import("../../db.server");
    if (await db.canSeeChannel(ch, me.sub, me.isOwner)) {
      // Modera quien manda en el room: el owner del workspace o quien lo creó.
      // Deliberadamente NO cualquier miembro: en un webinar, "expulsar" y
      // "silenciar" son acciones sobre personas reales delante de 100 testigos.
      const isHost = !!me.isOwner || ch.created_by === me.sub;
      return { sub: me.sub, name: me.name, isMember: true, isHost };
    }
    // Un miembro que no ve el room igual puede entrar como asistente si el
    // evento es público: cae al camino de invitado de abajo.
  }

  if (ch.public_access !== 1) return null;

  const { currentGuestSub } = await import("./guest.server");
  const sub = await currentGuestSub();
  if (!sub) return null;

  // El registro es la autorización. No basta con traer cookie: tiene que existir
  // una fila para ESTE room, y no estar baneada.
  const { dbq, num } = await import("../../dbq.server");
  const rows = await dbq(
    "SELECT name, banned FROM gt_event_registrations WHERE channel_id = ? AND guest_sub = ? LIMIT 1",
    [ch.id, sub]
  );
  if (!rows[0] || num(rows[0].banned) === 1) return null;

  return { sub, name: rows[0].name || "Invitado", isMember: false, isHost: false };
}

/** La URL de la sala de video, ya con su ticket. Se acuña por carga de página. */
export async function roomUrlFor(ch: Channel, viewer: EventViewer): Promise<string | null> {
  const base = ch.call_livekit_url || process.env.EVENT_LIVEKIT_URL || "";
  if (!base || !ch.call_mode) return null;

  const { currentNamespace } = await import("../tenant.server");
  const { eventRoomName, mintEventTicket, eventRoomUrl } = await import("./ticket.server");
  const room = eventRoomName(await currentNamespace(), ch.id);

  // El rol sale del modo del room y de quién modera — nunca del cliente.
  const role = viewer.isHost ? "host" : ch.call_mode === "webinar" ? "viewer" : "speaker";

  try {
    const ticket = mintEventTicket({
      room,
      name: viewer.name,
      role,
      mode: ch.call_mode,
      title: ch.call_title || ch.name,
    });
    return eventRoomUrl(base, room, ticket);
  } catch (e) {
    console.error("[evento] no pude firmar el ticket", e);
    return null;
  }
}
