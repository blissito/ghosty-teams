import { useEffect, useRef } from "react";
import type { RtEvent } from "../server/bus.server";

// Cliente realtime: UNA conexión SSE por pestaña. `EventSource` reconecta solo;
// en cada (re)apertura y al volver a la pestaña dispara onReconnect → catch-up
// (revalida el room activo), lo que garantiza que nunca se pierdan mensajes aunque
// el stream haya tenido un hueco (VM suspendida, rebake, red caída).
export function useLiveStream(handlers: {
  onEvent: (ev: RtEvent) => void;
  onReconnect: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("open", () => ref.current.onReconnect());
    es.onmessage = (e) => {
      try {
        ref.current.onEvent(JSON.parse(e.data) as RtEvent);
      } catch {
        /* heartbeat u otra línea no-JSON */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") ref.current.onReconnect();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
}
