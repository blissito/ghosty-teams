import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Server fns de agentes: typeahead (todos) + CRUD (owner) + listar flota EasyBits.

export type PublicAgent = { handle: string; name: string; avatar: string };

// Para el typeahead del composer: agentes habilitados (ghosty implícito + extra).
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async (): Promise<PublicAgent[]> => {
  const { resolvedAgents } = await import("../agents.server");
  return (await resolvedAgents()).map((a) => ({ handle: a.handle, name: a.name, avatar: a.avatar }));
});

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("solo el owner gestiona agentes");
  return user;
}

// Puede EDITAR la config de este agente: owner o colaborador (slice 4). NO implica
// ver el secret (nunca lo exponemos en la UI/lista).
async function requireAgentManage(agentId: number) {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  if (user.isOwner) return user;
  const db = await import("../db.server");
  if (await db.isAgentCollaborator(agentId, user.sub)) return user;
  throw new Error("no autorizado para este agente");
}

// Los gc_agents extra (para la UI de Ajustes → Agentes). NO incluye el ghosty
// implícito (ese se gestiona en el wizard). Sin exponer tokens.
export const listManagedAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const db = await import("../db.server");
  let list = await db.listAgents();
  // Owner ve todos; un colaborador ve SOLO los agentes que le compartieron.
  if (!user.isOwner) {
    const ids = new Set(await db.listCollaboratorAgentIds(user.sub));
    list = list.filter((a) => ids.has(a.id));
  }
  return list.map((a) => ({
    id: a.id,
    handle: a.handle,
    name: a.name,
    kind: a.kind,
    fleet_id: a.fleet_id,
    webhook_url: a.webhook_url,
    avatar: a.avatar,
    system_prompt: a.system_prompt,
    enabled: a.enabled,
  }));
});

// ¿El usuario puede ver la pestaña Agentes? (owner o colaborador de ≥1 agente.)
export const agentAccessFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await sessionUser();
  if (!user) return { canManage: false };
  if (user.isOwner) return { canManage: true };
  const db = await import("../db.server");
  return { canManage: (await db.listCollaboratorAgentIds(user.sub)).length > 0 };
});

// Colaboradores de un agente. Ver = owner o colaborador; gestionar (add/remove) = owner.
export const listAgentCollaboratorsFn = createServerFn({ method: "GET" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireAgentManage(data.id);
    const db = await import("../db.server");
    return db.listAgentCollaboratorsInfo(data.id);
  });

export const addAgentCollaboratorFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; email: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner(); // solo el owner suma/quita colaboradores
    const db = await import("../db.server");
    const sub = await db.getUserSubByEmail(data.email);
    if (!sub) throw new Error("ese usuario aún no ha entrado a Ghosty Teams");
    await db.addAgentCollaborator(data.id, sub);
    return { ok: true as const };
  });

export const removeAgentCollaboratorFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; sub: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    const db = await import("../db.server");
    await db.removeAgentCollaborator(data.id, data.sub);
    return { ok: true as const };
  });

// Lista los fleet agents del owner, refrescando el OAuth token si expiró. El
// eb_access_token es un JWT que CADUCA; ante 401 usamos el refresh_token para
// renovarlo (y persistirlo) y reintentamos una vez. Sin conexión/refresh → [].
// (Bug 2026-07-05: la flota salía vacía porque el token había expirado y esta
// ruta no refrescaba, a diferencia de la Files API.)
async function fleetAgentsWithRefresh() {
  const { getConfig } = await import("../config.server");
  const token = await getConfig("eb_access_token");
  if (!token) return [];
  const { listFleetAgents } = await import("./easybits-oauth.server");
  try {
    return await listFleetAgents(token);
  } catch (e) {
    if (!String(e).includes("401")) throw e;
    const { refreshOwnerToken } = await import("./easybits-files.server");
    const fresh = await refreshOwnerToken();
    if (!fresh) return [];
    return await listFleetAgents(fresh);
  }
}

// Agentes de la flota EasyBits del owner (para elegir uno al agregar tipo fleet).
export const listFleetAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  // `name` = nombre distinto del pool (ej. "tania-0"); `assistantName` suele ser
  // "Ghosty" para todos → priorizar `name` para distinguirlos en el selector.
  return (await fleetAgentsWithRefresh()).map((a) => ({ id: a.id, name: a.name || a.assistantName || a.id }));
});

export const createAgentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      handle: string;
      name: string;
      kind: "fleet" | "webhook";
      fleetId?: string;
      webhookUrl?: string;
      systemPrompt?: string;
      avatar?: string;
    }) => d
  )
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../db.server");
    const handle = data.handle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!handle) throw new Error("handle requerido");
    if (handle === db.GHOSTY_HANDLE) throw new Error("@ghosty está reservado");
    if (await db.getAgentByHandle(handle)) throw new Error(`@${handle} ya existe`);

    let name = data.name.trim();
    let fleetId: string | undefined;
    let fleetToken: string | undefined;
    let webhookUrl: string | undefined;

    if (data.kind === "fleet") {
      if (!data.fleetId) throw new Error("elige un agente de la flota");
      const found = (await fleetAgentsWithRefresh()).find((a) => a.id === data.fleetId);
      if (!found) throw new Error("agente de flota no encontrado");
      fleetId = found.id;
      fleetToken = found.token;
      if (!name) name = found.name || found.assistantName || handle;
    } else {
      if (!data.webhookUrl?.trim()) throw new Error("URL del webhook requerida");
      try {
        new URL(data.webhookUrl.trim());
      } catch {
        throw new Error("URL inválida");
      }
      webhookUrl = data.webhookUrl.trim();
      if (!name) name = handle;
    }

    const ag = await db.createAgent({
      handle,
      name: name || handle,
      kind: data.kind,
      fleetId,
      fleetToken,
      webhookUrl,
      avatar: data.avatar?.trim() || null,
      systemPrompt: data.systemPrompt?.trim() || null,
      createdBy: user.sub,
    });
    return { ok: true as const, handle: ag.handle };
  });

export const updateAgentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id: number;
      name?: string;
      webhookUrl?: string;
      enabled?: boolean;
      systemPrompt?: string | null;
      avatar?: string | null;
    }) => d
  )
  .handler(async ({ data }) => {
    await requireAgentManage(data.id); // owner o colaborador (editar config, no ver secret)
    const db = await import("../db.server");
    await db.updateAgent(data.id, {
      name: data.name,
      webhookUrl: data.webhookUrl,
      enabled: data.enabled,
      systemPrompt: data.systemPrompt,
      avatar: data.avatar,
    });
    return { ok: true as const };
  });

export const deleteAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    const db = await import("../db.server");
    await db.deleteAgent(data.id);
    return { ok: true as const };
  });
