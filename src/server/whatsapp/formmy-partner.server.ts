/**
 * Cliente de la API de partner de Formmy — conectar un número de WhatsApp Business
 * (WABA) de un cliente de Teams SIN que tenga cuenta en Formmy.
 *
 * Reparto de responsabilidades (el mismo que ya usan Deník y EasyBits):
 *   - Formmy tiene el **Meta App Secret**: hospeda el popup de Embedded Signup,
 *     hace el intercambio code→access_token, registra el WABA y guarda la
 *     Integration. Nosotros nunca vemos el token de Meta.
 *   - Nosotros aportamos DÓNDE entregar (`externalAgentUrl`) y con qué secreto
 *     (`channelSecret`), y luego recogemos `{integrationId, phoneNumber}`.
 *
 * Port de `~/agenda/app/lib/formmy-partner.server.ts` (Deník), recortado a lo que
 * hace falta para conectar y recibir. Templates, perfil del número y el envío por
 * template viven allá y se traen cuando se necesiten.
 *
 * ⚠️ `X-Partner-Id: ghosty-chat` NO es opcional. Deník lo omite y cae al default
 * `denik` del registro de Formmy; nosotros somos otra fila, y las sesiones de
 * pairing son partner-scoped (`api.v1.partners.whatsapp.pairing.ts` rechaza el
 * `get` si el `partnerId` de la fila no coincide con el del request). Sin el
 * header, `createPairingSession` abriría la sesión como Deník y el `get` fallaría.
 */
import { createHmac, randomBytes } from "node:crypto";

/** La fila que YA existe en el registro de Formmy (`server/channels/partners.server.ts`). */
export const PARTNER_ID = "ghosty-chat";

export function formmyBaseUrl(): string {
  return process.env.FORMMY_BASE_URL || "https://www.formmy.app";
}

export function partnerSecret(): string {
  const s = process.env.FORMMY_PARTNER_SECRET_GHOSTY;
  if (!s) throw new Error("FORMMY_PARTNER_SECRET_GHOSTY no configurado");
  return s;
}

/**
 * POST firmado a Formmy: HMAC-SHA256 sobre `${timestamp}.${rawBody}`.
 *
 * Es el MISMO esquema que la firma de partner gs↔Teams, y por la misma razón: el
 * cuerpo se firma en crudo, así que hay que serializarlo UNA vez y mandar ese
 * string exacto (re-serializar cambiaría el orden de las llaves y la firma).
 */
