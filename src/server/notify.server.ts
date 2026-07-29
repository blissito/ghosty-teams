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
  // Best-effort y en paralelo: un canal que falle no tumba a los demás. Los rechazos se
  // LOGUEAN: `allSettled` los descarta, y un canal roto en silencio no se nota nunca.
  const r = await Promise.allSettled([deliverWebPush(ev, ns), deliverEmail(ev, ns)]);
  r.forEach((x, i) => {
    if (x.status === "rejected") console.warn(`[notify ${ev.kind}] canal ${i === 0 ? "push" : "email"} falló:`, String(x.reason).slice(0, 200));
  });
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
  const mascot = mascotInline();
  const html = emailHtml(ev, !!mascot);
  // Un envío por persona (To individual → no filtra los emails entre destinatarios).
  const out = await Promise.allSettled(
    people.map((p) =>
      sendSesEmail({ to: p.email, subject: ev.title, html, text: emailText(ev), inline: mascot ? [mascot] : undefined })
    )
  );
  // Traza, igual que el fan-out de push: notify() envuelve todo en allSettled, así que sin
  // esto un correo que no sale es INDISTINGUIBLE de uno que sí — que es exactamente donde
  // nos atoramos el 2026-07-29 (SES aceptaba los envíos directos y los de la app no
  // aparecían por ningún lado).
  const ok = out.filter((r) => r.status === "fulfilled" && r.value === true).length;
  const err = out.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  console.log(`[email ${ev.kind}] to=${people.length} ok=${ok}${err ? ` err=${String(err.reason).slice(0, 120)}` : ""}`);
}

/**
 * Plantilla de correo de Ghosty Teams. UNA sola, para menciones, DMs y recordatorios:
 * dos correos del mismo producto que se ven distinto se leen como dos productos.
 *
 * Tabla y estilos EN LÍNEA a propósito — Gmail borra el `<style>` del head y Outlook no
 * entiende flex; una tabla centrada es lo único que se ve igual en los dos.
 */
/**
 * El mismo correo a direcciones SUELTAS (no miembros del workspace). Lo usan los
 * recordatorios con copia: "recuérdame facturar y mándaselo también a brenda@…".
 *
 * No pasa por preferencias ni por el filtro de conectados: son direcciones que el dueño
 * del recordatorio escribió a mano, una por una. Devuelve cuántas salieron.
 */
export async function sendEmailTo(addresses: string[], ev: NotifyEvent): Promise<number> {
  const { sesConfigured, sendSesEmail } = await import("./ses.server");
  if (!sesConfigured() || !addresses.length) return 0;
  const mascot = mascotInline();
  const html = emailHtml(ev, !!mascot);
  const out = await Promise.allSettled(
    addresses.map((to) =>
      sendSesEmail({ to, subject: ev.title, html, text: emailText(ev), inline: mascot ? [mascot] : undefined })
    )
  );
  const ok = out.filter((r) => r.status === "fulfilled" && r.value === true).length;
  console.log(`[email ${ev.kind}·copia] to=${addresses.length} ok=${ok}`);
  return ok;
}

/**
 * El mascot como imagen INCRUSTADA (cid:), leído del disco una sola vez.
 *
 * Enlazarlo costaba una petición al abrir el correo —500ms medidos, casi todo handshake
 * TLS contra OVH— para traer 1.5KB. Incrustado no hay red, funciona sin conexión y no
 * depende de que el destinatario acepte "mostrar imágenes de este remitente".
 * Si el archivo no está (build sin public), se cae al enlace de siempre.
 */
let mascotCache: { cid: string; bytes: Buffer; mime: string; fileName: string } | null | undefined;
function mascotInline() {
  if (mascotCache !== undefined) return mascotCache;
  mascotCache = null;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const dir of [".output/public", "public", "build/client"]) {
      const p = path.resolve(process.cwd(), dir, "mascot-mail.png");
      if (fs.existsSync(p)) {
        mascotCache = { cid: "mascot", bytes: fs.readFileSync(p), mime: "image/png", fileName: "mascot.png" };
        break;
      }
    }
  } catch { /* sin disco → enlace remoto */ }
  return mascotCache;
}

