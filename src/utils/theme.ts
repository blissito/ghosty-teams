// ── Theming: preset (paleta) × scheme × tamaño × fuente × movimiento ────────
// Fuente ÚNICA de verdad: la tabla PRESETS. Cada preset trae paleta clara/oscura y
// una fuente sugerida. Todo se aplica como variables inline en <html> (--color-*,
// --font-sans) + atributos (data-theme/data-preset/data-reduce-motion) y el root
// font-size (escala toda la UI). Los componentes no cambian: usan bg-surface / bg-brand.
//
// ➕ Añadir un preset = agregar UN objeto a PRESETS. Nada de CSS ni de boot.

export type ThemeScheme = "system" | "light" | "dark";
export type TextSize = "tiny" | "regular" | "large" | "xl";
export type FontChoice = "default" | "serif" | "mono";
type FontKind = "sans" | "serif" | "mono";

type Palette = {
  brand: string; "brand-2": string; "brand-fg": string;
  surface: string; "surface-2": string; "surface-3": string;
  border: string; ink: string; muted: string;
};

export type ThemePreset = {
  id: string;
  label: string;
  font: FontKind; // fuente propia del estilo (cuando Font = "default")
  light: Palette;
  dark: Palette;
};

// El preset que CEDE ante la marca del workspace (/api/brand-css). Es el default de
// fábrica —un workspace con kit se ve como su marca sin que nadie configure nada— pero
// es UNA OPCIÓN MÁS: elegir cualquier otra (incluida "Ghosty") gana, y esa elección es
// PERSONAL. Antes este papel lo hacía `ghosty`, así que "Default" no significaba la
// paleta de Ghosty sino "lo que el dueño haya puesto": mutaba cuando el dueño tocaba el
// kit, y todo el que no hubiera elegido preset veía la marca del dueño en vez de la suya.
export const BRAND_PRESET_ID = "brand";

