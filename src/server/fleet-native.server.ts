// ── Cliente de la flota NATIVA (Teams → Ghosty Studio) ─────────────────────────
// Gemelo de listFleetAgents/createFleetAgent (easybits-oauth) pero contra el runtime
// nativo de Studio: auth = HMAC de partner (no OAuth Bearer), owner = `user.sub` de la
// sesión (la identidad gs; Studio scopea la flota por ownerUserId). Se usa SOLO cuando
// el tenant es nativo (`nativeRuntimeBase()` != null). Shape de salida IDÉNTICO al de
// EasyBits (`{pools:[{id,name,assistantName,token,workerTemplate}]}`) → el wizard no cambia.
import { partnerHeaders } from "./ghosty-runtime.server";

export type FleetPool = {
  id: string;
  name: string;
  assistantName?: string;
  /** Studio dejó de mandarlo: un agente nativo se opera por HMAC, no por token. */
  token?: string;
  workerTemplate?: string;
  engine?: string;
  model?: string;
  /**
   * Cómo se le habla a ese agente. Ausente = `sse`, el camino nativo de siempre
   * (`message-stream` contra Studio).
   *
   * `acp` es otro transporte: WebSocket contra la caja del agente, con `runAcpTurn`. Studio
   * lo declara por MOTOR y manda además su `runtimeUrl`, que es un dominio FIJO — no la URL
   * con el sandboxId dentro, justamente para que recrear la caja no deje muertos a todos los
   * workspaces donde el agente esté activado.
   */
  protocol?: "sse" | "acp";
  runtimeUrl?: string;
};

/** Lista los FleetAgent del owner en Studio. GET firma HMAC sobre body vacío. */
export async function listNativeFleetAgents(base: string, ownerUserId: string): Promise<FleetPool[]> {
  const { currentNamespace } = await import("./tenant.server");
  const headers = partnerHeaders("", await currentNamespace()); // canonical `${ts}.${ws}.`
  // `ownerUserId` va por compat: Studio lo ignora y resuelve el dueño desde el
  // workspace que firmó. Se manda para que una punta vieja siga funcionando.
  const url = `${base}/api/v2/fleet-agents?ownerUserId=${encodeURIComponent(ownerUserId)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fleet-agents(native) ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { pools?: FleetPool[] };
  return j.pools ?? [];
}

/** Alta de un FleetAgent nativo. Devuelve `{id, token, assistantName}` (shape flat). */
export async function createNativeFleetAgent(
  base: string,
  opts: { ownerUserId: string; engine?: string; name?: string },
): Promise<{ id: string; token: string; assistantName: string }> {
  const name = opts.name || "Ghosty";
  const body = JSON.stringify({
    ownerUserId: opts.ownerUserId,
    engine: opts.engine,
    name,
    persona: { name },
  });
  const { currentNamespace } = await import("./tenant.server");
  const res = await fetch(`${base}/api/v2/fleet-agents`, {
    method: "POST",
    headers: partnerHeaders(body, await currentNamespace()),
    body,
  });
  if (!res.ok) throw new Error(`fleet-agents(native) create ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; token: string; assistantName: string };
}
