// ── sRGB ⇄ OKLab/OKLCh ──────────────────────────────────────────────────────
//
// Mezclar en sRGB apaga los puntos medios: el punto medio entre dos colores saturados
// sale gris sucio, y una rampa de luminosidad da pasos desiguales. OKLab es perceptual,
// así que una mezcla al 50% se VE a medio camino. Es a donde se movieron Tailwind v4,
// shadcn y Radix.
//
// ⚠️ La LUMINANCIA de WCAG **no** se calcula aquí: su fórmula está definida sobre sRGB
// linealizado y es normativa. `luminance()`/`contrast()` de brand-tokens se quedan como
// están; lo que cambia es la MEZCLA y la derivación de superficies.
//
// Fórmulas de Björn Ottosson (2020), dominio público.

export type Rgb = { r: number; g: number; b: number };
export type Oklab = { L: number; a: number; b: number };

const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const g = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklab({ r, g: gr, b }: Rgb): Oklab {
  const R = f(r / 255);
  const G = f(gr / 255);
  const B = f(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, g(v) * 255)));
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** OKLCh: L (0-1), croma y tono en grados. Es lo cómodo para "el mismo color pero…". */
export function oklabToOklch({ L, a, b }: Oklab): { L: number; C: number; h: number } {
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function oklchToOklab(L: number, C: number, h: number): Oklab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}
