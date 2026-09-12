// ── El prompt BASE de un agente de Studio, para el turno ACP ─────────────────────────
//
// `persona.prompt` (lo que se escribe en "Prompt base (todos los canales)") lo aplica el
// runtime nativo de Studio en `routeTurn`; un agente ACP no pasa por ahí —Teams le habla a
// su caja por WebSocket— así que ese campo se guardaba y NUNCA llegaba. Aquí se lee de
// Studio y el turno lo antepone a la persona del espacio (`identidad` en agents.server.ts).
//
// Cache de 60 s por agente: un turno no puede pagar un GET a Studio cada vez, y "se aplica
// al siguiente turno" tolera ese minuto. Guardar desde Ajustes invalida la entrada.
const TTL_MS = 60_000;
const cache = new Map<string, { prompt: string | null; until: number }>();

export function invalidateStudioPrompt(fleetId: string): void {
  cache.delete(fleetId);
}

export async function studioBasePrompt(fleetId: string): Promise<string | null> {
  const hit = cache.get(fleetId);
  if (hit && hit.until > Date.now()) return hit.prompt;
  let prompt: string | null = null;
  try {
    const { runtimeFor } = await import("./agent-runtime.server");
    // Sin los campos del agente a propósito: su `runtimeUrl` es el wss:// de su caja y ahí no
    // vive `capabilities`; la config la sirve Studio (mismo criterio que `nativeRuntime`).
    const rt = await runtimeFor({ runtime: null, runtimeUrl: null });
    if (rt.kind === "gs-native") {
      const res = await fetch(`${rt.base}/api/v2/fleet-agents/${fleetId}/capabilities`, {
        headers: rt.headers("", ""),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const j = (await res.json()) as { prompt?: string };
        prompt = j.prompt?.trim() || null;
      }
    }
  } catch (e) {
    // Sin base no se cae el turno: el agente contesta con la persona del espacio, como antes.
    console.log(`[acp] sin prompt base de Studio para ${fleetId}: ${e instanceof Error ? e.message : e}`);
  }
  cache.set(fleetId, { prompt, until: Date.now() + TTL_MS });
  return prompt;
}
