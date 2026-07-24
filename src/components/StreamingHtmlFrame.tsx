import { useEffect, useRef } from "react";

// PREVIEW EN VIVO REAL del artefacto HTML: en vez de re-montar el iframe con srcDoc cada X ms
// (que reinicia el parseo y deja la vista en blanco hasta que el HTML está casi completo),
// abrimos el documento del iframe UNA vez y le vamos escribiendo los DELTAS con document.write().
// Eso es exactamente cómo el navegador pinta una página que llega por red: se ve armarse desde
// el primer token (el parser incremental muestra head/style/body conforme entran).
//
// El iframe queda sandboxed SIN allow-same-origin (el padre no puede tocar su DOM), así que el
// puente es postMessage: srcDoc carga un bootstrap mínimo que escucha mensajes y escribe.
const BOOTSTRAP = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style><script>
(function(){
  var opened=false;
  addEventListener('message',function(e){
    var d=e.data; if(!d||d.__gt!=='html')return;
    if(d.reset){ try{document.open()}catch(_){} opened=true; }
    else if(!opened){ try{document.open()}catch(_){} opened=true; }
    if(d.chunk) document.write(d.chunk);
  });
  parent.postMessage({__gt:'ready'},'*');
})();
<\/script>`;

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
  const sent = useRef(""); // lo que ya escribimos dentro del iframe
  const pending = useRef(html);
  pending.current = html;

  useEffect(() => {
    // Flush a ~80ms: suficientemente fino para que se vea escribir, sin postMessage por token.
    const flush = (force = false) => {
      const win = ref.current?.contentWindow;
      if (!win || !ready.current) return;
      const next = pending.current;
      if (next === sent.current && !force) return;
      if (next.startsWith(sent.current)) {
        const delta = next.slice(sent.current.length);
        if (!delta) return;
        win.postMessage({ __gt: "html", chunk: delta }, "*");
      } else {
        // El cuerpo se reescribió (no es append) → reabrimos el documento con todo.
        win.postMessage({ __gt: "html", chunk: next, reset: true }, "*");
      }
      sent.current = next;
    };
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { __gt?: string })?.__gt === "ready" && e.source === ref.current?.contentWindow) {
        ready.current = true;
        flush(true);
      }
    };
    window.addEventListener("message", onMsg);
    const iv = setInterval(flush, 80);
    return () => {
      window.removeEventListener("message", onMsg);
      clearInterval(iv);
    };
  }, []);

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
