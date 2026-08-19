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
  // Migra el @ghosty del wizard (gc_config) a fila real → mismo card + panel que el
  // resto. Idempotente; solo el owner (los colaboradores no ven config del wizard).
  if (user.isOwner) {
    const { getConfigMany } = await import("../config.server");
    const c = await getConfigMany(["fleet_agent_id", "fleet_token", "fleet_name", "ghosty_prompt"]);
    if (c.fleet_agent_id && c.fleet_token) {
      await db
        .ensureGhostyAgentRow({
          fleetId: c.fleet_agent_id,
          fleetToken: c.fleet_token,
          name: c.fleet_name || "Ghosty",
          systemPrompt: c.ghosty_prompt || null,
          createdBy: user.sub,
        })
        .catch(() => {});
    }
  }
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
    // Mismo criterio que al invitar a un room: correo o @handle, y si no está en la
    // proyección local se pregunta por el padrón real (gs).
    let sub = await db.getUserSubByEmailOrHandle(data.email);
    if (!sub) {
      const { workspaceRoster } = await import("./roster.server");
      const target = data.email.trim().toLowerCase();
      const hit = (await workspaceRoster()).find((m) => m.email === target);
      if (hit) sub = hit.sub;
    }
    if (!sub) throw new Error("esa persona no es miembro del workspace todavía");
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
  const { getConfigMany } = await import("../config.server");
  const { resolveFleetAuth } = await import("./setup");
  const c = await getConfigMany(["eb_access_token", "eb_owner_key"]);
  const token = resolveFleetAuth(c);
  if (!token) return [];
  const { listFleetAgents } = await import("./easybits-oauth.server");
  try {
    return await listFleetAgents(token);
  } catch (e) {
    if (!String(e).includes("401")) throw e;
    // 401 solo aplica al carril OAuth (JWT que caduca); la key del owner no expira.
    if (c.eb_owner_key === "1") return [];
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

// ── Agentes de Studio: listar y ACTIVAR en este workspace ─────────────────────
//
// Un agente se crea y se configura en Studio (persona, motor, modelo, canales).
// Activarlo aquí es darle un @handle y una fila local — NO se crea nada allá, y
// desactivarlo tampoco lo borra. Esa separación es la que permite que el mismo
// agente esté en varios workspaces, y que quitarlo de uno no afecte a los otros.
//
// El listado sale del runtime nativo, que scopea por el workspace que FIRMA: no
// se manda "de quién" son los agentes, lo resuelve Studio. Por eso esto no puede
// usarse para espiar la flota de otro.
export const listStudioAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  const { nativeRuntimeBase } = await import("./ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) return { native: false as const, agents: [] };

  const { listNativeFleetAgents } = await import("./fleet-native.server");
  const db = await import("../db.server");
  const [pools, locales] = await Promise.all([
    listNativeFleetAgents(base, "").catch(() => []),
    db.listAgents(),
  ]);
  // Ya activado = hay fila local con ese fleet_id. Se marca en vez de esconderse:
  // saber que un agente YA está y con qué @handle es justo lo que evita duplicarlo.
  const porFleetId = new Map(locales.filter((a) => a.fleet_id).map((a) => [a.fleet_id!, a]));
  return {
    native: true as const,
    agents: pools.map((p) => {
      const local = porFleetId.get(p.id);
      return {
        id: p.id,
        name: p.name || p.assistantName || p.id,
        engine: p.engine ?? null,
        model: p.model ?? null,
        activatedAs: local ? local.handle : null,
      };
    }),
  };
});

