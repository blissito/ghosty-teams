// ── i18n listo para traducción ──────────────────────────────────────────────
// Estrategia "source string as key": la CLAVE es el texto en español. Así el
// código se lee natural (`t("Crear room")`) y el español funciona SIN diccionario
// (t() devuelve la clave tal cual si no hay override). Añadir un idioma en otra
// sesión = rellenar su diccionario con {clave-en-español: traducción}. Cero
// refactor de componentes: ya quedan envueltos en t().
import { createContext, useContext } from "react";

export type Locale = "es" | "en";
export const LOCALES: Locale[] = ["es", "en"];
export const DEFAULT_LOCALE: Locale = "es";

// Diccionarios de override por idioma. `es` va vacío (es la fuente). Los demás se
// llenan en la sesión de traducción; mientras estén vacíos caen al texto fuente.
const dictionaries: Record<Locale, Record<string, string>> = {
  es: {},
  en: {
    // se completa en otra sesión: { "Crear room": "Create room", ... }
  },
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

const LocaleCtx = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale?: Locale; children: React.ReactNode }) {
  return <LocaleCtx.Provider value={locale ?? DEFAULT_LOCALE}>{children}</LocaleCtx.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleCtx);
}

// Hook principal: `const t = useT();` → `t("texto en español", { params })`.
export type TFn = (key: string, params?: Record<string, string | number>) => string;
export function useT(): TFn {
  const locale = useContext(LocaleCtx);
  return (key, params) => translate(locale, key, params);
}
