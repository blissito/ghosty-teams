import { useEffect, useRef } from "react";
import type { RtEvent } from "../server/bus.server";

// Cliente realtime de la SALA de un evento. Gemelo reducido de `useLiveStream`, con la
// misma lección aprendida dentro y por eso vale la pena repetirla:
//
// ⚠️ **`EventSource` NO siempre reconecta solo.** Reintenta cuando la conexión se corta
// limpia, pero si al reconectar el servidor contesta con un status de error o un
// content-type que no es `text/event-stream`, la especificación dice que el navegador FALLA
// la conexión y no vuelve a intentarlo nunca. Durante un deploy el proceso se reinicia y
// Caddy contesta 502 justo en esa ventana. En un webinar en vivo eso significa una sala
// entera congelada, en silencio, sin que nada en pantalla lo diga.
//
// No se reusa `useLiveStream` tal cual porque aquél lo monta la raíz UNA vez para toda la
// app, con sesión, y hace fan-out por un bus global de cliente. Aquí es una página suelta,
// sin sesión y con un solo consumidor.
export function useEventStream(slug: string, onEvent: (ev: RtEvent) => void) {
  // El callback se guarda en un ref para no reabrir el stream en cada render: la página
  // re-renderiza con cada mensaje que llega, y reabrir ahí sería una reconexión por
  // mensaje.
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!slug) return;
    const url = `/api/event-stream?slug=${encodeURIComponent(slug)}`;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let intentos = 0;
    let cerrado = false;

    const abrir = () => {
      if (cerrado) return;
      es = new EventSource(url);

      es.addEventListener("open", () => {
        intentos = 0;
      });

      es.onmessage = (e) => {
        try {
          cb.current(JSON.parse(e.data) as RtEvent);
        } catch {
          /* heartbeat u otra línea no-JSON */
        }
      };

      es.onerror = () => {
        // `CONNECTING` = el navegador ya reintenta por su cuenta; reabrir aquí duplicaría
        // conexiones (y en la presencia se vería como gente de más).
        if (cerrado || es?.readyState !== EventSource.CLOSED) return;
        es.close();
        es = null;
        const espera = Math.min(15000, 1000 * 2 ** intentos++) + Math.floor(Math.random() * 400);
        retry = setTimeout(abrir, espera);
      };
    };

    abrir();

    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      // Volver a la pestaña es el momento en que la persona MIRA: si el stream murió
      // mientras estaba en otra, se reabre ya en vez de esperar el backoff.
      if (!es || es.readyState === EventSource.CLOSED) {
        if (retry) clearTimeout(retry);
        intentos = 0;
        abrir();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cerrado = true;
      if (retry) clearTimeout(retry);
      es?.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [slug]);
}
