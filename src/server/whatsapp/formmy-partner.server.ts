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
