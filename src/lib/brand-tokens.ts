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

import {
  CUSTOM_FAMILY,
  FALLBACK,
  type FaceSpec,
  faceCss,
  fontById,
} from "./brand-fonts";
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from "./oklch";
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

/**
 * Las dos ranuras tipográficas. `heading`/`body` son ids del CATÁLOGO
 * (`brand-fonts.ts`), no texto libre: un nombre que nadie puede cargar es decoración.
 * `*Url` es una fuente propia subida por el cliente, y gana sobre el catálogo.
 */
export type BrandFonts = {
  heading?: string;
  body?: string;
  headingUrl?: string;
  bodyUrl?: string;
  headingName?: string;
  bodyName?: string;
};

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

/**
 * Mezcla en OKLab: t=0 → a, t=1 → b.
 *
 * ⚠️ En sRGB el punto medio entre dos colores saturados sale gris sucio y los pasos de
 * luminosidad quedan desiguales. OKLab es perceptual: un 50% se VE a medio camino. Es lo
 * mismo que hace `color-mix(in oklab, …)` y a donde se movieron Tailwind v4, shadcn y
 * Radix. `luminance()` sigue en sRGB porque la fórmula de WCAG es normativa.
 */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const x = rgbToOklab(toRgb(a));
  const y = rgbToOklab(toRgb(b));
  return toHex(
    oklabToRgb({ L: x.L + (y.L - x.L) * k, a: x.a + (y.a - x.a) * k, b: x.b + (y.b - x.b) * k })
  );
}

/**
 * Un color SEMÁNTICO: tono fijo, adaptado al fondo sobre el que va a leerse.
 *
 * ⚠️ Error, éxito y aviso NO pueden salir de la marca. Antes `--req` —el asterisco de
 * obligatorio y los mensajes de error— tomaba el `accent` del kit, así que una marca con
 * acento verde pintaba sus errores en verde. Son señales, no identidad: el tono se fija y
 * lo único que se adapta es la luminosidad, para que se lea sobre el papel de esta marca.
 */
function semantic(hue: number, bg: string, target = 4.5): string {
  const oscuro = !isDarkColor(bg);
  // Se arranca de una L razonable según el fondo y se empuja hasta cumplir contraste.
  for (let L = oscuro ? 0.55 : 0.75; oscuro ? L > 0.2 : L < 0.95; L += oscuro ? -0.02 : 0.02) {
    const hex = toHex(oklabToRgb(oklchToOklab(L, 0.16, hue)));
    if (contrast(hex, bg) >= target) return hex;
  }
  return ensureContrast(toHex(oklabToRgb(oklchToOklab(oscuro ? 0.5 : 0.8, 0.16, hue))), bg, target);
}

/** Los tres tonos semánticos, en grados OKLCh. Fijos a propósito. */
const HUE = { danger: 27, success: 150, warn: 75 } as const;

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

/**
 * El `mood` es una PERILLA DE LA DERIVACIÓN, no una etiqueta.
 *
 * En EasyBits es sólo texto que se le pasa al modelo, y desde el panel se siente un
 * control muerto: lo eliges y no cambia nada. Aquí mueve tres cosas medibles —cuánto tiñe
 * la marca las superficies, cuánto contrasta contra el fondo, y qué tan marcada queda la
 * línea— así que la elección se ve en el preview al instante. Y además sigue viajando al
 * agente, que es donde manda el matiz que un número no captura.
 *
 * `tint` es el multiplicador del teñido; `edge`, el de los bordes; `pop`, el contraste
 * mínimo que se le exige a la marca sobre el fondo.
 */
export type MoodTuning = {
  /** Multiplicador del teñido de las superficies. */
  tint: number;
  /** Grosor de línea, en px. */
  edge: number;
  /**
   * Factor de la rampa de radios, 0 (todo cuadrado) a 2 (muy redondo).
   *
   * ⚠️ Antes esto era un radio en píxeles y era un error: cada superficie lo clampaba a
   * su manera (la muestra a 14, el horneado a 10) y tres tonos acababan idénticos. Un
   * factor sobre la rampa completa es lo único que mantiene la proporción entre un
   * botón y un modal.
   */
  roundness: number;
  /** Contraste mínimo exigido a la marca sobre el fondo. */
  pop: number;
  /** Los títulos caen en serif cuando no hay fuente elegida. */
  serif: boolean;
  /** Encabezados y botones en versalitas espaciadas. */
  caps: boolean;
  /** Sombra: 0 = plano, 1 = suave, 2 = dura y desplazada. */
  shadow: 0 | 1 | 2;
};