export const activateStudioAgentFn = createServerFn({ method: "POST" })
  .validator((d: { studioAgentId: string; handle: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../db.server");

    const handle = data.handle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!handle) throw new Error("handle requerido");
    if (handle === db.GHOSTY_HANDLE) throw new Error("@ghosty está reservado");
    if (await db.getAgentByHandle(handle)) throw new Error(`@${handle} ya existe`);

    const { nativeRuntimeBase } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) throw new Error("este workspace no tiene runtime nativo configurado");

    // Se confirma contra Studio que el agente EXISTE y es de este workspace. El
    // listado ya viene scopeado por la firma, así que si no está en él, no es suyo
    // — y no se acepta un id escrito a mano.
    const { listNativeFleetAgents } = await import("./fleet-native.server");
    const pools = await listNativeFleetAgents(base, "");
    const found = pools.find((p) => p.id === data.studioAgentId);
    if (!found) throw new Error("ese agente no existe en Studio o no es de este workspace");

    const ya = (await db.listAgents()).find((a) => a.fleet_id === found.id);
    if (ya) throw new Error(`ese agente ya está activo como @${ya.handle}`);

    const ag = await db.createAgent({
      handle,
      name: found.name || found.assistantName || handle,
      kind: "fleet",
      fleetId: found.id,
      // Sin token a propósito: el runtime nativo se opera con la firma de partner.
      // Guardar una credencial que no se usa sólo agranda lo que se pierde.
      fleetToken: null,
      runtime: "gs-native",
      // Clave de conversación con el namespace del workspace: este agente PUEDE
      // estar activo en varios, y sin esto compartirían memoria (ver agentGroupId).
      groupNs: true,
      createdBy: user.sub,
    });

    const { connectTeamsChannel } = await import("./agent-config");
    await connectTeamsChannel(found.id, "", "gs-native").catch(() => {});
    return { ok: true as const, handle: ag.handle };
  });

export const createAgentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      handle: string;
      name: string;
      kind: "fleet" | "webhook" | "a2a" | "acp";
      fleetId?: string;
      webhookUrl?: string;
      /** A2A: la URL del AgentCard. Es la identidad del agente, no un endpoint más. */
      cardUrl?: string;
      /** ACP: la URL del WebSocket de la caja. */
      wsUrl?: string;
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
    let cardUrl: string | undefined;
    let wsUrl: string | undefined;

    if (data.kind === "fleet") {
      if (!data.fleetId) throw new Error("elige un agente de la flota");
      const found = (await fleetAgentsWithRefresh()).find((a) => a.id === data.fleetId);
      if (!found) throw new Error("agente de flota no encontrado");
      fleetId = found.id;
      fleetToken = found.token;
      if (!name) name = found.name || found.assistantName || handle;
      // Marca el canal Teams como conectado → el agente aparece "Activo · Conectado" de
      // una (sin esperar el primer mensaje que estamparía connectedAt). Best-effort.
      const { connectTeamsChannel } = await import("./agent-config");
      await connectTeamsChannel(fleetId, fleetToken, "easybits"); // este camino adopta uno de EasyBits
    } else if (data.kind === "acp") {
      // Se comprueba que la caja ESTÉ VIVA antes de guardar. No hay card que descubrir —la
      // caja es nuestra— pero sí un `/health`, y guardar una URL muerta sólo mueve el fallo
      // al primer mensaje que alguien mande en un canal.
      const raw = data.wsUrl?.trim();
      if (!raw) throw new Error("URL del agente requerida");
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new Error("URL inválida");
      }
      if (u.protocol !== "wss:" && u.protocol !== "ws:") {
        throw new Error("tiene que ser una URL de WebSocket (wss://…)");
      }
      // El health va por HTTPS sobre el mismo host y puerto; el socket sólo cambia el esquema.
      const health = new URL(raw.replace(/^ws/, "http"));
      health.pathname = "/health";
      health.search = "";
      const res = await fetch(health.toString()).catch(() => null);
      if (!res?.ok) throw new Error(`la caja no responde en ${health.host}`);
      wsUrl = raw;
      if (!name) name = handle;
    } else if (data.kind === "a2a") {
      // El alta A2A LEE el card antes de guardar. Es la razón de ser del protocolo: si el
      // descubrimiento funciona, guardamos algo que sabemos que sirve; si no, se dice ahora
      // y no en el primer mensaje que alguien mande en un canal.
      const raw = data.cardUrl?.trim();
      if (!raw) throw new Error("URL del AgentCard requerida");
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new Error("URL inválida");
      }
      if (u.protocol !== "https:") throw new Error("el AgentCard tiene que servirse por HTTPS");
      const { fetchCard, interfaceOf } = await import("./a2a-client.server");
      const card = await fetchCard(raw, { force: true }).catch((e) => {
        throw new Error(`no pude leer el AgentCard: ${e instanceof Error ? e.message : e}`);
      });
      if (!interfaceOf(card)) {
        throw new Error("ese AgentCard no ofrece una interfaz JSONRPC, que es la que sabemos hablar");
      }
      if (card.capabilities?.streaming === false) {
        throw new Error("ese agente no soporta streaming y Teams lo necesita para el chat");
      }
      cardUrl = raw;
      if (!name) name = card.name?.slice(0, 40) || handle;
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
      // Este camino ADOPTA un agente que ya existe en la flota de EasyBits
      // (`fleetAgentsWithRefresh`), así que ahí corre. Un webhook no tiene runtime: la URL
      // ya dice todo. Un agente A2A sí lo tiene, y su "dónde" es su card.
      runtime:
        data.kind === "fleet" ? "easybits" : data.kind === "a2a" ? "a2a" : data.kind === "acp" ? "acp" : null,
      runtimeUrl: cardUrl ?? wsUrl ?? null,
    });
    return { ok: true as const, handle: ag.handle };
  });

