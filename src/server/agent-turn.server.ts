// Encolar el turno de un agente: módulo aparte de `wakeups.server.ts` a propósito, para que los
// tests que mockean ese módulo (enqueueWakeup/mintWakeRef/kickWakeups) sigan cubriendo a quien lo usa.
import type { ToolDest } from "./connectors/tool-token.server";

/**
 * Encola el turno de un agente en un hilo de room y barre YA. Es el despertar de un rol que usa
 * la estafeta de la fábrica (`handoff` en factory-runs) y las automatizaciones de GitHub
 * (`automations/ctx.server.ts`): firma la capacidad, vence ahora (o en `delayS`) y patea el
 * barrido de ese espacio para que no espere al tick de 30 s.
 */
export async function enqueueAgentTurn(p: {
  ns: string;
  sub: string;
  groupId: string;
  dest: ToolDest;
  key: string;
  cause: string;
  text: string;
  origin: string;
  delayS?: number;
}): Promise<boolean> {
  const { enqueueWakeup, mintWakeRef, kickWakeups } = await import("./wakeups.server");
  const ok = await enqueueWakeup({
    key: p.key,
    ref: mintWakeRef({ sub: p.sub, ns: p.ns, groupId: p.groupId, dest: p.dest }),
    cause: p.cause,
    text: p.text,
    origin: p.origin,
    // Vencido YA: con +2 s el barrido inmediato de `kickWakeups` lo veía «aún no» y el relevo
    // esperaba al siguiente tick (pedir cambios tardó ~30 s en arrancar a @plan, MailMask #15).
    dueAt: Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(p.delayS ?? 0)),
  });
  // `kick`, no `arm`: con sólo armar, el relevo esperaba al siguiente tick (hasta 30 s).
  if (ok) kickWakeups(p.ns);
  return ok;
}
