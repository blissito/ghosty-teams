// ── Capa agnóstica de notificaciones ────────────────────────────────────────
// UN solo punto de fan-out a los "canales de entrega". Misma filosofía que el bus
// realtime: las features llaman notify() y NO saben por dónde llega. Hoy entrega
// por Web Push (PWA). Añadir email (Resend/SMTP), Slack, etc. = rellenar un
// deliver* nuevo aquí, SIN tocar a los llamadores (notifyMentions, DMs, …).
//
// Referencia Zulip: notifica por push y por email según preferencias del usuario
// (típicamente "solo si estás offline/idle"). Ese gating vivirá aquí (un solo
// lugar), no disperso por cada feature.

export type NotifyKind = "mention" | "dm" | "call" | "call-end" | "reminder";
export type NotifyEvent = {
  kind: NotifyKind;
  recipients: string[]; // user subs a notificar (el emisor ya viene excluido)
  title: string;
  body: string;
  url: string;
  // Tag estable (hoy: `call:<callId>`) para poder REEMPLAZAR o RETIRAR la notificación.
  tag?: string;
  /** El destinatario pidió correo para ESTE aviso → ignora el toggle global. */
  forceEmail?: boolean;
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
  const tally = { ok: 0, gone: 0, error: 0 };
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
      tally[r]++;
      if (r === "gone") await db.deletePushSub(s.endpoint);
    })
  );
  // Traza del fan-out: `error` sistemático = el canal está roto (VAPID ausente, VAPID
  // mal pareado con las subs, red). Antes se descartaba y no había cómo notarlo.
  console.log(`[push ${ev.kind}] subs=${stored.length} ok=${tally.ok} gone=${tally.gone} error=${tally.error}`);
}

// Canal: Email (AWS SES). Estilo Slack/Zulip: SOLO se envía correo a quien está
// OFFLINE (sin pestaña conectada) — si estás online, el toast/push ya te avisó. Sin
// creds SES → no-op. TODO: gc_notify_prefs (opt-out por usuario) + digest/agrupación.
async function deliverEmail(ev: NotifyEvent, ns: string): Promise<void> {
  const { sesConfigured, sendSesEmail } = await import("./ses.server");
  if (!sesConfigured()) return;
  const { isOnline } = await import("./bus.server");
  // Regla normal (Slack/Zulip): correo SOLO a quien está offline — si tienes la pestaña
  // abierta ya te avisó el toast. Un correo PEDIDO se manda igual: lo pediste tú, y que
  // llegue o no según dónde tengas el foco sería impredecible.
  const offline = ev.forceEmail ? ev.recipients : ev.recipients.filter((sub) => !isOnline(ns, sub));
  if (!offline.length) return;
  const db = await import("../db.server");
  // `forceEmail`: el usuario dijo QUE SÍ para ESTE aviso en concreto (p.ej. al programar
  // un recordatorio). Es consentimiento explícito y puntual, así que se salta el toggle
  // global — que es una preferencia por default, no una negativa expresa.
  const people = ev.forceEmail ? await db.emailsForSubsAny(offline) : await db.emailsForSubs(offline);
  if (!people.length) return;
  const html = emailHtml(ev);
  // Un envío por persona (To individual → no filtra los emails entre destinatarios).
  await Promise.allSettled(people.map((p) => sendSesEmail({ to: p.email, subject: ev.title, html })));
}

/**
 * Plantilla de correo de Ghosty Teams. UNA sola, para menciones, DMs y recordatorios:
 * dos correos del mismo producto que se ven distinto se leen como dos productos.
 *
 * Tabla y estilos EN LÍNEA a propósito — Gmail borra el `<style>` del head y Outlook no
 * entiende flex; una tabla centrada es lo único que se ve igual en los dos.
 */
export function emailHtml(ev: NotifyEvent): string {
  const base = process.env.PUBLIC_BASE_URL || process.env.TEAMS_ROOT_DOMAIN || "https://teams.ghosty.studio";
  const link = ev.url.startsWith("http") ? ev.url : `${base}${ev.url}`;
  const cta = ev.kind === "reminder" ? "Abrir la conversación" : "Abrir en Ghosty Teams";
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f5f5f7">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6ea;border-radius:14px">
    <tr><td style="padding:22px 26px 0">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:9px"><img src="${base}/ghosty-192.png" width="26" height="26" alt="" style="display:block;border:0;border-radius:7px"></td>
        <td style="font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#6b6b76;letter-spacing:.02em">Ghosty Teams</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:12px 26px 0">
      <div style="font:600 19px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#16161a">${escapeHtml(ev.title)}</div>
    </td></tr>
    <tr><td style="padding:10px 26px 0">
      <div style="font:400 15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#3f3f46;white-space:pre-wrap">${escapeHtml(ev.body)}</div>
    </td></tr>
    <tr><td style="padding:22px 26px 26px">
      <a href="${link}" style="display:inline-block;background:#16161a;color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;padding:12px 18px;border-radius:9px;text-decoration:none">${cta}</a>
    </td></tr>
    <tr><td style="padding:0 26px 22px">
      <div style="border-top:1px solid #eeeef2;padding-top:14px;font:400 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94">
        Recibes este correo porque lo activaste en Ghosty Teams. Puedes apagarlo en Ajustes → Notificaciones.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
