import { useEffect, useReducer, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import { Mic, MicOff, Video, VideoOff, ScreenShare, PhoneOff, Loader2 } from "lucide-react";
import { useT } from "../i18n";

// UI NATIVA de quick-call (corre en el browser del miembro). livekit-client → SFU
// (box livekit-svc) con el token/wss que acuña el server (quick-calls.ts). Estilada
// con tokens de Teams → hereda light/dark. Sin green-room: entra directo (mic on,
// cámara off). Layout estilo Meet/Zoom/Slack: al compartir pantalla, la pantalla va
// GRANDE + cámaras en filmstrip; si no, grid parejo (galería).
export type CallConn = { token: string; wss: string; room: string; name: string };

// ── Sonidos (WebAudio, sin assets) — entrar/salir, como Meet/Slack ──
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

// Un tile = UNA fuente (cámara O pantalla). La pantalla es su propio tile, así tu
// cámara SIEMPRE se ve (self-view) aunque estés compartiendo.
function Tile({ p, source, local }: { p: Participant; source: Track.Source; local: boolean }) {
  const vref = useRef<HTMLVideoElement>(null);
  const pub = p.getTrackPublication(source);
  const track = pub?.track;
  const on = !!(pub && track && !pub.isMuted && (local || pub.isSubscribed));
  const screen = source === Track.Source.ScreenShare;

  useEffect(() => {
    const el = vref.current;
    if (!el || !track || !on) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, on]);

  const micPub = p.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;
  const base = p.name || p.identity;
  const label = base + (local ? " (tú)" : "") + (screen ? " · pantalla" : "");
  const initial = (base || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-3">
      {on ? (
        <video
          ref={vref}
          autoPlay
          playsInline
          muted={local && !screen}
          className={"h-full w-full " + (screen ? "object-contain" : "object-cover") + (local && !screen ? " -scale-x-100" : "")}
        />
      ) : (
        <div className="grid h-14 w-14 place-items-center rounded-full bg-brand text-lg font-bold text-brand-fg">
          {initial}
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[85%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {label}
      </span>
      {!screen && muted && (
        <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-red-600 text-white">
          <MicOff size={11} />
        </span>
      )}
    </div>
  );
}

export function QuickCall({ conn, onLeft }: { conn: CallConn; onLeft: (alone?: boolean) => void }) {
  const t = useT();
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [, tick] = useReducer((n) => n + 1, 0); // re-render en cada evento de sala
  const audioRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const onAudio = (track: { kind: Track.Kind; attach: () => HTMLMediaElement }) => {
      if (track.kind !== Track.Kind.Audio || !audioRef.current) return;
      audioRef.current.appendChild(track.attach());
    };
    room
      .on(RoomEvent.ParticipantConnected, () => (joinSound(), tick()))
      .on(RoomEvent.ParticipantDisconnected, tick)
      .on(RoomEvent.TrackSubscribed, (track) => (onAudio(track as never), tick()))
      .on(RoomEvent.TrackUnsubscribed, (track) => ((track as { detach: () => void }).detach(), tick()))
      .on(RoomEvent.LocalTrackPublished, tick)
      .on(RoomEvent.LocalTrackUnpublished, tick)
      .on(RoomEvent.TrackMuted, tick)
      .on(RoomEvent.TrackUnmuted, tick)
      .on(RoomEvent.Disconnected, () => onLeft(room.remoteParticipants.size === 0));
    (async () => {
      try {
        await room.connect(conn.wss, conn.token);
        await room.localParticipant.setMicrophoneEnabled(true); // mic on, cámara off por default
        if (alive) {
          setStatus("live");
          joinSound();
        }
      } catch {
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
      room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = () => {
    byeSound();
    onLeft(room.remoteParticipants.size === 0); // el cliente sabe si quedó solo → cierre confiable
  };

  const lp = room.localParticipant;
  const micOn = !!lp?.isMicrophoneEnabled;
  const camOn = !!lp?.isCameraEnabled;
  const screenOn = !!lp?.isScreenShareEnabled;
  const participants: Participant[] = [lp, ...room.remoteParticipants.values()].filter(Boolean) as Participant[];

  // ¿Alguien comparte pantalla? (el primero manda el foco, patrón Meet/Zoom).
  let sharer: Participant | null = null;
  for (const p of participants) {
    const sp = p.getTrackPublication(Track.Source.ScreenShare);
    if (sp && sp.track && !sp.isMuted && (p === lp || sp.isSubscribed)) {
      sharer = p;
      break;
    }
  }
  const cams = participants; // una cámara-tile por participante
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(cams.length))));

  const ctrl = "grid h-10 w-10 place-items-center rounded-full border border-border text-ink transition hover:bg-surface-3";
  const ctrlOff = "grid h-10 w-10 place-items-center rounded-full bg-red-600 text-white transition hover:bg-red-700";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div ref={audioRef} className="hidden" />
      {status !== "live" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
          {status === "connecting" ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              {t("Conectando…")}
            </>
          ) : (
            t("No se pudo conectar a la llamada")
          )}
        </div>
      ) : sharer ? (
        // Foco: pantalla GRANDE arriba + cámaras en filmstrip abajo (Meet/Zoom/Slack).
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">
            <Tile p={sharer} source={Track.Source.ScreenShare} local={sharer === lp} />
          </div>
          <div className="flex shrink-0 gap-2 overflow-x-auto">
            {cams.map((p) => (
              <div key={p.identity + ":cam"} className="aspect-video h-20 shrink-0 md:h-24">
                <Tile p={p} source={Track.Source.Camera} local={p === lp} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Galería: grid parejo de cámaras.
        <div className="grid min-h-0 flex-1 gap-2 overflow-auto p-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {cams.map((p) => (
            <Tile key={p.identity + ":cam"} p={p} source={Track.Source.Camera} local={p === lp} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-center gap-2 border-t border-border px-3 py-2">
        <button onClick={() => lp?.setMicrophoneEnabled(!micOn)} className={micOn ? ctrl : ctrlOff} title={micOn ? t("Silenciar") : t("Activar micrófono")}>
          {micOn ? <Mic size={17} /> : <MicOff size={17} />}
        </button>
        <button onClick={() => lp?.setCameraEnabled(!camOn)} className={camOn ? ctrl : ctrlOff} title={camOn ? t("Apagar cámara") : t("Encender cámara")}>
          {camOn ? <Video size={17} /> : <VideoOff size={17} />}
        </button>
        <button
          onClick={() => lp?.setScreenShareEnabled(!screenOn, { audio: true })}
          className={"grid h-10 w-10 place-items-center rounded-full border border-border transition hover:bg-surface-3 " + (screenOn ? "bg-brand text-brand-fg" : "text-ink")}
          title={t("Compartir pantalla")}
        >
          <ScreenShare size={17} />
        </button>
        <button onClick={leave} className="grid h-10 w-10 place-items-center rounded-full bg-red-600 text-white transition hover:bg-red-700" title={t("Salir de la llamada")}>
          <PhoneOff size={17} />
        </button>
      </div>
    </div>
  );
}
