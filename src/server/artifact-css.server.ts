/**
 * HORNEA el CSS de Tailwind dentro del artefacto al publicarlo.
 *
 * El agente genera artefactos con `<script src="https://cdn.tailwindcss.com">`, que compila
 * las clases EN EL NAVEGADOR — después del `load` del iframe. Resultado: cada apertura del
 * panel pintaba un primer frame con el HTML crudo (blobs gigantes, títulos encimados, botones
 * estirados) y luego saltaba al layout bueno. Compilando el CSS acá el artefacto abre ya
 * estilado, carga más rápido y funciona sin red.
 *
 * El <script> del CDN se CONSERVA detrás del <style> horneado: un artefacto que arma clases
 * en JS (`el.className = "bg-" + color`) genera candidatos que no existen en el HTML estático,
 * y el CDN los sigue resolviendo en runtime. Lo horneado mata el destello; el CDN, el resto.
 */
import { compile } from "tailwindcss";
import { type BrandKit, brandThemeCss } from "../lib/brand-tokens";
import { TAILWIND_INDEX_CSS as indexCss } from "./tailwind-index-css";

const CDN_RE = /<script[^>]*src=["']https?:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*>\s*<\/script>/i;
const MARK = "gt-baked-tw";
const BAKED_RE = /<style gt-baked-tw>[\s\S]*?<\/style>\s*/gi;

/**
 * Candidatos para el compilador. Tailwind DESCARTA lo que no es una utilidad válida, así que
 * conviene ser generoso: barremos todo el documento (no solo los `class=`), lo que de paso
 * atrapa clases escritas dentro de strings de JS.
 */
function candidatesFrom(html: string): string[] {
  const out = new Set<string>();
  for (const tok of html.match(/[^\s"'`<>={}();]+/g) ?? []) {
    if (tok.length > 1 && tok.length < 120) out.add(tok);
  }
  return [...out];
}

/**
 * Devuelve el HTML con el CSS horneado. Ante CUALQUIER problema devuelve el original tal cual:
 * el artefacto con CDN se ve bien igual (solo con el destello), así que esto nunca debe ser
 * capaz de romper una publicación.
 */
export async function bakeTailwind(input: string, brand?: BrandKit | null): Promise<string> {
  // Un ```eb-patch``` publica el HTML ya horneado + el nodo nuevo: si respetáramos el <style>
  // viejo, las clases que trae el patch se quedarían sin CSS. Se tira y se hornea de cero.
  const html = input.replace(BAKED_RE, "");
  if (!CDN_RE.test(html)) return input;
  try {
    const t0 = performance.now();
    // El `@theme` de la marca se ANTEPONE al index: así `bg-brand`, `text-ink` o
    // `font-heading` de un artefacto salen con los colores del workspace, y el kit no
    // puede pisar utilidades de Tailwind — sólo define tokens.
    //
    // ⚠️ Va HORNEADO y no inyectado desde el padre: el iframe se sirve con CSP `sandbox`
    // sin `allow-same-origin` (artefacto.$id.raw.ts), o sea que nadie puede meterle CSS
    // después. Y por eso mismo un artefacto ya publicado conserva la marca con la que
    // nació hasta que se vuelva a publicar.
    const source = brand ? `${brandThemeCss(brand)}\n${indexCss}` : indexCss;
    const compiler = await compile(source, { base: "/" });
    const css = compiler.build(candidatesFrom(html));
    if (!css || css.length < 200) return input;
    const style = `<style ${MARK}>\n${css}\n</style>\n`;
    // El <style> va ANTES del script del CDN → el primer paint ya sale estilado.
    const out = html.replace(CDN_RE, (m) => style + m);
    console.log(
      `[artifact bake] ${Math.round(performance.now() - t0)}ms css=${css.length}b`
    );
    return out;
  } catch (e) {
    console.error("[artifact bake] falló, se publica con CDN", e);
    return input;
  }
}
