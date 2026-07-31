import { useEffect, useRef } from "react";
import type { RtEvent } from "../server/bus.server";

// Fan-out del stream realtime. Antes `useLiveStream` era de UN solo consumidor y sólo lo
// montaba la ruta del chat: fuera de /c/$slug la pestaña no tenía SSE, así que una llamada
// entrante no se enteraba nadie estando en /forms o en un documento. Ahora el EventSource
// lo abre la RAÍZ (una sola conexión por pestaña, como siempre) y aquí se reparte a N
// suscriptores: la ruta del chat, el store de llamadas, y lo que venga.
//
// ⚠️ El bus recuerda si YA está conectado. Quien se suscribe tarde (el chat monta después
// que la raíz) recibe su `onReconnect()` de inmediato — ese callback ES el catch-up, y sin
// esto la ruta se perdería el que disparó la apertura inicial y arrancaría con datos viejos.

export type RtHandlers = {
  onEvent?: (ev: RtEvent) => void;
  onReconnect?: () => void;
};

const subs = new Set<RtHandlers>();
let connected = false;

export function subscribeRt(h: RtHandlers): () => void {
  subs.add(h);
  if (connected) {
    try {
      h.onReconnect?.();
    } catch {
      /* un suscriptor roto no tumba al resto */
    }
  }
  return () => {
    subs.delete(h);
  };
}

export function emitRtEvent(ev: RtEvent): void {
  for (const h of [...subs]) {
    try {
      h.onEvent?.(ev);
    } catch (e) {
      console.error("[rt] suscriptor falló", e);
    }
  }
}

export function emitRtConnected(): void {
  connected = true;
  for (const h of [...subs]) {
    try {
      h.onReconnect?.();
    } catch (e) {
      console.error("[rt] suscriptor falló", e);
    }
  }
}

export function markRtDisconnected(): void {
  connected = false;
}

export function isRtConnected(): boolean {
  return connected;
}

// Azúcar para componentes: se suscribe al montar y sigue viendo los handlers frescos
// (ref) sin re-suscribirse en cada render.
export function useRtSubscribe(handlers: RtHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(
    () =>
      subscribeRt({
        onEvent: (ev) => ref.current.onEvent?.(ev),
        onReconnect: () => ref.current.onReconnect?.(),
      }),
    []
  );
}
