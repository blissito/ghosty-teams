import { useEffect, useRef, useState } from "react";

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

// Esqueleto de CARGA: el panel se abre en cuanto el agente abre el fence, pero los primeros
// tokens son <!doctype>/<head>/<style> → splitArtifact devuelve body vacío y el panel se veía
// NEGRO varios segundos (parecía colgado). Mientras no haya UN nodo pintado tapamos con este
// placeholder; se quita solo con el primer nodo real del artefacto.
export function ArtifactSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-surface-2">
      <div className="w-full max-w-md px-8">
        <div className="mb-6 flex items-center gap-2 text-sm text-muted">
          <span className="h-2 w-2 animate-ping rounded-full bg-brand" />
          {label}
        </div>
        <div className="space-y-3">
          <div className="h-28 w-full animate-pulse rounded-lg bg-white/[0.06]" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-white/[0.06] [animation-delay:120ms]" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-white/[0.06] [animation-delay:240ms]" />
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="h-16 animate-pulse rounded-lg bg-white/[0.06] [animation-delay:300ms]" />
            <div className="h-16 animate-pulse rounded-lg bg-white/[0.06] [animation-delay:400ms]" />
            <div className="h-16 animate-pulse rounded-lg bg-white/[0.06] [animation-delay:500ms]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LiveArtifactPreview({
  html,
  className,
  loadingLabel = "Construyendo el artefacto…",
}: { html: string; className?: string; loadingLabel?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const lastCss = useRef("");
  const [empty, setEmpty] = useState(true);

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
    // Vacío = todavía NADA pintado (solo head/style/espacios) → decide el esqueleto. Se mide
    // sobre el DOM, no sobre html.length (que ya crece con el <head> sin nada visible).
    setEmpty(!host.firstElementChild && !host.textContent?.trim());
  }, [html]);

  return (
    <div className={className}>
      <style ref={styleRef} />
      <div ref={hostRef} className="gt-live" />
      {empty ? <ArtifactSkeleton label={loadingLabel} /> : null}
    </div>
  );
}
