import { useEffect, useRef } from "react";
import type { RtEvent } from "../server/bus.server";

// Cliente realtime: UNA conexión SSE por pestaña. En cada (re)apertura y al volver a la
// pestaña dispara onReconnect → catch-up (revalida el room activo), lo que garantiza que
// nunca se pierdan mensajes aunque el stream haya tenido un hueco (VM suspendida, rebake,
// red caída).
//
// ⚠️ **`EventSource` NO siempre reconecta solo.** Reintenta cuando la conexión se corta
// limpia, pero si al reconectar el servidor responde con un status de error o un
// content-type que no es `text/event-stream`, la especificación dice que el navegador
// FALLA la conexión y no vuelve a intentarlo. Durante un deploy el proceso se reinicia y
// Caddy contesta 502 en esa ventana — justo el caso. Resultado: el stream de TODAS las
// pestañas abiertas quedaba muerto en silencio, y la persona veía su agente clavado en
// "pensando…" indefinidamente aunque el server sí estuviera emitiendo. Sólo se recuperaba
// refrescando a mano, y nada en la interfaz decía que había que hacerlo.
//
// Por eso la reconexión se maneja aquí: `onerror` con la conexión cerrada = reabrir, con
// backoff para no martillear un server que todavía está levantando.
export function useLiveStream(handlers: {
  onEvent: (ev: RtEvent) => void;
  onReconnect: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    // La ZONA HORARIA del navegador viaja en el connect: es el único lugar donde se
    // sabe en qué reloj vive esta persona, y los recordatorios ("mañana a las 9") no
    // significan nada sin ella. Va aquí y no en un endpoint aparte porque este stream
    // se abre al montar la app, siempre.
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
    const url = `/api/stream${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`;

    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let intentos = 0;
    let cerrado = false;

    const abrir = () => {
      if (cerrado) return;
      es = new EventSource(url);

      es.addEventListener("open", () => {
        intentos = 0; // reconectó: el backoff vuelve a empezar desde abajo
        ref.current.onReconnect();
      });

      es.onmessage = (e) => {
        try {
          ref.current.onEvent(JSON.parse(e.data) as RtEvent);
        } catch {
          /* heartbeat u otra línea no-JSON */
        }
      };

      es.onerror = () => {
        // `CONNECTING` = el navegador ya está reintentando por su cuenta; no tocar
        // (reabrir aquí duplicaría conexiones). `CLOSED` = se rindió, y ahí entramos.
        if (cerrado || es?.readyState !== EventSource.CLOSED) return;
        es.close();
        es = null;
        // 1s, 2s, 4s… con techo de 15s y un poco de jitter, para que N pestañas no
        // vuelvan todas en el mismo instante contra un server recién levantado.
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
      ref.current.onReconnect();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cerrado = true;
      if (retry) clearTimeout(retry);
      es?.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
}