// `bold` va con radio CHICO a propósito: lo contundente es su borde de 3px y su
// contraste AAA, no unas esquinas redondas.
const MOOD_TUNING: Record<BrandMood, MoodTuning> = {
  professional: { tint: 0.8, edge: 1, roundness: 1, pop: 4.5, serif: false, caps: false, shadow: 1 },
  minimal: { tint: 0.1, edge: 1, roundness: 0.25, pop: 4.5, serif: false, caps: true, shadow: 0 },
  elegant: { tint: 0.5, edge: 1, roundness: 0, pop: 4.5, serif: true, caps: true, shadow: 0 },
  warm: { tint: 2.2, edge: 1, roundness: 1.75, pop: 4.5, serif: true, caps: false, shadow: 1 },
  bold: { tint: 1.4, edge: 3, roundness: 0.5, pop: 7, serif: false, caps: true, shadow: 2 },
  vibrant: { tint: 3.4, edge: 2, roundness: 1.5, pop: 4.5, serif: false, caps: false, shadow: 1 },
  playful: { tint: 2.6, edge: 2, roundness: 2, pop: 4.5, serif: false, caps: false, shadow: 1 },
};

/** La forma que impone el tono. La usan el panel y las cuatro salidas. */
export function brandShape(kit: BrandKit): MoodTuning {
  return tuning(kit);
}

const NEUTRAL_TUNING = MOOD_TUNING.professional;

function tuning(kit: BrandKit) {
  return (kit.mood && MOOD_TUNING[kit.mood]) || NEUTRAL_TUNING;
}

// ── La rampa de radios ──────────────────────────────────────────────────────

/** Los radios de fábrica de Tailwind v4, en px (theme.css). El suelo de la escala. */
const RADIUS_BASE = { xs: 2, sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32 } as const;
export type RadiusStep = keyof typeof RADIUS_BASE;

/**
 * La ÚNICA función que produce píxeles de radio. Todo lo demás lee de aquí, para que las
 * cuatro superficies no puedan divergir.
 *
 * ⚠️ El techo es ADITIVO (`base + 12`), no multiplicativo: con un factor de 2 puro,
 * `4xl` pasaría de 32 a 64px y un modal con `overflow-hidden` recorta su contenido en las
 * esquinas. El techo comprime sólo los escalones grandes y preserva la monotonía.
 *
 * ⚠️ `rounded-full` y `rounded-none` NO pasan por aquí: compilan a `calc(infinity*1px)` y
 * `0`. Los avatares y las píldoras son inmunes al tono, que es lo correcto — un avatar
 * cuadrado se ve roto, no elegante.
 */
export function brandRadiusScale(kit: BrandKit): Record<RadiusStep | "base", number> {
  const f = tuning(kit).roundness;
  const r = (base: number) => Math.round(Math.max(0, Math.min(base * f, base + 12)));
  return {
    xs: r(RADIUS_BASE.xs),
    sm: r(RADIUS_BASE.sm),
    md: r(RADIUS_BASE.md),
    lg: r(RADIUS_BASE.lg),
    xl: r(RADIUS_BASE.xl),
    "2xl": r(RADIUS_BASE["2xl"]),
    "3xl": r(RADIUS_BASE["3xl"]),
    "4xl": r(RADIUS_BASE["4xl"]),
    // `--radius` es el que alimenta al `rounded` pelado. Tailwind lo tiene en 4px.
    base: r(4),
  };
}

