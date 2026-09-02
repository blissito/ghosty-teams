import { useSyncExternalStore } from "react";
import type { Room, RemoteTrack } from "livekit-client";
import { startCallFn, joinCallFn, leaveCallFn, getActiveCallFn } from "../server/quick-calls";
import { listMutesFn } from "../server/stars";
import { subscribeRt } from "../utils/rt-bus";
import { playNotificationSound, startCallRing, stopCallRing } from "../utils/notificationSound";
import { showSystemNotification } from "../utils/system-notification";

// ─────────────────────────────────────────────────────────────────────────────
// Dueño de la llamada rápida, FUERA de React.
//
// Antes esto vivía como `useState` de la ruta del chat y el `Room` de LiveKit se creaba
// dentro de <QuickCall> (`useState(() => new Room())`) con un cleanup que hacía
// `room.disconnect()`. Consecuencia: salir a /forms, /artifacts o /coeditar desmontaba la
// ruta y CORTABA la llamada. Con el Room en module-scope ningún desmontaje puede colgarla
// —ni una navegación, ni HMR, ni un layout futuro—; el montaje en la raíz es la segunda
// red, no la única.
//
// También vive aquí el aviso de llamada ENTRANTE (antes atado al chat, o sea que fuera de
// /c/$slug no timbraba nadie).
// ─────────────────────────────────────────────────────────────────────────────

export type CallConn = { token: string; wss: string; room: string; name: string };
export type CallTarget = { scope: "room"; slug: string } | { scope: "dm"; dmId: number };
export type CallScope = "room" | "dm";
export type Incoming = {
  callId: string;
  host: { sub: string; name: string; avatar: string };
  label: string;
  startedAt: number;
  scope: CallScope;
  scopeId: number;
  slug?: string;
};
export type Joined = {
  scope: CallScope;
  scopeId: number;
  conn: CallConn;
  label: string;
  target: CallTarget;
  room: Room;
};

export type CallSnapshot = {
  joined: Joined | null;
  status: "idle" | "connecting" | "live" | "error";
  incoming: Incoming[];
  /** sube en cada evento de la sala → re-render de la UI que lee del Room */
  version: number;
  /**
   * La llamada se está grabando. Vive aquí y no dentro del componente porque quien
   * aparece en la grabación tiene derecho a verlo aunque no haya sido quien pulsó: el
   * testigo llega por el bus a TODOS los que están dentro.
   */
  recording: { by: string; startedAt: number; canStop: boolean } | null;
};

const EMPTY: CallSnapshot = { joined: null, status: "idle", incoming: [], version: 0, recording: null };

let snapshot: CallSnapshot = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function set(patch: Partial<CallSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  emit();
}
function bump() {
  snapshot = { ...snapshot, version: snapshot.version + 1 };
  emit();
}

export function subscribeCall(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getCallSnapshot(): CallSnapshot {
  return snapshot;
}
export function useCall(): CallSnapshot {
  return useSyncExternalStore(subscribeCall, getCallSnapshot, () => EMPTY);
}

// Sólo la IDENTIDAD de la llamada en la que estoy ("room:12" / "dm:3" / null). La ruta del
// chat consume esto y no el snapshot entero: `version` sube en CADA evento de la sala
// (mute, track, participante) y suscribir ahí el árbol completo del chat lo re-renderizaría
// decenas de veces por llamada. Un string primitivo sólo despierta cuando de verdad cambia.
const callKey = () => (snapshot.joined ? `${snapshot.joined.scope}:${snapshot.joined.scopeId}` : null);
export function useMyCallKey(): string | null {
  return useSyncExternalStore(subscribeCall, callKey, () => null);
}

// ── Quién soy (lo inyecta CallLayer desde el contexto del router) ─────────────
let mySub = "";
export function setCallIdentity(sub: string) {
  mySub = sub;
}

// ── Sonidos (WebAudio, sin assets) ───────────────────────────────────────────
function blip(notes: [number, number][], type: OscillatorType = "sine", peak = 0.2) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    let tn = ctx.currentTime;
    for (const [f, d] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.exponentialRampToValueAtTime(peak, tn + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, tn + d);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(tn);
      o.stop(tn + d);
      tn += d;
    }
    setTimeout(() => ctx.close().catch(() => {}), (tn - ctx.currentTime + 0.1) * 1000);
  } catch {
    /* sin audio disponible → silencio */
  }
}
const joinSound = () => blip([[523, 0.1], [784, 0.12]]);
const byeSound = () => blip([[392, 0.12], [262, 0.2]], "triangle", 0.28);

