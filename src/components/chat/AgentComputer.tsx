// «La computadora del agente» en el panel lateral (`ArtifactPanel` kind "computer"). El panel
// vive en `@ghostystudio/computer` (el mismo de /c y de Sitios de EasyBits); aquí sólo se le dan
// los pasos de la burbuja y las piezas de Teams: traducciones y, más adelante, vista en vivo y
// «Tomar el control» (ghosty-studio `docs/claude/computadora-del-agente-teams.md`).
import { isPlumbing } from "@ghostystudio/computer";
import { AgentComputer } from "@ghostystudio/computer/react";
import { useT } from "../../i18n";
import { useComputerSteps } from "../../lib/computer-store";

export function AgentComputerPanel({ messageId, agentName }: { messageId: number; agentName?: string }) {
  const t = useT();
  const { steps, loaded } = useComputerSteps(messageId);
  // En vivo mientras algún paso de trabajo siga corriendo.
  const live = steps.some((s) => s.status === "running" && !isPlumbing(s.tool));
  if (!loaded) return <div className="grid h-full place-items-center text-sm text-muted">…</div>;
  return <AgentComputer steps={steps} live={live} agentName={agentName} t={t} />;
}
