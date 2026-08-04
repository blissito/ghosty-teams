// ── Capa agnóstica de notificaciones ────────────────────────────────────────
// UN solo punto de fan-out a los "canales de entrega". Misma filosofía que el bus
// realtime: las features llaman notify() y NO saben por dónde llega. Hoy entrega
// por Web Push (PWA). Añadir email (Resend/SMTP), Slack, etc. = rellenar un
// deliver* nuevo aquí, SIN tocar a los llamadores (notifyMentions, DMs, …).
//
// Referencia Zulip: notifica por push y por email según preferencias del usuario
// (típicamente "solo si estás offline/idle"). Ese gating vivirá aquí (un solo
// lugar), no disperso por cada feature.

// "form" = alguien de FUERA respondió un formulario de intake. Es el único aviso que no
// nace de una persona del workspace, y por eso importa que llegue sin tener la pestaña
// abierta: nadie está esperando ese mensaje.
// "turn" = tu agente terminó. Va sólo a quien lo pidió; `notify` ya salta el push si esa
// persona está online, así que llega justo cuando hace falta: cuando te fuiste.
export type NotifyKind = "mention" | "dm" | "call" | "call-end" | "reminder" | "form" | "turn";
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
  const { html, text, inline } = await armar(ev);
  // Un envío por persona (To individual → no filtra los emails entre destinatarios).
  const out = await Promise.allSettled(
    people.map((p) =>
      sendSesEmail({ to: p.email, subject: ev.title, html, text, inline })
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
  const { html, text, inline } = await armar(ev);
  const out = await Promise.allSettled(
    addresses.map((to) =>
      sendSesEmail({ to, subject: ev.title, html, text, inline })
    )
  );
  const ok = out.filter((r) => r.status === "fulfilled" && r.value === true).length;
  console.log(`[email ${ev.kind}·copia] to=${addresses.length} ok=${ok}`);
  return ok;
}

import { ghostyEmail, mascotInline, publicBase, splitHead } from "./email-template.server";

/**
 * `NotifyEvent` → la plantilla oficial (`email-template.server.ts`). Este archivo ya no
 * dibuja HTML: el globo de cómic, el mascot incrustado y el pie viven en un solo sitio para
 * que Ghosty suene igual escriba por donde escriba.
 *
 * El `inlineMascot` que se pasaba antes desapareció: la plantilla devuelve el `inline` junto
 * al html, que es lo que evita el fallo silencioso de mandar uno sin el otro.
 */
export async function emailHtml(ev: NotifyEvent): Promise<string> {
  return (await armar(ev)).html;
}

async function armar(ev: NotifyEvent) {
  // TÍTULO propio, en su renglón. En un recordatorio el asunto genérico ("⏰ Recordatorio")
  // no dice nada: lo que el usuario reconoce es SU texto. Se parte por el guión largo o el
  // primer salto de línea —así es como la gente escribe "Título — detalle"— y si no hay
  // corte natural, el texto entero es el título.
  const { head, rest } = ev.kind === "reminder" ? splitHead(ev.body) : { head: ev.title, rest: ev.body };
  // ⚠️ Éste es el idioma de QUIEN DISPARÓ el aviso, no el de quien lo recibe: no guardamos
  // una preferencia de idioma por usuario (el locale vive en una cookie de su navegador).
  // En un workspace que trabaja en un idioma coinciden; en uno mixto, no. Para arreglarlo
  // de verdad hace falta una columna en gc_users, y entonces se lee del destinatario.
  const { currentLocale } = await import("./locale.server");
  const { translate } = await import("../i18n.core");
  const locale = await currentLocale();
  return ghostyEmail({
    head,
    body: rest,
    cta: {
      label: translate(locale, ev.kind === "reminder" ? "Abrir la conversación" : "Abrir en Ghosty Studio"),
      url: ev.url,
    },
    // Siempre a gente del workspace: estos avisos nacen de su propia actividad, y su pie
    // lleva la ruta para apagarlos.
    footer: "workspace",
    locale,
  });
}

export { publicBase, mascotInline };
