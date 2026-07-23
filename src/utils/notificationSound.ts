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

// ── Preferencias de sonido (por-categoría) ──────────────────────────────────
// El usuario puede apagar TODOS los sonidos o sólo algunas categorías (Ajustes →
// Apariencia). Se persiste en localStorage; el default es todo encendido. Cada
// play* consulta su categoría antes de sonar. `all:false` silencia todo de un tiro.
export type SoundCategory = "message" | "mention" | "dm" | "agent" | "delete" | "system" | "artifact";
export const SOUND_CATEGORIES: { key: SoundCategory; label: string }[] = [
  { key: "message", label: "Mensajes de sala" },
  { key: "mention", label: "Menciones" },
  { key: "dm", label: "Mensajes directos" },
  { key: "agent", label: "Respuesta del agente" },
  { key: "delete", label: "Eliminar" },
  { key: "artifact", label: "Abrir artefacto" },
  { key: "system", label: "Sistema (envío · listo)" },
];
export type SoundPrefs = { all: boolean } & Record<SoundCategory, boolean>;
const SOUND_KEY = "gc_sound_prefs";
const DEFAULT_PREFS: SoundPrefs = { all: true, message: true, mention: true, dm: true, agent: true, delete: true, system: true, artifact: true };
let prefsCache: SoundPrefs | null = null;

export function getSoundPrefs(): SoundPrefs {
  if (prefsCache) return prefsCache;
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  let loaded: SoundPrefs;
  try {
    loaded = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(SOUND_KEY) || "{}") };
  } catch {
    loaded = { ...DEFAULT_PREFS };
  }
  prefsCache = loaded;
  return loaded;
}

export function setSoundPref(key: "all" | SoundCategory, enabled: boolean): SoundPrefs {
  const next = { ...getSoundPrefs(), [key]: enabled };
  prefsCache = next;
  if (typeof window !== "undefined") {
    try { localStorage.setItem(SOUND_KEY, JSON.stringify(next)); } catch { /* almacenamiento lleno/negado */ }
  }
  return next;
}

// ¿Suena esta categoría? Gate: el master (`all`) manda; luego la categoría concreta.
function soundOn(cat: SoundCategory): boolean {
  const p = getSoundPrefs();
  return p.all !== false && p[cat] !== false;
}

/**
 * Reproduce el sonido oficial de notificación (doble knock).
 * @param volume 0–1 (default 0.85).
 */
export function playNotificationSound(volume = 0.85): void {
  if (!soundOn("message")) return;
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

/**
 * Sonido de APP LISTA (al abrir/cargar): arpegio breve ascendente (C5-E5-G5),
 * cálido y con cola, tipo "chime de bienvenida". Se dispara una vez cuando el
 * chat queda usable. Suena a "estás dentro" sin robar protagonismo.
 * @param volume 0–1 (default 0.5).
 */
export function playReadySound(volume = 0.5): void {
  if (!soundOn("system")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);
  const ping = (t0: number, freq: number, vol: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34); // cola tipo chime
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + 0.36);
  };
  ping(now, 523, 0.5); // C5
  ping(now + 0.09, 659, 0.45); // E5
  ping(now + 0.18, 784, 0.42); // G5 → tríada mayor = "listo/bienvenida"
}

/**
 * Sonido de ABRIR ARTEFACTO: "rastrillo"/trinquete — ráfaga de clics rápidos que ACELERA
 * y sube de tono, como un panel que se desliza/despliega. Cada clic = ráfaga muy corta de
 * ruido pasa-altos. Categoría "system". @param volume 0–1 (default 0.3).
 */
export function playArtifactOpen(volume = 0.3): void {
  if (!soundOn("artifact")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);
  const N = 13;
  let t = now;
  for (let i = 0; i < N; i++) {
    const p = i / (N - 1);
    const dur = 0.006;
    const buf = audio.createBuffer(1, Math.max(1, Math.floor(audio.sampleRate * dur)), audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length); // clic con decaimiento
    const src = audio.createBufferSource();
    src.buffer = buf;
    const hp = audio.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2000 + p * 2600; // sube de tono conforme "abre"
    const g = audio.createGain();
    g.gain.value = 0.5 + 0.5 * (1 - Math.abs(p - 0.5) * 2); // envolvente en campana (arranca/frena)
    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + dur);
    t += 0.02 - 0.011 * p; // el intervalo ACELERA: ~20ms → ~9ms (trinquete)
  }
}

/**
 * Sonido de GHOSTY / agentes — distinto del knock humano. Shimmer etéreo
 * ("fantasmal"): dos tonos ascendentes (una quinta) con vibrato suave.
 * @param volume 0–1 (default 0.7).
 */
export function playGhostySound(volume = 0.7): void {
  if (!soundOn("agent")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);

  const tone = (t0: number, freq: number, vol: number, dur: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t0 + dur); // sube una quinta
    // Vibrato sutil → sensación etérea.
    const lfo = audio.createOscillator();
    const lfoG = audio.createGain();
    lfo.frequency.value = 6;
    lfoG.gain.value = freq * 0.02;
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.05);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  };
  tone(now, 520, 0.5, 0.22);
  tone(now + 0.11, 690, 0.4, 0.28);
}

