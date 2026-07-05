// Web Push (VAPID). La pública es pública (va al cliente); la privada es secret
// (env VAPID_PRIVATE_KEY, inyectada en secrets.env). Notifica cuando te taggean.
import webpush from "web-push";

export const VAPID_PUBLIC_KEY =
  "BF9hOvpvzJcxOag4jrpOmDgeOU0DRh7oLF8-fn7bqVasjb_g99W9QZ5oTHXd15NAIHdjSAf-GswdpQbBfkpp8wo";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) return false;
  webpush.setVapidDetails("mailto:hola@easybits.cloud", VAPID_PUBLIC_KEY, priv);
  configured = true;
  return true;
}

export type PushSub = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; url: string };

// Envía a una suscripción. Devuelve "gone" si el endpoint ya no existe (404/410)
// para que el caller la borre.
export async function sendPush(sub: PushSub, payload: PushPayload): Promise<"ok" | "gone" | "error"> {
  if (!ensureConfigured()) return "error";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "ok";
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? "gone" : "error";
  }
}