/**
 * El radio que le toca a una pieza. Los nombres son de la RAMPA, no propios.
 *
 * ⚠️ Antes el formulario tenía su `--radius-sm` con el significado "radio de un input"
 * (8px) mientras el `--radius-sm` de Tailwind vale 4px. Con dos semánticas bajo el mismo
 * nombre, unificar la rampa habría encogido los inputs a la mitad en silencio.
 */
export const PIECE: Record<"card" | "control" | "item", RadiusStep> = {
  card: "xl",
  control: "md",
  item: "lg",
};

type Surfaces = { surface: string; surface2: string; surface3: string; border: string; ink: string; muted: string };

/**
 * El TONO de la marca, rehecho a una luminosidad de superficie.
 *
 * ⚠️ Aquí estaba el bug que puso la app gris. Las capas se teñían mezclando hacia el
 * `primary` TAL CUAL, así que una marca oscura no aportaba color sino OSCURIDAD: con el
 * primary casi negro de Formmy (#191a20) y el mood `warm` (×2.2), `surface-2` salía
 * #e5e5e6 y `surface-3` #cacbcc — gris de sistema, y encima varios tonos más oscuro que
 * cualquier preset (#f6f5fb / #ecebf6). Las tarjetas se veían sucias y pesadas.
 *
 * Se le toma sólo el tono (y un croma acotado, porque un primary fluorescente teñiría
 * de más) y se rehace a la luminosidad que le toca a una superficie. Así el TEÑIDO pone
 * color y el ESCALÓN de luminosidad lo pone `step`, que es constante y no depende de qué
 * tan oscura sea la marca.
 */
function wash(tint: string, dark: boolean): string {
  const { C, h } = oklabToOklch(rgbToOklab(toRgb(tint)));
  return toHex(oklabToRgb(oklchToOklab(dark ? 0.3 : 0.9, Math.min(C, 0.1), h)));
}

