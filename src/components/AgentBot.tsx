// El robot animado de un agente (@ghostystudio/boxes), el mismo que pinta Ghosty Studio: mismo
// handle, mismo robot en los dos lados (`lookFor`). Sólo va donde el agente TRABAJA (turno en
// vivo, panel «Trabajando ahora», perfil): cada uno es un canvas, así que el avatar de cada
// mensaje se queda quieto a propósito.
import { useEffect, useState } from "react";
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
  className = "",
}: {
  handle: string;
  status?: AgentBotStatus;
  size?: number;
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
        color={look.color}
        shape={look.shape}
        seed={look.seed}
        state={STATE_OF[status]}
        // Chico no lleva sombra de piso ni responde al mouse: es un indicador, no un juguete.
        floorShadow={size >= 64}
        interactive={size >= 64}
      />
    </span>
  );
}
