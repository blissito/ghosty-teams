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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${be.token}` } });
    if (!res.ok) throw new Error(`capabilities ${res.status}: ${await res.text()}`);
    return { fleet: true as const, ...(await res.json()) };
  });

// POST: aplica UNA mutación de config. `action` + payload van tal cual al POST de
// EasyBits (set-agent-prompt, set-model, set-effort, set-cap-level, toggle-builtin,
// set-toolgroup, set-prompt, toggle-asset, add-mcp, remove-mcp, toggle-skill,
// delete-skill, set-secret, toggle-own-number). El groupId por-canal default = "*".
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
