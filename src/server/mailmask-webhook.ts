/**
 * Firma de los webhooks de MailMask: `x-mailmask-signature` = `sha256=<hex>` de
 * HMAC(secret, `${ts}.${body}`), una por secreto vigente separadas por coma. `ts` en ms;
 * se rechaza si tiene más de 5 min. Puro, para probarlo sin red.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyMailmaskSignature(secret: string, signature: string, timestamp: string, rawBody: string, now = Date.now()): boolean {
  if (!secret || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60_000) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`);
  return signature.split(",").some((p) => {
    const got = Buffer.from(p.trim());
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** `"Ana <Ana@X.com>"` → `ana@x.com`. */
export function bareEmail(s: unknown): string {
  const v = String(s ?? "").trim();
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}
