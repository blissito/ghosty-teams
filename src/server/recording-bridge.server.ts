// El cable Teams → Studio → caja de LiveKit, compartido por las DOS cajas que graban.
//
// Vivía dentro de `events/recording.server.ts` como función privada. Se saca aquí porque
// las llamadas rápidas graban con el MISMO protocolo: sólo cambia a qué caja va.
//
// ⚠️ Teams NO le habla a la caja directamente, y no es ceremonia. Dos razones:
//
//  1. El `ADMIN_TOKEN` no sólo graba: también silencia, expulsa y mintea tokens de sala.
//     Tenerlo en el env de Teams significaba copiarlo en cada deploy y rotarlo en dos
//     sitios. Vive en el vault de Studio y Teams pide "graba" sin saber con qué credencial.
//  2. **La caja es efímera.** Su URL llevaba el `sandboxId`, así que recrearla —por disco,
//     por imagen nueva, o porque el janitor la recicló a las 72 h dormida— dejaba a Teams
//     apuntando a una caja que ya no existe. Studio la descubre cada vez y la despierta.

/** Cuál de las dos cajas. `event` = webinar; `huddle` = las llamadas rápidas. */
export type RecordingBox = "event" | "huddle";

/**
 * Una operación de grabación contra la caja que toque.
 *
 * ⚠️ El `box` viaja en el cuerpo y Studio lo usa para elegir el resolver. Su default allá
 * es `event`, así que omitirlo NO es neutro: manda la petición al webinar.
 */
export async function askStudio(
  payload: Record<string, unknown>,
  box: RecordingBox = "event"
): Promise<Record<string, unknown>> {
  const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) throw new Error("No hay runtime nativo al que pedirle la grabación");
  const { currentNamespace } = await import("./tenant.server");
  const body = JSON.stringify({ ...payload, box });
  const r = await fetch(`${base}/api/v2/event-recording`, {
    method: "POST",
    headers: partnerHeaders(body, await currentNamespace()),
    body,
    // Generoso: detrás puede haber una caja despertando y un PUT de más de un giga.
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(json.error ?? `studio ${r.status}`));
  return json;
}

/**
 * Sube el `.txt` del transcript si YA existe en la caja. Devuelve su clave, o `null` si
 * todavía no está — que es lo normal en una grabación larga: whisper sobre una hora de
 * audio tarda mucho más que un request.
 *
 * Borra el `.txt` de la caja al confirmar la subida, pero **nunca el `.mp4`**: de eso se
 * encarga quien llama, que es quien sabe si aún hace falta (whisper transcribe DESDE ese
 * archivo, y borrarlo antes deja la grabación muda para siempre).
 */
export async function uploadTranscript(file: string, box: RecordingBox = "event"): Promise<string | null> {
  const { presignPut, keyFor } = await import("./storage.server");
  const txt = file.replace(/\.mp4$/, ".txt");
  const keyTexto = keyFor(txt);
  try {
    await askStudio(
      { action: "upload", file: txt, putUrl: presignPut(keyTexto, 3600), contentType: "text/plain; charset=utf-8" },
      box
    );
  } catch {
    return null; // whisper sigue trabajando, o no hubo audio
  }
  await askStudio({ action: "delete", file: txt }, box).catch(() => {});
  return keyTexto;
}
