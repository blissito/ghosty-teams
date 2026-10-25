// «La computadora del agente» en el panel lateral (`ArtifactPanel` kind "computer"). El panel
// vive en `@ghostystudio/computer` (el mismo de /c y de Sitios de EasyBits); aquí sólo se le dan
// los pasos de la burbuja y las piezas de Teams: traducciones, vista en vivo y «Tomar el control»
// (pase de gs vía `computerBrowserFn`; ghosty-studio `docs/claude/computadora-del-agente-teams.md`).
import { isPlumbing } from "@ghostystudio/computer";
import { AgentComputer } from "@ghostystudio/computer/react";
import { useT } from "../../i18n";
import { closeComputerAsk, useComputerSteps } from "../../lib/computer-store";
import { computerBrowserFn } from "../../server/chat";

/** Los roles de la fábrica trabajan con código: ellos sí ven la terminal y el diff técnico. */
const DEV_HANDLES = new Set(["plan", "build", "check", "arqui"]);

export function AgentComputerPanel({ messageId, agentName, handle, replay, takeoverAt }: { messageId: number; agentName?: string; handle?: string; replay?: boolean; takeoverAt?: number }) {
  const t = useT();
  // En vivo mientras el turno de la burbuja siga (entre tool y tool también), o haya un paso corriendo.
  const { steps, loaded, live: turnLive } = useComputerSteps(messageId);
  const live = turnLive || steps.some((s) => s.status === "running" && !isPlumbing(s.tool));
  // gs dijo 410: el navegador ya no existe. El pedido de ayuda se cierra (sin «Tomar el control»
  // muerto) y el panel enseña por qué.
  const gone = (sessionId: string) => {
    closeComputerAsk(messageId, sessionId);
    return new Error(t("El navegador ya se cerró."));
  };
  if (!loaded) return <div className="grid h-full place-items-center text-sm text-muted">…</div>;
  return (
    <AgentComputer
      steps={steps}
      live={live}
      agentName={agentName}
      autoplay={replay && !live}
      // Fuera de la fábrica, en palabras de persona: la terminal queda tras «Ver detalles técnicos».
      technical={!!handle && DEV_HANDLES.has(handle)}
      t={t}
      // Un clic en la tarjeta vale una toma, no para siempre: si el panel se vuelve a montar
      // (cambiar de hilo y volver) tras «Devolver el control», no debe retomarlo solo.
      takeoverNow={takeoverAt && Date.now() - takeoverAt < 15_000 ? takeoverAt : undefined}
      // «Activar voz» en la sala de LiveKit de la sesión (sólo con video en vivo).
      onVoice={async (sessionId, voice) => {
        const r = await computerBrowserFn({ data: { id: messageId, sessionId, op: "voice", speak: voice.speak, mic: voice.mic } });
        if (r.gone) throw gone(sessionId);
      }}
      onWatch={async (sessionId) => {
        const r = await computerBrowserFn({ data: { id: messageId, sessionId, op: "watch" } });
        if (r.gone) throw gone(sessionId);
        return { liveUrl: r.liveUrl, ...(r.livekit ? { livekit: r.livekit } : {}) };
      }}
      onTakeover={async (sessionId) => {
        const r = await computerBrowserFn({ data: { id: messageId, sessionId, op: "takeover" } });
        if (r.gone) throw gone(sessionId);
        return { liveUrl: r.liveUrl, inputUrl: r.inputUrl ?? "", releaseUrl: r.releaseUrl ?? "", viewport: r.viewport ?? null, ...(r.livekit ? { livekit: r.livekit } : {}) };
      }}
    />
  );
}
