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

export async function notify(ev: NotifyEvent, ns: string): Promise<void> {
  if (!ev.recipients.length) return;
  // Best-effort y en paralelo: un canal que falle no tumba a los demás.
  await Promise.allSettled([deliverWebPush(ev), deliverEmail(ev, ns)]);
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

// Canal: Email (AWS SES). Estilo Slack/Zulip: SOLO se envía correo a quien está
// OFFLINE (sin pestaña conectada) — si estás online, el toast/push ya te avisó. Sin
// creds SES → no-op. TODO: gc_notify_prefs (opt-out por usuario) + digest/agrupación.
async function deliverEmail(ev: NotifyEvent, ns: string): Promise<void> {
  const { sesConfigured, sendSesEmail } = await import("./ses.server");
  if (!sesConfigured()) return;
  const { isOnline } = await import("./bus.server");
  const offline = ev.recipients.filter((sub) => !isOnline(ns, sub));
  if (!offline.length) return;
  const db = await import("../db.server");
  const people = await db.emailsForSubs(offline);
  if (!people.length) return;
  const base = process.env.PUBLIC_BASE_URL || process.env.TEAMS_ROOT_DOMAIN || "https://teams.ghosty.studio";
  const link = ev.url.startsWith("http") ? ev.url : `${base}${ev.url}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px">
    <h2 style="margin:0 0 8px">${escapeHtml(ev.title)}</h2>
    <p style="color:#444;white-space:pre-wrap">${escapeHtml(ev.body)}</p>
    <p style="margin-top:16px"><a href="${link}" style="background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Abrir en Ghosty Teams</a></p>
  </div>`;
  // Un envío por persona (To individual → no filtra los emails entre destinatarios).
  await Promise.allSettled(people.map((p) => sendSesEmail({ to: p.email, subject: ev.title, html })));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
