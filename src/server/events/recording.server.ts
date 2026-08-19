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
    `SELECT id, box_file, video_id FROM gt_event_recordings
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
        // El borrado espera si la grabación aún tiene que publicarse: se lleva el HLS.
        if (!fila.video_id) await pedirAStudio({ action: "delete", file }).catch(() => {});
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

/**
 * Empieza a grabar la sala de este room, y —si `live`— la transmite además a los destinos
 * RTMP configurados en la caja (YouTube, Facebook).
 *
 * ⚠️ Transmitir NO es una acción aparte: es el MISMO ffmpeg con una rama más del `tee`, así
 * que un solo encode alimenta el MP4, el HLS y cada destino. La contrapartida es que **a un
 * ffmpeg ya corriendo no se le puede añadir un destino**: "salir en vivo" se decide al
 * empezar a grabar, no a mitad. Si hiciera falta empezar a transmitir después, habría que
 * cortar la grabación y volver a arrancarla — y eso parte el MP4 en dos.
 *
 * ⚠️ Aquí viaja un BOOLEANO, nunca una URL. Las claves de stream viven sólo en el env de la
 * caja: ni Teams ni Studio las ven, así que ninguno de los dos puede filtrarlas, y quien
 * tenga el ADMIN_TOKEN no puede redirigir el webinar a un canal ajeno.
 */
export async function iniciarGrabacion(_ch: unknown, roomName: string, live = false) {
  return pedirAStudio({ action: "start", room: roomName, live });
}

/**
 * Cierra las publicaciones que quedaron a medias: mira si la caja ya terminó el HLS y, si
 * sí, le pasa a fixtergeek el `m3u8`, la portada y la transcripción.
 *
 * Corre en el mismo sitio que `recogerTranscript` —al abrir el room— por la misma razón: la
 * conversión de las calidades chicas tarda minutos y nadie va a esperar con el dedo en el
 * botón. Y nunca lanza: un fallo de publicación no puede tumbar la vista del room.
 */
export async function cerrarPublicaciones(channelId: number): Promise<number> {
  const { dbq } = await import("../../dbq.server");
  // `pending` = falta subir el vídeo. `partial` = el vídeo ya está allá, pero whisper aún
  // no había terminado cuando se cerró — y sin la transcripción no hay subtítulos, ni
  // capítulos, ni buscador. Se vuelve a pasar por aquí hasta tenerla.
  const pendientes = await dbq(
    `SELECT id, box_file, video_id, poster_key, started_at, ended_at, publish_state FROM gt_event_recordings
      WHERE channel_id = ? AND video_id IS NOT NULL
        AND COALESCE(publish_state, 'none') IN ('pending', 'partial')
        AND ended_at > unixepoch() - 604800`,
    [channelId]
  ).catch(() => []);
  if (!pendientes.length) return 0;

  const { cerrarPublicacion, m3u8Para, posterPublico } = await import("./publish.server");
  const ch = await dbq("SELECT call_course_id FROM gc_channels WHERE id = ?", [channelId]).catch(() => []);
  const courseId = String(ch[0]?.call_course_id ?? "");
  if (!courseId) return 0;

  let hechos = 0;
  for (const fila of pendientes) {
    const file = String(fila.box_file ?? "");
    if (!/^[\w.-]+\.mp4$/.test(file)) continue;
    const yaPublicado = fila.publish_state === "partial";
    if (!yaPublicado) {
      const estado = await pedirAStudio({ action: "hls-status", file }).catch(() => null);
      if (!estado || estado.status !== "ready") continue;
    }

    // La transcripción viaja como DATOS, no como archivo: de ahí salen los subtítulos, los
    // capítulos y el buscador del curso. ⚠️ Puede NO estar todavía: whisper tarda ~1/4 de
    // lo que dure el audio, y el vídeo se publica en cuanto está listo. En ese caso se
    // manda ahora lo que hay y la transcripción va en una segunda pasada.
    const t = await pedirAStudio({ action: "transcript-json", file }).catch(() => null);
    const hayTranscript = !!(t?.transcript as { segments?: unknown[] } | undefined)?.segments?.length;

    const minutos = fila.started_at
      ? Math.max(1, Math.round((Number(fila.ended_at) - Number(fila.started_at)) / 60))
      : null;
    const videoId = String(fila.video_id);
    try {
      await cerrarPublicacion({
        videoId,
        m3u8: m3u8Para(courseId, videoId),
        // ⚠️ La portada NO puede ser una firma nuestra: caduca a los 7 días y el vídeo se
        // queda sin imagen para siempre, en un sitio donde ya nadie va a mirar. Se usa la
        // que la caja subió al bucket del propio taller, junto al HLS.
        poster: posterPublico(courseId, videoId),
        durationMin: minutos,
        transcript: t?.transcript ?? undefined,
      });
    } catch (e) {
      console.error("[event] no pude cerrar la publicación:", e);
      continue;   // se reintenta la próxima vez que alguien abra el room
    }
    // `published_url` ya se guardó al crear el borrador: se conoce desde el principio. Lo
    // que cambia aquí es el ESTADO, que es lo que decide si el enlace se ofrece.
    // ⚠️ `partial` no puede ser eterno: si la caja ya no tiene el `transcript.json` —se
    // recicló, o se limpió— esa transcripción no va a llegar nunca, y seguir preguntando en
    // cada carga del room es gastar por gastar. Se cierra como está.
    const imposible = !hayTranscript && (t?.status === "not_found" || !t);
    await dbq("UPDATE gt_event_recordings SET publish_state = ? WHERE id = ?",
      [hayTranscript || imposible ? "ready" : "partial", fila.id]).catch(() => {});
    // ⚠️ El disco se libera sólo cuando está TODO. Borrar con la transcripción a medias se
    // lleva el `transcript.json` que aún no se ha mandado, y ya no se puede rehacer: el
    // audio vivía en ese mismo directorio.
    if (hayTranscript) await pedirAStudio({ action: "delete", file }).catch(() => {});
    hechos++;
  }
  return hechos;
}

/**
 * Para, SUBE y sólo entonces borra el local. Devuelve las URLs firmadas del video y del
 * transcript; el transcript es `null` si whisper aún no terminó — el video, que es lo caro,
 * ya está fuera de la caja.
 */
export async function detenerGrabacion(ch: { call_course_id?: string | null; call_title?: string | null; name?: string; starts_at?: number | null }) {
  // ⚠️ El borrador se crea ANTES de parar, y no es un capricho: el `videoId` va dentro de la
  // llave de todos los objetos que la caja va a subir, así que tiene que existir antes de
  // que empiece a subirlos. Si fixtergeek no contesta, la grabación se guarda igual y queda
  // pendiente de publicar — perder el vídeo por un fallo de publicación sería absurdo.
  let publicacion: { videoId: string; viewerUrl: string } | null = null;
  let hlsPrefix = "";
  const courseId = (ch?.call_course_id ?? "").trim();
  if (courseId) {
    try {
      const { crearBorrador, prefijoHls } = await import("./publish.server");
      const d = await crearBorrador({
        courseId,
        title: (ch.call_title || ch.name || "Grabación").trim(),
        eventDate: ch.starts_at ?? null,
      });
      publicacion = { videoId: d.videoId, viewerUrl: d.viewerUrl };
      hlsPrefix = prefijoHls(courseId, d.videoId);
    } catch (e) {
      console.error("[event] no pude crear el borrador en fixtergeek:", e);
    }
  }

  const parada = await pedirAStudio({
    action: "stop",
    // Sin prefijo la caja NO transcodifica: una junta interna no paga el precio de un
    // webinar. Con prefijo, genera el HLS completo y lo sube ella misma.
    ...(hlsPrefix ? { hls: true, hlsPrefix } : {}),
  });
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
  // ⚠️ Y tampoco se borra si queda una publicación en marcha: el `delete` de la caja se
  // lleva el directorio entero del id —HLS, storyboard y el `transcript.json`—, que es
  // justo lo que falta por subir. Primero se publica, después se limpia.
  if (keyTexto && !publicacion) await pedirAStudio({ action: "delete", file }).catch(() => {});

  return {
    file,
    key,
    videoId: publicacion?.videoId ?? null,
    viewerUrl: publicacion?.viewerUrl ?? null,
    publishState: publicacion ? ("pending" as const) : ("none" as const),
    transcriptKey: keyTexto,
    posterKey: keyPortada,
    startedAt: parada.startedAt ? Math.floor(Date.parse(String(parada.startedAt)) / 1000) : null,
    bytes: Number(parada.bytes ?? 0),
    // 7 días: es lo que dura una firma de lectura, y para "ver lo que me perdí" alcanza.
    url: signedUrl(key, 7 * 24 * 3600),
    transcriptUrl: keyTexto ? signedUrl(keyTexto, 7 * 24 * 3600) : null,
  };
}