// Sólo para la tarjeta del selector: la marca real la sirve la hoja, no esta paleta.
export const BRAND_PRESET: ThemePreset = {
  id: BRAND_PRESET_ID, label: "Workspace", font: "sans",
  light: { brand: "#7c3aed", "brand-2": "#a78bfa", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f6f5fb", "surface-3": "#ecebf6", border: "#e4e2f0", ink: "#1c1b22", muted: "#6b6975" },
  dark: { brand: "#a78bfa", "brand-2": "#7c3aed", "brand-fg": "#14121a", surface: "#14121a", "surface-2": "#1c1a25", "surface-3": "#272536", border: "#302d3f", ink: "#f2f1f7", muted: "#9995ad" },
};

export const PRESETS: ThemePreset[] = [
  { id: "ghosty", label: "Ghosty", font: "sans",
    light: { brand: "#7c3aed", "brand-2": "#a78bfa", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f6f5fb", "surface-3": "#ecebf6", border: "#e4e2f0", ink: "#1c1b22", muted: "#6b6975" },
    dark: { brand: "#a78bfa", "brand-2": "#7c3aed", "brand-fg": "#14121a", surface: "#14121a", "surface-2": "#1c1a25", "surface-3": "#272536", border: "#302d3f", ink: "#f2f1f7", muted: "#9995ad" } },
  { id: "slate", label: "Slate", font: "sans",
    light: { brand: "#4f46e5", "brand-2": "#818cf8", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f1f5f9", "surface-3": "#e2e8f0", border: "#d3dbe6", ink: "#0f172a", muted: "#64748b" },
    dark: { brand: "#818cf8", "brand-2": "#4f46e5", "brand-fg": "#0b1220", surface: "#0f172a", "surface-2": "#1e293b", "surface-3": "#334155", border: "#334155", ink: "#f1f5f9", muted: "#94a3b8" } },
  { id: "dieter", label: "Dieter Rams", font: "sans",
    light: { brand: "#cc5500", "brand-2": "#f59e0b", "brand-fg": "#ffffff", surface: "#fafaf9", "surface-2": "#f5f5f4", "surface-3": "#e7e5e4", border: "#d6d3d1", ink: "#1c1917", muted: "#78716c" },
    dark: { brand: "#f59e0b", "brand-2": "#cc5500", "brand-fg": "#1c1917", surface: "#1c1917", "surface-2": "#292524", "surface-3": "#44403c", border: "#44403c", ink: "#fafaf9", muted: "#a8a29e" } },
  { id: "ocean", label: "Ocean", font: "sans",
    light: { brand: "#0891b2", "brand-2": "#22d3ee", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f0f9fb", "surface-3": "#e0f2f7", border: "#cde8ee", ink: "#0c2830", muted: "#5b7681" },
    dark: { brand: "#22d3ee", "brand-2": "#0891b2", "brand-fg": "#06232b", surface: "#0a2229", "surface-2": "#0f2f38", "surface-3": "#164450", border: "#1d4c58", ink: "#e6f6fb", muted: "#85b0bb" } },
  { id: "forest", label: "Forest", font: "sans",
    light: { brand: "#059669", "brand-2": "#34d399", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f0fdf4", "surface-3": "#dcfce7", border: "#cbe8d3", ink: "#08271a", muted: "#5b7a68" },
    dark: { brand: "#34d399", "brand-2": "#059669", "brand-fg": "#052117", surface: "#0a2018", "surface-2": "#0f2c20", "surface-3": "#16412f", border: "#1d4a37", ink: "#e7f7ef", muted: "#86b3a0" } },
  { id: "rose", label: "Rose", font: "sans",
    light: { brand: "#e11d48", "brand-2": "#fb7185", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#fff1f2", "surface-3": "#ffe4e6", border: "#fecdd3", ink: "#300711", muted: "#8a5b63" },
    dark: { brand: "#fb7185", "brand-2": "#e11d48", "brand-fg": "#2b0710", surface: "#1f0a0f", "surface-2": "#2b1016", "surface-3": "#3f1721", border: "#4a1d28", ink: "#f9e9ec", muted: "#b38a92" } },
  { id: "paper", label: "Paper", font: "serif",
    light: { brand: "#9a6b3f", "brand-2": "#c4915c", "brand-fg": "#ffffff", surface: "#faf7f0", "surface-2": "#f3ede1", "surface-3": "#e8dfce", border: "#ddd2bd", ink: "#2b2620", muted: "#6f6656" },
    dark: { brand: "#c4915c", "brand-2": "#9a6b3f", "brand-fg": "#201b14", surface: "#201b14", "surface-2": "#2a241b", "surface-3": "#3a3226", border: "#3f3628", ink: "#f2ece0", muted: "#a99a82" } },
  { id: "ink", label: "Ink", font: "sans",
    light: { brand: "#171717", "brand-2": "#525252", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f5f5f5", "surface-3": "#e5e5e5", border: "#d4d4d4", ink: "#0a0a0a", muted: "#737373" },
    dark: { brand: "#e5e5e5", "brand-2": "#a3a3a3", "brand-fg": "#0a0a0a", surface: "#0a0a0a", "surface-2": "#171717", "surface-3": "#262626", border: "#2e2e2e", ink: "#fafafa", muted: "#8f8f8f" } },
  { id: "terminal", label: "Terminal", font: "mono",
    light: { brand: "#15803d", "brand-2": "#16a34a", "brand-fg": "#ffffff", surface: "#f7f8f7", "surface-2": "#ecefec", "surface-3": "#dde3dd", border: "#cdd6cd", ink: "#14261a", muted: "#5c6b60" },
    dark: { brand: "#22c55e", "brand-2": "#16a34a", "brand-fg": "#041007", surface: "#041007", "surface-2": "#08200f", "surface-3": "#0c3016", border: "#10401d", ink: "#b9f7c9", muted: "#5fae74" } },
  { id: "neon", label: "Neon", font: "mono",
    light: { brand: "#db2777", "brand-2": "#06b6d4", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#fdf2f8", "surface-3": "#fce7f3", border: "#f5d0e5", ink: "#2a0a1c", muted: "#8a5b74" },
    dark: { brand: "#f0abfc", "brand-2": "#22d3ee", "brand-fg": "#16011f", surface: "#0d0714", "surface-2": "#160c22", "surface-3": "#241436", border: "#33204a", ink: "#f5e9ff", muted: "#b596d6" } },
  { id: "solarized", label: "Solarized", font: "mono",
    light: { brand: "#268bd2", "brand-2": "#2aa198", "brand-fg": "#fdf6e3", surface: "#fdf6e3", "surface-2": "#eee8d5", "surface-3": "#e3ddc7", border: "#d8d0b8", ink: "#073642", muted: "#93a1a1" },
    dark: { brand: "#268bd2", "brand-2": "#2aa198", "brand-fg": "#002b36", surface: "#002b36", "surface-2": "#073642", "surface-3": "#0d4552", border: "#14515f", ink: "#eee8d5", muted: "#93a1a1" } },
  { id: "protanopia", label: "Protanopia", font: "sans",
    light: { brand: "#0072b2", "brand-2": "#e69f00", "brand-fg": "#ffffff", surface: "#ffffff", "surface-2": "#f2f4f7", "surface-3": "#e6eaf0", border: "#d4dae3", ink: "#10151c", muted: "#5b6675" },
    dark: { brand: "#56b4e9", "brand-2": "#e69f00", "brand-fg": "#0a1017", surface: "#0c1017", "surface-2": "#141a23", "surface-3": "#1e2732", border: "#2a3542", ink: "#eef2f7", muted: "#94a3b5" } },
];

export const FONT_STACKS: Record<FontKind, string> = {
  sans: `"Inter", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`,
  serif: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif`,
  mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`,
};

const TEXT_SCALE: Record<TextSize, string> = { tiny: "14px", regular: "16px", large: "18px", xl: "20px" };

export type ThemeState = {
  preset: string;
  scheme: ThemeScheme;
  textSize: TextSize;
  font: FontChoice;
  reduceMotion: boolean;
  darkSidebar: boolean;
};

const KEYS = {
  preset: "gc.preset", scheme: "gc.scheme", textSize: "gc.textSize",
  font: "gc.font", reduceMotion: "gc.reduceMotion", darkSidebar: "gc.darkSidebar",
};

// ── Migración, una sola vez ─────────────────────────────────────────────────
// `setThemePartial` escribe TODAS las llaves, así que quien tocó cualquier ajuste tiene
// `gc.preset:"ghosty"` guardado sin haber elegido nunca un estilo. Con la semántica nueva
// eso significaría "quiero la paleta de Ghosty" y le quitaría la marca a medio workspace.
// Un `ghosty` heredado se reinterpreta como `brand`, que es lo que de hecho veía.
const MIGRATED = "gc.preset.v2";
function migratePreset(): void {
  try {
    if (localStorage.getItem(MIGRATED)) return;
    localStorage.setItem(MIGRATED, "1");
    if (localStorage.getItem(KEYS.preset) === "ghosty") localStorage.setItem(KEYS.preset, BRAND_PRESET_ID);
  } catch {}
}

export function readTheme(): ThemeState {
  if (typeof localStorage === "undefined")
    return { preset: BRAND_PRESET_ID, scheme: "system", textSize: "regular", font: "default", reduceMotion: false, darkSidebar: false };
  migratePreset(); // red por si el boot no corrió (p.ej. hidratación sin el shell)
  return {
    preset: localStorage.getItem(KEYS.preset) || BRAND_PRESET_ID,
    scheme: (localStorage.getItem(KEYS.scheme) as ThemeScheme) || "system",
    textSize: (localStorage.getItem(KEYS.textSize) as TextSize) || "regular",
    font: (localStorage.getItem(KEYS.font) as FontChoice) || "default",
    reduceMotion: localStorage.getItem(KEYS.reduceMotion) === "1",
    darkSidebar: localStorage.getItem(KEYS.darkSidebar) === "1",
  };
}

export function resolveDark(scheme: ThemeScheme): boolean {
  if (scheme === "dark") return true;
  if (scheme === "light") return false;
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

// ── La marca del workspace, del lado del cliente ────────────────────────────
// La app NO necesita el kit para pintarse: la hoja `/api/brand-css` ya lo hace, antes del
// primer paint y sin JS. Hace falta para los dos sitios que aplican una paleta a MANO,
// donde la cascada no llega: la muestra de la tarjeta "Workspace" en Ajustes y el SIDEBAR
// OSCURO sobre tema claro (vars inline en un subárbol). Sin esto los dos usaban una paleta
// de relleno, así que un workspace con marca verde enseñaba una muestra violeta y un
// sidebar violeta — se leía como que el tema no había cambiado.
//
// Se lee de la MISMA hoja, no de un endpoint nuevo: una sola fuente de la marca.
let brandPalette: ThemePreset | null = null;

export function loadBrandPalette(): void {
  if (brandPalette || typeof fetch === "undefined") return;
  const vars = (block: string) => {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;}]+)/g)) out[m[1]] = m[2].trim();
    return out;
  };
  fetch("/api/brand-css")
    .then((r) => r.text())
    .then((css) => {
      const light = css.match(/:root:root\{([^}]*)\}/)?.[1];
      if (!light) return; // workspace sin kit: la paleta de relleno ES la de Ghosty
      const dark = css.match(/:root:root\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? light;
      brandPalette = {
        ...BRAND_PRESET,
        light: { ...BRAND_PRESET.light, ...vars(light) } as Palette,
        dark: { ...BRAND_PRESET.dark, ...vars(dark) } as Palette,
      };
      listeners.forEach((l) => l()); // repinta la muestra y el sidebar sin recargar
    })
    .catch(() => {});
}

export function presetById(id: string): ThemePreset {
  if (id === BRAND_PRESET_ID) return brandPalette ?? BRAND_PRESET;
  return PRESETS.find((p) => p.id === id) ?? brandPalette ?? BRAND_PRESET;
}

// Variables inline de una paleta (para aplicar a <html> o a un subárbol, ej. sidebar).
export function paletteVars(preset: ThemePreset, dark: boolean): Record<string, string> {
  const pal = dark ? preset.dark : preset.light;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pal)) out[`--color-${k}`] = v;
  // ⚠️ `card` NO está en la paleta: se deriva. Es la superficie de una tarjeta, y la regla
  // es que en claro sea la MISMA que la página (la tarjeta se define por su borde, no por
  // un relleno gris) y en oscuro suba un escalón, porque ahí la elevación es luminosidad y
  // no sombra.
  //
  // En `styles.css` esto se resuelve solo, con `var(--color-surface)` y un override en el
  // bloque oscuro. Aquí hay que escribirlo a mano por un caso concreto: el SIDEBAR OSCURO
  // sobre tema claro (`c.$slug.tsx`) aplica estas variables inline a un SUBÁRBOL. Como
  // `--color-card` se computa en `:root`, sin esta línea seguiría apuntando a la superficie
  // CLARA y toda tarjeta dentro del sidebar oscuro saldría blanca.
  out["--color-card"] = dark ? pal["surface-2"] : pal.surface;
  return out;
}

export function applyTheme(s: ThemeState): void {
  if (typeof document === "undefined") return;
  const preset = presetById(s.preset);
  const dark = resolveDark(s.scheme);
  const r = document.documentElement;
  r.setAttribute("data-theme", dark ? "dark" : "light");
  const isBrand = preset.id === BRAND_PRESET_ID;
  if (!isBrand) r.setAttribute("data-preset", preset.id);
  else r.removeAttribute("data-preset");
  // SÓLO "Marca del workspace" cede: no escribe inline y deja que mande el CSS, que es
  // donde entra la marca (/api/brand-css, servida por tenant). Un estilo inline le gana a
  // cualquier hoja, así que escribir una paleta aquí haría invisible al kit.
  // Cualquier otro preset —Ghosty incluido— SÍ pisa la marca: es una preferencia PERSONAL
  // y tiene que ganarle a lo que el dueño del workspace haya configurado.
  if (isBrand) {
    for (const k of Object.keys(paletteVars(preset, dark))) r.style.removeProperty(k);
  } else {
    for (const [k, v] of Object.entries(paletteVars(preset, dark))) r.style.setProperty(k, v);
  }
  // Fuente: con la marca activa no se escribe inline (taparía su tipografía). Con un preset
  // personal, "default" significa la fuente DEL PRESET — si no, la familia de la marca se
  // colaba en un tema que la persona eligió justamente para no verla.
  if (s.font !== "default") r.style.setProperty("--font-sans", FONT_STACKS[s.font]);
  else if (isBrand) r.style.removeProperty("--font-sans");
  else r.style.setProperty("--font-sans", FONT_STACKS[preset.font]);
  if (isBrand) r.style.removeProperty("--font-brand-heading");
  else r.style.setProperty("--font-brand-heading", FONT_STACKS[s.font === "default" ? preset.font : s.font]);
  // Tamaño: escala TODO (Tailwind usa rem para texto y spacing).
  r.style.fontSize = TEXT_SCALE[s.textSize];
  // Movimiento reducido (forzado por el usuario; el sistema se respeta vía @media).
  if (s.reduceMotion) r.setAttribute("data-reduce-motion", "1");
  else r.removeAttribute("data-reduce-motion");
}

// ── Store reactivo mínimo (sin dependencias) ────────────────────────────────
let current: ThemeState | null = null;
const listeners = new Set<() => void>();

export function getTheme(): ThemeState {
  if (!current) current = readTheme();
  return current;
}

export function setThemePartial(patch: Partial<ThemeState>): void {
  const next = { ...getTheme(), ...patch };
  current = next;
  try {
    localStorage.setItem(KEYS.preset, next.preset);
    localStorage.setItem(KEYS.scheme, next.scheme);
    localStorage.setItem(KEYS.textSize, next.textSize);
    localStorage.setItem(KEYS.font, next.font);
    localStorage.setItem(KEYS.reduceMotion, next.reduceMotion ? "1" : "0");
    localStorage.setItem(KEYS.darkSidebar, next.darkSidebar ? "1" : "0");
  } catch {}
  applyTheme(next);
  listeners.forEach((l) => l());
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Cuando el scheme es "system", re-aplica al cambiar la preferencia del SO en vivo.
export function watchSystemScheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const s = getTheme();
    if (s.scheme === "system") {
      applyTheme(s);
      listeners.forEach((l) => l());
    }
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

// Script INLINE en <head> (antes del primer paint) → sin FOUC. JS puro autocontenido.
export const THEME_BOOT = `(function(){try{
var P=${JSON.stringify(Object.fromEntries(PRESETS.map((p) => [p.id, { light: p.light, dark: p.dark, font: p.font }])))};
var F=${JSON.stringify(FONT_STACKS)};
var T=${JSON.stringify(TEXT_SCALE)};
var g=function(k,d){return localStorage.getItem(k)||d};
// Migración v2 (ver migratePreset): un 'ghosty' heredado significaba "la marca".
if(!localStorage.getItem('${MIGRATED}')){localStorage.setItem('${MIGRATED}','1');
if(localStorage.getItem('${KEYS.preset}')==='ghosty')localStorage.setItem('${KEYS.preset}','${BRAND_PRESET_ID}');}
var id=g('${KEYS.preset}','${BRAND_PRESET_ID}');var sc=g('${KEYS.scheme}','system');
var ts=g('${KEYS.textSize}','regular');var fo=g('${KEYS.font}','default');
var rm=localStorage.getItem('${KEYS.reduceMotion}')==='1';
var dark=sc==='dark'||(sc==='system'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);
var pr=P[id];var br=!pr;var r=document.documentElement;
r.setAttribute('data-theme',dark?'dark':'light');
if(!br)r.setAttribute('data-preset',id);else r.removeAttribute('data-preset');
// Ver applyTheme: SÓLO "Marca del workspace" no escribe inline, para no taparle el kit.
if(!br){var pal=dark?pr.dark:pr.light;for(var k in pal)r.style.setProperty('--color-'+k,pal[k]);
r.style.setProperty('--color-card',dark?pal['surface-2']:pal.surface);
var ff=F[fo!=='default'?fo:pr.font];r.style.setProperty('--font-sans',ff);r.style.setProperty('--font-brand-heading',ff);}
else if(fo!=='default')r.style.setProperty('--font-sans',F[fo]);
r.style.fontSize=T[ts]||T.regular;
if(rm)r.setAttribute('data-reduce-motion','1');
}catch(e){}})();`;
