import { useEffect } from "react";

// Congela el scroll de la página mientras hay un modal abierto.
//
// Sin esto, la rueda o el swipe que empieza dentro del modal —o que llega al tope de su
// propio scroll— se lo lleva el chat de atrás: el modal de Ajustes se queda quieto y lo
// que se mueve es la conversación. En móvil es peor, porque ahí el gesto es el único
// modo de recorrer una pestaña larga como Apariencia. Lo reportó Brenda.
//
// Refcount de módulo, NO un booleano: con dos modales encimados (Ajustes → un confirm),
// el de arriba al cerrarse restauraría el scroll con el de abajo todavía abierto.
let depth = 0;
let previousOverflow = "";
let previousPaddingRight = "";

/** Bloquea el scroll del documento mientras el componente esté montado. */
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const body = document.body;
    if (depth === 0) {
      previousOverflow = body.style.overflow;
      previousPaddingRight = body.style.paddingRight;
      // La barra de scroll desaparece al ocultar el overflow y la página SALTA de ancho.
      // Se compensa con el hueco que dejó. En móvil el gap es 0 y no hace nada.
      const gap = window.innerWidth - document.documentElement.clientWidth;
      if (gap > 0) body.style.paddingRight = `${gap}px`;
      body.style.overflow = "hidden";
    }
    depth++;
    return () => {
      depth--;
      if (depth === 0) {
        body.style.overflow = previousOverflow;
        body.style.paddingRight = previousPaddingRight;
      }
    };
  }, [active]);
}
