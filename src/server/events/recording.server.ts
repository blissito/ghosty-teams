// Grabar la llamada de un evento, y que la grabación SOBREVIVA a la caja.
//
// La caja de LiveKit ya sabía hacer todo esto y nadie la llamaba: `recStart` levanta un
// chromium oculto + ffmpeg, `recStop` cierra el MP4 con SIGINT (el `moov` va al principio,
// así que se puede ver sin bajarlo entero), `recTranscript` lo pasa por whisper.cpp
// embebido, y `recUpload` lo streamea a una URL PUT presignada.
//
// ⚠️ La parte que HOY PIERDE DATOS es la subida. El MP4 vive en `/data/recordings` de una
// caja que hiberna, y el janitor recicla lo que lleve 72 h suspendido: sin subirlo, la
// grabación de un webinar desaparece el fin de semana. Por eso `detener()` sube y sólo
// entonces borra el local — y si la subida falla, NO borra.
//
// ⚠️ Y el disco: la caja tiene ~3.3 GB libres y una grabación con movimiento pesa 1-2 GB
// por hora. Dejar los MP4 ahí no es sólo perderlos: es que la segunda grabación del día se
// quede sin espacio a media sesión.

const ADMIN = () => process.env.EVENT_LIVEKIT_ADMIN_TOKEN ?? "";

function baseDe(ch: { call_livekit_url?: string | null }): string {
  return (ch.call_livekit_url || process.env.EVENT_LIVEKIT_URL || "").replace(/\/$/, "");
}

async function admin(base: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${ADMIN()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // La caja puede estar dormida: el proxy público la despierta, y el resume mide ~1.8 s.
    signal: AbortSignal.timeout(30_000),
  });
  const txt = await r.text();
  let json: Record<string, unknown> = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* la caja contestó algo que no es JSON */ }
  if (!r.ok) throw new Error(String(json.error ?? txt.slice(0, 200) ?? r.status));
  return json;
}

/** Empieza a grabar la sala de este room. Devuelve el id de la grabación. */
export async function iniciarGrabacion(ch: { id: number; call_livekit_url?: string | null }, roomName: string) {
  const base = baseDe(ch);
  if (!base) throw new Error("La llamada no está configurada");
  if (!ADMIN()) throw new Error("Falta EVENT_LIVEKIT_ADMIN_TOKEN");
  return admin(base, "/admin/recording/start", { room: roomName });
}

/**
 * Para, SUBE y sólo entonces borra el local. Devuelve las URLs firmadas del video y del
 * transcript, o `null` en el transcript si whisper aún no terminó (no bloquea: el audio de
 * una hora tarda, y el video ya está a salvo).
 */
export async function detenerGrabacion(ch: { id: number; call_livekit_url?: string | null }) {
  const base = baseDe(ch);
  if (!base) throw new Error("La llamada no está configurada");

  const parada = (await admin(base, "/admin/recording/stop", {})) as { file?: string; bytes?: number };
  const file = String(parada.file ?? "");
  if (!file) throw new Error("No había ninguna grabación en curso");

  const { presignPut, keyFor, signedUrl } = await import("../storage.server");
  const key = keyFor(file);
  // ⚠️ El PUT lo hace la CAJA, no Teams: un MP4 de una hora pasa del giga y hacerlo pasar
  // por aquí sería bajarlo y volverlo a subir sin ninguna razón. La firma sola no abre
  // nada más que esa clave, ese método y esa ventana.
  await admin(base, "/admin/recording/upload", {
    file,
    putUrl: presignPut(key, 3600),
    contentType: "video/mp4",
  });

  // El transcript viaja igual, con su propia clave. Si aún no existe, se deja para después:
  // el video —que es lo caro— ya está fuera de la caja.
  let keyTexto: string | null = null;
  const txt = file.replace(/\.mp4$/, ".txt");
  try {
    keyTexto = keyFor(txt);
    await admin(base, "/admin/recording/upload", {
      file: txt,
      putUrl: presignPut(keyTexto, 3600),
      contentType: "text/plain",
    });
  } catch {
    keyTexto = null; // whisper sigue trabajando, o no hubo audio
  }

  // Sólo AHORA se borra de la caja, y sólo lo que se confirmó. Borrar antes sería confiar
  // en que la subida no falla nunca.
  await admin(base, "/admin/recording/delete", { file }).catch(() => {});
  if (keyTexto) await admin(base, "/admin/recording/delete", { file: txt }).catch(() => {});

  return {
    file,
    bytes: Number(parada.bytes ?? 0),
    // 7 días: es lo que dura una firma de lectura, y para "ver lo que me perdí" alcanza.
    url: signedUrl(key, 7 * 24 * 3600),
    transcriptUrl: keyTexto ? signedUrl(keyTexto, 7 * 24 * 3600) : null,
  };
}
