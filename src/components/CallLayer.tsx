import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouterState } from "@tanstack/react-router";
import { useLiveStream } from "../hooks/useLiveStream";
import { QuickCallDock } from "./QuickCallDock";
import { IncomingCallStack } from "./IncomingCallStack";
import {
  dismissIncoming,
  joinCallFn,
  maybeRejoin,
  openCall,
  refreshCallMutes,
  setCallIdentity,
  useCall,
  wireCallRealtime,
  type Incoming,
} from "../lib/call-store";

// Capa GLOBAL de llamadas: vive en __root (RootDocument), no en la ruta del chat. Es lo
// que hace que una llamada sobreviva a ir a /forms, a un documento o a otro canal, y que
// un aviso de llamada entrante te alcance estés donde estés.
//
// También es el ÚNICO dueño del EventSource de la pestaña: `useLiveStream` abre la
// conexión y `utils/rt-bus` la reparte (el chat se suscribe, ya no la abre él).
export function CallLayer() {
  // El guard de __root resuelve `user` en beforeLoad; sin sesión (login, artefacto
  // público) no se abre stream ni se monta nada de llamadas.
  const user = useRouterState({
    select: (s) => (s.matches[0]?.context as { user?: { sub: string } | null } | undefined)?.user ?? null,
  });
  if (!user) return null;
  return <CallRuntime sub={user.sub} />;
}

function CallRuntime({ sub }: { sub: string }) {
  useLiveStream(); // una sola conexión SSE por pestaña, abierta desde la raíz
  const { joined, incoming } = useCall();

  useEffect(() => {
    setCallIdentity(sub);
    wireCallRealtime();
    refreshCallMutes();
    // Re-unirse tras un F5 SÓLO si dejamos marca al unirnos y la llamada sigue viva.
    // Colgar borra la marca, así que salirse es definitivo.
    void maybeRejoin();
  }, [sub]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {joined && <QuickCallDock room={joined.room} label={joined.label} />}
      <IncomingCallStack
        calls={incoming}
        onJoin={(c: Incoming) =>
          openCall(
            joinCallFn,
            c.scope,
            c.scopeId,
            c.scope === "room" ? { scope: "room", slug: c.slug ?? "" } : { scope: "dm", dmId: c.scopeId },
            c.label
          )
        }
        onDismiss={(c: Incoming) => dismissIncoming(`${c.scope}:${c.scopeId}`)}
      />
    </>,
    document.body
  );
}
