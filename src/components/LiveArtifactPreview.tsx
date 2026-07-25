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

// Destello del nodo recién parcheado: sin él, cambiar un precio o un color pasa
// inadvertido y el usuario cree que no ocurrió nada.
const PATCH_CSS =
  `@keyframes gt-patch-in{from{outline-color:rgba(139,92,246,.9);background-color:rgba(139,92,246,.14)}` +
  `to{outline-color:rgba(139,92,246,0);background-color:transparent}}` +
  `.gt-live .gt-patching{outline:2px solid rgba(139,92,246,.9);outline-offset:2px;border-radius:6px;` +
  `animation:gt-patch-in .7s ease-out forwards}`;

// Mismo saneado que el cuerpo completo, para un fragmento suelto (patch): sin scripts del
// agente ni handlers inline. El preview NO ejecuta el JS del artefacto.
function sanitizeFragment(html: string): string {
  return html
    .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
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
    // OCUPA TODO el panel (no una tarjetita centrada): el hueco vacío es justo lo que se
    // leía como "colgado", así que el esqueleto lo llena de borde a borde y respira.
    <div className="absolute inset-0 flex flex-col gap-4 bg-surface-2 p-6 sm:p-8">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="h-2 w-2 animate-ping rounded-full bg-brand" />
        {label}
      </div>
      <div className="h-8 w-1/2 animate-pulse rounded-lg bg-white/[0.07]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-white/[0.05] [animation-delay:120ms]" />
      {/* Hero grande + rejilla: el bloque crece con el panel (flex-1), así el esqueleto
          llena la altura completa en vez de dejar medio panel en negro. */}
      <div className="min-h-[120px] flex-[2] animate-pulse rounded-xl bg-white/[0.07] [animation-delay:200ms]" />
      <div className="grid flex-[3] grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="min-h-[80px] animate-pulse rounded-xl bg-white/[0.06] [animation-delay:300ms]" />
        <div className="min-h-[80px] animate-pulse rounded-xl bg-white/[0.06] [animation-delay:420ms]" />
        <div className="min-h-[80px] animate-pulse rounded-xl bg-white/[0.06] [animation-delay:540ms]" />
      </div>
      <div className="grid flex-[2] grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-h-[70px] animate-pulse rounded-xl bg-white/[0.05] [animation-delay:660ms]" />
        <div className="min-h-[70px] animate-pulse rounded-xl bg-white/[0.05] [animation-delay:780ms]" />
      </div>
    </div>
  );
}

export type LivePatch = { nodeId: string; html: string; closed: boolean };

export function LiveArtifactPreview({
  html,
  patches,
  className,
  loadingLabel = "Construyendo el artefacto…",
  onPatchFail,
}: {
  html: string;
  patches?: LivePatch[];
  className?: string;
  loadingLabel?: string;
  onPatchFail?: (nodeId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const lastCss = useRef("");
  const [empty, setEmpty] = useState(true);
  // Longitud ya aplicada por nodo: el body acumulado se re-parsea en cada chunk, así que sin
  // esto re-aplicaríamos el mismo patch decenas de veces (y perderíamos el flash de cambio).
  const appliedRef = useRef(new Map<string, number>());

  useEffect(() => { ensureTailwindPlay(); }, []);

  // PATCH QUIRÚRGICO sobre el DOM ya pintado: se reemplaza SOLO el nodo direccionado y el
  // resto del artefacto ni se toca (nada de innerHTML global → sin parpadeo, sin perder el
  // scroll). Es el mismo cambio que el server persistirá; aquí es para que se VEA ocurrir.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !patches?.length) return;
    for (const p of patches) {
      if (!p.html.trim()) continue;
      if (appliedRef.current.get(p.nodeId) === p.html.length) continue;
      const el = host.querySelector(`[data-id="${CSS.escape(p.nodeId)}"]`);
      if (!el) {
        // No se aplica y nada se rompe. El server es la autoridad y lo reportará; aquí
        // avisamos hacia arriba para que el panel lo muestre (fallo visible, no mudo).
        if (p.closed) onPatchFail?.(p.nodeId);
        continue;
      }
      // El fragmento debe ser UN elemento; mientras streamea todavía no lo es → se espera.
      const tpl = document.createElement("template");
      tpl.innerHTML = sanitizeFragment(p.html);
      const next = tpl.content.children.length === 1 ? (tpl.content.firstElementChild as HTMLElement) : null;
      if (!next) continue;
      next.setAttribute("data-id", p.nodeId);
      el.replaceWith(next);
      appliedRef.current.set(p.nodeId, p.html.length);
      // Destello: el usuario VE cuál nodo cambió (si no, un cambio pequeño pasa inadvertido
      // y parece que no pasó nada).
      next.classList.add("gt-patching");
      setTimeout(() => next.classList.remove("gt-patching"), 700);
    }
  }, [patches, onPatchFail]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { css, body } = splitArtifact(html);
    if (css !== lastCss.current && styleRef.current) {
      // PATCH_CSS acompaña siempre al CSS del artefacto: es el destello del nodo parcheado.
      styleRef.current.textContent = PATCH_CSS + css;
      lastCss.current = css;
    }
    const cls = bodyClasses(html);
    host.className = `gt-live ${cls}`;
    // innerHTML directo: barato y sin parser de documento que reiniciar. El navegador
    // repinta en el mismo frame, así que la página se ve CRECER.
    host.innerHTML = body;
    // Documento repintado → lo aplicado antes ya no vale (los nodos son otros).
    appliedRef.current.clear();
    // Vacío = todavía no hay nada VISIBLE. Se mide sobre el DOM (no sobre html.length, que ya
    // crece con el <head>) y por ALTURA REAL, no por "¿hay algún nodo?": los primeros nodos
    // del agente suelen ser contenedores sin contenido todavía (un <div> de 0px cuenta como
    // nodo pero no se ve), y con el criterio de nodos el esqueleto se quitaba dejando el
    // panel en negro otra vez.
    setEmpty(host.scrollHeight < 60 && !host.textContent?.trim());
  }, [html]);

  return (
    <div className={className}>
      <style ref={styleRef} />
      <div ref={hostRef} className="gt-live" />
      {empty ? <ArtifactSkeleton label={loadingLabel} /> : null}
    </div>
  );
}
