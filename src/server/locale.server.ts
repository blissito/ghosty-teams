// El idioma del lado SERVIDOR.
//
// `useT()` no llega hasta aquí: es un hook de React que lee el locale de un contexto de
// componente. Pero la mitad del texto que ve un usuario lo escribe el servidor —errores,
// cuerpos de mensajes que se postean al room, correos, notificaciones push, las etiquetas
// de herramientas del agente— y sin esto no había nada a lo que engancharlo.
//
// Calcado de `tenant.server.ts` a propósito, incluido el escape hatch: lo explícito gana
// sobre el request, porque hay código que corre FUERA de uno (un timer de recordatorios,
// un correo que sale en el idioma de QUIEN INVITA, no de quien lo recibe).
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, localeFromCookieString, translate, type Locale } from "../i18n.core";

const localeStore = new AsyncLocalStorage<Locale>();

/** Fija el idioma para todo lo que ocurra dentro de `fn`. */
export function withLocale<T>(locale: Locale, fn: () => Promise<T>): Promise<T> {
  return localeStore.run(locale, fn);
}

/**
 * Idioma de este request, de la cookie `lang`.
 *
 * Cae a español y NUNCA lanza: a diferencia del namespace —donde no saber el tenant es
 * fatal— aquí no saber el idioma sólo significa usar el de la fuente. Un throw aquí
 * convertiría cada mensaje de error en un error distinto.
 */
export async function currentLocale(): Promise<Locale> {
  const forced = localeStore.getStore();
  if (forced) return forced;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return localeFromCookieString(getRequestHeader("cookie"));
  } catch {
    // Fuera de un request (timer, webhook, arranque): no hay cookie que leer.
    return DEFAULT_LOCALE;
  }
}

/**
 * `t()` del servidor. Misma firma que el hook, así que el texto fuente en español se
 * escribe igual en los dos lados y comparten las claves de `i18n.en.ts`.
 *
 * Es `async` porque el locale sale del contexto de request. En un sitio donde eso
 * estorbe —dentro de un `.map()`, o para traducir muchas cadenas seguidas— resuelve el
 * locale una vez y usa `translate(locale, …)` directo.
 */
export async function st(key: string, params?: Record<string, string | number>): Promise<string> {
  return translate(await currentLocale(), key, params);
}
