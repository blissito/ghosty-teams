// El robot animado de un agente (@ghostystudio/boxes), el mismo que pinta Ghosty Studio: mismo
// handle, mismo robot en los dos lados (`lookFor`). Sólo va donde el agente TRABAJA (turno en
// vivo, panel «Trabajando ahora», perfil): cada uno es un canvas, así que el avatar de cada
// mensaje se queda quieto a propósito.
import { useEffect, useState, useSyncExternalStore } from "react";
import { RobotHead, lookFor, type RobotHeadState } from "@ghostystudio/boxes/react";

/** Cómo está el turno del agente, en el vocabulario de Teams. */
export type AgentBotStatus = "queued" | "running" | "streaming" | "done" | "failed" | "idle";

const STATE_OF: Record<AgentBotStatus, RobotHeadState> = {
  queued: "sleeping",
  running: "thinking",
  streaming: "working",
  done: "success",
  failed: "error",
  idle: "idle",
};

export function AgentBot({
  handle,
  status = "idle",
  size = 32,
  color,
  still = false,
  className = "",
}: {
  handle: string;
  status?: AgentBotStatus;
  size?: number;
  /** Color del cuerpo; sin él, el de `lookFor` (los roles de la fábrica traen el suyo). */
  color?: string;
  /** Quieto: un solo cuadro y sin bucle de animación, para los avatares de mensajes viejos. */
  still?: boolean;
  className?: string;
}) {
  // Sólo en el cliente: el canvas no tiene nada que hacer en el render del servidor y así no
  // hay diferencias de hidratación. Mientras, se aparta el mismo lugar para que nada brinque.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const box = { width: size, height: size };
  if (!mounted) return <span aria-hidden="true" className={`inline-block shrink-0 ${className}`} style={box} />;
  const look = lookFor(handle);
  return (
    <span aria-hidden="true" className={`inline-block shrink-0 ${className}`} style={box}>
      <RobotHead
        size={size}
        color={color ?? look.color}
        shape={look.shape}
        seed={look.seed}
        state={STATE_OF[status]}
        // Sin antena: en Teams se ve como un ícono, y la antena lo alarga y lo amontona.
        antenna={false}
        paused={still}
        // Chico no lleva sombra de piso; el mouse lo sigue a cualquier tamaño (bliss, 12-oct).
        floorShadow={size >= 64}
        interactive={!still}
      />
    </span>
  );
}


// ── El último mensaje de cada agente se anima ──────────────────────────────────
// Cada avatar de robot en pantalla se registra con su handle y el id de su mensaje; sólo el
// de id mayor por handle queda vivo (respira y sigue al mouse). Los viejos siguen en un
// cuadro: cada canvas animado cuesta, y un room largo tiene decenas.
const shown = new Map<string, Map<number, number>>(); // handle → id → montajes
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribeLatest(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function latestOf(handle: string): number {
  const ids = shown.get(handle);
  return ids && ids.size ? Math.max(...ids.keys()) : -1;
}

/** ¿Es éste el mensaje más reciente en pantalla de ese agente? */
export function useIsLatestBot(handle: string | null, messageId: number): boolean {
  useEffect(() => {
    if (!handle) return;
    const ids = shown.get(handle) ?? new Map<number, number>();
    shown.set(handle, ids);
    ids.set(messageId, (ids.get(messageId) ?? 0) + 1);
    emit();
    return () => {
      const n = (ids.get(messageId) ?? 1) - 1;
      if (n > 0) ids.set(messageId, n);
      else ids.delete(messageId);
      emit();
    };
  }, [handle, messageId]);
  return useSyncExternalStore(
    subscribeLatest,
    () => (handle ? latestOf(handle) === messageId : false),
    () => false,
  );
}
