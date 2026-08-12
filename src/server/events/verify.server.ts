// Verificación del correo de quien quiere participar en un room abierto.
//
// Por qué existe: el registro nació sin verificar nada. Cualquiera ponía un correo
// inventado y entraba, lo que rompía dos cosas a la vez — el baneo por correo se saltaba
// escribiendo otro, y la lista de asistentes quedaba llena de basura. Y esa lista NO es un
// detalle administrativo: es el objetivo comercial de abrir un room. Una suscripción.
//
// ⚠️ **Código de 6 dígitos, no magic link.** Es lo que hacen hoy Slack, Notion y Linear, y
// la razón es concreta: una liga en el correo abre una PESTAÑA NUEVA, y quien la pulsa
// pierde el room donde estaba leyendo. En un evento en vivo eso es exactamente el peor
// momento posible. El código se pega sin salir de la página.

import crypto from "node:crypto";

const TTL_S = 10 * 60;
/** Seis dígitos son un millón de combinaciones: sin tope se fuerzan por fuerza bruta. */
const MAX_INTENTOS = 5;

/** Código de 6 dígitos con aleatoriedad criptográfica (no `Math.random`). */
export function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Hash del código. Salado con el secreto del servidor: sin sal, una tabla de un millón de
 * hashes SHA-256 se precomputa en segundos y la columna deja de proteger nada.
 */
export function hashCode(code: string): string {
  const salt = process.env.EVENT_TICKET_SECRET ?? process.env.SESSION_SECRET ?? "";
  return crypto.createHmac("sha256", salt).update(code).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Un correo con forma de correo. No valida que exista — de eso se encarga el código. */
export function validEmail(email: string): boolean {
  const e = normalizeEmail(email);
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: "sin-codigo" | "caducado" | "agotado" | "incorrecto" };

/**
 * ¿El código que pegó esta persona es el suyo? Pura, para poder probarla sin DB.
 *
 * El orden de los rechazos importa y no es casual: **primero se mira si se agotaron los
 * intentos**, antes de comparar. Si se comparara primero, cada intento fallido seguiría
 * revelando "frío/caliente" indefinidamente por más que el contador estuviera al tope.
 */
export function checkCode(
  fila: { verify_code_hash?: string | null; verify_expires_at?: number | null; verify_attempts?: number | null },
  code: string,
  ahora: number
): CodeCheck {
  if (!fila.verify_code_hash) return { ok: false, reason: "sin-codigo" };
  if ((fila.verify_attempts ?? 0) >= MAX_INTENTOS) return { ok: false, reason: "agotado" };
  if (!fila.verify_expires_at || fila.verify_expires_at < ahora) return { ok: false, reason: "caducado" };

  const esperado = fila.verify_code_hash;
  const dado = hashCode(code.trim());
  // Comparación en tiempo constante. Con `===`, el tiempo de respuesta filtra cuántos
  // caracteres del hash coinciden — y aquí el atacante controla lo que manda y puede medir.
  const a = Buffer.from(esperado, "utf8");
  const b = Buffer.from(dado, "utf8");
  const igual = a.length === b.length && crypto.timingSafeEqual(a, b);
  return igual ? { ok: true } : { ok: false, reason: "incorrecto" };
}

export const VERIFY_TTL_S = TTL_S;
export const VERIFY_MAX_INTENTOS = MAX_INTENTOS;

/**
 * Manda el código. Se reusa `ghostyEmail()`, que ya trae la mascota incrustada por `cid:`,
 * tablas en vez de flex y un pie `"externo"` — está hecho justamente para escribirle a
 * alguien que no tiene cuenta y no debe ver promesas de ajustes que no posee.
 */
export async function sendCodeEmail(opts: {
  to: string;
  code: string;
  roomTitle: string;
  /** La liga del room. Sin ella, quien cierra la pestaña se queda con un código y sin dónde usarlo. */
  roomUrl?: string;
}): Promise<boolean> {
  const { ghostyEmail } = await import("../email-template.server");
  const { sendSesEmail } = await import("../ses.server");
  const { currentLocale } = await import("../locale.server");
  const locale = await currentLocale();

  const { html, text, inline } = ghostyEmail({
    head: `Tu código es ${opts.code}`,
    // El código va también en el CUERPO y no sólo en el asunto: mucha gente lee el asunto
    // en la notificación y ni abre el correo, pero quien abre necesita poder copiarlo.
    body: [
      `Escríbelo en la página de «${opts.roomTitle}» para poder participar.`,
      "Caduca en 10 minutos. Si no lo pediste tú, ignora este correo.",
    ].join("\n\n"),
    // ⚠️ El botón vuelve al ROOM, no verifica nada: el código se teclea en la página. Una
    // liga que verificara sola convertiría esto en un magic link, que es justo lo que se
    // evitó — abre pestaña nueva y quien la pulsa pierde el room donde estaba.
    //
    // Y hace falta: sin él, quien lee el correo en el teléfono se queda con seis dígitos y
    // sin sitio donde ponerlos.
    ...(opts.roomUrl ? { cta: { label: "Volver al room", url: opts.roomUrl } } : {}),
    footer: "externo",
    locale,
    // ⚠️ Sin `deQuien`: aquí NO hay una persona ni una empresa que firme. Se intentó con el
    // nombre del brand kit del workspace y salió "Te escribe Formmy" — el brand kit es un
    // juego de colores y tipografías, no la identidad de quien manda un correo. Sin nombre,
    // el pie se queda en lo único cierto: si no lo esperabas, ignóralo.
    //
    // Arriba va el TÍTULO DEL EVENTO, que es lo que esa persona sí reconoce: acaba de
    // registrarse en él hace diez segundos.
    marca: opts.roomTitle,
  });

  return sendSesEmail({
    to: opts.to,
    // El código en el ASUNTO es lo que ahorra el viaje al correo: se lee en la
    // notificación del teléfono y se teclea sin salir del room.
    subject: `${opts.code} — tu código para ${opts.roomTitle}`,
    html,
    text,
    inline,
  });
}
