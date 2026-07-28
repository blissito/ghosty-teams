// ── Adjuntar un archivo que el box publicó ────────────────────────────────────
//
// El SDK del box genera algo (nota de voz con voice.mjs, PDF/PNG con render.mjs),
// lo publica a un storage y emite un bloque con su URL. Acá lo bajamos, lo
// re-subimos a NUESTRO storage y lo colgamos como adjunto del mensaje.
//
// Por qué re-subir en vez de guardar la URL: el archivo deja de depender de que
// esa URL siga viva, y queda como cualquier otro adjunto — buscable, reenviable,
// con el mismo ciclo de vida. La URL publicada es un transporte, no un hogar.
//
// Vive aparte porque el mismo camino lo usan los canales (`chat.ts`) y los DMs
// (`dm.ts`). Estaba duplicado para audio; al sumar los archivos habrían sido
// cuatro copias del mismo bloque.

export type PublishedAttachment = {
  url: string;
  /** Nombre visible del adjunto. */
  name: string;
  /** Nombre de archivo para el storage (con extensión). */
  fileName: string;
  mime: string;
  /** Sólo audio: onda y duración para la burbuja tipo PTT. */
  waveform?: string | null;
  durationMs?: number | null;
  /** Miniatura ya publicada (p.ej. la página 1 de un PDF). Se re-sube igual que
   *  el archivo: la URL publicada caduca a los 7 días y la miniatura debe durar
   *  lo que dure el mensaje. */
  thumbUrl?: string | null;
};

/**
 * Baja el archivo publicado, lo re-sube y crea el adjunto. Best-effort: si algo
 * falla, lo dice y devuelve false — el mensaje se queda con su texto en vez de
 * romperse. Un adjunto que no llegó es molesto; un turno perdido, peor.
 */
export async function attachPublished(messageId: number, a: PublishedAttachment): Promise<boolean> {
  try {
    const db = await import("../db.server");
    const { uploadToEasyBits } = await import("./easybits-files.server");
    const r = await fetch(a.url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const up = await uploadToEasyBits({
      blob: new Blob([bytes], { type: a.mime }),
      contentType: a.mime,
      fileName: a.fileName,
    });
    // La miniatura es OPCIONAL: si falla, el adjunto se crea igual y la tarjeta
    // cae al ícono. No vale perder el archivo por no tener su preview.
    let thumbFileId: string | null = null;
    // Si es un PDF y nadie mandó miniatura, se pide. NO se depende de que el
    // agente haya usado `publishPdf` en vez de `pdf()` + su propia publicación:
    // en cuanto improvisa, el PDF llega sin portada. Generarla acá lo saca de la
    // ecuación — cualquier PDF que llegue tiene su miniatura.
    let thumbUrl = a.thumbUrl ?? null;
    let thumbBytes: Buffer | null = null;
    if (!thumbUrl && (a.mime === "application/pdf" || /\.pdf$/i.test(a.fileName))) {
      thumbBytes = await pdfThumb(a.url);
    }
    if (thumbBytes) {
      try {
        const tup = await uploadToEasyBits({
          blob: new Blob([new Uint8Array(thumbBytes)], { type: "image/png" }),
          contentType: "image/png",
          fileName: a.fileName.replace(/\.[a-z0-9]+$/i, "") + "-thumb.png",
        });
        thumbFileId = tup.fileId;
      } catch (e) {
        console.error(`[attach] subir miniatura de ${a.fileName} falló:`, e instanceof Error ? e.message : e);
      }
    } else if (thumbUrl) {
      try {
        const tr = await fetch(thumbUrl);
        if (tr.ok) {
          const tb = Buffer.from(await tr.arrayBuffer());
          const tup = await uploadToEasyBits({
            blob: new Blob([tb], { type: "image/png" }),
            contentType: "image/png",
            fileName: a.fileName.replace(/\.[a-z0-9]+$/i, "") + "-thumb.png",
          });
          thumbFileId = tup.fileId;
        }
      } catch (e) {
        console.error(`[attach] miniatura de ${a.fileName} falló:`, e instanceof Error ? e.message : e);
      }
    }
    await db.createAttachments(messageId, [
      {
        fileId: up.fileId,
        thumbFileId,
        mime: up.mime || a.mime,
        size: up.size ?? bytes.length,
        name: a.name,
        waveform: a.waveform ?? null,
        durationMs: a.durationMs ?? null,
      },
    ]);
    return true;
  } catch (e) {
    console.error(`[attach] ${a.fileName} falló:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Nombre de archivo seguro para el storage, conservando la extensión si trae. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").trim().replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80);
  return base || fallback;
}

/**
 * Portada de la página 1 de un PDF, vía Studio (que es quien sabe dónde vive la
 * caja de render). Devuelve null ante cualquier fallo: un PDF sin miniatura llega
 * igual y la tarjeta cae al ícono.
 */
async function pdfThumb(url: string): Promise<Buffer | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) return null; // sin runtime nativo no hay caja de render que pedir
    const { currentNamespace } = await import("./tenant.server");
    const body = JSON.stringify({ url });
    const res = await fetch(`${base}/api/v2/render/pdf-thumb`, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.error(`[attach] miniatura: studio devolvió ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error("[attach] miniatura falló:", e instanceof Error ? e.message : e);
    return null;
  }
}
