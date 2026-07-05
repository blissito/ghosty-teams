// ── Capa agnóstica de notificaciones ────────────────────────────────────────
// UN solo punto de fan-out a los "canales de entrega". Misma filosofía que el bus
// realtime: las features llaman notify() y NO saben por dónde llega. Hoy entrega
// por Web Push (PWA). Añadir email (Resend/SMTP), Slack, etc. = rellenar un
// deliver* nuevo aquí, SIN tocar a los llamadores (notifyMentions, DMs, …).
//
// Referencia Zulip: notifica por push y por email según preferencias del usuario
// (típicamente "solo si estás offline/idle"). Ese gating vivirá aquí (un solo
// lugar), no disperso por cada feature.

export type NotifyKind = "mention" | "dm";
export type NotifyEvent = {
  kind: NotifyKind;
  recipients: string[]; // user subs a notificar (el emisor ya viene excluido)
  title: string;
  body: string;
  url: string;
};

export async function notify(ev: NotifyEvent): Promise<void> {
  if (!ev.recipients.length) return;
  // Best-effort y en paralelo: un canal que falle no tumba a los demás.
  await Promise.allSettled([deliverWebPush(ev), deliverEmail(ev)]);
}

// Canal: Web Push (PWA). Ya operativo (VAPID + gc_push_subs).
async function deliverWebPush(ev: NotifyEvent): Promise<void> {
  const db = await import("../db.server");
  const push = await import("../push.server");
  const stored = await db.listPushSubsForUsers(ev.recipients);
  if (!stored.length) return;
  const payload = { title: ev.title, body: ev.body, url: ev.url };
  await Promise.all(
    stored.map(async (s) => {
      const r = await push.sendPush(s, payload);
      if (r === "gone") await db.deletePushSub(s.endpoint);
    })
  );
}

// Canal: Email (seam). Se activa cuando haya proveedor + preferencias de usuario.
// Punto único para: resolver emails (gc_users), respetar "solo si offline/idle"
// (consultar bus.onlineUsers()) y las preferencias por-usuario, y enviar. Hoy no-op.
async function deliverEmail(_ev: NotifyEvent): Promise<void> {
  // TODO(email): proveedor (Resend/SMTP) + gc_notify_prefs + gate por presencia.
}
