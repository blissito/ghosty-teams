import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Proxy de la config de CAPACIDADES de un fleet agent. GTeams no duplica la config:
// la lee/escribe en vivo contra la API capabilities de EasyBits usando el fleet_token
// del agente (nunca lo exponemos al browser; el server proxea). Fuente única = EasyBits.
// Contrato: /api/v2/fleet-agents/:id/capabilities (GET catálogo+estado, POST 1 mutación).
export const EB = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";

// Puede gestionar este agente: owner o colaborador. Devuelve el fleet backend
// (id + token + binding de runtime) o null si no es de flota (webhook → sin
// capacidades EasyBits).
//
// ⚠️ El `token` es NULLABLE y eso es lo normal en el runtime nativo: un agente de gs
// NO guarda token, se opera por HMAC de partner. Esto exigía `fleet_token` y devolvía
// null para todos ellos, así que el panel de Ajustes los daba por "no nativos" y caía
// al editor de EasyBits, que pedía capabilities con un token inexistente: de ahí que
// el modal saliera COMPLETAMENTE VACÍO. Quien necesite el token lo comprueba él.
export async function resolveFleetAgent(agentId: number): Promise<{
  id: string;
  token: string | null;
  runtime: string | null;
  runtimeUrl: string | null;
} | null> {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const db = await import("../db.server");
  if (!user.isOwner && !(await db.isAgentCollaborator(agentId, user.sub)))
    throw new Error("no autorizado para este agente");
  const a = await db.getAgentById(agentId);
  if (!a) throw new Error("agente no encontrado");
  if (a.kind !== "fleet" || !a.fleet_id) return null;
  return { id: a.fleet_id, token: a.fleet_token, runtime: a.runtime, runtimeUrl: a.runtime_url };
}

/** El fleet_token de EasyBits, o un error legible. Los caminos de EasyBits lo exigen;
 *  los nativos no (firman con HMAC). */
function requireToken(be: { id: string; token: string | null }): string {
  if (!be.token) throw new Error("este agente no tiene token de EasyBits (corre en el runtime nativo)");
  return be.token;
}

// Marca el canal "Ghosty Teams" del fleet agent como conectado (action connect-teams).
// Best-effort: NO debe tumbar el flujo de agregar/conectar agente.
//
// Va al runtime DEL AGENTE. Antes iba fijo a EasyBits con `Bearer fleetToken`,
// así que para un agente nativo mandaba una credencial que ese runtime no acepta,
// a un host que no es el suyo — y como el catch está vacío, fallaba en absoluto
// silencio: el canal quedaba sin marcar y nadie se enteraba.
export async function connectTeamsChannel(
  fleetId: string,
  fleetToken: string,
  runtime?: string | null,
): Promise<void> {
  try {
    const { runtimeFor, requireHttp } = await import("./agent-runtime.server");
    // `/capabilities` es del contrato de Studio, no de A2A: un agente A2A declara lo suyo
    // en su card y no hay nada que "conectar" en él.
    const rt = requireHttp(await runtimeFor({ runtime }));
    const body = JSON.stringify({ action: "connect-teams" });
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${fleetId}/capabilities`, {
      method: "POST",
      headers: rt.headers(body, fleetToken),
      body,
    });
    // Se dice, aunque no se lance: el canal apagado se manifiesta después como
    // "el agente no responde", y sin esta línea no hay por dónde empezar.
    if (!res.ok) {
      console.error(`[connect-teams] ${fleetId} (${rt.kind}) → ${res.status}`);
    }
  } catch (e) {
    console.error(`[connect-teams] ${fleetId} falló:`, e instanceof Error ? e.message : e);
  }
}

// ── Toggle simple del canal Teams (runtime NATIVO) ────────────────────────────
// Para el settings de Teams reducido a "encender/apagar". Lee/escribe channels.teams
// del FleetAgent contra las capabilities nativas de Studio (HMAC de partner). Si el
// tenant NO es nativo, devuelve { native:false } → el settings cae al editor viejo.
// Runtime NATIVO del agente, o null si corre en EasyBits / no está configurado.
// Decide por el BINDING DEL AGENTE (`runtimeFor`), no por el default del tenant: un
// workspace puede tener uno de cada tipo, que era justo el bug de elegir por tenant.
async function nativeRuntime(be: { runtime: string | null; runtimeUrl: string | null }) {
  const { runtimeFor } = await import("./agent-runtime.server");
  try {
    const rt = await runtimeFor({ runtime: be.runtime, runtimeUrl: be.runtimeUrl });
    return rt.kind === "gs-native" ? rt : null;
  } catch {
    return null;
  }
}

export const fleetChannelStateFn = createServerFn({ method: "GET" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) return { native: false as const, fleet: false as const };
    const rt = await nativeRuntime(be);
    if (!rt) return { native: false as const, fleet: true as const };
    try {
      const res = await fetch(`${rt.base}/api/v2/fleet-agents/${be.id}/capabilities`, {
        headers: rt.headers("", ""),
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
    const rt = await nativeRuntime(be);
    if (!rt) throw new Error("runtime no nativo");
    const body = JSON.stringify({ action: "set-channel", channel: "teams", on: data.on });
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${be.id}/capabilities`, {
      method: "POST",
      headers: rt.headers(body, ""),
      body,
    });
    if (!res.ok) throw new Error(`set-channel ${res.status}: ${await res.text().catch(() => "")}`);
    return { ok: true as const, on: data.on };
  });

// ── Config del agente en el runtime NATIVO (modelo + prompt base) ─────────────
// Studio es la fuente única; Teams sólo proxea con la firma de partner. Es el
// gemelo nativo de agentFleetConfigFn/setAgentFleetConfigFn, que van a EasyBits.

export type NativeAgentConfig = {
  name: string;
  engine: string;
  engineLabel: string;
  model: string | null;
  prompt: string;
  models: Array<{ id: string; label: string; ready?: boolean }>;
};

export const nativeAgentConfigFn = createServerFn({ method: "GET" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }): Promise<{ native: false } | ({ native: true } & NativeAgentConfig)> => {
    const be = await resolveFleetAgent(data.id);
    if (!be) return { native: false };
    const rt = await nativeRuntime(be);
    if (!rt) return { native: false };
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${be.id}/capabilities`, {
      headers: rt.headers("", ""),
    });
    if (!res.ok) throw new Error(`capabilities ${res.status}: ${await res.text().catch(() => "")}`);
    return { native: true, ...((await res.json()) as NativeAgentConfig) };
  });

export const setNativeAgentConfigFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; body: Record<string, unknown> }) => d)
  .handler(async ({ data }) => {
    const be = await resolveFleetAgent(data.id);
    if (!be) throw new Error("este agente no es de flota");
    const rt = await nativeRuntime(be);
    if (!rt) throw new Error("runtime no nativo");
    const body = JSON.stringify(data.body);
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${be.id}/capabilities`, {
      method: "POST",
      headers: rt.headers(body, ""),
      body,
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    // El mensaje de Studio se propaga TAL CUAL: el 402 del gate de plan ("ese modelo
    // es de Empresarial: gasta 2× del saldo…") está escrito para que lo lea una
    // persona. Sustituirlo por un genérico convierte una explicación en un misterio.
    if (!res.ok) throw new Error(j.error || `capabilities ${res.status}`);
    return { ok: true as const };
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
    let res = await get(requireToken(be));
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
      headers: { Authorization: `Bearer ${requireToken(be)}`, "Content-Type": "application/json" },
      body: JSON.stringify(data.body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j as { error?: string }).error || `capabilities ${res.status}`);
    return j as { ok?: boolean };
  });
