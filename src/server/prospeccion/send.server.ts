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
 *  1. ¿Está dado de baja? → no se manda.
 *  2. ¿Ya se le tocó 2 veces sin respuesta? → no se manda.
 *  3. Se RESERVA la tocada (índice único) → dos procesos no mandan lo mismo.
 *  4. Se instrumenta el HTML: pixel, enlaces firmados y la baja de un clic.
 */
import { currentNamespace } from "../tenant.server";
import { isOptedOut } from "./optout.server";
import { markError, markSent, reserveTouch, touchCount } from "./touches.server";
import { instrument } from "./track.server";
import type { InlineImage } from "../ses.server";
import type { ProspRow } from "./lists.server";

/** Tope de intentos por fila y canal. Al tercero se deja en paz. */
export const MAX_ATTEMPTS = 2;

/**
 * Pausa entre envíos.
 *
 * Copiado del criterio de Formmy, y la razón está en su comentario: "una campaña que sale
 * de golpe concentra los bloqueos y baja la calidad del número". Vale igual para el
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
 * Qué pasaría si se manda: se calcula SIN mandar nada.
 *
 * El spec lo pide como invariante — «el agente propone, la persona confirma todo lo que
 * sale hacia fuera» — y además es lo único honesto: «Mandar a 312» no dice que 40 están
 * dadas de baja, 60 tienen el correo muerto y 12 ya recibieron dos intentos. El número que
 * de verdad sale es otro, y hay que verlo ANTES.
 */
export type SendPlan = {
  total: number;
  irian: number;
  optOut: number;
  sinCorreo: number;
  correoMuerto: number;
  yaTocados: number;
  /** Los primeros, para poder mirar a quién se le va a escribir. */
  muestra: { rowId: number; name: string | null; email: string }[];
};

export async function planSend(args: {
  listId: number;
  campaign: string;
  rows: ProspRow[];
}): Promise<SendPlan> {
  const { optOutSet } = await import("./optout.server");
  const bajas = await optOutSet("email", args.rows.map((r) => r.email));
  const { normalize } = await import("./optout.server");

  const plan: SendPlan = {
    total: args.rows.length,
    irian: 0,
    optOut: 0,
    sinCorreo: 0,
    correoMuerto: 0,
    yaTocados: 0,
    muestra: [],
  };

  for (const row of args.rows) {
    if (!row.email) { plan.sinCorreo++; continue; }
    const n = normalize("email", row.email);
    if (n && bajas.has(n)) { plan.optOut++; continue; }
    // El veredicto del verificador, si esa columna se corrió: no se re-verifica aquí
    // (serían N consultas DNS por cada previsualización).
    const veredicto = Object.values(row.data).find((c) => c?.src === "correo_sirve")?.v ?? "";
    if (veredicto && veredicto !== "sirve" && veredicto !== "buzón de rol") { plan.correoMuerto++; continue; }
    if ((await touchCount(row.id, "email")) >= MAX_ATTEMPTS) { plan.yaTocados++; continue; }
    plan.irian++;
    if (plan.muestra.length < 5) plan.muestra.push({ rowId: row.id, name: row.name, email: row.email });
  }
  return plan;
}

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

    // 1. La baja gana sobre todo lo demás.
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

    // 4. Instrumentar: pixel, enlaces firmados, baja de un clic.
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
 * El pie de baja VISIBLE.
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


/**
 * El HTML de un correo, con su botón de WhatsApp ya resuelto.
 *
 * Sacado aparte para que la PREVISUALIZACIÓN y el ENVÍO usen exactamente el mismo código.
 * Si fueran dos caminos, la previsualización enseñaría una cosa y saldría otra — que es el
 * fallo clásico de este paso y la razón por la que existe la previsualización.
 */
export async function renderDraft(args: {
  subject: string;
  body: string;
  businessName?: string | null;
  waPhone?: string | null;
}): Promise<{ html: string; text: string; inline: InlineImage[]; preview: string; sinBoton: boolean }> {
  const { ghostyEmail } = await import("../email-template.server");

  const wa = args.waPhone
    ? `https://wa.me/${args.waPhone.replace(/\D/g, "")}?text=${encodeURIComponent(
        `Hola, me llegó su correo${args.businessName ? ` (soy de ${args.businessName})` : ""}.`
      )}`
    : "";

  /**
   * ⚠️ El botón va por `cta`, NO metido en el `body`.
   *
   * `ghostyEmail` declara que el body es PROSA y lo escapa siempre —«puede venir de un
   * modelo»—, que es exactamente lo correcto porque este cuerpo lo escribió un agente y
   * acaba en el correo de un tercero. Al meter ahí el `<a href>` del botón, se escapaba
   * también: al prospecto le llegaba el HTML como texto literal en vez de un botón.
   * Medido con el smoke antes de que saliera un solo correo.
   */
  const out = ghostyEmail({
    head: args.subject,
    body: args.body,
    cta: wa ? { label: "Escríbenos por WhatsApp", url: wa } : undefined,
    footer: "externo",
  });

  /**
   * Para MIRAR el correo, las imágenes van incrustadas como data URI.
   *
   * ⚠️ En el correo de verdad viajan como `cid:` —adjuntas al mensaje, sin una petición de
   * red que el destinatario pague al abrir—, pero `cid:` sólo lo resuelve un cliente de
   * correo. En un iframe se ve como imagen ROTA, y una previsualización con el logo roto
   * hace dudar de que el correo esté bien cuando está perfecto.
   *
   * El HTML que SE MANDA no se toca: esto es una copia sólo para la pantalla.
   */
  let paraMirar = out.html;
  for (const img of out.inline ?? []) {
    paraMirar = paraMirar.replaceAll(`cid:${img.cid}`, `data:${img.mime};base64,${img.bytes.toString("base64")}`);
  }

  return { ...out, preview: paraMirar, sinBoton: !wa };
}

/** El correo de quien está usando la app, para mandarle la prueba a él y no al prospecto. */
export async function getUserEmail(sub: string): Promise<string | null> {
  const { dbq } = await import("../../dbq.server");
  const r = await dbq(`SELECT email FROM gc_users WHERE sub = ? LIMIT 1`, [sub]).catch(() => []);
  return r[0]?.email ? String(r[0].email) : null;
}
