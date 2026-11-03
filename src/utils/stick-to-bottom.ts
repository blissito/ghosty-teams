import { useEffect, useRef } from "react";

// «Pegado al fondo» como lo hace la comunidad (use-stick-to-bottom de StackBlitz, que usan los
// Conversation de AI Elements y shadcn): la INTENCIÓN de subir despega al instante (rueda hacia
// arriba, dedo hacia abajo, ArrowUp/PageUp/Home, la barra hacia arriba) y sólo se vuelve a pegar
// al llegar DE VERDAD al fondo. Antes cada copia despegaba por distancia (>80–120 px) y cada
// token te regresaba al fondo a media subida: «se captura, vibra y no deja subir» (3-nov).

/** Hasta aquí del fondo cuenta como «en el fondo» (redondeos de subpíxel). */
export const STICK_GAP = 4;

export const gapToBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * Engancha los listeners a `el` y mantiene `stuck.current`. Devuelve la limpieza.
 * Quien escribe el contenido sólo hace `if (stuck.current) el.scrollTop = el.scrollHeight`.
 */
export function trackStick(el: HTMLElement, stuck: { current: boolean }): () => void {
  let lastTop = el.scrollTop;
  let touchY = 0;
  const release = () => { stuck.current = false; };
  const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) release(); };
  const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? touchY;
    if (y > touchY + 2) release();
    touchY = y;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) release();
  };
  const onScroll = () => {
    // El contenido que crece abajo no baja scrollTop; si bajó, alguien subió (p. ej. la barra).
    if (gapToBottom(el) <= STICK_GAP) stuck.current = true;
    else if (el.scrollTop < lastTop - 2) release();
    lastTop = el.scrollTop;
  };
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("keydown", onKey);
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("scroll", onScroll);
  };
}

/**
 * Hook sobre un ref. `bindKey` re-engancha cuando el elemento aparece o cambia (p. ej. un
 * <pre> que sólo existe mientras se escribe). `reset` vuelve a pegar (nuevo streaming).
 */
export function useStickToBottom(ref: { current: HTMLElement | null }, bindKey?: unknown) {
  const stuck = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return trackStick(el, stuck);
  }, [ref, bindKey]);
  const follow = () => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  };
  return { stuck, follow };
}
