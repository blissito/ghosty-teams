import { prettyName } from "./prospeccion-vars";
/**
 * El enlace `wa.me` del botón del correo, con el mensaje que llega YA escrito.
 *
 * Ese texto es lo único que le dice al agente que atiende el WhatsApp de qué campaña viene
 * la persona: con el genérico («me llegó su correo») no sabía si era una agencia de Ghosty
 * Experts o un negocio cualquiera, y la mandaba a la salida equivocada. Por eso es del
 * workspace y se edita (`prospeccion_cta_wa_text`), con `{negocio}` para el nombre de la fila.
 *
 * Antes se armaba en dos sitios (envío y previsualización) con textos distintos: la prueba
 * enseñaba uno y salía otro. Ahora los dos pasan por aquí.
 */
export const DEFAULT_WA_TEXT = "Hola, me llegó su correo (soy de {negocio}).";

export function waText(template: string | null | undefined, business: string | null | undefined): string {
  const tpl = (template ?? "").trim() || DEFAULT_WA_TEXT;
  // «Hola, vengo por… (soy de Duplimedios)», no «(soy de DUPLIMEDIOS)»: lo manda el prospecto.
  const name = prettyName(business ?? "");
  // Sin nombre se quita el paréntesis entero que lo envuelve, no sólo la palabra.
  const out = name
    ? tpl.replace(/\{negocio\}/g, name)
    : tpl.replace(/\s*\([^()]*\{negocio\}[^()]*\)/g, "").replace(/\{negocio\}/g, "");
  return out.replace(/\s+([.,])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

export function waLink(phone: string, template: string | null | undefined, business: string | null | undefined): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(waText(template, business))}`;
}
