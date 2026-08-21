// Publicar una grabación en fixtergeek.
//
// El reparto de trabajo es el mismo de siempre: la CAJA produce (HLS, storyboard, póster,
// transcripción) y no sabe qué es un curso; TEAMS sabe a qué taller va este room; y
// FIXTERGEEK guarda la fila del vídeo. Este módulo es la costura.
//
// ⚠️ Secreto PROPIO de fixtergeek, no el de plataforma (`GHOSTY_PARTNER_SECRET`). Compartir
// el de plataforma con un tercero le daría acceso a todo lo demás que ese secreto firma.

import crypto from "node:crypto";

type Draft = { videoId: string; slug: string; viewerUrl: string };

/**
 * Llamada firmada a fixtergeek. Canonical `${ts}.${body}` — el mismo formato que ya se usa
 * contra Formmy, para no inventar un tercer dialecto de firma.
 *
 * `process.env` se lee DENTRO de la función a propósito: este módulo lo importan handlers
 * que también corren en caminos donde el env todavía no está hidratado.
 */
async function pedirAFixtergeek(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = (process.env.FIXTERGEEK_BASE_URL || "https://www.fixtergeek.com").replace(/\/$/, "");
  const secret = process.env.FIXTERGEEK_PARTNER_SECRET;
  if (!secret) throw new Error("FIXTERGEEK_PARTNER_SECRET no configurado");
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const r = await fetch(`${base}/api/ingest/recording`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-Id": "ghosty-teams",
      "X-Partner-Timestamp": ts,
      "X-Partner-Signature": sig,
    },
    body: raw,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(json.error ?? `fixtergeek ${r.status}`));
  return json;
}

/**
 * ⚠️ fixtergeek devuelve el `viewerUrl` RELATIVO (`/cursos/<curso>/<video>`), y guardarlo
 * tal cual hacía que el enlace de la lista de grabaciones se resolviera contra el host de
 * Teams (`<slug>.teams.ghosty.studio/cursos/…`): "Not Found" con el vídeo perfectamente
 * publicado del otro lado.
 */
export function absolutaEnFixtergeek(u: string): string {
  if (!u || /^https?:\/\//i.test(u)) return u;
  const base = (process.env.FIXTERGEEK_BASE_URL || "https://www.fixtergeek.com").replace(/\/$/, "");
  return base + (u.startsWith("/") ? u : "/" + u);
}

/**
 * Crea el vídeo en borrador y devuelve su id. Es lo PRIMERO que pasa al detener, porque el
 * `videoId` va dentro de la llave de todos los objetos que la caja va a subir.
 *
 * Idempotente del otro lado (upsert por slug), así que reintentar no duplica nada.
 */
export async function crearBorrador(opts: {
  courseId: string;
  title: string;
  eventDate?: number | null;
}): Promise<Draft> {
  const d = await pedirAFixtergeek({
    intent: "draft",
    courseId: opts.courseId,
    title: opts.title,
    eventDate: opts.eventDate ? new Date(opts.eventDate * 1000).toISOString() : undefined,
  });
  return {
    videoId: String(d.videoId),
    slug: String(d.slug),
    viewerUrl: absolutaEnFixtergeek(String(d.viewerUrl ?? "")),
  };
}

/** Cierra el vídeo: le pone el `m3u8`, la portada, la duración y la transcripción. */
export async function cerrarPublicacion(opts: {
  videoId: string;
  m3u8: string;
  poster?: string | null;
  durationMin?: number | null;
  transcript?: unknown;
}): Promise<void> {
  await pedirAFixtergeek({
    intent: "ready",
    videoId: opts.videoId,
    m3u8: opts.m3u8,
    poster: opts.poster ?? undefined,
    durationMin: opts.durationMin ?? undefined,
    transcript: opts.transcript ?? undefined,
  });
}

/** La URL pública del bucket donde la caja deja el HLS de este vídeo. */
export function m3u8Para(courseId: string, videoId: string): string {
  const endpoint = (process.env.FIXTERGEEK_STORAGE_ENDPOINT || "https://t3.storage.dev").replace(/\/$/, "");
  const bucket = process.env.FIXTERGEEK_BUCKET || "wild-bird-2039";
  return `${endpoint}/${bucket}/fixtergeek/videos/${courseId}/${videoId}/hls/master.m3u8`;
}

/**
 * La portada, en el bucket del taller. La sube la caja junto al HLS.
 *
 * ⚠️ No se usa una URL firmada NUESTRA: caduca, y un vídeo publicado se queda sin imagen
 * meses después, cuando ya nadie está mirando esa parte.
 */
export function posterPublico(courseId: string, videoId: string): string {
  const endpoint = (process.env.FIXTERGEEK_STORAGE_ENDPOINT || "https://t3.storage.dev").replace(/\/$/, "");
  const bucket = process.env.FIXTERGEEK_BUCKET || "wild-bird-2039";
  return `${endpoint}/${bucket}/fixtergeek/videos/${courseId}/${videoId}/hls/poster.jpg`;
}

/** El prefijo que se le manda a la caja al detener. Termina en `/hls` a propósito: el
 *  storyboard cuelga de su PADRE, y así lo deriva quien lo consume. */
export const prefijoHls = (courseId: string, videoId: string) =>
  `fixtergeek/videos/${courseId}/${videoId}/hls`;
