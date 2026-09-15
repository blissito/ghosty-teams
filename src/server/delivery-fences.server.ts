// Adjuntos que el agente ENTREGA en su respuesta: bloques ```eb-file``` (archivo publicado)
// y ```eb-audio``` (nota de voz). Es el mismo procesamiento que hacen dm.ts y chat.ts al
// cerrar un turno normal; vive aquí para que el turno del DESPERTADOR (wakeups.server.ts)
// lo comparta. Sin esto, la entrega proactiva de un video/mp3 dejaba el fence en el body
// y ningún adjunto: el agente decía «aquí tienes el video» y no había nada (2026-09-15).

type Dest = { dmId?: number | null; channelId?: number | null; parentId?: number | null };

/**
 * Convierte los fences de entrega de `reply` en adjuntos del mensaje `id`. Devuelve el
 * body limpio (sin fences) o null si no había nada que entregar.
 */
export async function attachDeliveryFences(
  id: number,
  reply: string,
  dest: Dest,
): Promise<{ body: string; attached: boolean } | null> {
  const { extractAllEbAudio, stripEbAudio, extractAllEbFile, stripEbFile } = await import("../lib/ebdoc");
  const ebAudios = extractAllEbAudio(reply);
  const ebFiles = extractAllEbFile(reply);
  if (!ebAudios.length && !ebFiles.length) return null;

  const db = await import("../db.server");
  const { attachPublished, safeFileName } = await import("./published-attach.server");
  const { sintetizar } = await import("./tts-fence.server");
  const body = stripEbFile(stripEbAudio(reply));
  let attached = false;
  // En serie: el orden de los adjuntos es el orden en que el agente los emitió.
  for (const a of ebAudios) {
    const hecho = a.url ? null : await sintetizar(a);
    if (!a.url && !hecho) continue;
    attached =
      (await attachPublished(id, {
        url: a.url,
        bytes: hecho?.bytes,
        name: "Nota de voz",
        fileName: hecho ? "voz.mp3" : "voz.ogg",
        mime: hecho?.contentType || a.mime || "audio/ogg",
        waveform: a.waveform,
        durationMs: hecho?.durMs ?? a.durationMs,
      })) || attached;
  }
  for (const f of ebFiles) {
    attached =
      (await attachPublished(id, {
        url: f.url,
        name: f.name || "Archivo",
        fileName: safeFileName(f.name, "archivo"),
        mime: f.mime || "application/octet-stream",
        thumbUrl: f.thumb,
      })) || attached;
  }
  // Sella la última entrega del hilo/DM (el turno siguiente sabe qué fue «lo último»).
  if (ebFiles.length) {
    const ultimo = ebFiles[ebFiles.length - 1];
    const delivery = { name: ultimo.name || "Archivo", mime: ultimo.mime ?? null };
    if (dest.dmId != null) await db.setDmDelivery(dest.dmId, delivery).catch(() => {});
    else if (dest.channelId != null) await db.setThreadDelivery(dest.channelId, dest.parentId ?? null, delivery).catch(() => {});
  }
  return { body, attached };
}
