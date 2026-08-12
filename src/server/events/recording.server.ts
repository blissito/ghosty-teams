// Grabar la llamada de un evento, y que la grabación SOBREVIVA a la caja.
//
// ⚠️ Teams NO le habla a la caja de LiveKit. Le pide a Studio, que es quien tiene el
// `ADMIN_TOKEN` en su vault y quien sabe resolver (o crear) la caja. Dos razones, y la
// segunda es la que costó descubrir:
//
//  1. Ese token no sólo graba: también silencia, expulsa y mintea tokens de sala. Tenerlo
//     en el env de Teams significaba copiarlo en cada deploy y rotarlo en dos sitios.
//  2. **La caja es efímera.** Su URL llevaba el `sandboxId`, así que recrearla —por disco,
//     por imagen nueva, o porque el janitor la recicló a las 72 h dormida— dejaba a Teams
//     apuntando a una caja que ya no existe. Studio la descubre cada vez y la despierta.
//
// La caja ya sabía hacer todo esto y nadie la llamaba: `recStart` levanta chromium+ffmpeg,
// `recStop` cierra el MP4 con SIGINT (el `moov` va al principio → se puede ver sin bajarlo
// entero), `recTranscript` lo pasa por whisper.cpp, y `recUpload` lo streamea a una URL PUT
// firmada. Esto es el cable, no la máquina.
//
// ⚠️ Lo que HOY PERDÍA DATOS es la subida: el MP4 vive en el disco de una caja que hiberna.
// Por eso `detener()` sube PRIMERO y sólo entonces borra el local — y si la subida falla,
// no borra. Y el disco: 900 MB/h medidos con la sala VACÍA, 1.5-3 GB/h con contenido.

async function pedirAStudio(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) throw new Error("No hay runtime nativo al que pedirle la grabación");
  const { currentNamespace } = await import("../tenant.server");
  const body = JSON.stringify(payload);
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

/** Empieza a grabar la sala de este room. */
export async function iniciarGrabacion(_ch: unknown, roomName: string) {
  return pedirAStudio({ action: "start", room: roomName });
}

/**
 * Para, SUBE y sólo entonces borra el local. Devuelve las URLs firmadas del video y del
 * transcript; el transcript es `null` si whisper aún no terminó — el video, que es lo caro,
 * ya está fuera de la caja.
 */
export async function detenerGrabacion(_ch: unknown) {
  const parada = await pedirAStudio({ action: "stop" });
  const file = String(parada.file ?? "");
  if (!file) throw new Error("No había ninguna grabación en curso");

  const { presignPut, keyFor, signedUrl } = await import("../storage.server");
  const key = keyFor(file);
  await pedirAStudio({ action: "upload", file, putUrl: presignPut(key, 3600), contentType: "video/mp4" });

  let keyTexto: string | null = null;
  const txt = file.replace(/\.mp4$/, ".txt");
  try {
    keyTexto = keyFor(txt);
    await pedirAStudio({ action: "upload", file: txt, putUrl: presignPut(keyTexto, 3600), contentType: "text/plain" });
  } catch {
    keyTexto = null; // whisper sigue trabajando, o no hubo audio
  }

  // Sólo AHORA, y sólo lo confirmado. Borrar antes sería confiar en que la subida no falla.
  await pedirAStudio({ action: "delete", file }).catch(() => {});
  if (keyTexto) await pedirAStudio({ action: "delete", file: txt }).catch(() => {});

  return {
    file,
    bytes: Number(parada.bytes ?? 0),
    // 7 días: es lo que dura una firma de lectura, y para "ver lo que me perdí" alcanza.
    url: signedUrl(key, 7 * 24 * 3600),
    transcriptUrl: keyTexto ? signedUrl(keyTexto, 7 * 24 * 3600) : null,
  };
}
