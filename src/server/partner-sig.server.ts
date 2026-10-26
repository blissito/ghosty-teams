import crypto from "node:crypto";

// ── Firma de partner de las rutas `api/internal/*` ───────────────────────────────────────────
//
// gs (y la operación) le hablan a Teams firmando con GHOSTY_PARTNER_SECRET:
//   headers `x-ghosty-ts` (segundos) + `x-ghosty-sig` = hex(HMAC-SHA256(`${ts}.${rawBody}`)).
// Se firma el CUERPO en crudo: la firma cubre lo que se va a hacer. Firmar un literal por
// recurso (`ts.members-admin`) dejaba que UNA firma capturada sirviera 5 min para cualquier
// cuerpo (26-oct). Un GET no tiene cuerpo: firma `GET <pathname>` (`canonicalGet`), así la
// firma de un GET no sirve en otra ruta.
//
// Antes cada ruta traía su propia copia de esto (16); ahora todas pasan por aquí.

const MAX_SKEW_S = 300;

function hmacOk(secret: string, message: string, sig: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fresh(ts: string): boolean {
  const t = Number(ts);
  return ts !== "" && Number.isFinite(t) && Math.abs(Math.floor(Date.now() / 1000) - t) <= MAX_SKEW_S;
}

/** ¿`sig` firma `${ts}.${rawBody}` con el secreto de partner, y `ts` está dentro de ±300 s? */
export function partnerSigOk(ts: string, sig: string, rawBody: string): boolean {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret || !sig || !fresh(ts)) return false;
  return hmacOk(secret, `${ts}.${rawBody}`, sig);
}

/** La firma de los headers `x-ghosty-ts`/`x-ghosty-sig` sobre el cuerpo crudo ya leído. */
export function partnerRequestOk(request: Request, rawBody: string): boolean {
  return partnerSigOk(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", rawBody);
}

/** Lo que firma un GET (no tiene cuerpo): el método y la ruta. */
export function canonicalGet(pathname: string): string {
  return `GET ${pathname}`;
}

/**
 * ⚠️ Transición (26-oct): formato VIEJO de members/announcements/prospeccion-run, `?ts&sig` en
 * la query sobre `${ts}.<literal>`. Se acepta sólo mientras gs pasa a firmar el cuerpo; luego se
 * borra junto con sus llamadas.
 */
export function legacyLiteralOk(request: Request, literal: string): boolean {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  const u = new URL(request.url);
  const ts = u.searchParams.get("ts") ?? "";
  const sig = u.searchParams.get("sig") ?? "";
  if (!secret || !sig || !fresh(ts)) return false;
  return hmacOk(secret, `${ts}.${literal}`, sig);
}
