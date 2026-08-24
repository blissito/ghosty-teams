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
import { IDLE_MS } from "../lib/presence";

// Canales namespaced POR TENANT: cada nombre lleva el prefijo `${ns}|` para que
// publish() nunca cruce workspaces (los clients de otro ns no matchean el canal).
export const ch = {
  room: (ns: string, id: number) => `${ns}|room:${id}`,
  dm: (ns: string, id: number) => `${ns}|dm:${id}`,
  user: (ns: string, sub: string) => `${ns}|user:${sub}`,
  presence: (ns: string) => `${ns}|presence`,
  // Presencia de UNA sala de evento. Es sólo la CLAVE del mapa, no un canal al que
  // nadie se suscriba: el aviso viaja por `room`, donde ya están los miembros y los
  // invitados. Existe aparte de `presence` porque son dos públicos distintos: aquélla
  // es el padrón del workspace —gente con cuenta y nombre real— y ésta, desconocidos
  // que entraron por una liga. Mezclarlos metería 100 `guest:*` en el chip de "quiénes
  // están en línea" del dueño, y le enseñaría a cada invitado la plantilla del cliente.
  event: (ns: string, channelId: number) => `${ns}|event:${channelId}`,
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
  // El agente movió el filtro de una lista de prospección.
  //
  // ⚠️ Va a `ch.user`, no al room: es la vista de UNA persona. Y va como evento propio y no
  // como `refresh` porque trae DATOS (el filtro) — la pantalla tiene que aplicar ese filtro
  // exacto, no volver a leer y quedarse igual.
  //
  // Es lo que hace que el agente mueva LA MISMA barra que la persona ve, en vez de filtrar
  // por dentro y contestar «listo».
  | { t: "prospeccion:filter"; listId: number; f: string | null }
  // El agente PROPONE mandar. Abre la pantalla de confirmación con el asunto ya puesto; no
  // manda nada. Un correo enviado es lo único de todo el módulo que no se puede deshacer.
  | { t: "prospeccion:send"; listId: number; subject: string }
  // La pantalla la crea y la corre: el turno del agente no vive los minutos que tarda.
  | {
      t: "prospeccion:column";
      listId: number;
      label: string;
      kind: "enrich" | "ai";
      waterfall: string[];
      prompt: string;
      mode: "write" | "research";
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
  // `lastActiveAt` = última señal REAL de la persona (escribir, marcar leído, enviar),
  // no la última conexión. Con la pestaña abierta y quieta, envejece: es lo que separa
  // "conectado" de "atento". El paso a inactivo no se emite — se deriva del timestamp.
  | { t: "presence"; sub: string; name: string; avatar?: string; status: "online" | "offline"; lastActiveAt: number }
  | { t: "presence:init"; online: { sub: string; name: string; avatar?: string; lastActiveAt: number }[] }
  | { t: "typing"; sub: string; name: string; channelId: number | null; parentId?: number | null; dmId?: number | null }
  // Cuánta gente hay AHORA en la sala de un evento, y quién entró o salió. Va al canal
  // del room, así que lo reciben por igual los invitados de la sala y el equipo desde su
  // Teams. Lleva `count` además del delta porque quien acaba de conectarse no tiene otra
  // fuente para el total, y porque un delta perdido se corrige solo al siguiente.
  | { t: "event:presence"; channelId: number; count: number; joined?: { sub: string; name: string }; left?: { sub: string; name: string } }
  // Quick-call arrancada/terminada en un scope → banner de "unirse" para la audiencia.
  // NO lleva token (cada quien acuña el suyo al unirse, ver quick-calls.ts).
  | { t: "quickcall:started"; scope: "room" | "dm"; scopeId: number; slug?: string; callId: string; host: { sub: string; name: string; avatar: string }; label: string; startedAt: number }
  | { t: "quickcall:ended"; scope: "room" | "dm"; scopeId: number; callId: string };

type Listener = (ev: RtEvent) => void;
type Client = { ns: string; channels: Set<string>; listener: Listener; sub: string };

const clients = new Set<Client>();
// Presencia POR TENANT: ns -> (sub -> {conexiones abiertas, nombre}). Nunca global,
// o "quién está online" se filtraría entre workspaces distintos.
// El NOMBRE se guarda aquí porque el snapshot del recién llegado (`presence:init`)
// tiene que poder decir QUIÉN, no sólo cuántos: los eventos sueltos sí traen nombre,
// pero de la gente que ya estaba conectada el cliente no tiene ninguna otra fuente.
type OnlineEntry = { n: number; name: string; avatar?: string; lastActiveAt: number };
const online = new Map<string, Map<string, OnlineEntry>>();

function nsOnline(ns: string): Map<string, OnlineEntry> {
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
  return (online.get(ns)?.get(sub)?.n ?? 0) > 0;
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
  listener: Listener,
  avatar?: string
): () => void {
  const client: Client = { ns, channels: new Set(channels), listener, sub };
  clients.add(client);
  const om = nsOnline(ns);
  const prev = om.get(sub)?.n ?? 0;
  const now = Date.now();
  om.set(sub, { n: prev + 1, name, avatar, lastActiveAt: now });
  if (prev === 0) publish(ch.presence(ns), { t: "presence", sub, name, avatar, status: "online", lastActiveAt: now });

  return () => {
    clients.delete(client);
    const e = om.get(sub);
    const n = (e?.n ?? 1) - 1;
    if (n <= 0) {
      om.delete(sub);
      if (om.size === 0) online.delete(ns);
      publish(ch.presence(ns), { t: "presence", sub, name, status: "offline", lastActiveAt: e?.lastActiveAt ?? now });
    } else {
      om.set(sub, { n, name, avatar: e?.avatar ?? avatar, lastActiveAt: e?.lastActiveAt ?? now });
    }
  };
}

// ── Presencia de las salas de evento ────────────────────────────────────────
// Mapa aparte del de `online` A PROPÓSITO, y es la decisión que importa de todo este
// bloque: ahí viven las personas del workspace, y `onlinePeople()` —que alimenta el
// snapshot `presence:init` y el chip del dueño— devuelve la lista ENTERA con nombres.
// Un `guest:<uuid>` metido ahí saldría en el chip como si fuera del equipo, y peor:
// haría que el snapshot que recibe cada invitado llevara los nombres de la plantilla.
// Contarlos por separado hace que eso no pueda pasar por descuido.
type EventEntry = { n: number; name: string };
const eventOnline = new Map<string, Map<string, EventEntry>>(); // `${ns}|event:${chId}` → sub → entry

function eventMap(key: string): Map<string, EventEntry> {
  let m = eventOnline.get(key);
  if (!m) {
    m = new Map();
    eventOnline.set(key, m);
  }
  return m;
}

/** Quién está ahora en la sala de un evento (para el snapshot del recién llegado). */
export function eventPeople(ns: string, channelId: number): { sub: string; name: string }[] {
  const m = eventOnline.get(ch.event(ns, channelId));
  return [...(m?.entries() ?? [])].map(([sub, e]) => ({ sub, name: e.name }));
}

/**
 * Registra una conexión a la sala de un evento: recibe todo lo del room y cuenta en la
 * presencia DEL EVENTO, nunca en la del workspace.
 *
 * `filtro` es la lista blanca de eventos que puede ver quien se conecta. Va aquí y no
 * en el endpoint para que ninguna conexión de invitado pueda existir sin ella.
 */
export function addEventClient(
  ns: string,
  channelId: number,
  sub: string,
  name: string,
  listener: Listener,
  filtro: (ev: RtEvent) => boolean
): () => void {
  const roomCh = ch.room(ns, channelId);
  const key = ch.event(ns, channelId);
  const client: Client = {
    ns,
    channels: new Set([roomCh]),
    listener: (ev) => {
      if (filtro(ev)) listener(ev);
    },
    sub,
  };
  clients.add(client);

  const m = eventMap(key);
  const prev = m.get(sub)?.n ?? 0;
  m.set(sub, { n: prev + 1, name });
  // Sólo al ABRIR la primera pestaña de esa persona: dos pestañas no son dos personas.
  //
  // Sin nombre (un MIRÓN, que llegó por la liga y aún no se ha identificado) se anuncia
  // el conteo pero no el `joined`: cuenta como presencia, no como alguien que "entró".
  // Nombrarlo obligaría a inventarle uno, y una lista de "Invitado 7, Invitado 8" es peor
  // señal que un número honesto.
  if (prev === 0) {
    publish(roomCh, {
      t: "event:presence",
      channelId,
      count: m.size,
      ...(name ? { joined: { sub, name } } : {}),
    });
  }

  let dado = false;
  return () => {
    // De un SOLO uso, igual que en `api.stream.ts`: la baja la puede disparar tanto el
    // `cancel()` del stream como el heartbeat que descubre el socket muerto, y descontar
    // dos veces la misma pestaña deja el contador por debajo de la realidad.
    if (dado) return;
    dado = true;
    clients.delete(client);
    const e = m.get(sub);
    const n = (e?.n ?? 1) - 1;
    if (n > 0) {
      m.set(sub, { n, name: e?.name ?? name });
      return;
    }
    m.delete(sub);
    if (m.size === 0) eventOnline.delete(key);
    publish(roomCh, {
      t: "event:presence",
      channelId,
      count: m.size,
      ...(name ? { left: { sub, name } } : {}),
    });
  };
}

// "Sigo aquí": lo llama lo que el cliente YA le manda al servidor (escribir, marcar
// leído, enviar). No hay ping periódico nuevo — una pestaña abierta y quieta deja de
// contar sola, que es justo lo que queremos distinguir.
//
// ⚠️ Sólo publica al VOLVER de inactivo. Publicar en cada señal sería un evento por
// tecla a todo el workspace; el paso a inactivo tampoco se anuncia (nadie lo emite:
// el cliente lo deriva del timestamp que ya tiene).
export function touchPresence(ns: string, sub: string): void {
  const e = online.get(ns)?.get(sub);
  if (!e) return; // sin conexión abierta no hay presencia que refrescar
  const now = Date.now();
  const wasIdle = now - e.lastActiveAt > IDLE_MS;
  e.lastActiveAt = now;
  if (wasIdle) publish(ch.presence(ns), { t: "presence", sub, name: e.name, avatar: e.avatar, status: "online", lastActiveAt: now });
}

// Subs online EN ESTE tenant.
export function onlineUsers(ns: string): string[] {
  return [...(online.get(ns)?.keys() ?? [])];
}

// Quién está online, con nombre y última señal (para presence:init del recién llegado).
export function onlinePeople(ns: string): { sub: string; name: string; avatar?: string; lastActiveAt: number }[] {
  return [...(online.get(ns)?.entries() ?? [])].map(([sub, e]) => ({ sub, name: e.name, avatar: e.avatar, lastActiveAt: e.lastActiveAt }));
}
