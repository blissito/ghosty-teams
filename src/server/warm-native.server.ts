// ── Precalentar la conversación de un agente NATIVO de gs (25-nov-2026) ─────────
//
// El primer mensaje tras más de 5 min sin actividad pagaba 5–7 s de arranque en frío: la caja
// de gs duerme y el proceso del motor se cierra. gs ya precalienta solo en WhatsApp, Messenger,
// Instagram y /c; Teams no tiene espera de ráfaga, así que su señal más temprana es el
// «escribiendo…» (`pingTypingFn`, 1 cada 2 s): con el primer ping se le pide a gs
// `POST /api/v2/fleet-agents/:id/warm` con el MISMO groupId que mandará el turno, y mientras la
// persona termina de escribir la caja despierta y el worker abre su sesión.
//
// Sólo `gs-native` (EasyBits no tiene ese endpoint). Doble freno: aquí, uno por conversación
// cada 60 s ANTES de tocar la DB; en gs, uno por (agente, groupId) cada 60 s. Nunca lanza.
// Ficha (gs): docs/claude/tiempos-respuesta-mercado-nov25.md.

export const WARM_WINDOW_MS = 60_000;
const MAX_KEYS = 5_000;

export function createWarmGate(windowMs = WARM_WINDOW_MS) {
  const last = new Map<string, number>();
  return {
    /** `true` si toca precalentar ahora (y lo anota); `false` dentro de la ventana. */
    take(key: string, now = Date.now()): boolean {
      const prev = last.get(key);
      if (prev != null && now - prev < windowMs) return false;
      if (last.size >= MAX_KEYS) for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
      last.set(key, now);
      return true;
    },
  };
}

/** Freno del proceso: llave = conversación de Teams (`<ns>:dm:<id>` o `<ns>:room:<canal>:<raíz>`). */
export const warmGate = createWarmGate();

/**
 * Pide a gs precalentar la conversación `suffix` (lo que va tras `ghosty-chat-<handle>-`, ver
 * `agentGroupId`) del agente `handle`. No hace nada si el agente no corre en gs-native.
 */
export async function warmNativeConversation(handle: string, suffix: string): Promise<void> {
  try {
    const { resolvedAgents, agentGroupId } = await import("../agents.server");
    const agent = (await resolvedAgents()).find((a) => a.handle === handle);
    if (!agent || agent.backend.kind !== "fleet") return;
    // Los roles de la fábrica turnan con el agente del equipo, no con el de su fila: otra ruta.
    const { FACTORY_HANDLES } = await import("./apps/factory-roles");
    if ((FACTORY_HANDLES as readonly string[]).includes(handle)) return;
    const { runtimeFor } = await import("./agent-runtime.server");
    const rt = await runtimeFor(agent.backend);
    if (rt.transport !== "http" || rt.kind !== "gs-native") return;
    const groupId = await agentGroupId(agent, suffix);
    const body = JSON.stringify({ groupId });
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${encodeURIComponent(agent.backend.id)}/warm`, {
      method: "POST",
      headers: rt.headers(body, ""),
      body,
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // best-effort: precalentar nunca toca el flujo de quien escribe
  }
}
