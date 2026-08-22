/**
 * Rastreo de correo — tokens firmados para el pixel, el clic y la stop1.
 *
 * Se hace CON NUESTROS PROPIOS ENDPOINTS y no con el event publishing de SES, a propósito:
 * el tracking de SES reescribe los enlaces a `r.us-east-1.awstrack.me`, que es un dominio
 * de Amazon visible en el correo y que los filtros conocen. Un enlace a nuestro propio
 * dominio se ve como lo que es.
 *
 * El token lleva `{touchId, ns, kind}` y va firmado con HMAC, igual que `tool-token`:
 *  - Sin firma, cualquiera podría inflar aperturas ajenas o —peor— dar de stop1 a
 *    contactos de otro workspace probando ids.
 *  - `ns` viaja DENTRO porque estos endpoints los abre un cliente de correo, sin sesión y
 *    a veces from un proxy: no hay subdominio del que resolver el tenant. Es el mismo
 *    razonamiento que el token de formularios.
 *
 * ⚠️ Estos tokens NO caducan. Un correo se puede abrir seis meses después, y un pixel que
 * expira sólo produce estadísticas que mienten hacia abajo. Lo que sí se acota es lo que
 * pueden hacer: marcar una tocada o dar de stop1 — nada que lea datos.
 */
import crypto from "node:crypto";

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

export type TrackKind = "open" | "click" | "unsub";
export type TrackClaims = { touchId: number; ns: string; kind: TrackKind; url?: string };

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

export function mintTrackToken(claims: TrackClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyTrackToken(token: string): TrackClaims | null {
  const [payload, sig] = (token ?? "").split(".");
  if (!payload || !sig) return null;
  const esperado = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  // timingSafeEqual exige mismo largo; un token recortado lo tendría distinto.
  if (sig.length !== esperado.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as TrackClaims;
    return c && typeof c.touchId === "number" && typeof c.ns === "string" ? c : null;
  } catch {
    return null;
  }
}

/** El origen público de este tenant, para armar las URLs que van dentro del correo. */
export function publicOrigin(): string {
  return (process.env.GTEAMS_PUBLIC_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Prepara el HTML para mandarlo: reescribe los enlaces y pega el pixel.
 *
 * Devuelve también `unsubUrl` porque va en DOS sitios —el header `List-Unsubscribe` y el
 * pie visible del correo— y tienen que ser el mismo.
 */
export function instrument(
  html: string,
  touchId: number,
  ns: string
): { html: string; unsubUrl: string } {
  const base = publicOrigin();
  const unsubUrl = `${base}/api/p/u/${mintTrackToken({ touchId, ns, kind: "unsub" })}`;

  // Los enlaces: cada href absoluto pasa por el redirect firmado, con el destino DENTRO
  // del token (no como query param, o cualquiera podría usar el dominio como redirector
  // abierto hacia donde quisiera).
  const rewritten = html.replace(
    /href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi,
    (m, q: string, url: string) => {
      // El propio enlace de stop1 no se rastrea: sería contarle un clic a quien se va.
      if (url.startsWith(`${base}/api/p/`)) return m;
      const tk = mintTrackToken({ touchId, ns, kind: "click", url });
      return `href=${q}${base}/api/p/c/${tk}${q}`;
    }
  );

  const pixel = `<img src="${base}/api/p/o/${mintTrackToken({ touchId, ns, kind: "open" })}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />`;

  // Al finalHtml del body, o pegado al finalHtml si no hay etiqueta.
  const withPixel = /<\/body>/i.test(rewritten)
    ? rewritten.replace(/<\/body>/i, `${pixel}</body>`)
    : rewritten + pixel;

  return { html: withPixel, unsubUrl };
}

/** GIF transparente de 1×1. Se responde SIEMPRE, incluso si el token no resuelve. */
export const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);
