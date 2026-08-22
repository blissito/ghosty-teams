// ── i18n listo para traducción ──────────────────────────────────────────────
// La capa REACT. El núcleo (diccionarios, translate, cookie) vive en `i18n.core.ts`,
// sin React, para que el servidor pueda usarlo sin arrastrar el runtime de React.
// Todo lo que este archivo exportaba sigue exportándose desde aquí: los consumidores
// no cambian.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_LOCALE, LANG_COOKIE, localeFromCookieString, translate, type Locale } from "./i18n.core";

export {
  DEFAULT_LOCALE,
  LANG_COOKIE,
  LOCALES,
  interpolate,
  intlLocale,
  isLocale,
  localeFromCookieString,
  translate,
} from "./i18n.core";
export type { Locale } from "./i18n.core";

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

/**
 * ⚠️ MEMORIZADO por idioma, y no es una optimización: es corrección.
 *
 * Devolvía una función NUEVA en cada render. Poner `t` en las dependencias de un `useEffect`
 * —lo natural, y lo que sugiere la regla de lint `exhaustive-deps`— convertía ese efecto en
 * un bucle infinito si además hacía `setState`: efecto → estado → render → `t` nueva →
 * efecto.
 *
 * El síntoma no parece un bucle. El 2026-08-22 se vio como un modal CONGELADO a media
 * animación: `opacity: 0.36` y ahí se quedaba, porque Motion nunca llegaba a terminar entre
 * re-render y re-render. Se diagnosticó midiendo la opacidad computada, no mirando.
 *
 * Con `useCallback([locale])` la identidad sólo cambia al cambiar de idioma, que es
 * exactamente cuando un efecto que depende de `t` SÍ debe volver a correr.
 */
export function useT(): TFn {
  const { locale } = useContext(LocaleCtx);
  return useCallback<TFn>((key, params) => translate(locale, key, params), [locale]);
}
