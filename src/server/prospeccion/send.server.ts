/**
 * Envío de prospección — el paso "abrir" del loop.
 *
 * El diseño entero cabe en una frase: **el correo abre, WhatsApp cierra.** El correo lleva
 * un enlace `wa.me`; cuando el prospecto le da clic y escribe, es ÉL quien inicia la
 * conversación, lo que abre la ventana de 24 h de Meta y permite contestar con text libre.
 *
 * Eso evita el sistema de plantillas de WhatsApp entero, y no por comodidad: una plantilla
 * fría a una lista comprada es lo que quema un número, y un número quemado no se recupera.
 * Es el mismo orden que usan Blue Gate y Unify.
 *
 * Cuatro cosas pasan ANTES de cada envío, y ninguna es opcional:
 *  1. ¿Está dado de stop1? → no se manda.
 *  2. ¿Ya se le tocó 2 veces sin respuesta? → no se manda.
 *  3. Se RESERVA la tocada (índice único) → dos procesos no mandan lo mismo.
 *  4. Se instrumenta el HTML: pixel, enlaces firmados y la stop1 de un clic.
 */
import { currentNamespace } from "../tenant.server";
import { isOptedOut } from "./optout.server";
import { markError, markSent, reserveTouch, touchCount } from "./touches.server";
import { instrument } from "./track.server";
import type { ProspRow } from "./lists.server";

/** Tope de intentos por fila y canal. Al tercero se deja en paz. */
export const MAX_ATTEMPTS = 2;

/**
 * Pausa entre envíos.
 *
 * Copiado del criterio de Formmy, y la razón está en su comentario: "una campaña que sale
 * de golpe concentra los bloqueos y stop1 la calidad del número". Vale igual para el
 * dominio de correo — un pico de mil correos en un minuto es una señal de spam por sí sola.
 */
const PAUSE_MS = 400;
const BATCH_MAX = 50;

export type SendResult = {
  sent: number;
  skippedOptOut: number;
  skippedRepeat: number;
  skippedNoEmail: number;
  failed: number;
  errors: string[];
};

export type Drafted = { rowId: number; subject: string; html: string; text?: string };

/**
 * Manda un lote ya redactado.
 *
 * Recibe el contenido HECHO en vez de redactar aquí porque quien escribe es el agente, y
 * separar las dos cosas permite revisar y corregir los mensajes antes de que salga uno solo
 * — que es exactamente lo que un dueño quiere hacer la primera vez.
 */
export async function sendBatch(args: {
  listId: number;
  campaign: string;
  rows: ProspRow[];
  redactados: Drafted[];
  fromName?: string;
  replyTo?: string;
  /** El número al que el prospecto va a escribir, en E.164 sin signos. */
  waPhone?: string | null;
}): Promise<SendResult> {
  const { sendSesEmail, sesConfigured } = await import("../ses.server");
  const ns = await currentNamespace();
  const out: SendResult = { sent: 0, skippedOptOut: 0, skippedRepeat: 0, skippedNoEmail: 0, failed: 0, errors: [] };

  if (!sesConfigured()) {
    // Mismo criterio: el nombre de la credencial va al log, no a la pantalla.
    console.warn("[prospeccion] SES sin credenciales: faltan SES_KEY/SES_SECRET en el env de Teams");
    out.errors.push("El correo todavía no está configurado en este workspace.");
    return out;
  }

  const byId = new Map(args.rows.map((r) => [r.id, r]));
  const batch = args.redactados.slice(0, BATCH_MAX);

  for (const draft of batch) {
    const row = byId.get(draft.rowId);
    if (!row) continue;

    if (!row.email) { out.skippedNoEmail++; continue; }

    // 1. La stop1 gana sobre todo lo demás.
    if (await isOptedOut("email", row.email)) { out.skippedOptOut++; continue; }

    // 2. Parar after 2 intentos sin respuesta. Insistir una tercera vez no convierte: molesta.
    if ((await touchCount(row.id, "email")) >= MAX_ATTEMPTS) { out.skippedRepeat++; continue; }

    // 3. Reservar. Si devuelve null, otro proceso ya la tomó o ya se mandó.
    const touchId = await reserveTouch({
      listId: args.listId,
      rowId: row.id,
      channel: "email",
      campaign: args.campaign,
      subject: draft.subject,
      body: draft.html.slice(0, 4000),
    });
    if (touchId == null) { out.skippedRepeat++; continue; }

    // 4. Instrumentar: pixel, enlaces firmados, stop1 de un clic.
    const withWa = args.waPhone ? injectWaLink(draft.html, args.waPhone, row.name ?? "") : draft.html;
    const { html, unsubUrl } = instrument(appendUnsubFooter(withWa, UNSUB_PLACEHOLDER), touchId, ns);
    const finalHtml = html.replace(UNSUB_PLACEHOLDER, unsubUrl);

    try {
      const ok = await sendSesEmail({
        to: row.email,
        subject: draft.subject,
        html: finalHtml,
        text: draft.text,
        replyTo: args.replyTo,
        headers: {
          // Gmail y Yahoo lo exigen a quien manda en volumen. Los dos juntos son lo que
          // habilita el botón nativo de "cancelar suscripción" del cliente de correo.
          "List-Unsubscribe": `<${unsubUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (ok) { await markSent(touchId); out.sent++; }
      else { await markError(touchId, "sendSesEmail devolvió false"); out.failed++; }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      await markError(touchId, msg);
      out.failed++;
      if (out.errors.length < 5) out.errors.push(msg);
    }

    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  return out;
}

/** Marcador que se sustituye por la URL real cuando ya existe el touchId. */
const UNSUB_PLACEHOLDER = "%%UNSUB%%";

/**
 * El pie de stop1 VISIBLE.
 *
 * El header `List-Unsubscribe` no basta: no todos los clientes lo pintan, y quien no
 * encuentra cómo salir usa el botón de spam. Un enlace visible es más barato que una queja.
 */
function appendUnsubFooter(html: string, url: string): string {
  const footer = `<p style="margin:24px 0 0;font-size:11px;color:#8b8b8b;text-align:center">
<a href="${url}" style="color:#8b8b8b">Ya no quiero recibir estos emails</a></p>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
}

/**
 * Sustituye el marcador del botón de WhatsApp por el enlace real.
 *
 * `wa.me` con text prellenado: el prospecto llega al chat con el mensaje ya escrito, sólo
 * le da enviar. Ese envío es lo que abre la ventana de 24 h.
 */
function injectWaLink(html: string, phone: string, business: string): string {
  const text = encodeURIComponent(`Hola, me llegó su correo${business ? ` (soy de ${business})` : ""}. Cuéntenme más.`);
  const url = `https://wa.me/${phone.replace(/\D/g, "")}?text=${text}`;
  return html.replace(/%%WA%%/g, url);
}
