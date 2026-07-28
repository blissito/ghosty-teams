// Web Push (VAPID). La pública es pública (va al cliente); la privada es secret
// (env VAPID_PRIVATE_KEY, inyectada en secrets.env). Notifica cuando te taggean.
import webpush from "web-push";

// Par VAPID vigente (2026-07-27). La private (VAPID_PRIVATE_KEY) va en secrets.env
// del box de Teams. Rotado porque la private del par anterior (2026-07-22) NO se
// copió al secrets.env de la caja nueva en la migración al template ghosty-teams
// (2026-07-26) y no quedó guardada en ningún lado → se perdió. Durante ese lapso
// `ensureConfigured()` devolvía false y NINGÚN push salía, sin una sola línea de
// log (de ahí el warn de abajo). Rotar ambas juntas: cambiar la public aquí
// invalida las subs viejas → los clientes re-suscriben (ver push-subscribe.ts).
export const VAPID_PUBLIC_KEY =
  "BP7OAwI8kXpE9BNcjg27A5WKtl7wHJQqg42VrgWS_Gyh3QZVLS8emm8XFKqMFqx85b7zt5WivZ0PxKJqb-lKQCA";

let configured = false;
let warnedMissing = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) {
    // Una sola línea por proceso, pero que EXISTA: sin esto un secreto que no se
    // copió al recrear la caja apaga todas las notificaciones en silencio y no deja
    // rastro (pasó del 2026-07-26 al 27; se diagnosticó leyendo /proc/PID/environ).
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[push] DESACTIVADO: falta VAPID_PRIVATE_KEY en el env — ningún push saldrá");
    }
    return false;
  }
  webpush.setVapidDetails("mailto:hola@easybits.cloud", VAPID_PUBLIC_KEY, priv);
  configured = true;
  return true;
}

export type PushSub = { endpoint: string; p256dh: string; auth: string };
// `badge` = total de no-leídos del destinatario (el SW lo pone en el ícono del PWA);
// `tag` estable + `close` permiten retirar una notificación viva (llamada terminada).
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  kind?: string;
  tag?: string;
  badge?: number;
  close?: boolean;
};

// Envía a una suscripción. Devuelve "gone" si el endpoint ya no existe (404/410)
// para que el caller la borre.
export async function sendPush(
  sub: PushSub,
  payload: PushPayload,
  opts?: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high" }
): Promise<"ok" | "gone" | "error"> {
  if (!ensureConfigured()) return "error";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: opts?.ttl ?? 60 * 60 * 24, urgency: opts?.urgency ?? "normal" }
    );
    return "ok";
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? "gone" : "error";
  }
}
