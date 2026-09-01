// Grabar una LLAMADA RÁPIDA. Gemelo de `events/recording.server.ts`, sin la mitad de
// eventos: aquí no hay curso de fixtergeek al que publicar, ni tickets, ni transmisión en
// vivo. Lo que queda es lo que importa: parar, subir a storage, y devolver el enlace.
//
// Todo el transporte y la subida del transcript se reusan tal cual del puente compartido
// (`recording-bridge.server.ts`); lo único propio de aquí es el destino —la caja `huddle`—
// y el hecho de que **no se pide HLS**.
//
// ⚠️ Y no pedirlo es deliberado, con un número detrás: el `-f tee` de la caja ya escribe el
// MP4 y el HLS 1080p en paralelo (~3.7 GB/h entre los dos), y las calidades 720p/480p se
// transcodifican DESPUÉS de parar, sumando otros ~1.4 GB/h. Un taller de dos horas con HLS
// completo son ~10.3 GB; sin pedirlo se queda en ~7.5. Una llamada de trabajo se ve una
// vez, entera y desde un enlace: no paga el precio de un webinar.

import { askStudio, uploadTranscript } from "./recording-bridge.server";

/** Qué se estaba grabando. En un room coincide con el canal; en un DM es el dmId. */
export type CallScope = { scope: "room" | "dm"; scopeId: number; channelId: number };

/**
 * Empieza a grabar la sala de esta llamada.
 *
 * El `title` viaja porque el recorder entra a la sala como un participante más y la pantalla
 * lo pinta: sin él, la grabación abre con una sala sin nombre.
 */
export async function startCallRecording(roomName: string, title = "") {
  return await askStudio({ action: "start", room: roomName, live: false, title }, "huddle");
}

/**
 * Para la grabación y la deja a salvo en storage.
 *
 * El orden importa y está copiado del camino de eventos, donde cada paso costó un incidente:
 *
 *  - **Se sube ANTES de borrar nada.** El MP4 vive en el disco de una caja que hiberna y que
 *    el janitor recicla; si la subida falla, no se borra.
 *  - **El transcript NO se espera.** Whisper sobre dos horas de audio tarda mucho más que un
 *    request. Se intenta una vez —una grabación corta ya puede estar lista— y si no, lo
 *    recoge después `recogerTranscript` al abrir el room.
 *  - **El MP4 sólo se borra si el transcript ya está.** Whisper transcribe DESDE ese archivo:
 *    borrarlo antes deja la grabación muda para siempre.
 */
export async function stopCallRecording() {
  // Sin `hlsPrefix` la caja no transcodifica. Ver la nota de la cabecera.
  const parada = await askStudio({ action: "stop" }, "huddle");
  const file = String(parada.file ?? "");
  if (!file) throw new Error("No había ninguna grabación en curso");

  const { presignPut, keyFor, signedUrl } = await import("./storage.server");
  const key = keyFor(file);
  await askStudio(
    { action: "upload", file, putUrl: presignPut(key, 3600), contentType: "video/mp4" },
    "huddle"
  );

  // La portada: un fotograma que saca la caja al parar. Pesa unos 30 KB y es lo que
  // convierte la lista de grabaciones en algo que se mira en vez de leerse.
  let keyPortada: string | null = null;
  const portada = String(parada.poster ?? "");
  if (portada) {
    const k = keyFor(portada);
    const subida = await askStudio(
      { action: "upload", file: portada, putUrl: presignPut(k, 3600), contentType: "image/webp" },
      "huddle"
    ).then(() => true).catch(() => false); // sin portada se sigue: no vale romper el guardado
    if (subida) keyPortada = k;
  }

  const keyTexto = await uploadTranscript(file, "huddle");
  if (keyTexto) await askStudio({ action: "delete", file }, "huddle").catch(() => {});

  return {
    file,
    key,
    transcriptKey: keyTexto,
    posterKey: keyPortada,
    startedAt: parada.startedAt ? Math.floor(Date.parse(String(parada.startedAt)) / 1000) : null,
    bytes: Number(parada.bytes ?? 0),
    // 7 días: es lo que dura una firma de lectura, y para "ver lo que me perdí" alcanza. La
    // fila guarda la CLAVE, así que la vista puede volver a firmarla cuando ésta caduque.
    url: signedUrl(key, 7 * 24 * 3600),
    transcriptUrl: keyTexto ? signedUrl(keyTexto, 7 * 24 * 3600) : null,
  };
}

/**
 * Deja constancia de la grabación. Misma tabla que las de evento —es el mismo objeto y la
 * misma vista— distinguida por `scope`.
 *
 * ⚠️ En un DM `channel_id` va en **0**, no NULL: la columna es NOT NULL y 0 es el convenio
 * que este repo ya usa para los DM. Poner NULL rompería el INSERT; inventar otro centinela
 * dejaría dos convenios para lo mismo.
 */
export async function saveCallRecording(
  s: CallScope,
  r: Awaited<ReturnType<typeof stopCallRecording>>,
  byName: string,
  title: string
): Promise<void> {
  const { dbq } = await import("../dbq.server");
  await dbq(
    `INSERT INTO gt_event_recordings
       (channel_id, storage_key, transcript_key, bytes, started_at, by_name, box_file,
        transcript_state, poster_key, publish_state, title, scope, scope_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, 'call', ?)`,
    [
      s.scope === "room" ? s.channelId : 0,
      r.key,
      r.transcriptKey,
      r.bytes,
      r.startedAt,
      byName,
      r.file,
      r.transcriptKey ? "ready" : "pending",
      r.posterKey,
      title,
      s.scopeId,
    ]
  );
}