// ── Sink de audio: un contenedor oculto en <body>, NO dentro de un componente ──
// Antes era un ref de <QuickCall>: si el componente se desmontaba, los <audio> se iban
// del DOM con él y la llamada se quedaba muda aunque la conexión siguiera viva.
let audioSink: HTMLDivElement | null = null;
function sink(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (!audioSink) {
    audioSink = document.createElement("div");
    audioSink.style.display = "none";
    audioSink.dataset.gtCallAudio = "1";
    document.body.appendChild(audioSink);
  }
  return audioSink;
}

// ── Marca de sesión: qué llamada re-tomar tras un F5 ──────────────────────────
// ⚠️ SALIRSE ES DEFINITIVO. La marca se escribe SÓLO al unirse y se borra en el MISMO
// acto de salir (botón de colgar, quickcall:ended, Disconnected), antes de cualquier
// await. Que la llamada siga viva con otra gente NO basta para re-unirte: el rejoin exige
// la marca. Nunca derivar el rejoin de "hay una llamada activa en un scope del que soy
// miembro" — eso te metería de vuelta a una llamada de la que te saliste a propósito.
const MARK = "gt:call:rejoin";
type Mark = { scope: CallScope; scopeId: number; target: CallTarget; label: string };
function writeMark(m: Mark) {
  try {
    sessionStorage.setItem(MARK, JSON.stringify(m));
  } catch {
    /* modo privado / storage lleno → sin rejoin, no es crítico */
  }
}
function clearMark() {
  try {
    sessionStorage.removeItem(MARK);
  } catch {
    /* idem */
  }
}
function readMark(): Mark | null {
  try {
    const raw = sessionStorage.getItem(MARK);
    return raw ? (JSON.parse(raw) as Mark) : null;
  } catch {
    return null;
  }
}

// ── Llamadas entrantes ───────────────────────────────────────────────────────
const incomingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let mutes = new Set<string>();

export function refreshCallMutes(): void {
  // El store necesita los silencios por su cuenta: fuera del chat no hay ruta que se los
  // pase, y sin ellos timbraría un scope silenciado.
  listMutesFn()
    .then((rows) => {
      mutes = new Set(rows.map((m) => `${m.scope}:${m.scope_id}`));
    })
    .catch(() => {});
}

function clearIncomingTimer(key: string) {
  const tm = incomingTimers.get(key);
  if (tm) {
    clearTimeout(tm);
    incomingTimers.delete(key);
  }
}

function syncRing() {
  // DM 1:1 = ring en loop (tipo teléfono). Room = un chime puntual al llegar.
  if (snapshot.incoming.some((c) => c.scope === "dm")) startCallRing();
  else stopCallRing();
}

export function dismissIncoming(key: string): void {
  clearIncomingTimer(key);
  const next = snapshot.incoming.filter((c) => `${c.scope}:${c.scopeId}` !== key);
  if (next.length !== snapshot.incoming.length) set({ incoming: next });
  syncRing();
}

