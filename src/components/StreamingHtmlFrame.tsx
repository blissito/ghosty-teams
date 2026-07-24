import { useEffect, useRef, useState } from "react";

// PREVIEW EN VIVO REAL del artefacto HTML: en vez de re-montar el iframe con srcDoc cada X ms
// (que reinicia el parseo y deja la vista en blanco hasta que el HTML está casi completo),
// escribimos los DELTAS con document.write() dentro del iframe. Eso es exactamente cómo el
// navegador pinta una página que llega por red: se ve armarse desde el primer token.
//
// El iframe va sandboxed SIN allow-same-origin (el padre NO puede tocar su DOM), así que el
// puente es postMessage: el documento del iframe lleva un script-puente que escucha y escribe.
//
// GOTCHA que rompía todo (2026-07-24): `document.open()` ELIMINA los event listeners
// registrados en el Window (está en el spec). El puente vivía en el bootstrap → al primer
// reset se auto-destruía y ya no llegaba ningún delta: el panel se quedaba en blanco para
// siempre. Por eso el puente se RE-INYECTA dentro de cada documento nuevo: el padre antepone
// el script al HTML del reset, y como document.write parsea sincrónicamente, el nuevo listener
// queda registrado antes de que llegue el siguiente delta.
const BRIDGE = `<script>(function(){
  addEventListener('message',function(e){
    var d=e.data; if(!d||d.__gt!=='html'||!d.chunk)return;
    // open = documento NUEVO. Ojo: document.open() borra ESTE listener (spec), pero el
    // chunk que escribimos a continuacion trae el puente otra vez, asi sigue vivo.
    if(d.open){ try{document.open()}catch(_){} }
    document.write(d.chunk);
    parent.postMessage({__gt:'wrote',n:d.chunk.length},'*');
  });
  parent.postMessage({__gt:'ready'},'*');
})();<\/script>`;

const BOOTSTRAP = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${BRIDGE}`;

// El HTML del modelo empieza con su doctype; si le anteponemos el puente, el doctype deja de
// ser lo primero y el documento cae en quirks mode. Lo separamos y metemos el puente después.
function withBridge(html: string): string {
  const m = /^\s*<!doctype[^>]*>/i.exec(html);
  if (!m) return BRIDGE + html;
  return m[0] + BRIDGE + html.slice(m[0].length);
}

export function StreamingHtmlFrame({
  html,
  title,
  className,
}: {
  html: string;
  title?: string;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const wrote = useRef(false); // ¿el iframe confirmó al menos una escritura?
  const sent = useRef(""); // lo que ya escribimos dentro del iframe
  const pending = useRef(html);
  pending.current = html;
  // Red de seguridad: si el puente no responde (navegador que bloquee el truco, CSP…),
  // caemos al srcDoc de siempre para que el usuario VEA el artefacto igual.
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    // Flush a ~80ms: fino para que se vea escribir, sin un postMessage por token.
    const flush = () => {
      const win = ref.current?.contentWindow;
      if (!win || !ready.current) return;
      const next = pending.current;
      if (next === sent.current) return;
      const append = sent.current && next.startsWith(sent.current);
      const chunk = append ? next.slice(sent.current.length) : withBridge(next);
      if (!chunk) return;
      // Un solo mensaje: si es documento nuevo, el propio puente hace open() y escribe el
      // payload (que re-inyecta el puente) sin ventana entre medias.
      win.postMessage({ __gt: "html", chunk, open: !append }, "*");
      sent.current = next;
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __gt?: string } | undefined;
      if (!d || e.source !== ref.current?.contentWindow) return;
      if (d.__gt === "ready") {
        ready.current = true;
        flush();
      } else if (d.__gt === "wrote") {
        wrote.current = true;
      }
    };
    window.addEventListener("message", onMsg);
    const iv = setInterval(flush, 80);
    // Si a los 3s hay contenido pero el iframe nunca confirmó una escritura → fallback.
    const guard = setTimeout(() => {
      if (!wrote.current && pending.current.length > 200) setFallback(true);
    }, 3000);
    return () => {
      window.removeEventListener("message", onMsg);
      clearInterval(iv);
      clearTimeout(guard);
    };
  }, []);

  if (fallback) {
    return (
      <iframe
        title={title || "artefacto"}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        srcDoc={html}
        className={className}
      />
    );
  }

  return (
    <iframe
      ref={ref}
      title={title || "artefacto"}
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      srcDoc={BOOTSTRAP}
      className={className}
    />
  );
}
