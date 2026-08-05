// ── Brand kit → tokens ──────────────────────────────────────────────────────
// Fuente ÚNICA de verdad de la marca de un workspace. Un kit guarda MUY POCO
// (primary, secondary, accent, surface, fuentes) y de ahí sale todo lo demás:
// la paleta de la app, las vars del formulario público, las del PDF y el @theme
// de los artefactos. Si las seis superficies derivaran por su cuenta, divergirían.
//
// Isomorfo a propósito: cero imports de servidor, para que el panel de Ajustes
// pinte exactamente lo mismo que se hornea.
//
// ⚠️ El color de TEXTO no se guarda, se CALCULA por luminancia contra su fondo.
// EasyBits lo tiene fijo en "#1a1a1a" (brandKitOperations.ts:117) y por eso un kit
// oscuro le sale texto negro sobre fondo negro.

import type { ThemePreset } from "#/utils/theme";

export const BRAND_MOODS = [
  "professional", "playful", "elegant", "bold", "minimal", "warm", "vibrant",
] as const;
// Un solo union para schema, UI y prompt de extracción. EasyBits tiene TRES listas
// distintas (schema.prisma:887, el prompt en :214 y la UI en dash/brand-kits.tsx:602).
export type BrandMood = (typeof BRAND_MOODS)[number];

export type BrandColors = {
  primary: string;
  secondary: string;
  accent: string;
  surface: string;
  extras?: { name: string; hex: string }[];
};

export type BrandFonts = { heading?: string; body?: string };

export type BrandKit = {
  id: string;
  name: string;
  colors: BrandColors;
  fonts?: BrandFonts | null;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  mood?: BrandMood | null;
};

// ── Color: lo mínimo, a mano (sin dependencias) ─────────────────────────────

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Devuelve `boolean` y NO un type predicate a propósito: como predicado, un `else` sobre
// un valor ya tipado `string` lo estrecha a `never` y rompe el código de al lado.
export function isHex(v: unknown): boolean {
  return typeof v === "string" && HEX_RE.test(v.trim());
}

/** Normaliza a `#rrggbb` en minúsculas. Lanza si no es un hex — validación de borde. */
export function normalizeHex(v: string): string {
  const s = v.trim().toLowerCase();
  if (!HEX_RE.test(s)) throw new Error(`hex inválido: ${v}`);
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return s;
}

type Rgb = { r: number; g: number; b: number };

function toRgb(hex: string): Rgb {
  const h = normalizeHex(hex);
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Luminancia relativa WCAG 2.1. */
export function luminance(hex: string): number {
  const { r, g, b } = toRgb(hex);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Razón de contraste WCAG: 1 (nada) a 21 (negro sobre blanco). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.4;
}

/** Mezcla lineal: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  const k = Math.min(1, Math.max(0, t));
  return toHex({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k,
  });
}

const NEAR_WHITE = "#ffffff";
const NEAR_BLACK = "#0b0b0f";

/**
 * Texto legible SOBRE `bg`. Elige claro u oscuro por contraste real, y lo tiñe
 * levemente con `tint` para que no se vea gris de sistema.
 */
export function onColor(bg: string, tint?: string): string {
  const light = tint ? mix(NEAR_WHITE, tint, 0.06) : NEAR_WHITE;
  const dark = tint ? mix(NEAR_BLACK, tint, 0.12) : NEAR_BLACK;
  return contrast(light, bg) >= contrast(dark, bg) ? light : dark;
}

/**
 * Empuja `fg` hacia claro u oscuro hasta alcanzar `target` de contraste contra `bg`.
 * Devuelve el color tal cual si ya cumple. Es lo que permite que un kit con un
 * amarillo de marca siga teniendo botones legibles sin pedirle nada al usuario.
 */
export function ensureContrast(fg: string, bg: string, target = 4.5): string {
  if (contrast(fg, bg) >= target) return fg;
  const towards = isDarkColor(bg) ? NEAR_WHITE : NEAR_BLACK;
  let best = fg;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    best = mix(fg, towards, t);
    if (contrast(best, bg) >= target) return best;
  }
  return best;
}

// ── Derivación ──────────────────────────────────────────────────────────────

type Surfaces = { surface: string; surface2: string; surface3: string; border: string; ink: string; muted: string };

/** Las capas de fondo/línea/texto que salen de un solo color de superficie. */
function surfacesFrom(surface: string, tint: string, dark: boolean): Surfaces {
  const step = dark ? NEAR_WHITE : NEAR_BLACK;
  const ink = onColor(surface, tint);
  return {
    surface,
    surface2: mix(surface, tint, dark ? 0.06 : 0.045),
    surface3: mix(mix(surface, tint, dark ? 0.1 : 0.08), step, dark ? 0.04 : 0.03),
    border: mix(surface, step, dark ? 0.14 : 0.11),
    ink,
    // El apagado debe seguir pasando AA para texto grande y secundario.
    muted: ensureContrast(mix(ink, surface, 0.42), surface, 4.5),
  };
}

/** ¿La superficie del kit es clara u oscura? Decide de qué lado se derivan las capas. */
function lightSurface(kit: BrandKit): string {
  const s = kit.colors.surface;
  return isDarkColor(s) ? NEAR_WHITE : normalizeHex(s);
}

function darkSurface(kit: BrandKit): string {
  const s = kit.colors.surface;
  return isDarkColor(s) ? normalizeHex(s) : mix(NEAR_BLACK, kit.colors.primary, 0.1);
}