function addIncoming(c: Incoming) {
  const key = `${c.scope}:${c.scopeId}`;
  const prev = snapshot.incoming.find((x) => `${x.scope}:${x.scopeId}` === key);
  if (prev?.callId === c.callId) return;
  set({ incoming: [...snapshot.incoming.filter((x) => `${x.scope}:${x.scopeId}` !== key), c] });
  if (c.scope === "room") playNotificationSound();
  // Con la pestaña en otra ventana el banner in-app no se ve: segundo camino, la
  // notificación del SO desde la propia página.
  if (typeof document !== "undefined" && document.hidden) {
    showSystemNotification(
      `${c.host.name} está llamando`,
      c.scope === "room" ? `Llamada en #${c.label}` : "Llamada directa",
      c.slug
    );
  }
  clearIncomingTimer(key);
  incomingTimers.set(key, setTimeout(() => dismissIncoming(key), 30000)); // no contestada
  syncRing();
}

// ── Abrir / cerrar la llamada ────────────────────────────────────────────────
let opening = false;

export async function openCall(
  fn: (o: { data: CallTarget }) => Promise<CallConn>,
  scope: CallScope,
  scopeId: number,
  target: CallTarget,
  label: string,
  onError?: (raw: string) => void
): Promise<void> {
  if (opening) return;
  const key = `${scope}:${scopeId}`;
  dismissIncoming(key); // unirme a ese scope lo saca de "entrante" y para su ring
  if (snapshot.joined) {
    if (snapshot.joined.scope === scope && snapshot.joined.scopeId === scopeId) return; // ya estoy
    leaveCall(); // una llamada a la vez
  }
  opening = true;
  set({ status: "connecting" });
  let room: Room | null = null;
  try {
    const { Room, RoomEvent } = await import("livekit-client");
    const conn = await fn({ data: target });
    room = new Room({ adaptiveStream: true, dynacast: true });
    room
      .on(RoomEvent.ParticipantConnected, () => (joinSound(), bump()))
      .on(RoomEvent.ParticipantDisconnected, bump)
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === "audio") sink()?.appendChild(track.attach());
        bump();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        bump();
      })
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
      .on(RoomEvent.Disconnected, () => {
        // El SFU nos soltó (o alguien terminó la llamada). Salir es salir: se borra la
        // marca, así que un F5 después NO nos re-mete.
        if (snapshot.joined?.room !== room) return; // disconnect de una sala ya reemplazada
        finishLocal(room.remoteParticipants.size === 0, true);
      });
    set({ joined: { scope, scopeId, conn, label, target, room }, status: "connecting" });
    await room.connect(conn.wss, conn.token);
    await room.localParticipant.setMicrophoneEnabled(true); // mic on, cámara off por default
    // El dispositivo elegido la última vez, si sigue conectado. Con `.catch`: un USB que
    // ya no está no puede impedir entrar a la llamada.
    for (const kind of ["audioinput", "videoinput"] as const) {
      const id = readDevice(kind);
      if (id) await room.switchActiveDevice(kind, id).catch(() => {});
    }
    if (snapshot.joined?.room !== room) return; // salieron mientras conectaba
    writeMark({ scope, scopeId, target, label });
    set({ status: "live" });
    joinSound();
  } catch (e) {
    // Un fallo silencioso se lee como "el botón no sirve" (incidente 2026-07-26).
    console.error("[call] no se pudo abrir", e);
    clearMark();
    try {
      room?.removeAllListeners();
      room?.disconnect();
    } catch {
      /* nunca llegó a conectar */
    }
    set({ joined: null, status: "error", recording: null });
    onError?.(String((e as Error)?.message ?? e));
  } finally {
    opening = false;
  }
}

// Cierra el estado local. `notifyServer` = avisar a leaveCallFn (no hace falta cuando la
// llamada ya terminó desde el server).
function finishLocal(alone: boolean, notifyServer: boolean) {
  const j = snapshot.joined;
  clearMark(); // SIEMPRE primero: salirse es definitivo
  if (!j) {
    set({ status: "idle" });
    return;
  }
  set({ joined: null, status: "idle", recording: null });
  try {
    j.room.removeAllListeners();
    j.room.disconnect();
  } catch {
    /* ya estaba caída */
  }
  if (audioSink) audioSink.replaceChildren();
  if (notifyServer) leaveCallFn({ data: { ...j.target, alone } }).catch(() => {});
}

