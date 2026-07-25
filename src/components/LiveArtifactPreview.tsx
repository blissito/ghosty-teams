import { useEffect, useRef } from "react";

// PREVIEW EN VIVO **SIN IFRAME**: el HTML parcial del agente se pinta como DOM REAL
// dentro del panel, igual que hace el editor con el artefacto.
//
// Por qué no iframe: un iframe obliga a elegir entre re-emitir `srcDoc` (remonta el
// documento y reinicia el parser en cada actualización → nunca alcanza a pintar) o
// servir el HTML por HTTP en chunks (funciona, pero el pintado queda en manos del
// navegador y es opaco desde fuera). Con DOM propio no hay documento que reiniciar:
// cada actualización es innerHTML sobre un contenedor y el navegador repinta al
// instante. Es el mismo montaje que ya se comprobó en el editor.
//
// Coste consciente: aquí NO se ejecuta el <script> del artefacto (se elimina). Es un
// PREVIEW de construcción — el resultado interactivo se ve al terminar. A cambio se ve
// crecer de verdad, que es el punto.
declare global {
  interface Window { tailwind?: { config?: unknown } }
}

let twPlayStarted = false;
function ensureTailwindPlay(): void {
  if (twPlayStarted || typeof document === "undefined") return;
  twPlayStarted = true;
  const s = document.createElement("script");
  s.src = "https://cdn.tailwindcss.com";
  s.async = false;
  // `important` acota las utilidades al contenedor del artefacto → no pisa la UI de Teams,
  // y preflight off para no resetear los estilos del app.
  s.onload = () => {
    try {
      if (window.tailwind) window.tailwind.config = { important: ".gt-live", corePlugins: { preflight: false } };
    } catch { /* noop */ }
  };
  document.head.appendChild(s);
}

// Separa el HTML parcial en: CSS del artefacto (reescrito al contenedor) y su cuerpo.
// Tolera documento a medias — es justo lo que llega mientras el agente escribe.
export function splitArtifact(html: string): { css: string; body: string } {
  const styles = html.match(/<style[^>]*>([\s\S]*?)(?:<\/style>|$)/gi) || [];
  const css = styles
    .map((b) => b.replace(/<\/?style[^>]*>/gi, ""))
    .join("\n")
    // El artefacto define su paleta en :root y estiliza html/body; ambos deben aplicarse
    // AL CONTENEDOR, no al documento de Teams (si no, le robamos los tokens a la app).
    .replace(/:root\b/gi, ".gt-live")
    .replace(/(^|[\s,{}])(html|body)\b/gi, "$1.gt-live");
  // Cuerpo: lo que va después de <body …>; si aún no llegó, no hay nada visual.
  const m = /<body[^>]*>/i.exec(html);
  let body = m ? html.slice(m.index + m[0].length) : "";
  body = body
    .replace(/<\/body\s*>[\s\S]*$/i, "")
    // Nada de scripts: este preview no ejecuta el JS del agente.
    .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  return { css, body };
}

// Clases del <body> del artefacto (fondo/tipografía) → se aplican al contenedor.
function bodyClasses(html: string): string {
  const m = /<body([^>]*)>/i.exec(html);
  return m ? (/class\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? "") : "";
}

export function LiveArtifactPreview({ html, className }: { html: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const lastCss = useRef("");

  useEffect(() => { ensureTailwindPlay(); }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { css, body } = splitArtifact(html);
    if (css !== lastCss.current && styleRef.current) {
      styleRef.current.textContent = css;
      lastCss.current = css;
    }
    const cls = bodyClasses(html);
    host.className = `gt-live ${cls}`;
    // innerHTML directo: barato y sin parser de documento que reiniciar. El navegador
    // repinta en el mismo frame, así que la página se ve CRECER.
    host.innerHTML = body;
  }, [html]);

  return (
    <div className={className}>
      <style ref={styleRef} />
      <div ref={hostRef} className="gt-live" />
    </div>
  );
}