/**
 * El kit como `ThemePreset` sintético — las mismas 9 claves que la tabla PRESETS,
 * así `paletteVars()` y `applyTheme()` funcionan sin tocarse.
 *
 * ⚠️ El modo oscuro NO se le pide al usuario: se deriva. Un kit que sólo trae la
 * paleta clara igual tiene que verse bien de noche.
 */
export function brandPalette(kit: BrandKit): ThemePreset {
  const primary = normalizeHex(kit.colors.primary);
  const secondary = normalizeHex(kit.colors.secondary);

  const ls = surfacesFrom(lightSurface(kit), primary, false);
  const ds = surfacesFrom(darkSurface(kit), primary, true);

  // La marca sobre cada fondo, empujada hasta ser legible como texto/borde.
  const brandLight = ensureContrast(primary, ls.surface, 4.5);
  const brandDark = ensureContrast(primary, ds.surface, 4.5);

  return {
    id: "brand",
    label: kit.name,
    font: "sans",
    light: {
      brand: brandLight,
      "brand-2": ensureContrast(secondary, ls.surface, 3),
      "brand-fg": onColor(brandLight, primary),
      surface: ls.surface,
      "surface-2": ls.surface2,
      "surface-3": ls.surface3,
      border: ls.border,
      ink: ls.ink,
      muted: ls.muted,
    },
    dark: {
      brand: brandDark,
      "brand-2": ensureContrast(secondary, ds.surface, 3),
      "brand-fg": onColor(brandDark, primary),
      surface: ds.surface,
      "surface-2": ds.surface2,
      "surface-3": ds.surface3,
      border: ds.border,
      ink: ds.ink,
      muted: ds.muted,
    },
  };
}

/**
 * Las 9 variables del `:root` del formulario público (forms/render.server.ts:763).
 * Se emiten en un segundo `<style>`, después del original: mismas claves, valores
 * del kit. Ni una regla del CSS del formulario cambia.
 */
export function brandFormVars(kit: BrandKit): Record<string, string> {
  const p = brandPalette(kit);
  const l = p.light;
  // ⚠️ El fondo del formulario es `--paper` (surface-2), NO surface: la tarjeta es
  // blanca pero el texto secundario y el asterisco de requerido se leen sobre el
  // papel. Garantizar el contraste contra surface deja a los dos un pelo cortos.
  const paper = l["surface-2"];
  return {
    "--accent": l.brand,
    "--accent-ink": ensureContrast(l.brand, paper, 4.5),
    "--tint": mix(paper, l.brand, 0.1),
    "--ink": ensureContrast(l.ink, paper, 4.5),
    "--muted": ensureContrast(l.muted, paper, 4.5),
    "--line": l.border,
    "--req": ensureContrast(normalizeHex(kit.colors.accent), paper, 4.5),
    "--ok": ensureContrast(l["brand-2"], paper, 4.5),
    "--paper": paper,
  };
}

/** Los colores del PDF (doc-export.server.ts, PRINT_CSS). Papel siempre claro. */
export function brandPrintVars(kit: BrandKit): Record<string, string> {
  const p = brandPalette(kit);
  const l = p.light;
  return {
    "--pr-ink": l.ink,
    "--pr-muted": l.muted,
    "--pr-line": l.border,
    "--pr-tint": mix("#ffffff", l.brand, 0.08),
    "--pr-brand": l.brand,
    "--pr-paper": "#ffffff",
  };
}

/** Familias con fallback, para CSS. */
export function brandFontStacks(kit: BrandKit): { heading: string; body: string } {
  const q = (f?: string | null) => (f && f.trim() ? `"${f.trim()}", ` : "");
  return {
    heading: `${q(kit.fonts?.heading)}"Iowan Old Style", Georgia, serif`,
    body: `${q(kit.fonts?.body)}-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
  };
}

/**
 * Bloque `@theme` para Tailwind v4 — se concatena a TAILWIND_INDEX_CSS antes de
 * `compile()` en bakeTailwind, así `bg-brand` / `text-ink` de un artefacto salen
 * con la marca. Tiene que ir HORNEADO: el iframe va con CSP sandbox sin
 * allow-same-origin y el padre no puede inyectarle nada.
 */
export function brandThemeCss(kit: BrandKit): string {
  const p = brandPalette(kit);
  const f = brandFontStacks(kit);
  const vars = Object.entries(p.light)
    .map(([k, v]) => `  --color-${k}: ${v};`)
    .join("\n");
  const extras = (kit.colors.extras ?? [])
    .filter((e) => isHex(e.hex))
    .map((e) => `  --color-${slugToken(e.name)}: ${normalizeHex(e.hex)};`)
    .join("\n");
  const darkVars = Object.entries(p.dark)
    .map(([k, v]) => `    --color-${k}: ${v};`)
    .join("\n");
  return `@theme {
${vars}
${extras}
  --font-heading: ${f.heading};
  --font-body: ${f.body};
}
@media (prefers-color-scheme: dark) {
  :root {
${darkVars}
  }
}
`;
}

/** Nombre libre de un color extra → token CSS seguro. */
export function slugToken(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? `x-${s}` : "x-extra";
}

/** Valida y normaliza lo que llega de la UI, de una tool o de la extracción. */
export function normalizeColors(input: BrandColors): BrandColors {
  const out: BrandColors = {
    primary: normalizeHex(input.primary),
    secondary: normalizeHex(input.secondary),
    accent: normalizeHex(input.accent),
    surface: normalizeHex(input.surface),
  };
  const extras = (input.extras ?? []).filter((e) => e && isHex(e.hex)).slice(0, 12);
  if (extras.length) {
    out.extras = extras.map((e) => ({ name: String(e.name || "").slice(0, 40), hex: normalizeHex(e.hex) }));
  }
  return out;
}
