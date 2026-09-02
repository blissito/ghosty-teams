import { Track, type LocalParticipant, type LocalVideoTrack } from "livekit-client";

// Compartir pantalla en la llamada de Teams. Portado de `livekit-svc/room.html`
// (⇄ Fuente, hardenShareTrack, killShareTracks), donde se pagaron tres trampas de
// livekit-client que aquí se repiten a propósito:
//
// 1. El SDK escucha el `mute` de la captura y a los 5 s hace `pauseUpstream()`
//    (`sender.replaceTrack(null)`): la sala se queda en NEGRO sin error. Chrome dispara
//    ese `mute` por cosas mundanas (ventana oculta, cambio de superficie). Se le quitan
//    esos listeners al publicar.
// 2. `replaceTrack` NO detiene la pista anterior (la marca `userProvided`): el navegador
//    sigue capturando la ventana vieja y su barra "estás compartiendo" se queda viva. Se
//    para a mano, quitándole antes su `onended` para que su muerte no se lea como "dejó
//    de compartir".
// 3. El SDK sólo detiene la pista publicada al parar. Cada pista que salió de
//    `getDisplayMedia` se apunta y se mata en stop y en `pagehide`.

const shareTracks = new Set<MediaStreamTrack>();

function remember(t: MediaStreamTrack) {
  shareTracks.add(t);
}
export function killShareTracks(): void {
  for (const t of shareTracks) {
    try {
      t.onended = null;
      t.stop();
    } catch {
      /* ya muerta */
    }
  }
  shareTracks.clear();
}
if (typeof window !== "undefined") window.addEventListener("pagehide", killShareTracks);

// Deja que Chrome cambie de pestaña/ventana desde su propia barra sin cortar la pista,
// y no ofrece la pestaña de Teams (compartirse a sí mismo es un espejo infinito).
const SURFACE = { surfaceSwitching: "include", selfBrowserSurface: "exclude" } as const;
const DISPLAY_OPTS: DisplayMediaStreamOptions = { video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, ...SURFACE };

function screenPub(lp: LocalParticipant) {
  return lp.getTrackPublication(Track.Source.ScreenShare);
}

/** Quita el auto-pause del SDK y apunta la pista para poder matarla después. */
export function hardenShareTrack(track: LocalVideoTrack): void {
  const mst = track.mediaStreamTrack;
  if (!mst) return;
  remember(mst);
  const t = track as unknown as { handleTrackMuteEvent?: () => void; handleTrackUnmuteEvent?: () => void };
  try {
    if (t.handleTrackMuteEvent) mst.removeEventListener("mute", t.handleTrackMuteEvent);
    if (t.handleTrackUnmuteEvent) mst.removeEventListener("unmute", t.handleTrackUnmuteEvent);
  } catch {
    /* propiedades internas: si cambian de nombre, el SDK se queda como está */
  }
}

export async function startShare(lp: LocalParticipant): Promise<void> {
  // `contentHint: "text"` y no "detail": Jitsi midió que "detail" manda a Chrome a 5 fps.
  await lp.setScreenShareEnabled(true, { audio: true, contentHint: "text", resolution: { width: 1920, height: 1080 }, ...SURFACE });
  const pub = screenPub(lp);
  if (pub?.track) hardenShareTrack(pub.track as LocalVideoTrack);
}

export async function stopShare(lp: LocalParticipant): Promise<void> {
  try {
    await lp.setScreenShareEnabled(false);
  } finally {
    killShareTracks();
  }
}

/**
 * Cambia la ventana/pestaña compartida SIN dejar de compartir: el resto de la sala ve
 * el cambio en caliente, sin pasar por negro. Devuelve `false` si se canceló el picker
 * o no se pudo cambiar (y en ese caso no se toca nada de lo que ya se compartía).
 */
export async function switchShareSource(lp: LocalParticipant): Promise<boolean> {
  const pub = screenPub(lp);
  const track = pub?.track as LocalVideoTrack | undefined;
  if (!track) return false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTS);
  } catch {
    return false; // canceló el picker
  }
  const vtrack = stream.getVideoTracks()[0];
  if (!vtrack) return false;
  vtrack.contentHint = "text";
  const prev = track.mediaStreamTrack;
  remember(vtrack); // apuntada ANTES: si algo falla, igual se corta
  for (const extra of stream.getTracks()) if (extra !== vtrack) extra.stop();
  try {
    await track.replaceTrack(vtrack);
  } catch {
    try {
      vtrack.stop(); // sin esto sigue capturando y su barra queda viva
    } catch {
      /* nada */
    }
    return false;
  }
  if (prev && prev !== vtrack) {
    try {
      prev.onended = null;
      prev.stop();
    } catch {
      /* nada */
    }
    shareTracks.delete(prev);
  }
  hardenShareTrack(track);
  // El "Dejar de compartir" nativo del navegador sigue cortando tras el cambio: el SDK
  // vuelve a colgar su `ended` en la pista nueva (setMediaStreamTrack) y al terminar una
  // pista de ScreenShare la despublica él mismo (LocalParticipant.handleTrackEnded).
  // Aquí sólo se barren las pistas que el SDK no conoce; despublicar también desde aquí
  // metía dos `unpublish` en carrera.
  vtrack.onended = () => killShareTracks();
  return true;
}