export function leaveCall(alone?: boolean): void {
  const j = snapshot.joined;
  clearMark();
  if (!j) return;
  byeSound();
  // El cliente sabe si quedó solo → cierre confiable de la tarjeta.
  finishLocal(alone ?? j.room.remoteParticipants.size === 0, true);
}

// La llamada terminó desde el server (`quickcall:ended`): cierra lo local sin volver a
// avisar, y borra la marca — no hay a qué re-unirse.
export function endCallFromServer(scope: CallScope, scopeId: number): void {
  dismissIncoming(`${scope}:${scopeId}`); // ya no timbra: terminó
  const j = snapshot.joined;
  if (j && j.scope === scope && j.scopeId === scopeId) finishLocal(false, false);
}

// ── Rejoin tras recargar ─────────────────────────────────────────────────────
let rejoinTried = false;
export async function maybeRejoin(): Promise<void> {
  if (rejoinTried) return;
  rejoinTried = true;
  const m = readMark();
  if (!m || snapshot.joined) return;
  try {
    // Sólo si la llamada SIGUE viva. Si terminó, la marca se va sin ruido: nunca se
    // resucita una llamada muerta ni se piden permisos de micrófono de más.
    const live = await getActiveCallFn({ data: m.target });
    if (!live) {
      clearMark();
      return;
    }
    await openCall(joinCallFn, m.scope, m.scopeId, m.target, m.label);
  } catch {
    clearMark();
  }
}

// ── Enganche al realtime ─────────────────────────────────────────────────────
let wired = false;
export function wireCallRealtime(): void {
  if (wired) return;
  wired = true;
  subscribeRt({
    onReconnect: () => refreshCallMutes(),
    onEvent: (ev) => {
      if (ev.t === "quickcall:started") {
        const k = `${ev.scope}:${ev.scopeId}`;
        const iStarted = ev.host.sub === mySub;
        const j = snapshot.joined;
        const alreadyJoined = j?.scope === ev.scope && j?.scopeId === ev.scopeId;
        if (!iStarted && !alreadyJoined && !mutes.has(k)) {
          addIncoming({
            callId: ev.callId,
            host: ev.host,
            label: ev.label,
            startedAt: ev.startedAt,
            scope: ev.scope,
            scopeId: ev.scopeId,
            slug: ev.slug,
          });
        }
      } else if (ev.t === "quickcall:ended") {
        endCallFromServer(ev.scope, ev.scopeId);
      } else if (ev.t === "quickcall:recording") {
        // Sólo si es la llamada en la que estoy: el evento va al canal del room, que
        // también lo reciben quienes NO entraron a la llamada.
        const j = snapshot.joined;
        if (j?.scope === ev.scope && j?.scopeId === ev.scopeId) {
          // `canStop` no se deriva aquí: lo dice el servidor, que es quien sabe quién
          // inició la llamada. Al recibirlo por el bus se asume que no, y el que sí puede
          // ya lo tiene puesto desde su propia respuesta.
          set({
            recording: ev.recording
              ? { by: ev.by ?? "", startedAt: ev.startedAt ?? Math.floor(Date.now() / 1000), canStop: false }
              : null,
          });
        }
      }
    },
  });
}

export { startCallFn, joinCallFn, getActiveCallFn };

// Preferencia de mic/cámara por navegador. La sala del webinar la pierde al salir y
// obliga a re-elegir cada vez; aquí se recuerda y se aplica al entrar.
const DEVICE_KEY = "gt.call.device.";
export function rememberDevice(kind: "audioinput" | "videoinput", id: string): void {
  try {
    localStorage.setItem(DEVICE_KEY + kind, id);
  } catch {
    /* storage bloqueado */
  }
}
function readDevice(kind: "audioinput" | "videoinput"): string {
  try {
    return localStorage.getItem(DEVICE_KEY + kind) ?? "";
  } catch {
    return "";
  }
}

/** Marca local del estado de grabación (lo usa quien pulsa, sin esperar al bus). */
export function setRecording(r: CallSnapshot["recording"]): void {
  set({ recording: r });
}
