import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Ventana APARTE para la llamada (Document Picture-in-Picture), como la de Teams o Meet:
// una ventana del sistema, siempre encima, que sobrevive a minimizar el navegador o a
// cambiar de pestaña — cosa que un dock flotante dentro de la página no puede hacer.
//
// ⚠️ Esto sólo es posible porque el `Room` de LiveKit vive en module-scope
// (`lib/call-store.ts`). Mudar la UI a otro documento DESMONTA y REMONTA `<QuickCall>`;
// si la sala colgara del componente, minimizar cortaría la llamada. Los `<video>` se
// re-adjuntan solos: el efecto de cada `Tile` hace `track.attach()` al montar.
//
// Sólo Chromium lo implementa (116+). En Firefox/Safari `supported` es false y el botón
// no se pinta: no hay degradación que explicar, el dock de siempre sigue ahí.
type PipApi = {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
  window: Window | null;
};

export const pipSupported = () =>
  typeof window !== "undefined" && "documentPictureInPicture" in window;

const pipApi = () => (window as unknown as { documentPictureInPicture: PipApi }).documentPictureInPicture;

// El documento de la PiP nace VACÍO: sin nuestro CSS, la llamada saldría como HTML
// crudo. Se clonan las hojas de la página (en dev son `<style>` inyectados por Vite; en
// producción un `<link>`), y se copia `data-theme` para que herede claro/oscuro.
function copyStyles(target: Window) {
  for (const node of Array.from(document.querySelectorAll('style,link[rel="stylesheet"]'))) {
    target.document.head.appendChild(node.cloneNode(true));
  }
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) target.document.documentElement.setAttribute("data-theme", theme);
  target.document.body.style.margin = "0";
  // El body de la PiP es el viewport entero: sin esto el dock (que es `flex-col` con
  // `min-h-0`) no tiene contra qué medirse y colapsa a la altura de sus controles.
  target.document.body.style.height = "100vh";
  target.document.body.style.overflow = "hidden";
}

export function useCallPipWindow() {
  const [pip, setPip] = useState<Window | null>(null);

  const open = useCallback(async (size?: { width: number; height: number }) => {
    if (!pipSupported()) return;
    try {
      const win = await pipApi().requestWindow({
        width: Math.round(size?.width ?? 420),
        height: Math.round(size?.height ?? 320),
      });
      copyStyles(win);
      // Cerrar la ventana (botón del SO) devuelve la llamada al dock; NO cuelga.
      win.addEventListener("pagehide", () => setPip(null), { once: true });
      setPip(win);
    } catch {
      // Un `NotAllowedError` (sin gesto, o ya hay otra PiP) deja la llamada donde estaba.
      setPip(null);
    }
  }, []);

  const close = useCallback(() => {
    try {
      pipApi()?.window?.close();
    } catch {
      /* ya estaba cerrada */
    }
    setPip(null);
  }, []);

  // Al desmontar la capa de llamadas (colgar, salir de sesión) la ventana no puede
  // quedarse huérfana en pantalla.
  useEffect(() => {
    return () => {
      try {
        pipApi()?.window?.close();
      } catch {
        /* nada */
      }
    };
  }, []);

  // El tema se cambia en la pestaña principal; la PiP tiene que seguirlo.
  useEffect(() => {
    if (!pip) return;
    const obs = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute("data-theme");
      if (theme) pip.document.documentElement.setAttribute("data-theme", theme);
      else pip.document.documentElement.removeAttribute("data-theme");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [pip]);

  return { pip, open, close, supported: pipSupported() };
}

export function CallPipPortal({ win, children }: { win: Window; children: React.ReactNode }) {
  return createPortal(children, win.document.body);
}
