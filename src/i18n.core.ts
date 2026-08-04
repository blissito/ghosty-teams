// Núcleo de i18n SIN React. Lo que vive aquí lo pueden importar por igual los
// componentes (vía i18n.tsx, que lo reexporta) y el código de servidor.
//
// Existe separado por una razón mecánica: `i18n.tsx` define `LocaleProvider` con JSX, así
// que importar `translate` desde un `.server.ts` arrastraría React entero al bundle de
// servidor por un helper de tres líneas.
//
// Estrategia "source string as key": la CLAVE es el texto en español. El código se lee
// natural (`t("Crear room")`) y el español funciona SIN diccionario (t() devuelve la clave
// tal cual si no hay override). Añadir un idioma = rellenar su diccionario.
import { en } from "./i18n.en";

export type Locale = "es" | "en";
export const LOCALES: Locale[] = ["es", "en"];
export const DEFAULT_LOCALE: Locale = "es";
export const LANG_COOKIE = "lang";

// Diccionarios de override por idioma. `es` va vacío (es la fuente). `en` es el mapa
// generado (i18n.en.ts). Claves faltantes caen al texto fuente (español).
const dictionaries: Record<Locale, Record<string, string>> = {
  es: {},
  en,
};

// Interpola {placeholders} nombrados: t("Hola {name}", { name: "Ana" }).
export function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = dictionaries[locale] ?? {};
  return interpolate(dict[key] ?? key, params);
}

export function isLocale(v: string | undefined | null): v is Locale {
  return v === "es" || v === "en";
}

// Lee la cookie `lang` de un string de cookies (header en server, document.cookie en
// cliente). Cae a DEFAULT_LOCALE si no está o no es válida.
export function localeFromCookieString(cookie: string | undefined | null): Locale {
  const m = (cookie ?? "").match(/(?:^|;\s*)lang=([^;]+)/);
  return m && isLocale(m[1]) ? m[1] : DEFAULT_LOCALE;
}

/** Fechas y números en el idioma correcto: "es" → es-MX, "en" → en-US. */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "es-MX";
}
