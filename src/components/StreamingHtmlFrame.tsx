import { useEffect, useRef, useState } from "react";

// PREVIEW EN VIVO del artefacto HTML mientras el agente lo escribe.
//
// HISTORIA (para no volver a intentarlo): probé escribir los deltas dentro del iframe con
// document.write() vía un puente postMessage — en teoría es el render incremental perfecto
// (como una página que llega por red). En la práctica no pintaba: `document.open()` elimina
// los listeners del Window (spec), y aunque re-inyectes el puente en cada documento el
// arranque queda demasiado frágil (sandbox sin allow-same-origin, orden de mensajes). Se
// quedaba en blanco. Volvemos a lo simple y COMPROBABLE: re-emitir el HTML acumulado en el
// `srcDoc` cada ~250ms. El navegador auto-cierra las etiquetas abiertas, así que cada pasada
// muestra la página un poco más armada.
const TICK_MS = 250;
// Umbral para no re-montar el iframe por cambios minúsculos (cada re-emisión reinicia el
// parseo): solo repintamos si llegó contenido apreciable o si el HTML ya se cerró.
const MIN_GROWTH = 120;

export function StreamingHtmlFrame({
  html,
  title,
  className,
}: {
  html: string;
  title?: string;
  className?: string;
}) {
  const pending = useRef(html);
  pending.current = html;
  const shownLen = useRef(0);
  const [shown, setShown] = useState(html);

  useEffect(() => {
    const iv = setInterval(() => {
      const next = pending.current;
      if (next.length - shownLen.current < MIN_GROWTH && next.length !== shownLen.current) return;
      if (next.length === shownLen.current) return;
      shownLen.current = next.length;
      setShown(next);
    }, TICK_MS);
    return () => clearInterval(iv);
  }, []);

  return (
    <iframe
      title={title || "artefacto"}
      sandbox="allow-scripts allow-forms allow-popups"
      referrerPolicy="no-referrer"
      srcDoc={shown}
      className={className}
    />
  );
}
