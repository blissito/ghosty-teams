// «La computadora del agente» en el panel lateral (`ArtifactPanel` kind "computer"). El panel
// vive en `@ghostystudio/computer` (el mismo de /c y de Sitios de EasyBits); aquí sólo se le dan
// los pasos de la burbuja y las piezas de Teams: traducciones, vista en vivo y «Tomar el control»
// (pase de gs vía `computerBrowserFn`; ghosty-studio `docs/claude/computadora-del-agente-teams.md`).
import { isPlumbing } from "@ghostystudio/computer";
import { AgentComputer } from "@ghostystudio/computer/react";
import { useT } from "../../i18n";
import { useComputerSteps } from "../../lib/computer-store";
import { computerBrowserFn } from "../../server/chat";

/** Los roles de la fábrica trabajan con código: ellos sí ven la terminal y el diff técnico. */
const DEV_HANDLES = new Set(["plan", "build", "check", "arqui"]);

export function AgentComputerPanel({ messageId, agentName, handle, replay, takeoverAt }: { messageId: number; agentName?: string; handle?: string; replay?: boolean; takeoverAt?: number }) {
  const t = useT();
  // En vivo mientras el turno de la burbuja siga (entre tool y tool también), o haya un paso corriendo.
  const { steps, loaded, live: turnLive } = useComputerSteps(messageId);
  const live = turnLive || steps.some((s) => s.status === "running" && !isPlumbing(s.tool));
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
      takeoverNow={takeoverAt}
      // «Activar voz» en la sala de LiveKit de la sesión (sólo con video en vivo).
      onVoice={async (sessionId, voice) => {
        await computerBrowserFn({ data: { id: messageId, sessionId, op: "voice", speak: voice.speak, mic: voice.mic } });
      }}
      onWatch={async (sessionId) => {
        const r = await computerBrowserFn({ data: { id: messageId, sessionId, op: "watch" } });
        return { liveUrl: r.liveUrl, ...(r.livekit ? { livekit: r.livekit } : {}) };
      }}
      onTakeover={async (sessionId) => {
        const r = await computerBrowserFn({ data: { id: messageId, sessionId, op: "takeover" } });
        return { liveUrl: r.liveUrl, inputUrl: r.inputUrl ?? "", releaseUrl: r.releaseUrl ?? "", viewport: r.viewport ?? null, ...(r.livekit ? { livekit: r.livekit } : {}) };
      }}
    />
  );
}
