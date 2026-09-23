import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// El pie de cada mensaje de agente, como el «Lens · Opus 5.5 · Configure» del hilo de Boris:
// quién contestó, con qué modelo, y un atajo para configurarlo. El modelo vive en Studio y
// no en Teams, así que se resuelve aquí (cacheado) y el cliente lo pide UNA vez.
export type AgentMeta = { handle: string; name: string; model: string | null; engine: string | null; configUrl: string | null };

export const agentMetaFn = createServerFn({ method: "GET" }).handler(async (): Promise<AgentMeta[]> => {
  const me = await sessionUser();
  if (!me) return [];
  const { resolvedAgents, agentModelInfo } = await import("../agents.server");
  const agents = await resolvedAgents();
  return Promise.all(
    agents.map(async (a) => {
      const info = await agentModelInfo(a);
      return {
        handle: a.handle,
        name: a.name,
        model: info.model,
        engine: info.engine,
        // Configurar es cosa de quien administra el espacio: a los demás no se les ofrece un
        // enlace que Studio les va a negar.
        configUrl: me.isOwner && info.fleetId ? `https://www.ghosty.studio/app/fleet/${info.fleetId}` : null,
      };
    }),
  );
});
