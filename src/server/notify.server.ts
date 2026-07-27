// ── Capa agnóstica de notificaciones ────────────────────────────────────────
// UN solo punto de fan-out a los "canales de entrega". Misma filosofía que el bus
// realtime: las features llaman notify() y NO saben por dónde llega. Hoy entrega
// por Web Push (PWA). Añadir email (Resend/SMTP), Slack, etc. = rellenar un
// deliver* nuevo aquí, SIN tocar a los llamadores (notifyMentions, DMs, …).
//
// Referencia Zulip: notifica por push y por email según preferencias del usuario
// (típicamente "solo si estás offline/idle"). Ese gating vivirá aquí (un solo
// lugar), no disperso por cada feature.

export type NotifyKind = "mention" | "dm" | "call" | "call-end";
export type NotifyEvent = {
  kind: NotifyKind;
  recipients: string[]; // user subs a notificar (el emisor ya viene excluido)
  title: string;
  body: string;
  url: string;
  // Tag estable (hoy: `call:<callId>`) para poder REEMPLAZAR o RETIRAR la notificación.
  tag?: string;
};

export async function notify(ev: NotifyEvent, ns: string): Promise<void> {
  if (!ev.recipients.length) return;
  // "call-end" sólo retira la notificación de llamada que ya está en pantalla: ni
  // email ni banner nuevo.
  if (ev.kind === "call-end") return void (await deliverWebPush(ev, ns).catch(() => {}));
  // Best-effort y en paralelo: un canal que falle no tumba a los demás.
  await Promise.allSettled([deliverWebPush(ev, ns), deliverEmail(ev, ns)]);
}

// Canal: Web Push (PWA). Ya operativo (VAPID + gc_push_subs).
async function deliverWebPush(ev: NotifyEvent, ns: string): Promise<void> {
  const db = await import("../db.server");
  const push = await import("../push.server");
  const isCall = ev.kind === "call" || ev.kind === "call-end";
  // Sin doble aviso (criterio de Slack/Zulip): a quien tiene una pestaña conectada ya le
  // avisa el cliente —toast si mira, notificación del SW si está oculta— así que el push
  // es SOLO para quien no está. Las llamadas se saltan el filtro: una pestaña en segundo
  // plano puede tener el audio silenciado y el timbre pasa desapercibido.
  const { isOnline } = await import("./bus.server");
  const recipients = isCall ? ev.recipients : ev.recipients.filter((sub) => !isOnline(ns, sub));
  if (!recipients.length) return;
  const stored = await db.listPushSubsForUsers(recipients);
  if (!stored.length) return;
  // El badge del ícono del PWA se calcula POR DESTINATARIO (es su total de no-leídos)
  // → una query por persona, no por suscripción. Con la app cerrada este es el único
  // camino para que el número del ícono suba (la página no corre).
  const badges = new Map<string, number>();
  if (!isCall) {
    await Promise.all(
      recipients.map(async (sub) => {
        try {
          const [rooms, dms] = await Promise.all([db.unreadByRoom(sub), db.unreadByDm(sub)]);
          const total = [...rooms, ...dms].reduce((a, r) => a + r.unread, 0);
          badges.set(sub, total);
        } catch {
          /* el badge es cosmético: si falla, la notificación igual sale */
        }
      })
    );
  }
  await Promise.all(
    stored.map(async (s) => {
      const payload = {
        title: ev.title,
        body: ev.body,
        url: ev.url,
        kind: ev.kind,
        ...(ev.tag ? { tag: ev.tag } : {}),
        ...(ev.kind === "call-end" ? { close: true } : {}),
        ...(badges.has(s.user_sub) ? { badge: badges.get(s.user_sub) } : {}),
      };
      // Una llamada caduca: TTL corto para que no aparezca "te llaman" 20 min después,
      // y urgency alta para saltarse el ahorro de batería del navegador.
      const r = await push.sendPush(
        s,
        payload,
        isCall ? { ttl: 45, urgency: "high" as const } : undefined
      );
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
