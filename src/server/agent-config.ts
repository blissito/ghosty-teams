import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Proxy de la config de CAPACIDADES de un fleet agent. GTeams no duplica la config:
// la lee/escribe en vivo contra la API capabilities de EasyBits usando el fleet_token
// del agente (nunca lo exponemos al browser; el server proxea). Fuente única = EasyBits.
// Contrato: /api/v2/fleet-agents/:id/capabilities (GET catálogo+estado, POST 1 mutación).
export const EB = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";

// Puede gestionar este agente: owner o colaborador. Devuelve el fleet backend
// (id + token) o null si no es de flota (webhook → sin capacidades EasyBits).
export async function resolveFleetAgent(agentId: number): Promise<{ id: string; token: string } | null> {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const db = await import("../db.server");
  if (!user.isOwner && !(await db.isAgentCollaborator(agentId, user.sub)))
    throw new Error("no autorizado para este agente");
  const a = await db.getAgentById(agentId);
  if (!a) throw new Error("agente no encontrado");
  if (a.kind !== "fleet" || !a.fleet_id || !a.fleet_token) return null;
  return { id: a.fleet_id, token: a.fleet_token };
}

// Marca el canal "Ghosty Teams" del fleet agent como conectado (action connect-teams).
// Best-effort: NO debe tumbar el flujo de agregar/conectar agente. Auth = fleetToken.
export async function connectTeamsChannel(fleetId: string, fleetToken: string): Promise<void> {
  try {
    await fetch(`${EB}/api/v2/fleet-agents/${fleetId}/capabilities`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fleetToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect-teams" }),
    });
  } catch {}
}

// ── Toggle simple del canal Teams (runtime NATIVO) ────────────────────────────
// Para el settings de Teams reducido a "encender/apagar". Lee/escribe channels.teams
// del FleetAgent contra las capabilities nativas de Studio (HMAC de partner). Si el
// tenant NO es nativo, devuelve { native:false } → el settings cae al editor viejo.
export const fleetChannelStateFn = createServerFn({ method: "GET" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) return { native: false as const, fleet: false as const };
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) return { native: false as const, fleet: true as const };
    try {
      const res = await fetch(`${base}/api/v2/fleet-agents/${be.id}/capabilities`, {
        headers: partnerHeaders(""),
      });
      if (!res.ok) return { native: true as const, fleet: true as const, teams: true, fleetId: be.id };
      const j = (await res.json()) as { channels?: { teams?: boolean }; name?: string };
      return {
        native: true as const,
        fleet: true as const,
        teams: j.channels?.teams !== false,
        name: j.name,
        fleetId: be.id,
      };
    } catch {
      return { native: true as const, fleet: true as const, teams: true, fleetId: be.id };
    }
  });

export const setFleetChannelFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; on: boolean }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) throw new Error("este agente no es de flota");
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) throw new Error("runtime no nativo");
    const body = JSON.stringify({ action: "set-channel", channel: "teams", on: data.on });
    const res = await fetch(`${base}/api/v2/fleet-agents/${be.id}/capabilities`, {
      method: "POST",
      headers: partnerHeaders(body),
      body,
    });
    if (!res.ok) throw new Error(`set-channel ${res.status}: ${await res.text().catch(() => "")}`);
    return { ok: true as const, on: data.on };
  });

// GET: catálogo + estado de config del agente (builtins, capacidades, secrets,
// persona/modelo/effort/buckets, skills, MCPs custom, grupos). `q` = búsqueda de
// archivos para el picker de entregables. Devuelve null si el agente no es de flota.
export const agentFleetConfigFn = createServerFn({ method: "GET" })
  .validator((d: { id: number; q?: string }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) return { fleet: false as const };
    const url = new URL(`${EB}/api/v2/fleet-agents/${be.id}/capabilities`);
    if (data.q) url.searchParams.set("q", data.q);
    const get = (tok: string) => fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    // Self-heal en 401 (el fleet_token caduca): refresca y reintenta una vez.
    let res = await get(be.token);
    if (res.status === 401) {
      const { refreshFleetToken } = await import("../agents.server");
      const fresh = await refreshFleetToken(be.id);
      if (fresh) res = await get(fresh);
    }
    if (!res.ok) throw new Error(`capabilities ${res.status}: ${await res.text()}`);
    return { fleet: true as const, ...(await res.json()) };
  });

// POST: aplica UNA mutación de config. `action` + payload van tal cual al POST de
// EasyBits (set-agent-prompt, set-model, set-effort, set-cap-level, toggle-builtin,
// set-toolgroup, set-prompt, toggle-asset, add-mcp, remove-mcp, toggle-skill,
// delete-skill, set-secret, recycle-box, toggle-own-number). El groupId por-canal default = "*".
export const setAgentFleetConfigFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; body: Record<string, unknown> }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) throw new Error("este agente no es de flota");
    const res = await fetch(`${EB}/api/v2/fleet-agents/${be.id}/capabilities`, {
      method: "POST",
      headers: { Authorization: `Bearer ${be.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data.body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j as { error?: string }).error || `capabilities ${res.status}`);
    return j as { ok?: boolean };
  });
