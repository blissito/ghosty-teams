// ── Sacar la marca de una página o de un logo ───────────────────────────────
//
// El método es el de EasyBits y es el único que da resultados fiables: SCRAPING
// determinista primero, y si hay modelo, sólo para CLASIFICAR entre los colores que ya
// se encontraron. Un modelo al que se le pide "dame los colores de esta marca" devuelve
// morados genéricos plausibles; uno al que se le da una lista y se le pide ordenarla, no
// puede inventar.
//
// Diferencia de implementación: aquí no hay Playwright ni pool de navegadores, así que se
// lee el HTML y las hojas enlazadas con `fetch`.
// ⚠️ Eso significa que un sitio que pinta TODO con JS no da colores. Se detecta y se dice
// (el panel enseña el aviso); el plan B, si resulta común, es un endpoint en Studio, que sí
// tiene Chromium en `render-svc`.

import { type BrandColors, isHex, normalizeHex } from "#/lib/brand-tokens";

const UA = "Mozilla/5.0 (compatible; GhostyTeams/1.0; +https://ghosty.studio)";
const MAX_BYTES = 1_500_000;
const TIMEOUT = 12_000;

async function grab(url: string, accept: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new TextDecoder().decode(buf.slice(0, MAX_BYTES));
  } catch {
    return null;
  }
}

/** Normaliza `#rgb`, `#rrggbb` y `rgb()` a `#rrggbb`. Devuelve null para lo demás. */
function readColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (isHex(s)) return normalizeHex(s);
  const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return null;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

// Casi-blancos y casi-negros no son la marca de nadie: son papel y tinta. Descartarlos es
// lo que evita que el "color principal" salga #ffffff en la mitad de los sitios.
function isNeutral(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 18) return true; // gris
  return max > 245 || max < 16;
}

function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export type ExtractResult = {
  name: string | null;
  colors: BrandColors;
  fonts: { heading?: string; body?: string } | null;
  logoKey: string | null;
  logoUrl: string | null;
};

export async function extractFromUrl(rawUrl: string): Promise<ExtractResult> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const origin = new URL(url).toString();
  const html = await grab(url, "text/html");
  if (!html) throw new Error("no pude abrir esa página");

  // ── CSS: el de la página más el de las hojas enlazadas (tope 4: el resto son
  // frameworks y no aportan la marca).
  const sheets = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
    .filter(Boolean)
    .map((h) => absolute(h as string, origin))
    .filter(Boolean)
    .slice(0, 4) as string[];
  const css = [
    ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
    ...(await Promise.all(sheets.map((s) => grab(s, "text/css")))),
    ...[...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1]),
  ]
    .filter(Boolean)
    .join("\n");

  // ── Colores, ponderados. Una variable de `:root` vale más que una aparición suelta:
  // quien define `--brand` está DECLARANDO su color, no usándolo de pasada.
  const score = new Map<string, number>();
  const bump = (hex: string | null, w: number) => {
    if (!hex || isNeutral(hex)) return;
    score.set(hex, (score.get(hex) ?? 0) + w);
  };
  for (const m of css.matchAll(/--[\w-]*(?:brand|primary|accent|main|theme|color)[\w-]*\s*:\s*([^;}]+)/gi)) {
    bump(readColor(m[1]), 6);
  }
  for (const m of css.matchAll(/--[\w-]+\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi)) bump(readColor(m[1]), 3);
  for (const m of css.matchAll(/(?:background(?:-color)?|border-color|fill)\s*:\s*([^;}!]+)/gi)) {
    bump(readColor(m[1]), 2);
  }
  for (const m of css.matchAll(/\bcolor\s*:\s*([^;}!]+)/gi)) bump(readColor(m[1]), 1);
  // `<meta name="theme-color">` es una declaración explícita de marca; pesa como una var.
  bump(readColor(html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)/i)?.[1] ?? ""), 6);

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  if (!ranked.length) {
    throw new Error("esa página no expone colores en su CSS (puede que los pinte con JavaScript)");
  }

  // ── Fuentes: la primera familia real de cada declaración, saltándose los genéricos.
  const families: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1].split(",")) {
      const f = part.replace(/["']/g, "").trim();
      if (!f || /^(inherit|initial|unset|var\(|-apple|system-ui|ui-|sans-serif|serif|monospace|cursive)/i.test(f)) {
        continue;
      }
      if (!families.includes(f)) families.push(f);
      break;
    }
  }

  const surface =
    readColor(css.match(/body\s*{[^}]*background(?:-color)?\s*:\s*([^;}!]+)/i)?.[1] ?? "") ?? "#ffffff";

  const colors: BrandColors = {
    primary: ranked[0],
    secondary: ranked[1] ?? ranked[0],
    accent: ranked[2] ?? ranked[1] ?? ranked[0],
    surface,
    extras: ranked.slice(0, 6).map((hex, i) => ({ name: `color-${i + 1}`, hex })),
  };

  const { key, url: logoUrl } = await findLogo(html, origin);

  return {
    name:
      html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1] ??
      html.match(/<title[^>]*>([^<]{2,60})</i)?.[1]?.split(/[|–—-]/)[0]?.trim() ??
      null,
    colors,
    fonts: families.length ? { heading: families[0], body: families[1] ?? families[0] } : null,
    logoKey: key,
    logoUrl,
  };
}

