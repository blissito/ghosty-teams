export type UploadedImage = {
  fileId: string; mime: string; size: number; name: string;
  thumbFileId: string | null; // derivado WebP inline (null = sin thumbnail)
  width?: number | null;  // dimensiones intrínsecas → reserva de alto exacta en el render
  height?: number | null;
};

// ── Pipeline de imagen (thumbnail WebP) sobre NUESTRO storage (Tigris) ───────
// Al subir una imagen: guarda el ORIGINAL (siempre) y genera un derivado WebP
// redimensionado (lado largo ≤ 1024, q~80) para servirlo INLINE → feed liviano/rápido
// (Slack/Discord sirven el derivado, no el original de MBs). El original queda para
// vista completa / descarga / el agente.
//
// Motor: `sharp` (libvips). Import DINÁMICO y GUARDADO: si sharp no está en el box
// (aún no instalado/horneado), degrada a "sin thumbnail" — nunca rompe el upload.
const THUMB_MAX_EDGE = 1024;
const WEBP_QUALITY = 80;
const THUMB_MIN_BYTES = 200 * 1024; // imágenes chicas: no vale la pena un derivado

export async function processAndStoreImage(opts: {
  blob: Blob;
  contentType: string;
  fileName: string;
}): Promise<UploadedImage> {
  const storage = await import("./storage.server");
  // Original SIEMPRE (privado). Si el storage propio no está configurado, cae al legacy.
  if (!storage.storageConfigured()) {
    const { uploadToEasyBits } = await import("./easybits-files.server");
    const up = await uploadToEasyBits(opts);
    return { ...up, thumbFileId: null };
  }
  const orig = await storage.put({ blob: opts.blob, contentType: opts.contentType, fileName: opts.fileName, visibility: "private" });
  const base: UploadedImage = { fileId: orig.key, mime: orig.mime, size: orig.size, name: orig.name, thumbFileId: null };

  // Leemos dims para reserva de alto en el render (0 layout-shift al abrir el canal) de
  // TODO lo que sharp sepa parsear —incluido GIF/SVG—; el thumbnail WebP sí se limita al
  // subset rasterizable. Sharp ausente → graceful (sin dims → el render cae al slot fijo).
  const isRaster = /^image\/(jpeg|png|webp|heic|heif|avif|tiff)$/i.test(opts.contentType);

  try {
    const sharpMod = await import("sharp").catch(() => null);
    const sharp = (sharpMod as { default?: (b: Buffer) => import("sharp").Sharp } | null)?.default;
    if (!sharp) return base; // sharp no está en el box → sin dims/thumbnail (graceful)
    const buf = Buffer.from(await opts.blob.arrayBuffer());
    const meta = await sharp(buf).metadata();
    // Dims tras EXIF-rotate: si la orientación gira 90°/270°, ancho↔alto se intercambian.
    const rotated = meta.orientation != null && meta.orientation >= 5;
    base.width = (rotated ? meta.height : meta.width) ?? null;
    base.height = (rotated ? meta.width : meta.height) ?? null;
    // Thumbnail WebP: solo raster (GIF animado/SVG → dims sí, derivado no) y si vale la pena.
    if (!isRaster) return base;
    if (opts.blob.size < THUMB_MIN_BYTES) return base;
    const big = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (big && big <= THUMB_MAX_EDGE && /webp/i.test(opts.contentType)) return base; // ya es webp chico
    const thumb = await sharp(buf)
      .rotate() // respeta EXIF orientation
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    const tb = await storage.put({
      blob: new Blob([new Uint8Array(thumb)], { type: "image/webp" }),
      contentType: "image/webp",
      fileName: (opts.fileName || "img") + ".webp",
      visibility: "private",
    });
    base.thumbFileId = tb.key;
  } catch { /* cualquier fallo del encode → sin thumbnail, el original sigue */ }
  return base;
}
