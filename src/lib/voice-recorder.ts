// ── Grabador de notas de voz (cliente) ────────────────────────────────────────
//
// Graba del micrófono y devuelve un File listo para /api/upload, más los dos
// datos que la burbuja necesita para pintar la onda PTT: `waveform` (64
// amplitudes 0..100 en base64, el formato que espera `decodeWaveform` en
// components/chat/message.tsx) y `durationMs`.
//
// ⚠️ Tres cosas que NO se pueden derivar del blob y por eso se miden aquí:
//
// 1. El MIME. `MediaRecorder` no da opus en Safari: hay que preguntar con
//    `isTypeSupported` y quedarse con el primero que sirva. El mime real importa
//    después — es lo que hace que el chat pinte el reproductor y lo que hace que
//    `comoAbrir` (gs) le diga al agente que lo transcriba con stt.mjs.
// 2. La duración. En Chrome un webm de MediaRecorder reporta `duration:
//    Infinity` hasta que alguien hace seek, así que se cronometra el tiempo de
//    grabación.
// 3. La onda. `decodeAudioData` sobre webm/mp4 no es fiable en todos los
//    navegadores, así que se muestrea el stream VIVO con un AnalyserNode.

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "requesting" | "recording" | "error";

export type VoiceClip = {
  file: File;
  /** 64 amplitudes 0..100 en base64 (formato de `decodeWaveform`). */
  waveform: string;
  durationMs: number;
};

/** Candidatos en orden de preferencia; el `.ext` acompaña al mime elegido. */
const CANDIDATES: { mime: string; ext: string }[] = [
  { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/mp4", ext: "m4a" }, // Safari
];

/** Formato soportado por este navegador, o null si no hay MediaRecorder. */
export function pickFormat(): { mime: string; ext: string } | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  for (const c of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* isTypeSupported puede lanzar con un mime raro: se prueba el siguiente */
    }
  }
  return null;
}

/** ¿Se puede grabar aquí? Sirve para no pintar el botón donde no hay soporte. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    pickFormat() !== null
  );
}

/**
 * Remuestrea las amplitudes crudas a 64 valores 0..100 y los codifica base64.
 * Cada valor es UN byte: `decodeWaveform` hace `charCodeAt` por posición.
 */
function encodeWaveform(samples: number[]): string {
  const BARS = 64;
  const out: number[] = [];
  if (samples.length === 0) return "";
  // Normaliza contra el pico: una grabación baja se vería como una línea plana.
  const peak = Math.max(...samples, 0.0001);
  for (let i = 0; i < BARS; i++) {
    const from = Math.floor((i * samples.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / BARS));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j] ?? 0;
    const avg = sum / (to - from);
    out.push(Math.max(2, Math.min(100, Math.round((avg / peak) * 100))));
  }
  let bin = "";
  for (const v of out) bin += String.fromCharCode(v);
  return btoa(bin);
}

export function useVoiceRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [ms, setMs] = useState(0);
  const [level, setLevel] = useState(0); // 0..1, para la barra de nivel en vivo
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const samplesRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const timersRef = useRef<{ tick?: number; sample?: number }>({});
  const cancelledRef = useRef(false);

  // Suelta micrófono, AudioContext y timers. Sin el `track.stop()` el punto rojo
  // del navegador se queda encendido después de grabar.
  const teardown = useCallback(() => {
    if (timersRef.current.tick) window.clearInterval(timersRef.current.tick);
    if (timersRef.current.sample) window.clearInterval(timersRef.current.sample);
    timersRef.current = {};
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    recRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    const fmt = pickFormat();
    if (!fmt || !navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no puede grabar audio");
      setState("error");
      return;
    }
    setError(null);
    setState("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      // Permiso denegado o sin micrófono: los dos se ven igual desde aquí.
      setError("No se pudo usar el micrófono");
      setState("error");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    samplesRef.current = [];
    cancelledRef.current = false;

    // Onda + nivel: se muestrea el stream vivo, no el blob (ver cabecera).
    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        timersRef.current.sample = window.setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          samplesRef.current.push(rms);
          setLevel(Math.min(1, rms * 3));
        }, 50);
      }
    } catch {
      // Sin onda se sigue grabando: la burbuja cae a su relleno pseudo-uniforme.
    }

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: fmt.mime });
    } catch {
      teardown();
      setError("No se pudo iniciar la grabación");
      setState("error");
      return;
    }
    recRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.start();
    startedAtRef.current = performance.now();
    setMs(0);
    timersRef.current.tick = window.setInterval(
      () => setMs(performance.now() - startedAtRef.current),
      100
    );
    setState("recording");
  }, [state, teardown]);

  /** Para y devuelve el clip. `null` si se canceló o no salió nada. */
  const stop = useCallback(async (): Promise<VoiceClip | null> => {
    const rec = recRef.current;
    if (!rec || state !== "recording") return null;
    const fmt = pickFormat();
    const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    try {
      rec.stop();
    } catch {
      /* ya estaba parado */
    }
    await done;
    const samples = samplesRef.current.slice();
    const chunks = chunksRef.current.slice();
    const cancelled = cancelledRef.current;
    teardown();
    setState("idle");
    setLevel(0);
    setMs(0);
    if (cancelled || chunks.length === 0) return null;
    const mime = fmt?.mime ?? rec.mimeType ?? "audio/webm";
    const ext = fmt?.ext ?? "webm";
    const blob = new Blob(chunks, { type: mime });
    if (blob.size === 0) return null;
    // El nombre lleva la hora: dos notas seguidas no deben llamarse igual.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = new File([blob], `nota-de-voz-${stamp}.${ext}`, { type: mime });
    return { file, waveform: encodeWaveform(samples), durationMs };
  }, [state, teardown]);

  /** Descarta la grabación en curso (no devuelve nada y no sube nada). */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    teardown();
    setState("idle");
    setLevel(0);
    setMs(0);
  }, [teardown]);

  return { state, ms, level, error, start, stop, cancel };
}
