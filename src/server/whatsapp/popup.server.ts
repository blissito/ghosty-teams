/**
 * URL firmada del wizard de Embedded Signup que **hospeda Formmy**.
 *
 * No corremos el SDK de Meta aquí: el popup vive en
 * `${FORMMY_BASE_URL}/partners/connect`, porque ese dominio es el que tiene el App
 * Secret. La URL va firmada para que Formmy sepa que la apertura viene de un partner
 * legítimo:
 *
 *   sig = HMAC-SHA256(`${ts}.${origin}`, FORMMY_PARTNER_SECRET_GHOSTY)
 *
 * Port de `~/agenda/app/lib/whatsapp-popup.server.ts` (Deník).
 *
 * ⚠️ El `origin` tiene que ser EXACTAMENTE la página donde está el usuario: es el
 * `targetOrigin` del `postMessage` de vuelta. Por eso se lee del request y NO de
 * `reqOrigin()` de `src/origin.server.ts`, que prefiere `APP_URL` — en un producto
 * multi-tenant por subdominio eso apuntaría al host equivocado.
 *
 * ⚠️ Y por eso mismo el flujo es por REDIRECT (`returnUrl`), no por popup: es el
 * único confiable en móvil, donde el `postMessage` de vuelta se pierde.
 */
import { createHmac } from "node:crypto";
import { formmyBaseUrl, partnerSecret } from "./formmy-partner.server";

/** Origin real del tenant detrás del proxy (TLS termina afuera). */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

export function buildPartnerPopupUrl(
  request: Request,
  opts: { pairingId: string; returnUrl: string },
): string {
  const origin = requestOrigin(request);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", partnerSecret()).update(`${ts}.${origin}`).digest("hex");
  const params = new URLSearchParams({ ts, o: origin, sig, s: opts.pairingId, r: opts.returnUrl });
  return `${formmyBaseUrl()}/partners/connect?${params.toString()}`;
}
