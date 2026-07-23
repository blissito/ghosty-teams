import { useEffect, useReducer, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import { Mic, MicOff, Video, VideoOff, ScreenShare, PhoneOff, Loader2 } from "lucide-react";
import { useT } from "../i18n";

// UI NATIVA de quick-call (corre en el browser del miembro). Se conecta con
// livekit-client al SFU (box livekit-svc) usando el token/wss que acuña el server
// (quick-calls.ts). Estilada con tokens de Teams → hereda light/dark. Sin green-room:
// entra directo (mic on, cámara off), como una quick call. Un solo <QuickCall> sirve
// para el dock del miembro (fase 1) y, luego, la página pública de invitado (fase 2).
export type CallConn = { token: string; wss: string; room: string; name: string };

// ── Un tile: adjunta el video (pantalla > cámara) o muestra el avatar ──
function Tile({ p, local }: { p: Participant; local: boolean }) {
  const vref = useRef<HTMLVideoElement>(null);
  const screen = p.getTrackPublication(Track.Source.ScreenShare);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const sharing = !!(screen && (screen.isSubscribed || local) && screen.track && !screen.isMuted);
  const pub = sharing ? screen : cam;
  const track = pub?.track;
  const videoOn = !!(pub && track && !pub.isMuted && (local || pub.isSubscribed) && (sharing || pub.source === Track.Source.Camera));
  const micPub = p.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;

  useEffect(() => {
    const el = vref.current;
    if (!el || !track || !videoOn) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, videoOn]);

  const name = (p.name || p.identity) + (local ? " (tú)" : "");
  const initial = (p.name || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-3">
      {videoOn ? (
        <video
          ref={vref}
          autoPlay
          playsInline
          muted={local}
          className={"h-full w-full " + (sharing ? "object-contain" : "object-cover") + (local && !sharing ? " -scale-x-100" : "")}
        />
      ) : (
        <div className="grid h-14 w-14 place-items-center rounded-full bg-brand text-lg font-bold text-brand-fg">
          {initial}
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[85%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {name}
      </span>
      {muted && (
        <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-red-600 text-white">
          <MicOff size={11} />
        </span>
      )}
    </div>
  );
}

export function QuickCall({ conn, onLeft }: { conn: CallConn; onLeft: () => void }) {
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
      .on(RoomEvent.ParticipantConnected, tick)
      .on(RoomEvent.ParticipantDisconnected, tick)
      .on(RoomEvent.TrackSubscribed, (track) => (onAudio(track as never), tick()))
      .on(RoomEvent.TrackUnsubscribed, (track) => ((track as { detach: () => void }).detach(), tick()))
      .on(RoomEvent.LocalTrackPublished, tick)
      .on(RoomEvent.LocalTrackUnpublished, tick)
      .on(RoomEvent.TrackMuted, tick)
      .on(RoomEvent.TrackUnmuted, tick)
      .on(RoomEvent.Disconnected, () => onLeft());
    (async () => {
      try {
        await room.connect(conn.wss, conn.token);
        await room.localParticipant.setMicrophoneEnabled(true); // mic on, cámara off por default
        if (alive) setStatus("live");
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

  const lp = room.localParticipant;
  const micOn = !!lp?.isMicrophoneEnabled;
  const camOn = !!lp?.isCameraEnabled;
  const screenOn = !!lp?.isScreenShareEnabled;
  const participants: Participant[] = [lp, ...room.remoteParticipants.values()].filter(Boolean) as Participant[];
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(participants.length))));

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
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-2 overflow-auto p-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {participants.map((p) => (
            <Tile key={p.identity} p={p} local={p === lp} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-center gap-2 border-t border-border px-3 py-2">
        <button
          onClick={() => lp?.setMicrophoneEnabled(!micOn)}
          className={micOn ? ctrl : ctrlOff}
          title={micOn ? t("Silenciar") : t("Activar micrófono")}
        >
          {micOn ? <Mic size={17} /> : <MicOff size={17} />}
        </button>
        <button
          onClick={() => lp?.setCameraEnabled(!camOn)}
          className={camOn ? ctrl : ctrlOff}
          title={camOn ? t("Apagar cámara") : t("Encender cámara")}
        >
          {camOn ? <Video size={17} /> : <VideoOff size={17} />}
        </button>
        <button
          onClick={() => lp?.setScreenShareEnabled(!screenOn)}
          className={"grid h-10 w-10 place-items-center rounded-full border border-border transition hover:bg-surface-3 " + (screenOn ? "bg-brand text-brand-fg" : "text-ink")}
          title={t("Compartir pantalla")}
        >
          <ScreenShare size={17} />
        </button>
        <button onClick={onLeft} className="grid h-10 w-10 place-items-center rounded-full bg-red-600 text-white transition hover:bg-red-700" title={t("Salir de la llamada")}>
          <PhoneOff size={17} />
        </button>
      </div>
    </div>
  );
}