async function signedPartnerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", partnerSecret())
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return fetch(`${formmyBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-Id": PARTNER_ID,
      "X-Partner-Timestamp": timestamp,
      "X-Partner-Signature": signature,
    },
    body: rawBody,
  });
}

/**
 * Secreto del canal, generado por nosotros y propagado a Formmy, que lo guarda como
 * `Integration.externalAgentSecret`. Autentica en LOS DOS sentidos: Formmy lo manda
 * como Bearer al entregarnos un mensaje, y nosotros lo mandamos como Bearer al
 * pedirle que envíe uno.
 */
export function generateChannelSecret(): string {
  return randomBytes(24).toString("hex");
}

// ── Envío ────────────────────────────────────────────────────────────────────────
// El envío NO va firmado como partner: va con el `channelSecret` de ESE número como
// Bearer, que es lo que `/api/v1/integrations/whatsapp/send` valida. Son dos
// credenciales distintas (partner = abrir un pairing; channel = operar ese número) y
// confundirlas da 401 sin más pista que el prefijo en los logs de Formmy.

/** Un texto de agente → las burbujas que se mandan. Ver `splitBubbles`. */
export type WaSendResult = { sent: number; failed: number };

/**
 * Parte la respuesta en burbujas por párrafo.
 *
 * ⚠️ Existe porque dejar que el otro lado parta un texto multi-párrafo ya truncó un
 * mensaje real a `"00 PM."` (incidente de nanoclaw, 2026-05-18). Partimos nosotros y
 * mandamos cada trozo como un mensaje completo.
 *
 * El tope de 4000 es el límite de Meta (4096) con holgura: pasado eso el endpoint no
 * valida nada y devuelve el error crudo de Meta.
 */
export function splitBubbles(text: string, max = 4000): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const t = chunk.trim();
    if (!t) continue;
    // Un párrafo más largo que el tope se parte por líneas antes que a mitad de palabra.
    if (t.length <= max) { out.push(t); continue; }
    let buf = "";
    for (const line of t.split("\n")) {
      if (buf && buf.length + line.length + 1 > max) { out.push(buf); buf = ""; }
      buf = buf ? `${buf}\n${line}` : line;
      while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * Quita lo que el agente marcó como interno.
 *
 * DETERMINISTA y en el único punto de salida, nunca por prompt: el turno siempre
 * devuelve algo y el canal manda lo que reciba. Es la misma conclusión a la que
 * llegaron nanoclaw y easybits después de filtrar bloques de análisis a clientes reales.
 */
export function stripInternal(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/gi, "")
    .replace(/```gt-(?:tools|steps)[\s\S]*?```/g, "")
    .trim();
}

/** Envía un texto por WhatsApp, en burbujas. Devuelve cuántas salieron y cuántas no. */
export async function sendWaText(a: {
  integrationId: string;
  channelSecret: string;
  phone: string;
  text: string;
}): Promise<WaSendResult> {
  const bubbles = splitBubbles(stripInternal(a.text));
  let sent = 0;
  let failed = 0;
  for (const body of bubbles) {
    try {
      const res = await fetch(`${formmyBaseUrl()}/api/v1/integrations/whatsapp/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.channelSecret}` },
        body: JSON.stringify({
          phone_number: a.phone,
          integration_id: a.integrationId,
          type: "text",
          text: body,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`send ${res.status}`);
      sent++;
    } catch (e) {
      // Se sigue con las siguientes: media respuesta entregada es mejor que ninguna, y
      // abortar dejaría al cliente con una frase cortada sin explicación.
      failed++;
      console.error("[wa] send failed", String(e).slice(0, 200));
    }
  }
  return { sent, failed };
}

/**
 * Acuse de lectura (👀) y "escribiendo…", en UNA sola llamada.
 *
 * Best-effort absoluto: si falla, el cliente sólo se queda sin el indicador. Nunca debe
 * impedir que la respuesta salga.
 */
export async function markWaRead(a: {
  integrationId: string;
  channelSecret: string;
  phone: string;
  messageId: string;
  typing?: boolean;
}): Promise<void> {
  // Sin el wamid real de Meta no hay nada que marcar (los ids sintéticos no valen).
  if (!a.messageId) return;
  await fetch(`${formmyBaseUrl()}/api/v1/integrations/whatsapp/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.channelSecret}` },
    body: JSON.stringify({
      phone_number: a.phone,
      integration_id: a.integrationId,
      type: "read",
      message_id: a.messageId,
      typing: a.typing ?? true,
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

/** Contexto del provision: se persiste en Formmy ANTES de abrir el wizard de Meta. */
export type PairingContext = {
  /** A dónde entrega Formmy los mensajes. Le pega `/message` al final. */
  externalAgentUrl: string;
  channelSecret: string;
  /** Correo del dueño que conecta — sólo para identificar la integración en Formmy. */
  email: string;
  /** Namespace del workspace, para reconocer la integración desde el panel de Formmy. */
  denikOrgId: string;
};

export type PairingStatus = {
  /** pending | completed | failed | expired */
  status: string;
  integrationId?: string | null;
  phoneNumber?: string | null;
  phoneNumberId?: string | null;
  error?: string | null;
};

/**
 * Abre una sesión de pairing y devuelve el `pairingId` que viaja en la URL del wizard.
 *
 * ⚠️ Vamos por sesión y NO por el `code` del navegador. El `code` de Meta caduca en
 * segundos: si el popup muere, el usuario completó el wizard entero para nada. Con
 * sesión, Formmy provisiona server-side al terminar y nosotros recogemos el resultado
 * cuando podamos — incluso en otra pestaña o después de un refresh.
 */
export async function createPairingSession(context: PairingContext): Promise<string> {
  const res = await signedPartnerPost("/api/v1/partners/whatsapp/pairing", {
    intent: "create",
    context,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`No se pudo abrir la sesión de pairing (${res.status}): ${body}`);
  }
  const out = (await res.json().catch(() => ({}))) as { pairingId?: string };
  if (!out.pairingId) throw new Error("Formmy no devolvió pairingId");
  return out.pairingId;
}

/** Consulta el resultado de una sesión de pairing. Idempotente, re-consultable. */
export async function getPairingSession(pairingId: string): Promise<PairingStatus> {
  const res = await signedPartnerPost("/api/v1/partners/whatsapp/pairing", {
    intent: "get",
    pairingId,
  });
  const out = (await res.json().catch(() => ({}))) as PairingStatus;
  if (!res.ok) throw new Error(out?.error || `Consulta de pairing falló (${res.status})`);
  return out;
}
