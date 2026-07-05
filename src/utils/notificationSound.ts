// ── Sonido OFICIAL de notificación de Ghosty Teams ──────────────────────────
// Doble "knock" de madera sintetizado con Web Audio: cuerpo pitcheado con caída
// de tono (tipo bloque de madera) + transitorio de ruido para el "click". Imita
// el ritmo/timbre del clásico de Slack SIN muestrear su audio (eso sería problema
// legal). Cero archivos, cero licencias, cero red.
//
// Uso: `import { playNotificationSound } from "~/utils/notificationSound";`
// y llámalo en cualquier evento de "llegó algo nuevo" (mensaje, mención, DM).
// Respeta tú el gating (mute, foco, preferencia) ANTES de llamar — esta función
// solo reproduce.

// AudioContext singleton (crear uno por sonido agota el límite del navegador).
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null; // SSR-safe
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  // Los navegadores suspenden el contexto hasta el primer gesto del usuario; en un
  // chat ya hubo interacción, así que esto normalmente arranca sin problema.
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Reproduce el sonido oficial de notificación (doble knock).
 * @param volume 0–1 (default 0.85).
 */
export function playNotificationSound(volume = 0.85): void {
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);

  // Un golpe = cuerpo (seno con caída rápida de tono) + click (ruido pasa-altos).
  const knock = (t0: number, f0: number, f1: number, vol: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + 0.05); // caída = "madera"
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004); // ataque muy rápido
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14); // decaimiento corto
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + 0.16);

    // Transitorio "tk": ráfaga corta de ruido pasa-altos.
    const n = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.02), audio.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const ns = audio.createBufferSource();
    ns.buffer = n;
    const hp = audio.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const ng = audio.createGain();
    ng.gain.value = vol * 0.5;
    ns.connect(hp);
    hp.connect(ng);
    ng.connect(master);
    ns.start(t0);
    ns.stop(t0 + 0.02);
  };

  // Doble knock: dos golpes ~160ms aparte, el 2º un pelín más grave/suave.
  knock(now, 430, 150, 0.7);
  knock(now + 0.16, 385, 140, 0.55);
}
