// ── Bus realtime en proceso (SSE in-VM) ─────────────────────────────────────
// UNA caja multitenant sirve a MUCHOS workspaces (un proceso Node, N tenants),
// así que TODO en este bus DEBE ir particionado por el namespace del tenant `ns`
// (el 24-hex del sqld del workspace). Sin eso, los canales colisionan entre
// tenants (`room:5` de A == `room:5` de B) y presencia/mensajes/notifs se filtran
// entre workspaces distintos. `ns` viene de currentNamespace() en cada request.
// La durabilidad NO vive aquí: cada mensaje se persiste en gc_messages ANTES de
// publicarse; esto es solo la señal "avísales ya". Un evento perdido nunca pierde
// el mensaje — el cliente reconcilia con getMessagesSince (catch-up por cursor).
//
// Interfaz swappable: si algún team creciera a miles de conexiones, se cambia SOLO
// la implementación de publish/addClient por un tier Centrifugo, sin tocar features.
import type { Message } from "../db.server";

// Canales namespaced POR TENANT: cada nombre lleva el prefijo `${ns}|` para que
// publish() nunca cruce workspaces (los clients de otro ns no matchean el canal).
export const ch = {
  room: (ns: string, id: number) => `${ns}|room:${id}`,
  dm: (ns: string, id: number) => `${ns}|dm:${id}`,
  user: (ns: string, sub: string) => `${ns}|user:${sub}`,
  presence: (ns: string) => `${ns}|presence`,
};

// Union versionada de eventos. `nonce` = id del cliente devuelto en el eco para que
// la pestaña que envió descarte su propio message:new (ya lo tiene optimista).
export type RtEvent =
  | { t: "message:new"; msg: Message; nonce?: string }
  | { t: "message:deleted"; id: number; channelId: number | null; parentId: number | null; dmId?: number | null }
  | { t: "message:edited"; id: number; body: string; edited_at: number }
  // Streaming de la respuesta de un agente, pedacito a pedacito: cada chunk se
  // appendea al body del mensaje-cáscara ya visible (kind:"msg", body vacío al
  // nacer). La durabilidad vive en gc_messages (body final al done); esto es señal.
  | { t: "message:delta"; id: number; chunk: string; channelId: number | null; parentId: number | null; dmId?: number | null }
  // Body autoritativo al terminar el stream (reconcilia por si se perdió un delta;
  // NO es una edición → no marca edited_at).
  | { t: "message:body"; id: number; body: string }
  // Estado de un turno de agente EN VUELO: corriendo o esperando su lugar en la cola,
  // y cuándo empezó. Sin esto, N turnos encolados se pintaban como N "pensando…"
  // idénticos y no había dónde colgar el botón de Detener.
  // Lleva el CONTEXTO completo (agente, tarea, paso) a propósito: con sólo id+estado el
  // cliente tenía que preguntar por el resto cada 8 s —2 consultas por turno vivo y por
  // pestaña abierta— para pintar la barra. Yendo completo, el sondeo sobra.
  | {
      t: "turn"; id: number; state: "running" | "queued" | "stopped" | "done";
      position: number; startedAt: number;
      agent?: string; avatar?: string; channelId?: number | null; parentId?: number | null; dmId?: number | null;
      tarea?: string; paso?: string; outcome?: string;
    }
  | { t: "reaction"; messageId: number; emoji: string; userSub: string; op: "add" | "remove"; count: number }
  | { t: "pin"; channelId: number; messageId: number; pinned: boolean } // fijado/desfijado (room-wide)
  | { t: "star"; messageId: number; starred: boolean } // marcado personal (a ch.user, cross-device)
  // "ábreme esto en el panel". Va SIEMPRE a ch.user: abrir el panel es una acción sobre la
  // pantalla de alguien, y hacerlo a todo el room le robaría lo que esté mirando. Hoy lo
  // usa el formulario recién creado: se pidió verlo aparecer, no tener que buscar la tarjeta.
  | { t: "artifact:open"; messageId: number }
  | { t: "refresh"; channelId: number | null; parentId: number | null; dmId?: number | null } // churn de agente/status
  | { t: "unread"; scope: "room" | "dm"; scopeId: number } // hay algo nuevo en un scope no-activo → badge
  | { t: "presence"; sub: string; name: string; status: "online" | "offline" }
  | { t: "presence:init"; online: string[] }
  | { t: "typing"; sub: string; name: string; channelId: number | null; parentId?: number | null; dmId?: number | null }
  // Quick-call arrancada/terminada en un scope → banner de "unirse" para la audiencia.
  // NO lleva token (cada quien acuña el suyo al unirse, ver quick-calls.ts).
  | { t: "quickcall:started"; scope: "room" | "dm"; scopeId: number; slug?: string; callId: string; host: { sub: string; name: string; avatar: string }; label: string; startedAt: number }
  | { t: "quickcall:ended"; scope: "room" | "dm"; scopeId: number; callId: string };

type Listener = (ev: RtEvent) => void;
type Client = { ns: string; channels: Set<string>; listener: Listener; sub: string };

