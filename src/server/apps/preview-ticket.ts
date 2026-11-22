// Boleto de un solo uso para que el NAVEGADOR de un agente (su computadora) abra la preview de un pedido.
// El agente no tiene sesión de Teams, así que `/preview/<id>` le daba 401 y @check escalaba «inicia sesión en
// mi computadora» (hilo #184 de test-isma, 21-nov). El boleto: firmado (HMAC), atado al pedido, caduca en
// 10 min y sirve UNA vez. La llave `?k=` sigue sin salir: sólo va en el redirect, como para una persona.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TICKET_TTL_MS = 10 * 60_000;
const used = new Map<string, number>();

const b64 = (b: Buffer) => b.toString("base64url");
const sign = (secret: string, body: string) => b64(createHmac("sha256", `preview-ticket:${secret}`).update(body).digest());

export function makePreviewTicket(runId: number, secret: string, now = Date.now()): string {
  const body = `${runId}.${now + TICKET_TTL_MS}.${b64(randomBytes(9))}`;
  return `${b64(Buffer.from(body))}.${sign(secret, body)}`;
}

/** ¿El boleto abre ESTE pedido? Lo gasta al aceptarlo. */
export function redeemPreviewTicket(ticket: string, runId: number, secret: string, now = Date.now()): boolean {
  const [raw, mac] = String(ticket ?? "").split(".");
  if (!raw || !mac) return false;
  const body = Buffer.from(raw, "base64url").toString();
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  const [id, exp, nonce] = body.split(".");
  if (Number(id) !== runId || !(Number(exp) > now) || !nonce) return false;
  for (const [n, e] of used) if (e <= now) used.delete(n);
  if (used.has(nonce)) return false;
  used.set(nonce, Number(exp));
  return true;
}