/**
 * Sonido de MENCIÓN (@ti / @all / @channel): el más notorio — doble campana
 * brillante ascendente (G5→C6). Pide atención sin ser estridente.
 * @param volume 0–1 (default 0.8).
 */
export function playMentionSound(volume = 0.8): void {
  if (!soundOn("mention")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);
  const bell = (t0: number, freq: number, vol: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006); // ataque brillante
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3); // cola tipo campana
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + 0.32);
  };
  bell(now, 784, 0.7); // G5
  bell(now + 0.12, 1047, 0.7); // C6 → sube = "atención"
}

/**
 * Sonido de MENSAJE DIRECTO (DM): dos notas cálidas descendentes (E5→C#5),
 * íntimo y distinto del knock de room y de la mención.
 * @param volume 0–1 (default 0.65).
 */
export function playDmSound(volume = 0.65): void {
  if (!soundOn("dm")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);
  const note = (t0: number, freq: number, vol: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + 0.24);
  };
  note(now, 660, 0.6); // E5
  note(now + 0.13, 554, 0.55); // C#5 → baja suave, íntimo
}

/**
 * Sonido de MENSAJE PROPIO (al enviar): un "pip" corto y sutil, ascendente,
 * como confirmación de "enviado". Más discreto que las notificaciones.
 * @param volume 0–1 (default 0.4).
 */
export function playSelfSound(volume = 0.4): void {
  if (!soundOn("system")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  master.connect(audio.destination);
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(880, now);
  o.frequency.exponentialRampToValueAtTime(1320, now + 0.06); // sube = "enviado"
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.6, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  o.connect(g);
  g.connect(master);
  o.start(now);
  o.stop(now + 0.1);
}

/**
 * Sonido de ELIMINAR (mensaje / hilo / lo que sea): gesto MELÓDICO descendente en
 * modo MENOR (tríada de La menor bajando: E4 → C4 → A3) con un golpe grave al final
 * → lee como "negativo / se fue", NO como un pip alegre. Timbre apagado (lowpass),
 * sin destellos agudos. Categoría "delete". @param volume 0–1 (default 0.5).
 */
export function playDeleteSound(volume = 0.5): void {
  if (!soundOn("delete")) return;
  const audio = getCtx();
  if (!audio) return;
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = volume;
  // Lowpass global → mantiene todo oscuro/mate (nada brillante = nada "feliz").
  const lp = audio.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  lp.connect(audio.destination);
  master.connect(lp);

  // Tres notas DESCENDENTES en menor (E4, C4, A3) → melodía que "cae".
  const step = (t0: number, freq: number, vol: number, dur: number) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012); // ataque suave (sin click)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  };
  step(now, 330, 0.5, 0.13); // E4
  step(now + 0.1, 262, 0.5, 0.15); // C4
  step(now + 0.21, 220, 0.55, 0.3); // A3 (nota final, más larga = "se asienta abajo")

  // Golpe grave bajo la última nota → peso/finalidad ("cayó y se fue").
  const thud = audio.createOscillator();
  const tg = audio.createGain();
  thud.type = "sine";
  thud.frequency.setValueAtTime(110, now + 0.21);
  thud.frequency.exponentialRampToValueAtTime(55, now + 0.45); // sub que cae
  tg.gain.setValueAtTime(0.0001, now + 0.21);
  tg.gain.exponentialRampToValueAtTime(0.4, now + 0.24);
  tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  thud.connect(tg);
  tg.connect(master);
  thud.start(now + 0.21);
  thud.stop(now + 0.52);
}

/**
 * RING de llamada entrante (estilo teléfono). Un patrón de dos notas ("bring-bring")
 * que se REPITE en loop hasta que se llama a stopCallRing(). Para DM 1:1 (aviso fuerte
 * tipo Discord). Devuelve una función stop; también se puede parar con stopCallRing().
 * Categoría "dm" (respeta el toggle de sonidos). No-op si el sonido está apagado.
 * @param volume 0–1 (default 0.5).
 */
let callRingTimer: ReturnType<typeof setInterval> | null = null;
export function startCallRing(volume = 0.5): () => void {
  stopCallRing(); // nunca dos rings a la vez
  if (!soundOn("dm")) return () => {};
  const burst = () => {
    const audio = getCtx();
    if (!audio) return;
    const now = audio.currentTime;
    const master = audio.createGain();
    master.gain.value = volume;
    master.connect(audio.destination);
    const ring = (t0: number) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = 480;
      const o2 = audio.createOscillator();
      o2.type = "sine";
      o2.frequency.value = 620; // dos tonos = timbre "telefónico"
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
      g.gain.setValueAtTime(0.6, t0 + 0.34);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(g); o2.connect(g); g.connect(master);
      o.start(t0); o2.start(t0); o.stop(t0 + 0.42); o2.stop(t0 + 0.42);
    };
    ring(now);
    ring(now + 0.5); // "bring-bring"
  };
  burst();
  callRingTimer = setInterval(burst, 2400); // repite cada ~2.4s hasta stop
  return stopCallRing;
}
export function stopCallRing(): void {
  if (callRingTimer) { clearInterval(callRingTimer); callRingTimer = null; }
}
