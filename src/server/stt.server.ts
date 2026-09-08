// ── Transcribir las notas de voz del turno ────────────────────────────────────
//
// Gemelo de `tts.server.ts` (que es el camino inverso: texto → voz del agente) y del
// cliente de `languagetool.server.ts`: Teams no le habla a `whisper-svc` directo —el mesh
// enruta por el dueño del LLAMADOR y desde la caja de Teams contesta 503—, así que va por
// Studio, que es quien sabe resolver la caja de la flota y despertarla.
//
// Por qué existe, teniendo el agente su `sdk/stt.mjs`: el SDK sigue siendo lo correcto
// para un audio que el agente se encuentra trabajando. Pero un adjunto que la plataforma
// YA tiene en la mano le costaba TRES vueltas del modelo antes de leer cuatro segundos de
// voz — medido el 2026-09-08 en un turno real: `mkdir && curl`, `sed` para leerse el SDK,
// y un `node -e`. La regla de siempre: lo que tiene que pasar SIEMPRE lo hace la
// plataforma, no se le pide al modelo. Y así vale igual para los cuatro motores y para el
// runtime que venga, traiga SDK o no.

/** Techo por audio. Por encima, la transcripción se salta y el adjunto viaja como siempre. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Tope de audios por turno: alguien puede soltar veinte notas de golpe. */
const MAX_CLIPS = 4;

export type AudioAtt = { fileId: string; mime: string | null; size: number | null; name: string | null };

export function esAudio(mime: string | null | undefined): boolean {
  return !!mime && mime.toLowerCase().startsWith("audio/");
}

/** Transcribe UN audio por el puente de Studio. `null` si no se pudo.
 *  Recibe el audio ya en base64: es lo que devuelve `mintFileBytes` y lo que pide el
 *  puente, así que no se decodifica y se re-codifica por gusto. */
async function transcribirUno(b64: string, lang: string): Promise<string | null> {
  const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) {
    console.error("[stt] sin runtime nativo: no hay a quién pedirle la transcripción");
    return null;
  }
  const { currentNamespace } = await import("./tenant.server");
  // El audio va en base64 dentro del JSON: la firma de partner se calcula sobre el cuerpo
  // como TEXTO y un cuerpo binario no sobrevive ese ida y vuelta.
  const body = JSON.stringify({ audio: b64, lang });
  try {
    const res = await fetch(`${base}/api/v2/stt`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      // whisper corre en CPU y la caja puede estar hibernada; por encima del techo de
      // Studio (120s) para no cortar antes que él y perder su respuesta.
      body,
      signal: AbortSignal.timeout(130_000),
    });
    if (!res.ok) {
      console.error(`[stt] studio devolvió ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { text?: string };
    const text = (j.text || "").trim();
    return text || null;
  } catch (e) {
    console.error("[stt] falló:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Bloque de texto con lo que dicen las notas de voz del turno, para anteponerlo al mensaje.
 *
 * Best-effort a propósito: si la transcripción falla, devuelve "" y el audio sigue viajando
 * como adjunto — el agente conserva su camino con `stt.mjs`. Un turno sin transcribir es
 * más lento; un turno que revienta por el transcriptor sería peor.
 */
export async function transcripcionesDelTurno(atts: AudioAtt[], opts?: { lang?: string }): Promise<string> {
  const clips = atts.filter((a) => esAudio(a.mime)).slice(0, MAX_CLIPS);
  if (!clips.length) return "";
  const { mintFileBytes } = await import("./easybits-files.server");
  const lang = opts?.lang ?? "es";

  const textos: string[] = [];
  for (const c of clips) {
    if (c.size != null && c.size > MAX_BYTES) continue;
    const b64 = await mintFileBytes(c.fileId).catch(() => null);
    if (!b64) continue;
    const text = await transcribirUno(b64, lang);
    if (text) textos.push(text);
  }
  if (!textos.length) return "";

  // ⚠️ Se dice DE DÓNDE sale y que el audio sigue ahí. Sin la primera parte el agente lee
  // la transcripción como si la hubiera escrito la persona; sin la segunda no se le ocurre
  // volver al original cuando la transcripción sale rara, que es justo cuando hay que
  // hacerlo (un nombre propio, una cifra). Es un dato observado, no una instrucción.
  const cuerpo =
    textos.length === 1
      ? `«${textos[0]}»`
      : textos.map((t, i) => `${i + 1}. «${t}»`).join("\n");
  return `[Nota de voz transcrita por la plataforma (whisper). El audio original va adjunto: vuelve a él si algo suena mal.]\n${cuerpo}\n\n`;
}
