import { createServerFn } from "@tanstack/react-start";

// Link unfurling (estilo Slack/WhatsApp): fetch server-side de la URL + parseo de meta
// tags OG/Twitter → tarjeta {title, description, image, site}. Server-side para evitar
// CORS y NO filtrar la IP del viewer. Cache en memoria por URL (TTL) + timeout corto.
// Solo http(s), sin deps (regex sobre el <head>).

type Unfurl = { url: string; title?: string; description?: string; image?: string; site?: string; favicon?: string } | null;
const cache = new Map<string, { at: number; data: Unfurl }>();
const TTL = 60 * 60 * 1000; // 1h

function metaTag(html: string, keys: string[]): string | undefined {
  for (const k of keys) {
    // property/name en cualquier orden respecto a content.
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${k}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return undefined;
}
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'");
}
/**
 * Favicon del sitio. Sale de ACÁ y no de `google.com/s2/favicons`: ese atajo le
 * contaría a Google qué está leyendo el equipo en cada mensaje que trae un link.
 * Si el head no lo declara, se apuesta al /favicon.ico del origen — si tampoco
 * existe, el chip cae al dominio a secas (no rompe nada).
 */
function faviconFrom(head: string, base: string): string | undefined {
  const m =
    head.match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]+href=["']([^"']+)["']/i) ||
    head.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*\bicon\b[^"']*["']/i);
  const declared = absolutize(m?.[1], base);
  if (declared) return declared;
  try {
    return new URL("/favicon.ico", base).href;
  } catch {
    return undefined;
  }
}

function absolutize(u: string | undefined, base: string): string | undefined {
  if (!u) return undefined;
  try { return new URL(u, base).href; } catch { return undefined; }
}

export const unfurlLinkFn = createServerFn({ method: "GET" })
  .validator((d: { url: string }) => d)
  .handler(async ({ data }): Promise<Unfurl> => {
    const url = data.url;
    if (!/^https?:\/\//i.test(url)) return null;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL) return hit.data;

    let data2: Unfurl = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "User-Agent": "GhostyTeamsBot/1.0 (+link preview)", Accept: "text/html,application/xhtml+xml" },
      }).finally(() => clearTimeout(to));
      const ctype = res.headers.get("content-type") || "";
      if (res.ok && ctype.includes("text/html")) {
        // Solo el <head> (más chico + suficiente para OG). Cap a 512KB por si acaso.
        const raw = (await res.text()).slice(0, 512 * 1024);
        const head = raw.slice(0, (raw.search(/<\/head>/i) + 1) || raw.length);
        const title = metaTag(head, ["og:title", "twitter:title"]) || (head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decodeEntities(head.match(/<title[^>]*>([^<]*)<\/title>/i)![1].trim()) : undefined);
        const description = metaTag(head, ["og:description", "twitter:description", "description"]);
        const image = absolutize(metaTag(head, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]), res.url || url);
        const site = metaTag(head, ["og:site_name"]) || new URL(res.url || url).hostname.replace(/^www\./, "");
        const favicon = faviconFrom(head, res.url || url);
        // Basta con el favicon para que el chip de fuente valga la pena: un link
        // sin OG igual se pinta con su icono y su dominio.
        if (title || description || image || favicon) data2 = { url, title, description, image, site, favicon };
      }
    } catch { /* timeout/red/parse → sin preview */ }
    cache.set(url, { at: Date.now(), data: data2 });
    return data2;
  });