/**
 * El logo, en cascada. El orden importa: `og:image` suele ser una tarjeta social (bonita
 * pero con texto), así que va DESPUÉS de un `<img>` que se llame a sí mismo logo.
 */
async function findLogo(html: string, origin: string): Promise<{ key: string | null; url: string | null }> {
  const candidates: string[] = [];
  const push = (u?: string | null) => {
    const abs = u ? absolute(u, origin) : null;
    if (abs && !candidates.includes(abs)) candidates.push(abs);
  };

  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    if (!/logo|brand|isotipo|wordmark/i.test(tag)) continue;
    push(tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]);
  }
  push(html.match(/<meta[^>]+property=["']og:logo["'][^>]+content=["']([^"']+)/i)?.[1]);
  push(html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)/i)?.[1]);
  push(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]);
  push(html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)/i)?.[1]);

  const { putLogo } = await import("./brand.server");
  const storage = await import("./storage.server");
  for (const c of candidates.slice(0, 5)) {
    try {
      const res = await fetch(c, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      const blob = await res.blob();
      // Un icono de 16px no es un logo utilizable en un membrete.
      if (blob.size < 600) continue;
      const key = await putLogo(blob, c.split("/").pop() || "logo", type);
      return { key, url: storage.publicAssetUrl(key) };
    } catch {
      // Un candidato que falla no interrumpe la extracción: se prueba el siguiente y,
      // si ninguno sirve, se devuelven los colores igual. Media extracción es útil.
    }
  }
  return { key: null, url: null };
}

/**
 * Paleta desde un logo. Es lo que la documentación de EasyBits promete y su código no
 * implementa (reference.ts:1607 dice "URL **or image**"; no existe tal función).
 *
 * Cuantización burda a una rejilla de 6 niveles por canal sobre los píxeles OPACOS,
 * descartando neutros: en un logo lo que sobra es fondo transparente y contorno negro.
 */
export async function extractFromLogo(key: string): Promise<BrandColors | null> {
  const storage = await import("./storage.server");
  const buf = await storage.getBytes(key, "public");
  if (!buf) return null;

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    return null; // sin sharp no hay paleta; el resto del kit funciona igual
  }

  // A 64px de ancho: sobra para la paleta y hace el conteo trivial.
  const { data, info } = await sharp(buf)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3];
    if (a < 200) continue; // transparente = fondo, no marca
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const q = (v: number) => Math.round(v / 51) * 51;
    const hex = `#${[q(r), q(g), q(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (isNeutral(hex)) continue;
    const cur = bins.get(hex) ?? { n: 0, r: 0, g: 0, b: 0 };
    bins.set(hex, { n: cur.n + 1, r: cur.r + r, g: cur.g + g, b: cur.b + b });
  }

  // El promedio real de cada bin, no el centro de la rejilla: la rejilla agrupa, no define.
  const top = [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map(({ n, r, g, b }) => {
      const hx = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
      return `#${hx(r)}${hx(g)}${hx(b)}`;
    });
  if (!top.length) return null;

  return {
    primary: top[0],
    secondary: top[1] ?? top[0],
    accent: top[2] ?? top[1] ?? top[0],
    surface: "#ffffff",
  };
}
