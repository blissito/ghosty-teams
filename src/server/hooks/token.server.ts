// Token de un webhook ENTRANTE. Calcado de forms/token.server.ts —mismo HMAC, mismo
// timingSafeEqual, misma decisión de no expirar— pero con un trabajo distinto y mucho
// más delicado, así que no se pueden tratar igual.
//
// ⚠️ EL TOKEN DEL FORMULARIO ES PÚBLICO POR DISEÑO: viaja dentro del HTML de un formulario
// que cualquiera abre, y su único trabajo es transportar el namespace sin que se pueda
// manipular. ÉSTE ES UN SECRETO. Sentry NO firma sus webhooks legacy —ni
// `sentry-hook-signature`, ni secreto compartido, nada: `LegacyWebhookClient` hace un POST
// pelado— así que este token es LO ÚNICO que separa una alerta legítima de cualquiera que
// descubra la URL. No lo pongas en un HTML, ni en un mensaje del chat, ni en un log.
//
// Qué puede hacer quien lo tenga: escribir mensajes en ese canal, con la identidad del
// agente. No puede leer nada ni tocar otro canal ni otro tenant: el destino va firmado
// aquí dentro y el endpoint no lee ningún canal de los argumentos.
//
// SIN expiración, igual que el de formularios: la URL queda guardada del lado de Sentry y
// tiene que seguir viva meses después. Para cortar el flujo se quita la URL allá
// (`sentry_alerts_disable`), no se caduca el token — rotarlo dejaría al cliente con
// alertas que dejaron de llegar y ninguna señal de por qué.
import crypto from "node:crypto";

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

/**
 * A dónde entrega este webhook. Es el `ToolDest` del turno en el que se configuró,
 * congelado: el canal y la identidad con la que se va a publicar.
 */
export type HookRef = {
  ns: string;
  channelId: number;
  topic: string;
  /** Identidad del agente que lo configuró — el mensaje sale con su cara. */
  handle: string;
  name: string;
  avatar: string;
  /** Quién lo pidió. No se usa para autorizar; sirve para saber a quién preguntarle. */
  ownerSub: string;
};

export function mintHookToken(ref: HookRef): string {
  const payload = Buffer.from(JSON.stringify(ref)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyHookToken(token: string): HookRef | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<HookRef>;
    if (!p.ns || typeof p.channelId !== "number") return null;
    return {
      ns: p.ns,
      channelId: p.channelId,
      topic: p.topic || "general",
      handle: p.handle || "ghosty",
      name: p.name || "Ghosty",
      avatar: p.avatar || "",
      ownerSub: p.ownerSub || "",
    };
  } catch {
    return null;
  }
}
