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
  /** De dónde bajarlo. Opcional: ver `bytes`. */
  url?: string;
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
  /**
   * Los bytes, cuando ya los tenemos y no hay nada que bajar — el caso de un audio que
   * sintetizó ESTE proceso. Si vienen, `url` sobra.
   */
  bytes?: Buffer;
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
    let bytes: Buffer;
    if (a.bytes) {
      bytes = a.bytes;
    } else {
      const r = await fetch(a.url!);
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer());
    }
    const up = await uploadToEasyBits({
      // `new Uint8Array(bytes)` y no el Buffer pelado: el `ArrayBufferLike` de Node no encaja
      // en el `BlobPart` del DOM y TypeScript lo rechaza. Es una vista, no una copia.
      blob: new Blob([new Uint8Array(bytes)], { type: a.mime }),
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
    // Sólo con URL: la miniatura la hace `render-svc` bajándose el PDF, así que un PDF que
    // llegara en bytes no la tendría. Hoy no pasa (los bytes son sólo audio) y forzarlo
    // sería publicar el archivo dos veces para hacerle una portada.
    if (!thumbUrl && a.url && (a.mime === "application/pdf" || /\.pdf$/i.test(a.fileName))) {
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

/**
 * Re-hospeda las imágenes de un markdown: baja cada `![alto](url)` externa, la
 * re-sube a NUESTRO storage y reescribe la url a `/api/attachment/<fileId>`.
 *
 * Misma razón que `attachPublished`, aplicada al contenido de un documento en vez
 * de a un adjunto: la url que emite el box es una presignada a 7 días. Un dictamen
 * pericial que hoy se ve completo saldría con huecos el mes que viene, y nadie lo
 * revisa a tiempo. La url publicada es un transporte, no un hogar.
 *
 * También desbloquea el PDF: `blocksToPrintHtml` incrusta las imágenes leyéndolas
 * de nuestro storage, y no puede hacerlo con una url ajena.
 *
 * Best-effort por imagen: la que falle se queda con su url original en vez de
 * tumbar la publicación entera del documento.
 */
export async function rehostMarkdownImages(md: string): Promise<{ md: string; failed: string[] }> {
  const IMG = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
  const encontradas = [...md.matchAll(IMG)];
  if (!encontradas.length) return { md, failed: [] };

  const { uploadToEasyBits } = await import("./easybits-files.server");
  const nuevo = new Map<string, string>();
  // ⚠️ Una imagen que no se pudo traer NO puede irse en silencio. Antes moría en el
  // `console.error` de abajo y el documento se entregaba con el hueco, turno en verde:
  // ni el agente ni la persona se enteraban. El caso típico es que el agente escriba
  // una ruta de su caja (`logo.png`, `/tmp/…`), que aquí ni siquiera es una URL válida.
  const failed: string[] = [];

  for (const m of encontradas) {
    const url = m[2];
    // Ya es nuestra (o es un data: URI): nada que hacer.
    if (nuevo.has(url) || url.startsWith("/api/attachment/") || url.startsWith("data:")) continue;
    if (failed.includes(url)) continue;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const mime = r.headers.get("content-type")?.split(";")[0] || "image/png";
      if (!mime.startsWith("image/")) throw new Error(`no es imagen: ${mime}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const up = await uploadToEasyBits({
        blob: new Blob([new Uint8Array(bytes)], { type: mime }),
        contentType: mime,
        fileName: safeFileName(url.split("/").pop()?.split("?")[0], "imagen"),
      });
      nuevo.set(url, `/api/attachment/${up.fileId}`);
    } catch (e) {
      failed.push(url);
      console.error(`[doc] re-hospedar imagen falló (${url.slice(0, 100)}):`, e instanceof Error ? e.message : e);
    }
  }
  if (!nuevo.size) return { md, failed };
  return {
    md: md.replace(IMG, (todo, alt, url, titulo) =>
      nuevo.has(url) ? `![${alt}](${nuevo.get(url)}${titulo ?? ""})` : todo
    ),
    failed,
  };
}
