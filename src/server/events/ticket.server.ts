// Ticket de entrada a la sala de un evento.
//
// Teams AUTORIZA (pide nombre y correo, mira el baneo, aplica el límite) y la caja
// de LiveKit EJECUTA. El ticket es el puente entre las dos, y su trabajo es llevar
// el **rol** desde donde se decide hasta donde se aplica.
//
// ⚠️ Por qué firmado y no `?role=viewer` en claro: en un webinar de 100 personas el
// rol es justo lo que alguien querría cambiarse. Con la firma, el peor caso de que
// se filtre una liga es que entre alguien de más — no que se ponga a hablar.
//
// Formato (lo verifica `verifyTicket` en templates/livekit-svc/server.mjs):
//   base64url(json) "." base64url(HMAC-SHA256(secreto, base64url(json)))
//   json = { room, name, role, mode, title, exp, jti }
//
// De UN SOLO USO: la caja recuerda el `jti`. Por eso el ticket se acuña al abrir la
// página, no al repartir la liga — la liga se puede compartir, el ticket no.
import crypto from "node:crypto";

export type EventRole = "viewer" | "speaker" | "host";
export type EventMode = "webinar" | "taller";

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function secret(): string {
  const s = process.env.EVENT_TICKET_SECRET;
  if (!s) throw new Error("EVENT_TICKET_SECRET no configurado");
  return s;
}

/**
 * Nombre de sala en LiveKit. Determinista y **no adivinable**: se deriva del
 * namespace y del id del room con el mismo salt que las llamadas normales.
 *
 * Que sea determinista importa: todos los que abren la misma liga tienen que caer
 * en la misma sala, y no hay dónde guardar un id de sesión. Que no sea adivinable
 * también: la caja es compartida y el nombre de sala es parte de la frontera.
 */
export function eventRoomName(ns: string, channelId: number): string {
  const salt = process.env.LK_ROOM_SALT ?? process.env.EVENT_TICKET_SECRET ?? "";
  const h = crypto.createHmac("sha256", salt).update(`${ns}:event:${channelId}`).digest("hex");
  return "ev_" + h.slice(0, 24);
}

export function mintEventTicket(input: {
  room: string;
  name: string;
  role: EventRole;
  mode: EventMode;
  title?: string | null;
  ttlSec?: number;
}): string {
  const body = b64url(
    JSON.stringify({
      room: input.room,
      name: input.name.slice(0, 40),
      role: input.role,
      mode: input.mode,
      ...(input.title ? { title: input.title } : {}),
      // Corto a propósito: sólo tiene que sobrevivir el salto de esta página a la
      // sala. Una vez dentro, quien manda es el token de LiveKit, que dura horas.
      exp: Math.floor(Date.now() / 1000) + (input.ttlSec ?? 120),
      jti: crypto.randomUUID(),
    })
  );
  return body + "." + b64url(crypto.createHmac("sha256", secret()).update(body).digest());
}

/** La URL completa de la sala, ya con el ticket puesto. */
export function eventRoomUrl(baseUrl: string, room: string, ticket: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/room?room=${encodeURIComponent(room)}&ticket=${encodeURIComponent(ticket)}`;
}