/** Las capas de fondo/línea/texto que salen de un solo color de superficie. */
function surfacesFrom(
  surface: string,
  tint: string,
  dark: boolean,
  tune: (typeof MOOD_TUNING)[BrandMood]
): Surfaces {
  const step = dark ? NEAR_WHITE : NEAR_BLACK;
  const ink = onColor(surface, tint);
  const t = tune.tint;
  const w = wash(tint, dark);
  // El escalón de luminosidad: constante, lo pone el blanco/negro. El `t` del mood NO
  // entra aquí — mueve cuánto COLOR, no cuánto oscurece.
  const lift = (l: number) => mix(surface, step, l);
  const tinted = (base: string, k: number) => mix(base, w, Math.min(0.5, k * t));
  return {
    surface,
    surface2: tinted(lift(dark ? 0.05 : 0.028), 0.1),
    surface3: tinted(lift(dark ? 0.1 : 0.062), 0.14),
    // La línea se OSCURECE con el grosor: un borde de 3px del mismo gris claro se ve
    // sucio, no contundente. Es lo que hace que "bold" se lea como bold.
    border: mix(surface, step, (dark ? 0.14 : 0.11) * (0.7 + tune.edge * 0.45)),
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
  const tune = tuning(kit);

  const ls = surfacesFrom(lightSurface(kit), primary, false, tune);
  const ds = surfacesFrom(darkSurface(kit), primary, true, tune);

  // La marca sobre cada fondo, empujada hasta ser legible como texto/borde. El `pop` del
  // tono sube el listón: "bold" pide 7:1 (AAA), que se ve como un color más plantado.
  const brandLight = ensureContrast(primary, ls.surface, tune.pop);
  const brandDark = ensureContrast(primary, ds.surface, tune.pop);

  return {
    id: "brand",
    label: kit.name,
    font: tune.serif ? "serif" : "sans",
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

// ── El REGISTRO ─────────────────────────────────────────────────────────────
//
// ⚠️ Existe porque emitir un token y consumirlo eran dos actos sin ligadura, y así se
// colaron cuatro tokens muertos (`--radius-DEFAULT`, que además era un nombre inventado,
// `--radius-brand`, `--pr-paper` y `--shadow`/`--caps` en el PDF) sin que ningún test lo
// notara. Aquí cada token DECLARA en qué superficies vive, y `brand-registry.test` cruza
// esa declaración contra el CSS real de cada una, en las dos direcciones.
//
// Añadir un token sin consumirlo, o consumir uno que nadie emite, ahora falla en rojo.

export type BrandSurface = "app" | "artifact" | "form" | "print";

export type TokenDef = {
  name: `--${string}`;
  surfaces: readonly BrandSurface[];
  value: (kit: BrandKit) => string;
};

/** El papel del formulario es `surface-2`, no `surface`: se usa varias veces. */
function paperOf(kit: BrandKit): string {
  return brandPalette(kit).light["surface-2"];
}

function shadowOf(kit: BrandKit): string {
  const s = tuning(kit);
  if (s.shadow === 0) return "none";
  if (s.shadow === 1) return "0 1px 2px rgba(20,18,26,.05), 0 8px 24px rgba(20,18,26,.06)";
  return `4px 4px 0 ${brandPalette(kit).light.brand}`;
}

/**
 * Qué escalón consume cada superficie. La app y los artefactos usan la rampa ENTERA
 * (cualquier `rounded-*` de Tailwind); el formulario y el PDF sólo los escalones de las
 * piezas que tienen, y declarar de más es justo lo que el detector de tokens muertos
 * castiga — por diseño: un token emitido que nadie lee es una promesa incumplida.
 */
const RADIUS_STEPS: RadiusStep[] = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
const STEP_SURFACES: Partial<Record<RadiusStep, BrandSurface[]>> = {
  xs: ["print"], // `code` en el PDF
  md: ["form", "print"], // controles del formulario · `pre` del PDF
  lg: ["form"], // items y el recuadro de borrador
  xl: ["form"], // la tarjeta
};

export const BRAND_TOKENS: readonly TokenDef[] = [
  // ── Forma.
  ...RADIUS_STEPS.map(
    (step): TokenDef => ({
      name: `--radius-${step}`,
      surfaces: ["app", "artifact", ...(STEP_SURFACES[step] ?? [])],
      value: (k) => `${brandRadiusScale(k)[step]}px`,
    })
  ),
  {
    // El que alimenta al `rounded` pelado. ⚠️ En Tailwind v4 vive en un bloque
    // `@theme default inline reference`: mientras nadie lo DECLARE su valor se incrusta
    // y ningún override en runtime lo alcanza. Declararlo es lo que lo destraba.
    name: "--radius",
    surfaces: ["app", "artifact"],
    value: (k) => `${brandRadiusScale(k).base}px`,
  },
  // ⚠️ `--edge` y `--shadow` NO van a la app: sus bordes son la utilidad `border` de
  // Tailwind, que compila el grosor como LITERAL (`--default-border-width` es un token de
  // build, no pisable en runtime — comprobado compilando), y sus sombras son `shadow-*`.
  // Declararlos ahí sería emitir para nadie.
  { name: "--edge", surfaces: ["form", "print"], value: (k) => `${tuning(k).edge}px` },
  { name: "--shadow", surfaces: ["form"], value: shadowOf },
  { name: "--caps", surfaces: ["form"], value: (k) => (tuning(k).caps ? "uppercase" : "none") },
  { name: "--tracking", surfaces: ["form", "print"], value: (k) => (tuning(k).caps ? ".08em" : "0") },

  // ── Colores del formulario público.
  { name: "--accent", surfaces: ["form"], value: (k) => brandPalette(k).light.brand },
  { name: "--accent-ink", surfaces: ["form"], value: (k) => ensureContrast(brandPalette(k).light.brand, paperOf(k), 4.5) },
  { name: "--tint", surfaces: ["form"], value: (k) => mix(paperOf(k), brandPalette(k).light.brand, 0.1) },
  { name: "--ink", surfaces: ["form"], value: (k) => ensureContrast(brandPalette(k).light.ink, paperOf(k), 4.5) },
  { name: "--muted", surfaces: ["form"], value: (k) => ensureContrast(brandPalette(k).light.muted, paperOf(k), 4.5) },
  { name: "--line", surfaces: ["form"], value: (k) => brandPalette(k).light.border },
  // ⚠️ Semánticos, NO de la marca. Antes `--req` (asterisco de obligatorio Y mensajes de
  // error) salía del `accent` del kit: una marca con acento verde pintaba sus errores en
  // verde. Un error es una señal; su color no es negociable por identidad.
  { name: "--req", surfaces: ["form"], value: (k) => semantic(HUE.danger, paperOf(k)) },
  { name: "--ok", surfaces: ["form"], value: (k) => semantic(HUE.success, paperOf(k)) },
  // El acento SÍ es de la marca, y aquí tiene trabajo: los encabezados de sección.
  { name: "--sec", surfaces: ["form"], value: (k) => ensureContrast(normalizeHex(k.colors.accent), paperOf(k), 4.5) },
  { name: "--brand-2", surfaces: ["form"], value: (k) => ensureContrast(brandPalette(k).light["brand-2"], paperOf(k), 3) },
  { name: "--paper", surfaces: ["form"], value: paperOf },

  // ── Colores del PDF. El papel del PDF es blanco siempre y va literal en PRINT_CSS:
  // no hay `--pr-paper` porque nadie lo leía (era uno de los tokens muertos).
  { name: "--pr-ink", surfaces: ["print"], value: (k) => brandPalette(k).light.ink },
  { name: "--pr-muted", surfaces: ["print"], value: (k) => brandPalette(k).light.muted },
  { name: "--pr-line", surfaces: ["print"], value: (k) => brandPalette(k).light.border },
  { name: "--pr-tint", surfaces: ["print"], value: (k) => mix("#ffffff", brandPalette(k).light.brand, 0.08) },
  { name: "--pr-brand", surfaces: ["print"], value: (k) => brandPalette(k).light.brand },

  // ── Para lo que el agente diseñe. Los tokens de color de Tailwind (`--color-x`)
  // generan `bg-x`, `text-x`, `border-x`, así que aquí SÍ tienen consumidor.
  {
    name: "--color-accent",
    surfaces: ["artifact"],
    value: (k) => ensureContrast(normalizeHex(k.colors.accent), brandPalette(k).light.surface, 3),
  },
  { name: "--color-danger", surfaces: ["artifact"], value: (k) => semantic(HUE.danger, brandPalette(k).light.surface) },
  { name: "--color-success", surfaces: ["artifact"], value: (k) => semantic(HUE.success, brandPalette(k).light.surface) },
  { name: "--color-warn", surfaces: ["artifact"], value: (k) => semantic(HUE.warn, brandPalette(k).light.surface) },
  // Rampa de gráficas: el agente hace gráficas y no tenía de dónde sacar cinco colores
  // que se distinguieran entre sí. Salen de la marca y se separan en TONO (OKLCh), que
  // es lo que hace que se diferencien de verdad y no sólo en el hex.
  ...[1, 2, 3, 4, 5].map(
    (i): TokenDef => ({
      name: `--color-chart-${i}`,
      surfaces: ["artifact"],
      value: (k) => chartColor(k, i - 1),
    })
  ),
] as const;

/**
 * El color i de la rampa de gráficas. Los tres primeros son los colores de la marca
 * (principal, secundario, acento); los dos que faltan se generan rotando el tono del
 * principal, que es como se consigue una serie categórica distinguible.
 */
function chartColor(kit: BrandKit, i: number): string {
  const surface = brandPalette(kit).light.surface;
  const base = [kit.colors.primary, kit.colors.secondary, kit.colors.accent].map(normalizeHex);
  if (i < base.length) return ensureContrast(base[i], surface, 3);
  const { L, C, h } = oklabToOklch(rgbToOklab(toRgb(base[0])));
  // 140° y 220° de separación: lo bastante lejos del principal y entre sí.
  const rot = [140, 220][i - base.length];
  return ensureContrast(
    toHex(oklabToRgb(oklchToOklab(L, Math.max(C, 0.1), (h + rot) % 360))),
    surface,
    3
  );
}

/** Los tokens que le tocan a una superficie, ya resueltos. */
export function emit(kit: BrandKit, surface: BrandSurface): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of BRAND_TOKENS) if (t.surfaces.includes(surface)) out[t.name] = t.value(kit);
  return out;
}

/** Los tokens de una superficie como cuerpo de una declaración CSS. */
export function emitCss(kit: BrandKit, surface: BrandSurface): string {
  return Object.entries(emit(kit, surface))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

export function brandFormVars(kit: BrandKit): Record<string, string> {
  return emit(kit, "form");
}

export function brandPrintVars(kit: BrandKit): Record<string, string> {
  return emit(kit, "print");
}

/**
 * Las caras que hay que CARGAR para este kit. Vacío si el kit no eligió fuente.
 *
 * ⚠️ Sin esto, `brandFontStacks` era decorativo: nombraba una familia que el visitante no
 * tiene instalada. Toda superficie que emita el `font-family` tiene que emitir también
 * estas caras, y hay un test que lo exige (T5).
 */
export function brandFaces(kit: BrandKit): FaceSpec[] {
  const out: FaceSpec[] = [];
  const add = (slot: "heading" | "body") => {
    const custom = slot === "heading" ? kit.fonts?.headingUrl : kit.fonts?.bodyUrl;
    if (custom) {
      out.push({ family: CUSTOM_FAMILY[slot], src: custom, diskFile: null });
      return;
    }
    const def = fontById(slot === "heading" ? kit.fonts?.heading : kit.fonts?.body);
    if (def) out.push({ family: def.family, src: `/fonts/${def.file}`, diskFile: def.file });
  };
  add("heading");
  add("body");
  // Una sola cara si las dos ranuras apuntan a la misma familia.
  return out.filter((f, i) => out.findIndex((o) => o.family === f.family) === i);
}

/** Familias con respaldo, para CSS. */
export function brandFontStacks(kit: BrandKit): { heading: string; body: string } {
  const pick = (slot: "heading" | "body"): string => {
    const custom = slot === "heading" ? kit.fonts?.headingUrl : kit.fonts?.bodyUrl;
    if (custom) return `"${CUSTOM_FAMILY[slot]}", `;
    const def = fontById(slot === "heading" ? kit.fonts?.heading : kit.fonts?.body);
    return def ? `"${def.family}", ` : "";
  };
  // Sin fuente elegida, el respaldo de los TÍTULOS lo decide el tono: "elegant" y "warm"
  // caen en serif, el resto en sans. Es la otra mitad de lo que hace visible al tono.
  return {
    heading: `${pick("heading")}${tuning(kit).serif ? FALLBACK.serif : FALLBACK.sans}`,
    body: `${pick("body")}${FALLBACK.sans}`,
  };
}

/**
 * Los `@font-face` de este kit.
 *
 * ⚠️ `base` NO es opcional por capricho: el formulario público se sirve dentro de un
 * iframe con CSP `sandbox` sin `allow-same-origin`, o sea ORIGEN OPACO. Una ruta
 * relativa `/fonts/x.woff2` se resolvería contra el host del iframe y la fuente daría
 * 404 en silencio — la misma razón por la que `submitUrl` y `uploadUrl` son absolutas.
 * Quien renderiza en el mismo origen (la app) pasa `""`.
 */
export function brandFaceCss(kit: BrandKit, base = ""): string {
  return brandFaces(kit)
    .map((f) => faceCss(f.family, f.src.startsWith("/") ? `${base}${f.src}` : f.src))
    .join("\n");
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
  // La rampa completa, con los nombres que Tailwind SÍ conoce. Antes aquí iba
  // `--radius-DEFAULT`, un nombre inventado: `.rounded` seguía compilando a `0.25rem`
  // literal y el tono no llegaba a un solo artefacto.
  const shape = Object.entries(emit(kit, "artifact"))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  // Las caras van FUERA del `@theme`: `@font-face` es una at-rule de nivel superior y
  // dentro del bloque de tema el compilador la descartaría en silencio.
  const faces = brandFaceCss(kit);
  return `${faces ? faces + "\n" : ""}@theme {
${vars}
${extras}
${shape}
  --font-heading: ${f.heading};
  --font-body: ${f.body};
  --font-sans: ${f.body};
  --font-serif: ${f.heading};
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