const clients = new Set<Client>();
// Presencia POR TENANT: ns -> (sub -> nº de conexiones abiertas). Nunca global,
// o "quién está online" se filtraría entre workspaces distintos.
const online = new Map<string, Map<string, number>>();

function nsOnline(ns: string): Map<string, number> {
  let m = online.get(ns);
  if (!m) {
    m = new Map();
    online.set(ns, m);
  }
  return m;
}

// ¿El usuario tiene alguna pestaña conectada ahora, EN ESTE tenant? (gate de email:
// solo se notifica por correo a quien está OFFLINE, estilo Slack/Zulip).
export function isOnline(ns: string, sub: string): boolean {
  return (online.get(ns)?.get(sub) ?? 0) > 0;
}

// Publica un evento a todos los clientes suscritos a `channel`. Síncrono, best-effort:
// un listener que falle (controller ya cerrado) no debe tumbar a los demás. El
// aislamiento por tenant lo garantiza el prefijo `${ns}|` del nombre del canal.
// ── Body VIVO de un mensaje en curso (para el render progresivo del artefacto) ──
// El panel no puede pintar un artefacto "como llega" re-emitiendo srcDoc: cada
// re-emisión REMONTA el iframe y el <script> de Tailwind (render-blocking) vuelve a
// empezar → el frame nunca alcanza a pintar y solo se ve el resultado final. La
// solución es que el iframe apunte UNA vez a una respuesta HTTP que llega en chunks
// (el navegador la pinta incremental, como cualquier página). Para servir esa
// respuesta el proceso necesita el body EN CURSO: aquí lo guardamos conforme el
// agente lo va pintando, y avisamos a quien esté sirviéndolo.
// In-memory a propósito: es efímero (dura lo que el turno) y este bus ya es in-proceso.
const liveBodies = new Map<string, string>(); // `${ns}|${msgId}` → body acumulado
const bodyTaps = new Map<string, Set<(body: string) => void>>();
const LIVE_TTL_MS = 10 * 60_000;

const liveKey = (ns: string, id: number) => `${ns}|${id}`;

export function liveBody(ns: string, id: number): string | null {
  return liveBodies.get(liveKey(ns, id)) ?? null;
}

// Suscribe a las actualizaciones del body de UN mensaje. Devuelve el unsub.
export function tapBody(ns: string, id: number, fn: (body: string) => void): () => void {
  const k = liveKey(ns, id);
  let set = bodyTaps.get(k);
  if (!set) { set = new Set(); bodyTaps.set(k, set); }
  set.add(fn);
  return () => {
    const s = bodyTaps.get(k);
    if (!s) return;
    s.delete(fn);
    if (!s.size) bodyTaps.delete(k);
  };
}

function recordLiveBody(channel: string, ev: RtEvent): void {
  if (ev.t !== "message:body") return;
  const ns = channel.split("|")[0];
  const k = liveKey(ns, ev.id);
  liveBodies.set(k, ev.body);
  setTimeout(() => liveBodies.delete(k), LIVE_TTL_MS).unref?.();
  const taps = bodyTaps.get(k);
  if (/```eb-artifact/.test(ev.body) && !taps) console.log(`[gt-live] id=${ev.id} ns=${ns.slice(0, 8)} ${ev.body.length}b SIN taps`);
  if (!taps) return;
  for (const fn of taps) {
    try { fn(ev.body); } catch { /* stream cerrado en carrera */ }
  }
}

// Publica un evento a todos los clientes suscritos a `channel`. Síncrono, best-effort.
export function publish(channel: string, ev: RtEvent): void {
  recordLiveBody(channel, ev);
  for (const c of clients) {
    if (!c.channels.has(channel)) continue;
    try {
      c.listener(ev);
    } catch {
      /* controller cerrado en carrera — el cancel() lo limpiará */
    }
  }
}

// Registra una conexión (una pestaña) para el tenant `ns`. Gestiona presencia por
// conteo de conexiones, scopeada al tenant. Devuelve el unsub al cerrar el stream.
export function addClient(
  ns: string,
  sub: string,
  name: string,
  channels: string[],
  listener: Listener
): () => void {
  const client: Client = { ns, channels: new Set(channels), listener, sub };
  clients.add(client);
  const om = nsOnline(ns);
  const prev = om.get(sub) ?? 0;
  om.set(sub, prev + 1);
  if (prev === 0) publish(ch.presence(ns), { t: "presence", sub, name, status: "online" });

  return () => {
    clients.delete(client);
    const n = (om.get(sub) ?? 1) - 1;
    if (n <= 0) {
      om.delete(sub);
      if (om.size === 0) online.delete(ns);
      publish(ch.presence(ns), { t: "presence", sub, name, status: "offline" });
    } else {
      om.set(sub, n);
    }
  };
}

// Subs online EN ESTE tenant (para presence:init del recién llegado).
export function onlineUsers(ns: string): string[] {
  return [...(online.get(ns)?.keys() ?? [])];
}
