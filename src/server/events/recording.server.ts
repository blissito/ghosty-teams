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

/**
 * Sube el `.txt` del transcript si YA existe en la caja. Devuelve su clave, o `null` si
 * todavía no está — que es lo normal en una grabación larga.
 *
 * Borra el `.txt` de la caja al confirmar la subida, pero **nunca el `.mp4`**: de eso se
 * encarga quien llama, que es quien sabe si aún hace falta.
 */
async function subirTranscript(file: string): Promise<string | null> {
  const { presignPut, keyFor } = await import("../storage.server");
  const txt = file.replace(/\.mp4$/, ".txt");
  const keyTexto = keyFor(txt);
  try {
    await pedirAStudio({ action: "upload", file: txt, putUrl: presignPut(keyTexto, 3600), contentType: "text/plain; charset=utf-8" });
  } catch {
    return null; // whisper sigue trabajando, o no hubo audio
  }
  await pedirAStudio({ action: "delete", file: txt }).catch(() => {});
  return keyTexto;
}

/**
 * Recoge los transcripts que quedaron a medias. Se llama al abrir el room —Teams no tiene
 * planificador y montar uno para esto sería desproporcionado— y nunca lanza.
 *
 * Devuelve cuántas filas se completaron, para no revalidar la vista cuando no cambió nada.
 */
export async function recogerTranscript(channelId: number): Promise<number> {
  const { dbq } = await import("../../dbq.server");
  // ⚠️ Esto eran TRES HORAS, y por eso el transcript del webinar del 13-ago no se recogió
  // nunca: whisper murió con un reinicio de la caja, nadie volvió a abrir el room a tiempo,
  // y la fila se quedó en "Transcribiendo…" para siempre. Una hora de audio tarda más que
  // eso en un CPU compartido, así que la ventana era más corta que el propio trabajo.
  // Siete días es el orden de magnitud de lo que vive una caja de eventos.
  const pendientes = await dbq(
    `SELECT id, box_file FROM gt_event_recordings
      WHERE channel_id = ? AND transcript_key IS NULL
        AND COALESCE(transcript_state, 'pending') = 'pending'
        AND ended_at > unixepoch() - 604800`,
    [channelId]
  ).catch(() => []);
  let hechos = 0;
  for (const fila of pendientes) {
    const file = String(fila.box_file ?? "");
    if (!/^[\w.-]+\.mp4$/.test(file)) continue; // filas viejas, sin el nombre guardado
    const estado = await pedirAStudio({ action: "transcript-status", file }).catch(() => null);
    if (!estado) continue;
    if (estado.status === "ready") {
      const keyTexto = await subirTranscript(file);
      if (keyTexto) {
        await dbq("UPDATE gt_event_recordings SET transcript_key = ?, transcript_state = 'ready' WHERE id = ?", [keyTexto, fila.id]);
        await pedirAStudio({ action: "delete", file }).catch(() => {});
        hechos++;
      }
    } else if (estado.status === "not_found") {
      // ⚠️ `not_found` NO significa "imposible": la caja pudo reiniciarse y perder el
      // estado, que vive en memoria. Se pide que lo retome —es idempotente— en vez de dar
      // el transcript por muerto y BORRAR el MP4, que es irrecuperable.
      await pedirAStudio({ action: "transcript-retry", file }).catch(() => {});
    } else if (estado.status === "failed") {
      // Falló de verdad: se anota para no preguntar en cada carga del room. El MP4 se
      // conserva —ya está subido, pero borrarlo cierra la puerta a reintentarlo—.
      await dbq("UPDATE gt_event_recordings SET transcript_state = 'none' WHERE id = ?", [fila.id]).catch(() => {});
      hechos++;
    }
  }
  return hechos;
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

  // La portada: un fotograma del 25% que saca la caja al parar. Pesa unos 30 KB y es lo
  // que convierte la lista de grabaciones en algo que se mira en vez de leerse.
  let keyPortada: string | null = null;
  const portada = String(parada.poster ?? "");
  if (portada) {
    const k = keyFor(portada);
    const subida = await pedirAStudio({
      action: "upload", file: portada, putUrl: presignPut(k, 3600), contentType: "image/webp",
    }).then(() => true).catch(() => false);   // sin portada se sigue: no vale romper el guardado
    if (subida) keyPortada = k;
  }

  // ⚠️ El transcript NO se espera aquí. Whisper sobre una hora de audio tarda mucho más
  // que un request, así que se intenta una vez —una grabación corta ya puede estar lista—
  // y si no, se recoge después con `recogerTranscript`.
  const keyTexto = await subirTranscript(file);

  // ⚠️ Y el MP4 sólo se borra si NO queda transcript pendiente: whisper transcribe desde
  // ese archivo, y borrarlo antes deja la grabación muda para siempre. Es la misma
  // disciplina que ya rige el vídeo — primero se confirma, después se borra.
  if (keyTexto) await pedirAStudio({ action: "delete", file }).catch(() => {});

  return {
    file,
    key,
    transcriptKey: keyTexto,
    posterKey: keyPortada,
    startedAt: parada.startedAt ? Math.floor(Date.parse(String(parada.startedAt)) / 1000) : null,
    bytes: Number(parada.bytes ?? 0),
    // 7 días: es lo que dura una firma de lectura, y para "ver lo que me perdí" alcanza.
    url: signedUrl(key, 7 * 24 * 3600),
    transcriptUrl: keyTexto ? signedUrl(keyTexto, 7 * 24 * 3600) : null,
  };
}