// Crea un agente NUEVO: da de alta un fleet-agent propio (el "de verdad" donde corre
// la inferencia) con el motor elegido, y registra la fila de Teams apuntando a él. La
// flota es INVISIBLE para el usuario — cada agente de Teams nace con su propio
// fleet-agent (ya no se elige de una lista). Motor: hoy solo "claude" (el select del
// modal deja los demás para después).
export const createManagedAgentFn = createServerFn({ method: "POST" })
  .validator((d: { handle: string; name: string; engine: "claude" | "deepseek" }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../db.server");
    const handle = data.handle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!handle) throw new Error("handle requerido");
    if (handle === db.GHOSTY_HANDLE) throw new Error("@ghosty está reservado");
    if (await db.getAgentByHandle(handle)) throw new Error(`@${handle} ya existe`);

    const name = data.name.trim() || handle;
    let fleetId: string;
    let fleetToken: string;

    // Cutover per-tenant (igual que el path de mensajes): si el workspace ya es
    // NATIVO (gc_config.agent_runtime_url / env GHOSTY_RUNTIME_URL), el alta nace en
    // Studio por HMAC (owner = el user de GS = sub). Si no, sigue por EasyBits (path
    // actual, sin cambio). ADITIVO: no flipea a nadie que hoy esté en EasyBits.
    const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    // El agente queda MARCADO con el runtime donde nació. Antes no se guardaba y
    // había que adivinarlo después por la config del workspace — que es de todos
    // los agentes, no de éste.
    const { kindForNewAgent } = await import("./agent-runtime.server");
    const runtime = kindForNewAgent(base);
    if (base) {
      const payload = JSON.stringify({ ownerUserId: user.sub, engine: data.engine, name, persona: { name } });
      const res = await fetch(`${base}/api/v2/fleet-agents`, { method: "POST", headers: partnerHeaders(payload, await (await import("./tenant.server")).currentNamespace()), body: payload });
      if (!res.ok) throw new Error(`alta nativa ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { id: string; token: string };
      fleetId = j.id;
      fleetToken = j.token;
    } else {
      const { getConfigMany } = await import("../config.server");
      const { resolveFleetAuth } = await import("./setup");
      const c = await getConfigMany(["eb_access_token", "eb_owner_key"]);
      const token = resolveFleetAuth(c);
      if (!token) throw new Error("Conecta tu cuenta para crear agentes");
      const { createFleetAgent } = await import("./easybits-oauth.server");
      const agent = await createFleetAgent(token, { engine: data.engine, name });
      fleetId = agent.id;
      fleetToken = agent.token;
    }

    // Marca el canal Teams como conectado (best-effort) → aparece "Activo" de una.
    const { connectTeamsChannel } = await import("./agent-config");
    await connectTeamsChannel(fleetId, fleetToken, runtime).catch(() => {});
    const ag = await db.createAgent({
      handle,
      name,
      kind: "fleet",
      fleetId,
      fleetToken,
      createdBy: user.sub,
      runtime,
    });
    return { ok: true as const, handle: ag.handle };
  });

export const updateAgentFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      id: number;
      name?: string;
      handle?: string;
      webhookUrl?: string;
      enabled?: boolean;
      systemPrompt?: string | null;
      avatar?: string | null;
      /** A2A: nueva URL del AgentCard. */
      cardUrl?: string;
      /** ACP: nueva URL del WebSocket de la caja. */
      wsUrl?: string;
    }) => d
  )
  .handler(async ({ data }) => {
    await requireAgentManage(data.id); // owner o colaborador (editar config, no ver secret)
    const db = await import("../db.server");
    // Cambio de @handle (el tag): normaliza, valida no-vacío y unicidad. "ghosty" es
    // reservado — solo la propia fila @ghosty puede conservarlo (no se lo roba otro).
    let handle: string | undefined;
    if (data.handle !== undefined) {
      handle = data.handle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!handle) throw new Error("handle requerido");
      const clash = await db.getAgentByHandle(handle);
      if (clash && clash.id !== data.id) throw new Error(`@${handle} ya existe`);
      if (handle === db.GHOSTY_HANDLE) {
        const self = await db.getAgentById(data.id);
        if (self?.handle !== db.GHOSTY_HANDLE) throw new Error("@ghosty está reservado");
      }
    }
    // A2A: cambiar la URL del card es cambiar A QUÉ AGENTE apunta esta fila, así que se
    // valida igual que en el alta —leyéndolo— en vez de guardar a ciegas. La dirección de una
    // caja cambia cada vez que se recrea, y sin esto la única salida era borrar y volver a
    // dar de alta el agente, perdiendo su @handle y su historial.
    let cardUrl: string | undefined;
    let wsUrl: string | undefined;
    if (data.cardUrl !== undefined) {
      const raw = data.cardUrl.trim();
      if (!raw) throw new Error("URL del AgentCard requerida");
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new Error("URL inválida");
      }
      if (u.protocol !== "https:") throw new Error("el AgentCard tiene que servirse por HTTPS");
      const { fetchCard, interfaceOf } = await import("./a2a-client.server");
      const card = await fetchCard(raw, { force: true }).catch((e) => {
        throw new Error(`no pude leer el AgentCard: ${e instanceof Error ? e.message : e}`);
      });
      if (!interfaceOf(card)) {
        throw new Error("ese AgentCard no ofrece una interfaz JSONRPC, que es la que sabemos hablar");
      }
      cardUrl = raw;
    }

    // ACP: cambiar la URL es apuntar a OTRA caja. Se comprueba que responda, por lo mismo que
    // en el alta: guardar una muerta sólo mueve el fallo al primer mensaje de un canal.
    if (data.wsUrl !== undefined) {
      const raw = data.wsUrl.trim();
      if (!raw) throw new Error("URL del agente requerida");
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new Error("URL inválida");
      }
      if (u.protocol !== "wss:" && u.protocol !== "ws:") {
        throw new Error("tiene que ser una URL de WebSocket (wss://…)");
      }
      const health = new URL(raw.replace(/^ws/, "http"));
      health.pathname = "/health";
      health.search = "";
      const res = await fetch(health.toString()).catch(() => null);
      if (!res?.ok) throw new Error(`la caja no responde en ${health.host}`);
      wsUrl = raw;
    }

    await db.updateAgent(data.id, {
      name: data.name,
      handle,
      webhookUrl: data.webhookUrl,
      enabled: data.enabled,
      systemPrompt: data.systemPrompt,
      avatar: data.avatar,
      runtimeUrl: cardUrl ?? wsUrl,
    });
    return { ok: true as const };
  });

export const deleteAgentFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    const db = await import("../db.server");
    const a = await db.getAgentById(data.id);
    await db.deleteAgent(data.id);
    // Si borramos el @ghosty del wizard (fila migrada del config), limpia también las
    // claves de config → NO se re-materializa al recargar. Manda de vuelta al wizard.
    if (a && a.handle === db.GHOSTY_HANDLE) {
      const { setConfig } = await import("../config.server");
      for (const k of ["fleet_agent_id", "fleet_token", "fleet_name", "ghosty_prompt"]) await setConfig(k, "");
    }
    return { ok: true as const };
  });
