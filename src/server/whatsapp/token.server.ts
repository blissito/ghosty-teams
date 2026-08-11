/**
 * Token del webhook de WhatsApp. Misma mecánica que `hooks/token.server.ts` —HMAC,
 * `timingSafeEqual`, sin expiración— con una carga distinta, así que va aparte en vez
 * de ensanchar el `HookRef` de Sentry con campos que allá no significan nada.
 *
 * ⚠️ **ES UN SECRETO.** Va dentro de `Integration.externalAgentUrl` en Formmy y es lo que
 * dice a qué tenant y a qué room entregar. No lo pongas en un log, ni en el chat, ni en un
 * HTML. Quien lo tenga puede escribir en ese room; no puede leer nada ni tocar otro tenant
 * (el destino va firmado aquí dentro y el endpoint no lo lee de los argumentos).
 *
 * Lleva el `channelSecret` DENTRO a propósito: el endpoint tiene que validar el Bearer de
 * Formmy antes de saber de qué integración se trata, y el `integration_id` sólo aparece en
 * el cuerpo. Sin esto haría falta una lectura a la DB para poder autenticar, o sea confiar
 * en el cuerpo para decidir contra qué secreto comparar.
 *
 * SIN expiración, igual que los otros dos: la URL queda guardada del lado de Formmy y tiene
 * que seguir viva meses. Para cortar el flujo se desconecta el número allá, no se caduca el
 * token — rotarlo dejaría al cliente sin mensajes y sin ninguna señal de por qué.
 */
import crypto from "node:crypto";

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

export type WaHookRef = {
  /** Namespace del tenant. FIRMADO: Formmy llama sin host de tenant. */
  ns: string;
  /** Room destino, elegido al conectar. */
  roomId: number;
  topic: string;
  /** El `externalAgentSecret` de la integración = Bearer que manda Formmy. */
  channelSecret: string;
};

export function mintWaToken(ref: WaHookRef): string {
  const payload = Buffer.from(JSON.stringify(ref)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyWaToken(token: string): WaHookRef | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<WaHookRef>;
    if (!p.ns || typeof p.roomId !== "number" || !p.channelSecret) return null;
    return { ns: p.ns, roomId: p.roomId, topic: p.topic || "general", channelSecret: p.channelSecret };
  } catch {
    return null;
  }
}
