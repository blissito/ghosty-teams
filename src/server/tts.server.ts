// ── Voz: texto → audio, por `kokoro-svc` a través de Studio ──────────────────
//
// No se llama a la caja de voz directo: es de la flota y el mesh enruta por el dueño del
// llamador, así que desde la caja de Teams contesta 503. Studio ya sabe dónde vive —la
// resuelve para inyectar `GS_TTS_URL`— y hace de puente con el MISMO contrato HMAC que ya
// usan el PDF y la miniatura (`doc-export.server.ts`).
//
// Quién lo usa: el "leer en voz alta" del documento. Se sintetiza UN audio por BLOQUE, no
// el documento entero, porque el resaltado tiene que ir párrafo a párrafo — y de paso el
// play arranca en cuanto está el primero en vez de esperar a que se sintetice todo.
//
// ⚠️ **El caché se llavea por el CONTENIDO, no por el id del bloque.** Es lo que resuelve
// la invalidación al editar sin escribir una sola línea de invalidación: cambias el
// párrafo, cambia el hash, y el audio viejo simplemente deja de pedirse (lo barre el LRU).
// Con la llave puesta en el uuid habría que acordarse de tirar la entrada en cada
// edición, y el día que se olvide se lee en voz alta un texto que ya no está.
import { createHash } from "node:crypto";

export type Voz = "em_santa" | "em_alex" | "ef_dora";
export const VOZ_DEFAULT: Voz = "em_santa";
const VOCES: Voz[] = ["em_santa", "em_alex", "ef_dora"];

export function esVoz(v: string | null | undefined): v is Voz {
  return !!v && (VOCES as string[]).includes(v);
}

export type Audio = { bytes: Buffer; durMs: number; contentType: string };

// Caché en memoria del proceso. Un documento se relee varias veces (le das play, pausas,
// vuelves, cambias de versión) y re-sintetizar el mismo párrafo cuesta segundos de CPU en
// la caja de voz.
//
// No va a disco ni a Tigris a propósito, todavía: el audio de un párrafo pesa decenas de
// KB, el LRU cubre la sesión de lectura —que es cuando duele— y un caché persistente
// exige decidir dónde vive, quién lo borra y qué pasa con un documento privado. Si un
// documento largo se lee entero a diario, ése es el momento de subirlo a storage.
// Desde que se sintetiza por FRASE y no por bloque hay ~5 entradas donde había una, así
// que el mismo número de entradas cubriría cinco veces menos documento.
const MAX_ENTRADAS = 1200;
const cache = new Map<string, Audio>();

function recordar(k: string, a: Audio) {
  cache.set(k, a);
  // Map itera en orden de inserción: la primera llave es la más vieja.
  while (cache.size > MAX_ENTRADAS) {
    const vieja = cache.keys().next().value;
    if (vieja === undefined) break;
    cache.delete(vieja);
  }
}

/** La llave del caché: voz + hash del texto. Ver la nota de arriba. */
export function claveAudio(texto: string, voz: Voz): string {
  return `${voz}:${createHash("sha256").update(texto).digest("hex").slice(0, 32)}`;
}

/**
 * Sintetiza un trozo. Devuelve `null` ante cualquier fallo: la ruta lo traduce a 502 y el
 * control de reproducción avisa. No hay motor de respaldo — la voz del navegador suena
 * distinta en cada máquina y "a veces lee con otra voz" es peor que "ahora no se pudo"
 * (ver la decisión de descartar `SpeechSynthesis` en CLAUDE.md).
 */
// ── Precalentado ─────────────────────────────────────────────────────────────
//
// La caja de voz hiberna a los 900 s, así que el primer play tras un rato paga el resume
// ADEMÁS de la síntesis. Un texto mínimo la despierta mientras el usuario todavía está
// leyendo el documento, que es cuando no cuesta nada.
//
// La guarda es por módulo y no por usuario a propósito: la caja es UNA para todos, y dos
// personas con un documento abierto no necesitan despertarla dos veces.
let ultimoWarm = 0;
let warmEnVuelo: Promise<unknown> | null = null;
const WARM_CADA_MS = 5 * 60_000;

export async function precalentarVoz(voz: Voz = VOZ_DEFAULT): Promise<void> {
  if (warmEnVuelo) return;
  if (Date.now() - ultimoWarm < WARM_CADA_MS) return;
  ultimoWarm = Date.now();
  warmEnVuelo = hablar("Sí.", voz).finally(() => {
    warmEnVuelo = null;
  });
  await warmEnVuelo;
}

export async function hablar(texto: string, voz: Voz = VOZ_DEFAULT): Promise<Audio | null> {
  const limpio = texto.trim();
  if (!limpio) return null;

  const k = claveAudio(limpio, voz);
  const hit = cache.get(k);
  if (hit) {
    // Refresca su posición en el LRU: lo que se está leyendo ahora es lo que hay que
    // conservar.
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }

  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) {
      console.error("[tts] sin runtime nativo: no hay a quién pedirle la voz");
      return null;
    }
    const { currentNamespace } = await import("./tenant.server");
    const body = JSON.stringify({ text: limpio, voice: voz });
    const res = await fetch(`${base}/api/v2/tts`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      // Más que el timeout de Studio (45s) para no cortar antes que él y perder su mensaje.
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) {
      console.error(`[tts] studio devolvió ${res.status}`);
      return null;
    }
    const audio: Audio = {
      bytes: Buffer.from(await res.arrayBuffer()),
      durMs: Number(res.headers.get("x-duration-ms") || 0) || 0,
      contentType: res.headers.get("content-type") || "audio/wav",
    };
    recordar(k, audio);
    return audio;
  } catch (e) {
    console.error("[tts] falló:", e instanceof Error ? e.message : e);
    return null;
  }
}
