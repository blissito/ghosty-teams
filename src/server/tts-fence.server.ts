// Sintetizar la nota de voz que un agente pidió con ```eb-audio``` sin `url`.
//
// ⚠️ Por qué existe: un agente ACP de fuera NO tiene ninguna tool nuestra — su caja ni
// siquiera tiene `/opt/gs-sdk` (comprobado el 2026-09-01 en la de gemini: `ls` devuelve
// "No such file"). Su única salida era decir «no puedo generar audio». Un fence, en cambio,
// es texto: lo puede emitir cualquiera. Lo mismo que hizo posible el confeti y la entrega
// de documentos.
//
// Los agentes que SÍ tienen el SDK siguen mandando `{url}` y no pasan por aquí: aquel camino
// no cuesta un turno de TTS del servidor y ya trae onda y duración.
import type { EbAudio } from "../lib/ebdoc";
import { hablar, VOZ_DEFAULT, type Voz } from "./tts.server";

/**
 * Tope de lo que se sintetiza de una vez.
 *
 * kokoro SERIALIZA —dos peticiones tardan el doble exacto, medido— así que un agente que
 * mandara un capítulo entero bloquearía la voz de todo el workspace. Se corta y se dice en
 * el log: media nota de voz es mejor que la cola parada.
 */
const MAX_CHARS = 1200;

const VOCES: Voz[] = ["em_santa", "em_alex", "ef_dora"];
const esVoz = (v: unknown): v is Voz => typeof v === "string" && (VOCES as string[]).includes(v);

export async function sintetizar(a: EbAudio): Promise<{ bytes: Buffer; durMs: number; contentType: string } | null> {
  const texto = (a.text ?? "").trim();
  if (!texto) return null;
  if (texto.length > MAX_CHARS) {
    console.log(`[tts fence] texto de ${texto.length} chars; se corta a ${MAX_CHARS}`);
  }
  try {
    // La voz la elige el agente sólo si es una de las nuestras; cualquier otra cosa cae a la
    // de siempre en vez de fallar. Un nombre inventado no debe costar la nota de voz.
    const audio = await hablar(texto.slice(0, MAX_CHARS), esVoz(a.voice) ? a.voice : VOZ_DEFAULT);
    if (!audio) {
      console.log("[tts fence] kokoro no devolvió audio");
      return null;
    }
    return audio;
  } catch (e) {
    // Best-effort, igual que el resto de la entrega: el mensaje se queda con su texto en vez
    // de romperse. Una nota de voz que no llegó es molesta; un turno perdido, peor.
    console.log(`[tts fence] falló: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