export function emailHtml(ev: NotifyEvent, inlineMascot = false): string {
  // `TEAMS_ROOT_DOMAIN` es un dominio PELADO ("teams.ghosty.studio"): concatenarlo daba
  // `teams.ghosty.studio/ghosty-192.png`, que el cliente de correo lee como relativa → el
  // mascot salía roto y el botón apuntaba a ningún lado.
  const raw = process.env.PUBLIC_BASE_URL || process.env.TEAMS_ROOT_DOMAIN || "teams.ghosty.studio";
  const base = /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : `https://${raw.replace(/\/$/, "")}`;
  const link = ev.url.startsWith("http") ? ev.url : `${base}${ev.url}`;
  // Las IMÁGENES no pueden colgar del dominio del tenant: `teams.ghosty.studio` a secas no
  // resuelve (sólo los subdominios de workspace), así que el mascot llegaba roto. Van al
  // control-plane, que sí es un host público estable.
  const asset = (process.env.PUBLIC_ASSET_BASE || "https://www.ghosty.studio").replace(/\/$/, "");
  const cta = ev.kind === "reminder" ? "Abrir la conversación" : "Abrir en Ghosty Studio";
  // TÍTULO propio, en su renglón. En un recordatorio el asunto genérico ("⏰ Recordatorio")
  // no dice nada: lo que el usuario reconoce es SU texto. Se parte por el guión largo o el
  // primer salto de línea —así es como la gente escribe "Título — detalle"— y si no hay
  // corte natural, el texto entero es el título.
  const { head, rest } = ev.kind === "reminder" ? splitHead(ev.body) : { head: ev.title, rest: ev.body };
  return `<!doctype html><html><body style="margin:0;padding:28px 12px;background:#f5f5f7">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;margin:0 auto;background:#f4f4f7;border:1px solid #e6e6ea;border-radius:16px">
    <tr><td style="padding:22px 24px 0;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94;letter-spacing:.02em">Ghosty Studio</td></tr>

    <!-- Ghosty HABLANDO: mascot + globo de cómic. Dos celdas de tabla (no flex: Outlook no
         lo entiende). Se usa mascot-mail.png (112×132, el doble del tamaño en que se pinta) y NO mascot.png ni los íconos del PWA: ésos traen
         el fondo oscuro horneado y sobre la tarjeta clara se veían como un cuadro negro.
         La colita del globo va con el truco de bordes — si algún cliente la
         descarta, queda un globo sin colita, que se ve bien igual. -->
    <tr><td style="padding:16px 24px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="64" valign="top" style="padding-right:2px">
          <img src="${inlineMascot ? "cid:mascot" : `${asset}/mascot-mail.png`}" width="56" height="66" alt="Ghosty" style="display:block;border:0">
        </td>
        <td valign="top" style="padding-top:6px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td valign="top" style="padding-top:14px">
              <div style="width:0;height:0;border-top:7px solid transparent;border-bottom:7px solid transparent;border-right:10px solid #ffffff;font-size:0;line-height:0">&nbsp;</div>
            </td>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;border-radius:16px">
                <tr><td style="padding:14px 18px">
                  <div style="font:700 20px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#16161a">${escapeHtml(head)}</div>${rest ? `
                  <div style="margin-top:6px;font:400 15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#3f3f46;white-space:pre-wrap">${escapeHtml(rest)}</div>` : ""}
                </td></tr>
              </table>
            </td>
          </tr></table>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:20px 24px 26px 90px">
      <a href="${link}" style="display:inline-block;background:#16161a;color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;padding:12px 18px;border-radius:9px;text-decoration:none">${cta}</a>
    </td></tr>
    <tr><td style="padding:0 24px 22px">
      <div style="border-top:1px solid #e2e2e8;padding-top:14px;font:400 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#8a8a94">
        Recibes este correo porque lo activaste en Ghosty Studio. Puedes apagarlo en Ajustes → Notificaciones.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

/** La misma información sin adornos, para el text/plain. */
function emailText(ev: NotifyEvent): string {
  const base = (process.env.PUBLIC_BASE_URL || process.env.TEAMS_ROOT_DOMAIN || "teams.ghosty.studio").replace(/\/$/, "");
  const link = ev.url.startsWith("http") ? ev.url : `https://${base.replace(/^https?:\/\//, "")}${ev.url}`;
  return `${ev.title}\n\n${ev.body}\n\n${link}\n\n—\nGhosty Studio · puedes apagar estos correos en Ajustes → Notificaciones.`;
}

/** "Título — detalle" o "Título\ndetalle" → sus dos partes. Sin corte natural, todo es título. */
function splitHead(text: string): { head: string; rest: string } {
  const t = (text || "").trim();
  const m = /^(.{3,70}?)\s+—\s+([\s\S]+)$/.exec(t) || /^(.{3,70})\n+([\s\S]+)$/.exec(t);
  return m ? { head: m[1].trim(), rest: m[2].trim() } : { head: t, rest: "" };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
