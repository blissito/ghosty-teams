// ── i18n listo para traducción ──────────────────────────────────────────────
// Estrategia "source string as key": la CLAVE es el texto en español. Así el
// código se lee natural (`t("Crear room")`) y el español funciona SIN diccionario
// (t() devuelve la clave tal cual si no hay override). Añadir un idioma = rellenar
// su diccionario con {clave-en-español: traducción}. Cero refactor de componentes.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
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
function interpolate(s: string, params?: Record<string, string | number>): string {
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

type LocaleCtxValue = { locale: Locale; setLocale: (l: Locale) => void };
const LocaleCtx = createContext<LocaleCtxValue>({ locale: DEFAULT_LOCALE, setLocale: () => {} });

// El SSR monta con `locale` (o DEFAULT). En cliente reconcilia con la cookie `lang`
// (por si el SSR no la resolvió) y expone `setLocale` que PERSISTE (cookie 1 año) y
// actualiza el estado en vivo → todos los `t()` re-renderean sin recargar.
export function LocaleProvider({ locale: initial, children }: { locale?: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? DEFAULT_LOCALE);

  useEffect(() => {
    const fromCookie = localeFromCookieString(typeof document !== "undefined" ? document.cookie : "");
    if (typeof document !== "undefined") document.documentElement.lang = fromCookie;
    if (fromCookie !== locale) setLocaleState(fromCookie);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((l: Locale) => {
    if (typeof document !== "undefined") {
      document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
      document.documentElement.lang = l;
    }
    setLocaleState(l);
  }, []);

  return <LocaleCtx.Provider value={{ locale, setLocale }}>{children}</LocaleCtx.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleCtx).locale;
}

export function useSetLocale(): (l: Locale) => void {
  return useContext(LocaleCtx).setLocale;
}

// Hook principal: `const t = useT();` → `t("texto en español", { params })`.
export type TFn = (key: string, params?: Record<string, string | number>) => string;
export function useT(): TFn {
  const { locale } = useContext(LocaleCtx);
  return (key, params) => translate(locale, key, params);
}
