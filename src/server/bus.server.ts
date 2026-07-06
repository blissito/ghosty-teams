// ── Bus realtime en proceso (SSE in-VM) ─────────────────────────────────────
// Una microVM por team = UN proceso Node sirviendo a todos los usuarios del team,
// así que un pub/sub a nivel de módulo ES el fan-out correcto (sin infra externa).
// La durabilidad NO vive aquí: cada mensaje se persiste en gc_messages ANTES de
// publicarse; esto es solo la señal "avísales ya". Un evento perdido nunca pierde
// el mensaje — el cliente reconcilia con getMessagesSince (catch-up por cursor).
//
// Interfaz swappable: si algún team creciera a miles de conexiones, se cambia SOLO
// la implementación de publish/addClient por un tier Centrifugo, sin tocar features.
import type { Message } from "../db.server";

// Canales namespaced (dentro del proceso ya es de un solo team, no hace falta teamId).
export const ch = {
  room: (id: number) => `room:${id}`,
  dm: (id: number) => `dm:${id}`,
  user: (sub: string) => `user:${sub}`,
  presence: () => "presence",
};

// Union versionada de eventos. `nonce` = id del cliente devuelto en el eco para que
// la pestaña que envió descarte su propio message:new (ya lo tiene optimista).
export type RtEvent =
  | { t: "message:new"; msg: Message; nonce?: string }
  | { t: "message:deleted"; id: number; channelId: number | null; parentId: number | null; dmId?: number | null }
  | { t: "message:edited"; id: number; body: string; edited_at: number }
  | { t: "reaction"; messageId: number; emoji: string; userSub: string; op: "add" | "remove"; count: number }
  | { t: "pin"; channelId: number; messageId: number; pinned: boolean } // fijado/desfijado (room-wide)
  | { t: "star"; messageId: number; starred: boolean } // marcado personal (a ch.user, cross-device)
  | { t: "refresh"; channelId: number | null; parentId: number | null; dmId?: number | null } // churn de agente/status
  | { t: "unread"; scope: "room" | "dm"; scopeId: number } // hay algo nuevo en un scope no-activo → badge
  | { t: "presence"; sub: string; name: string; status: "online" | "offline" }
  | { t: "presence:init"; online: string[] }
  | { t: "typing"; sub: string; name: string; channelId: number | null; parentId?: number | null; dmId?: number | null };

type Listener = (ev: RtEvent) => void;
type Client = { channels: Set<string>; listener: Listener; sub: string };

const clients = new Set<Client>();
const online = new Map<string, number>(); // sub -> nº de conexiones abiertas

// Publica un evento a todos los clientes suscritos a `channel`. Síncrono, best-effort:
// un listener que falle (controller ya cerrado) no debe tumbar a los demás.
export function publish(channel: string, ev: RtEvent): void {
  for (const c of clients) {
    if (!c.channels.has(channel)) continue;
    try {
      c.listener(ev);
    } catch {
      /* controller cerrado en carrera — el cancel() lo limpiará */
    }
  }
}

// Registra una conexión (una pestaña). Gestiona presencia por conteo de conexiones.
// Devuelve el unsub que debe llamarse al cerrar el stream.
export function addClient(
  sub: string,
  name: string,
  channels: string[],
  listener: Listener
): () => void {
  const client: Client = { channels: new Set(channels), listener, sub };
  clients.add(client);
  const prev = online.get(sub) ?? 0;
  online.set(sub, prev + 1);
  if (prev === 0) publish(ch.presence(), { t: "presence", sub, name, status: "online" });

  return () => {
    clients.delete(client);
    const n = (online.get(sub) ?? 1) - 1;
    if (n <= 0) {
      online.delete(sub);
      publish(ch.presence(), { t: "presence", sub, name, status: "offline" });
    } else {
      online.set(sub, n);
    }
  };
}

export function onlineUsers(): string[] {
  return [...online.keys()];
}
