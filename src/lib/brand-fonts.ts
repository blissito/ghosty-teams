// ── Catálogo de fuentes de marca ────────────────────────────────────────────
//
// ⚠️ Esto existe porque el campo de texto libre anterior era decorativo: se guardaba
// "Playfair Display", se emitía `font-family:"Playfair Display"` y NADIE cargaba el
// archivo. El navegador pedía una familia que el visitante no tiene y caía al respaldo en
// silencio — el mismo fallo que `--radius-DEFAULT`, pero en tipografía.
//
// Auto-hospedadas y NO Google Fonts, por tres razones concretas:
//   · el formulario público lo abre el cliente DEL cliente: su visita no se manda a un
//     tercero sin que nadie lo haya pedido;
//   · `render-svc` (el Chromium que imprime los PDF) no tiene salida garantizada, así que
//     por CDN el PDF saldría con otra tipografía que la web — y eso no se nota hasta que
//     alguien compara los dos;
//   · un `@font-face` a disco funciona sin red y no caduca.
//
// Todas son variables (un archivo cubre 400–700), así que `font-weight: 400 700` en el
// `@font-face` es correcto y no hace falta un archivo por peso.

export type FontKind = "sans" | "serif" | "mono";

export type BrandFontDef = {
  id: string;
  /** El nombre real de la familia: es lo que va en `font-family`. */
  family: string;
  file: string;
  kind: FontKind;
};

export const BRAND_FONTS: readonly BrandFontDef[] = [
  { id: "inter", family: "Inter", file: "inter-v12-latin-regular.woff2", kind: "sans" },
  { id: "dm-sans", family: "DM Sans", file: "dm-sans.woff2", kind: "sans" },
  { id: "work-sans", family: "Work Sans", file: "work-sans.woff2", kind: "sans" },
  { id: "plex-sans", family: "IBM Plex Sans", file: "plex-sans.woff2", kind: "sans" },
  { id: "space-grotesk", family: "Space Grotesk", file: "space-grotesk.woff2", kind: "sans" },
  { id: "nunito", family: "Nunito", file: "nunito.woff2", kind: "sans" },
  // Montserrat entra por una exigencia REAL, no por gusto: es la tipográfica que el
  // manual de imagen del Gobierno de Hidalgo fija para títulos y cuerpo de texto en toda
  // su papelería, y sin ella el kit de una dependencia no puede cumplir su propio manual.
  // (Su compañera GMX es una fuente de encargo, sólo para títulos, y no se distribuye.)
  { id: "montserrat", family: "Montserrat", file: "montserrat.woff2", kind: "sans" },
  { id: "playfair", family: "Playfair Display", file: "playfair.woff2", kind: "serif" },
  { id: "lora", family: "Lora", file: "lora.woff2", kind: "serif" },
  { id: "source-serif", family: "Source Serif 4", file: "source-serif.woff2", kind: "serif" },
  { id: "jetbrains-mono", family: "JetBrains Mono", file: "jetbrains-mono.woff2", kind: "mono" },
] as const;

export function fontById(id?: string | null): BrandFontDef | null {
  return BRAND_FONTS.find((f) => f.id === id) ?? null;
}

/** Familia sintética de una fuente subida por el cliente. */
export const CUSTOM_FAMILY = { heading: "GT Brand Heading", body: "GT Brand Body" } as const;

export const FALLBACK: Record<FontKind, string> = {
  sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
  serif: `"Iowan Old Style", Georgia, serif`,
  mono: `ui-monospace, SFMono-Regular, Menlo, monospace`,
};

/** Una cara a cargar: qué familia, de qué archivo. */
export type FaceSpec = {
  family: string;
  /** Ruta pública (`/fonts/x.woff2`) o URL absoluta de una fuente subida. */
  src: string;
  /** Ruta en disco, para incrustar en base64 en el PDF. null si es subida. */
  diskFile: string | null;
};

/** El `@font-face` de una cara. `src` ya resuelto (url pública o data:). */
export function faceCss(family: string, src: string): string {
  // `font-display: swap` y no `block`: en un formulario público es preferible ver el
  // texto en la fuente de respaldo a ver un hueco mientras carga.
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:400 700;font-display:swap;src:url(${src}) format("woff2")}`;
}
