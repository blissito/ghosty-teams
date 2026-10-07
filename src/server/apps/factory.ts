import { createServerFn } from "@tanstack/react-start";
import { summarizeEvals } from "./factory-evals";
import { sessionUser } from "../chat";
import { FACTORY_ENGINES, FACTORY_HANDLES as HANDLES, ROLE_NAMES, roleAvatar, type FactoryHandle } from "./factory-roles";
import { keepRoleColor, recolorRoleAvatar } from "../../utils/factory-avatar";

// Instalar / desinstalar la Software Factory en ESTE espacio (Ajustes → Apps).
//
// Instalar deja la fábrica lista para trabajar:
//  1. un room (uno existente o `#fabrica`) con el repo del equipo atado (`gt_room_repos`);
//  2. los tres handles (`@plan`, `@build`, `@check`) apuntando a agentes de Studio que elige
//     el dueño (la fábrica NO crea agentes: motor, modelo y llaves se afinan en /app/agents);
//  3. un tablero de Tasks «Fábrica» recordado para el room (las tres columnas estándar: la
//     etapa de cada corrida va en su tarea y su tarjeta, no en columnas propias);
//  4. la fila en `gt_installed_apps`, que es lo que hace aparecer las tools `factory_*`,
//     `alert_webhook_*` y `uptime_*`.
// Desinstalar apaga los handles y borra la fila; la caja, el tablero y las corridas se
// quedan (desactivar no borra, igual que los agentes de Studio).


/**
 * Config en `gt_installed_apps`. `roles` = a qué agente de Studio apunta cada handle.
 * `ownedHandles` = los handles que CREÓ la instalación: sólo ésos se repuntan o apagan
 * (una fila `@plan` previa de otra cosa nunca se toca).
 * `fleetAgentId`/`boxes` = formato viejo (cajas propias de la fábrica, ya retirado).
 */
type FactoryCfg = {
  /** Etiqueta del runner de la caja de CI del espacio (`ws-<slug>`), una vez pedida a gs. */
  ciLabel?: string;
  roles?: Partial<Record<FactoryHandle, string>>;
  ownedHandles?: string[];
  roomId?: number;
  boardId?: number | null;
  fleetAgentId?: string;
  boxes?: Record<string, string>;
};

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("sólo el dueño del espacio instala apps");
  return user;
}

/**
 * Pide a gs la caja de CI del espacio con estos repos (la crea, la registra como runner con
 * la GitHub App; sin configuración). Devuelve la etiqueta del runner o null. Nunca lanza.
 */
export async function requestCiBox(repos: string[]): Promise<string | null> {
  try {
    const { currentSlug } = await import("../tenant.server");
    const slug = await currentSlug();
    if (!slug || !repos.length) return null;
    const body = JSON.stringify({ repos });
    const crypto = await import("node:crypto");
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!).update(`${ts}.${slug}.${body}`).digest("hex");
    const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
    const res = await fetch(`${IDP}/internal/workspace-ci/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; label?: string } | null;
    return res.ok && out?.ok && out.label ? out.label : null;
  } catch {
    return null;
  }
}

/** Agentes de Studio que puede usar este espacio (scopeado por la firma, como "De Studio"). */
export async function studioAgents() {
  const { nativeRuntimeBase } = await import("../ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) return [];
  const { listNativeFleetAgents } = await import("../fleet-native.server");
  const pools = await listNativeFleetAgents(base, "").catch(() => []);
  return pools
    // Sin los patrocinados (corren con la llave de otro, p.ej. la de testers): un rol de la
    // fábrica quema tokens a lo grande y la preselección los ponía sin que nadie lo notara
    // (@plan de abogados, 3-oct).
    .filter((p) => (p.protocol ?? "sse") === "sse" && !p.sponsored && (FACTORY_ENGINES as readonly string[]).includes(p.engine ?? ""))
    .map((p) => ({ id: p.id, name: p.name || p.assistantName || p.id, engine: p.engine ?? "", model: p.model ?? "" }));
}

export type StudioAgentOption = Awaited<ReturnType<typeof studioAgents>>[number];

/**
 * Crea un agente de Studio DESDE AQUÍ, para asignarlo a un rol sin salir de Teams. Es un
 * agente normal (sale en /app/agents, se afina ahí): lo crea gs con el mismo alta firmada que
 * ya usa Teams (`POST api/v2/fleet-agents`), a nombre del dueño del espacio y ligado a él,
 * así que siempre aparece en la lista de roles. El modelo es el default del motor que quepa
 * en el plan.
 */
export const createFactoryAgentFn = createServerFn({ method: "POST" })
  .validator((d: { name: string; engine: string }) => d)
  .handler(async ({ data }): Promise<StudioAgentOption> => {
    await requireOwner();
    const name = String(data.name ?? "").trim().slice(0, 40);
    if (!name) throw new Error("ponle nombre al agente");
    if (!(FACTORY_ENGINES as readonly string[]).includes(data.engine)) throw new Error("motor no válido");
    const { nativeRuntimeBase } = await import("../ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) throw new Error("este espacio no tiene runtime nativo");
    const { createNativeFleetAgent } = await import("../fleet-native.server");
    // `ownerUserId` vacío: gs resuelve el dueño desde el espacio que firma.
    const created = await createNativeFleetAgent(base, { ownerUserId: "", engine: data.engine, name });
    const found = (await studioAgents()).find((a) => a.id === created.id);
    return found ?? { id: created.id, name, engine: data.engine, model: "" };
  });

/**
 * Apunta cada handle al agente elegido. Crea el handle si no existe (y lo marca como de la
 * fábrica); si ya es de la fábrica, lo repunta; si es de OTRA cosa, error. Reusa la
 * activación "De Studio": fila `fleet` gs-native con `groupNs` + canal Teams declarado.
 */
async function assignRoles(sub: string, roles: Partial<Record<FactoryHandle, string>>, cfg: FactoryCfg | null) {
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const agents = await studioAgents();
  const owned = new Set(cfg?.ownedHandles ?? []);
  // Instalaciones de la versión con cajas propias: sus handles también son de la fábrica.
  const oldBoxes = new Set([cfg?.fleetAgentId, ...Object.values(cfg?.boxes ?? {})].filter(Boolean) as string[]);
  const out: Partial<Record<FactoryHandle, string>> = {};
  for (const h of HANDLES) {
    const id = roles[h];
    const agent = agents.find((a) => a.id === id);
    if (!agent) throw new Error(`elige un agente de Studio (Claude, DeepSeek o Codex) para @${h}`);
    const row = await db.getAgentByHandle(h);
    if (!row) {
      await db.createAgent({
        handle: h,
        name: ROLE_NAMES[h],
        kind: "fleet",
        fleetId: agent.id,
        fleetToken: null,
        runtime: "gs-native",
        groupNs: true,
        avatar: roleAvatar(h),
        systemPrompt: null,
        createdBy: sub,
      });
      owned.add(h);
    } else if (owned.has(h) || (row.fleet_id && oldBoxes.has(row.fleet_id))) {
      await dbq(
        `UPDATE gc_agents SET fleet_id = ?, kind = 'fleet', runtime = 'gs-native', runtime_url = NULL, fleet_token = NULL,
                              enabled = 1, name = ?, avatar = ?, group_ns = 1 WHERE handle = ?`,
        [agent.id, ROLE_NAMES[h], keepRoleColor(h, row.avatar, roleAvatar(h)), h],
      );
      owned.add(h);
    } else {
      throw new Error(`@${h} ya lo usa otro agente de este espacio: renómbralo antes de instalar la fábrica`);
    }
    out[h] = agent.id;
  }
  // Igual que "De Studio": el canal Teams se declara en Studio para cada agente usado.
  const { connectTeamsChannel } = await import("../agent-config");
  for (const id of new Set(Object.values(out))) await connectTeamsChannel(id!, "", "gs-native").catch(() => {});
  return { roles: out, ownedHandles: [...owned] };
}

export type FactoryRoleView = {
  handle: FactoryHandle;
  agentId: string | null;
  label: string;
  studioUrl: string | null;
};

export type FactoryStatus = {
  installed: boolean;
  room: { id: number; slug: string; name: string } | null;
  repos: string[];
  boardId: number | null;
  roles: FactoryRoleView[];
  /** @eval, el juez opcional de los evals (null = juzga @check). */
  judgeAgentId?: string | null;
  candidates: StudioAgentOption[];
  studioAgentsUrl: string;
};

const IDP = () => process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

/**
 * Rooms que trabajan como fábrica: TODOS los que tienen repos. La instalación sólo fija el
 * room por defecto (`cfg.roomId`): el de la barra, el de los horarios si no hay otro y el que
 * se abre primero en /factory. Las tools `factory_*` ya servían en cualquier room con repos.
 */
export async function factoryRoomIds(): Promise<number[]> {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq(
    `SELECT DISTINCT r.channel_id FROM gt_room_repos r JOIN gc_channels c ON c.id = r.channel_id WHERE COALESCE(c.archived, 0) = 0`,
    [],
  ).catch(() => []);
  return rows.map((r) => Number(r.channel_id));
}

/** El room pedido si es de fábrica y lo ves; si no, el de la instalación. Lanza si no ves ninguno. */
async function pickFactoryRoom(me: { sub: string; isOwner?: boolean }, cfg: FactoryCfg | null, roomId?: number | null) {
  const db = await import("../../db.server");
  const ids = new Set(await factoryRoomIds());
  const channels = (await db.listChannels(me.sub, !!me.isOwner)).filter((c) => ids.has(c.id));
  // Sin room pedido: el que tiene el pedido más reciente (donde se está trabajando), no el de la
  // instalación — con MailMask activo, /factory abría #denik y parecía que faltaba el pedido.
  const { dbq } = await import("../../dbq.server");
  const [latest] = await dbq(
    `SELECT channel_id FROM gt_factory_runs WHERE COALESCE(kind, '') != 'eval' ORDER BY updated_at DESC LIMIT 1`,
    [],
  ).catch(() => []);
  const recent = latest ? channels.find((c) => c.id === Number(latest.channel_id)) : undefined;
  const room = channels.find((c) => c.id === Number(roomId)) ?? recent ?? channels.find((c) => c.id === cfg?.roomId) ?? channels[0] ?? null;
  if (!room) throw new Error("no ves ningún room con repos de la fábrica");
  return { room, channels, repos: (await db.listRoomRepos(room.id)).map((r) => r.repo) };
}

export const factoryStatusFn = createServerFn({ method: "GET" }).handler(async (): Promise<FactoryStatus> => {
  await requireOwner();
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  const candidates = await studioAgents();
  const base = { candidates, studioAgentsUrl: `${IDP()}/app/agents` };
  if (!cfg) return { installed: false, room: null, repos: [], boardId: null, roles: [], ...base };
  const db = await import("../../db.server");
  const ch = cfg.roomId ? await db.getChannelById(cfg.roomId) : null;
  const repos = cfg.roomId ? (await db.listRoomRepos(cfg.roomId)).map((r) => r.repo) : [];
  const rows = await db.listAgents();
  // La verdad es la fila del handle HOY, no la config.
  const roles: FactoryRoleView[] = HANDLES.map((h) => {
    const id = rows.find((a) => a.handle === h && a.enabled)?.fleet_id ?? null;
    const a = candidates.find((c) => c.id === id);
    return {
      handle: h,
      agentId: id,
      label: a ? `${a.name} · ${a.engine} · ${a.model}` : id ? "agente fuera de la lista" : "sin agente",
      studioUrl: id ? `${IDP()}/app/agents/${id}` : null,
    };
  });
  // @eval (opcional): el juez de los evals. Sin fila activa, juzga @check.
  const judgeId = rows.find((a) => a.handle === "eval" && a.enabled)?.fleet_id ?? null;
  return {
    installed: true,
    room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null,
    repos,
    boardId: cfg.boardId ?? null,
    roles,
    judgeAgentId: judgeId,
    ...base,
  };
});

export const installFactoryFn = createServerFn({ method: "POST" })
  .validator((d: { roomId?: number | null; repo: string; roles: Partial<Record<FactoryHandle, string>> }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../../db.server");
    const { normalizeRepo } = await import("../connectors/github.server");
    const repo = normalizeRepo(String(data.repo ?? ""));
    if (!repo) throw new Error('elige el repositorio (va como "dueño/repo")');
    const { getAppConfig, recordInstall } = await import("./installed.server");
    // La instalación anterior (aunque se haya desinstalado): sus handles y su tablero se reusan.
    const prev = await getAppConfig<FactoryCfg>("factory", { includeUninstalled: true });

    // 1. Los roles primero: si un agente no vale, no se crea nada más.
    const assigned = await assignRoles(user.sub, data.roles ?? {}, prev);

    // 2. El room.
    let roomId = Number(data.roomId) || 0;
    if (roomId) {
      const ch = (await db.listChannels(user.sub, true)).find((c) => c.id === roomId);
      if (!ch) throw new Error("room no encontrado");
    } else {
      const ch = await db.createChannel({
        name: "fabrica",
        description: "Software Factory: pide aquí con @plan, @build construye y @check revisa.",
        isPrivate: false,
        createdBy: user.sub,
      });
      roomId = ch.id;
    }
    await db.addRoomRepo(roomId, repo, user.sub);
    // Su `homepage` como primer monitor de uptime del room (en segundo plano: habla con GitHub).
    void import("./uptime.server").then((U) => U.autoMonitorRepo(roomId, repo, user.sub)).catch(() => {});

    // 4. La caja de CI del espacio (se crea y registra sola, en segundo plano en gs).
    const ciLabel = (await requestCiBox((await db.listRoomRepos(roomId)).map((r) => r.repo))) ?? prev?.ciLabel;

    // 5. La fila que enciende las tools.
    await recordInstall("factory", user.sub, { ...assigned, roomId, ...(ciLabel ? { ciLabel } : {}) });
    const ch = await db.getChannelById(roomId);
    return { ok: true as const, room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null };
  });

/** Cambia a qué agente apunta cada rol, sin reinstalar. El siguiente turno ya corre en él. */
export const setFactoryRolesFn = createServerFn({ method: "POST" })
  .validator((d: { roles: Partial<Record<FactoryHandle, string>> }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const cfg = await getAppConfig<FactoryCfg>("factory");
    if (!cfg) throw new Error("la fábrica no está instalada");
    const assigned = await assignRoles(user.sub, data.roles ?? {}, cfg);
    await recordInstall("factory", user.sub, { roomId: cfg.roomId, boardId: cfg.boardId ?? null, ...(cfg.ciLabel ? { ciLabel: cfg.ciLabel } : {}), ...assigned });
    return { ok: true as const };
  });

/**
 * @eval, el juez opcional de los evals. `agentId: null` lo apaga (vuelve a juzgar @check). Misma
 * activación «De Studio» que los roles, pero aparte: no forma parte de la cadena ni del instalador.
 */
export const setFactoryJudgeFn = createServerFn({ method: "POST" })
  .validator((d: { agentId: string | null }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const cfg = await getAppConfig<FactoryCfg>("factory");
    if (!cfg) throw new Error("la fábrica no está instalada");
    const db = await import("../../db.server");
    const { dbq } = await import("../../dbq.server");
    const { JUDGE_HANDLE, JUDGE_NAME } = await import("./factory-roles");
    const owned = new Set(cfg.ownedHandles ?? []);
    const row = await db.getAgentByHandle(JUDGE_HANDLE);
    if (row && !owned.has(JUDGE_HANDLE)) throw new Error(`@${JUDGE_HANDLE} ya lo usa otro agente de este espacio: renómbralo primero`);
    if (!data.agentId) {
      if (row) await dbq("UPDATE gc_agents SET enabled = 0 WHERE handle = ?", [JUDGE_HANDLE]);
      return { ok: true as const };
    }
    const agent = (await studioAgents()).find((a) => a.id === data.agentId);
    if (!agent) throw new Error("elige un agente de Studio (Claude, DeepSeek o Codex)");
    if (!row) {
      await db.createAgent({
        handle: JUDGE_HANDLE,
        name: JUDGE_NAME,
        kind: "fleet",
        fleetId: agent.id,
        fleetToken: null,
        runtime: "gs-native",
        groupNs: true,
        avatar: roleAvatar(JUDGE_HANDLE),
        systemPrompt: null,
        createdBy: user.sub,
      });
    } else {
      await dbq(
        `UPDATE gc_agents SET fleet_id = ?, kind = 'fleet', runtime = 'gs-native', runtime_url = NULL, fleet_token = NULL,
                              enabled = 1, name = ?, avatar = ?, group_ns = 1 WHERE handle = ?`,
        [agent.id, JUDGE_NAME, keepRoleColor(JUDGE_HANDLE, row.avatar, roleAvatar(JUDGE_HANDLE)), JUDGE_HANDLE],
      );
    }
    const { connectTeamsChannel } = await import("../agent-config");
    await connectTeamsChannel(agent.id, "", "gs-native").catch(() => {});
    if (!owned.has(JUDGE_HANDLE)) await recordInstall("factory", user.sub, { ...cfg, ownedHandles: [...owned, JUDGE_HANDLE] });
    return { ok: true as const };
  });

/**
 * Color de la flamita de un rol (@plan, @build, @check, @eval), desde el Perfil del agente.
 * Se guarda en `gc_agents.avatar` (la URL lleva el color) y se avisa a todo el espacio para
 * que mensajes, barra lateral y perfil lo repinten sin recargar.
 */
export const setFactoryRoleColorFn = createServerFn({ method: "POST" })
  .validator((d: { handle: string; color: string }) => ({ handle: String(d?.handle ?? ""), color: String(d?.color ?? "").toLowerCase() }))
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user?.isOwner) throw new Error("sólo el dueño del espacio cambia el color de un rol");
    const db = await import("../../db.server");
    const row = await db.getAgentByHandle(data.handle);
    if (!row) throw new Error(`@${data.handle} no existe en este espacio`);
    const { roleAvatar: gsAvatar } = await import("./factory-roles");
    const avatar = recolorRoleAvatar(data.handle, row.avatar, data.color, gsAvatar(data.handle as FactoryHandle));
    await db.updateAgent(row.id, { avatar });
    const { currentNamespace } = await import("../tenant.server");
    const { publish, ch } = await import("../bus.server");
    publish(ch.presence(await currentNamespace()), { t: "agents:changed" });
    return { ok: true as const, avatar };
  });

export const uninstallFactoryFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { getAppConfig, recordUninstall } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  // Sólo los handles que creó la fábrica; los agentes de Studio no se tocan.
  const owned = (cfg?.ownedHandles ?? []).filter((h) => (HANDLES as readonly string[]).includes(h) || h === "eval");
  if (owned.length) {
    const { dbq } = await import("../../dbq.server");
    await dbq(`UPDATE gc_agents SET enabled = 0 WHERE handle IN (${owned.map(() => "?").join(",")})`, owned);
  }
  await recordUninstall("factory");
  return { ok: true as const };
});

// ── La tarjeta de plan ───────────────────────────────────────────────────────

/** Lo que pinta la tarjeta `gt-plan`: se lee al pintar, nunca se congela en el mensaje. */
export const factoryPlanCardFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number; version: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) return null;
    // Quien no ve el room no ve la corrida.
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) return null;
    const plan = await R.getPlan(run.id, Number(data.version));
    if (!plan) return null;
    return {
      runId: run.id,
      title: run.title,
      status: run.status,
      version: plan.version,
      current: run.planVersion,
      planMd: plan.planMd,
      decision: plan.decision,
      decidedBy: plan.decidedBy,
      note: plan.note,
      prUrl: run.prUrl,
      critique: plan.critique,
    };
  });

/** Aprobar / pedir cambios desde la tarjeta. Firma QUIEN HACE CLIC, no el agente. */
export const factoryDecisionFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number; version: number; decision: "approve" | "changes"; note?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("pedido no encontrado");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    const { reqOrigin } = await import("../../origin.server");
    const next = await R.decide({
      run,
      version: Number(data.version),
      decision: data.decision === "changes" ? "changes" : "approve",
      note: data.note,
      sub: me.sub,
      who: me.name || "alguien",
      origin: await reqOrigin().catch(() => ""),
    });
    return { ok: true as const, status: next.status };
  });

// ── Tareas programadas (revisión nocturna, dependencias) ─────────────────────

export const factorySchedulesFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  const { listSchedules } = await import("./factory-schedules.server");
  return listSchedules();
});

export const setFactoryScheduleFn = createServerFn({ method: "POST" })
  .validator((d: { kind: "nightly" | "deps"; enabled: boolean; hour: number }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    if (data.kind !== "nightly" && data.kind !== "deps") throw new Error("tarea desconocida");
    // La hora se entiende en la zona de quien la programa (la misma que usan los recordatorios).
    const { dbq } = await import("../../dbq.server");
    const rem = await import("../reminders.server");
    const rows = await dbq("SELECT tz FROM gc_users WHERE sub = ?", [user.sub]).catch(() => []);
    const tz = rows[0]?.tz && rem.isValidTz(String(rows[0].tz)) ? String(rows[0].tz) : rem.DEFAULT_TZ;
    const { saveSchedule } = await import("./factory-schedules.server");
    const { reqOrigin } = await import("../../origin.server");
    const origin = await reqOrigin().catch(() => "");
    const nextAt = await saveSchedule(data.kind, { enabled: !!data.enabled, hour: Number(data.hour) }, user.sub, tz, origin);
    return { ok: true as const, nextAt };
  });

// ── La tarjeta viva de una corrida (```gt-run```) ────────────────────────────

/** Estado de una corrida para su tarjeta viva en el room. Se lee al pintar. */
export const factoryRunCardFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) return null;
    const db = await import("../../db.server");
    const ch = (await db.listChannels(me.sub, me.isOwner)).find((c) => c.id === run.channelId);
    if (!ch) return null; // quien no ve el room no ve la corrida
    const plan = run.planVersion ? await R.getPlan(run.id, run.planVersion) : null;
    return {
      runId: run.id,
      title: run.title,
      status: run.status,
      planVersion: run.planVersion,
      loops: run.loops,
      prUrl: run.prUrl,
      repo: run.repo,
      // La preview del PR (Vercel, Netlify…): el cambio se ve sin bajar el código.
      // La preview del PR (la del hosting o la de nuestra caja), tal como la dejó el tick.
      // En cualquier etapa con PR: mientras Build corrige, la preview anterior sigue sirviendo
      // para ver cómo va (antes sólo se mostraba en check o con el PR listo).
      preview: run.prUrl && !["done", "cancelled"].includes(run.status) ? { ...(await R.runPreview(run.id)), provider: null as string | null } : null,
      threadUrl: `/c/${ch.slug}?thread=${run.rootMsgId}`,
      // Firmable desde la tarjeta: el plan vigente espera firma (o hay que decidir tras escalar).
      canSign: (run.status === "plan_review" && !!plan && !plan.decision) || run.status === "escalated",
      // El CI del PR EN VIVO (no el del veredicto): tras preparar el repo, el aviso seguía pidiendo
      // «Prepara el repo» con el CI ya en main (MailMask #10, 4-oct).
      // Con el GitHub de quien aprobó/pidió (como el tick): quien mira sin GitHub conectado también ve el paso.
      ci: run.prUrl && !["done", "cancelled"].includes(run.status) ? await liveCi(run.approvedBy ?? run.requestedBy ?? me.sub, run.prUrl, run.repo, me.sub) : null,
      canPrep: !!me.isOwner && !!run.repo,
      // Escalado: lo que @check pide decidir, para pintarlo arriba (y aprobar con un 2º clic).
      escalation: await (async () => {
        const e = await R.escalationOf(run);
        return e ? { points: R.findingPoints(e.findings), at: e.at } : null;
      })(),
      // Después del merge: lo que vio el vigilante en producción (paso «Prod»).
      prod: run.status === "done" ? await (await import("./post-merge.server")).runProd(run) : null,
      // Firmado pero sin lugar en el tier: la tarjeta dice «En espera de lugar», no «Arrancando…».
      boxWaiting: !!run.boxWaiting && run.status === "building",
      ...(await runLive(run)),
    };
  });

// La tarjeta se refresca con cada evento del room: GitHub se pregunta como mucho cada minuto por PR.
const ciCache = new Map<string, { at: number; v: { state: string; repoHasCi: boolean } | null }>();
async function liveCi(sub: string, prUrl: string, repo: string | null, fallbackSub?: string): Promise<{ state: string; repoHasCi: boolean } | null> {
  const hit = ciCache.get(prUrl);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const R = await import("./factory-runs.server");
  let ci = await R.prCi(sub, prUrl).catch(() => null);
  if (!ci && fallbackSub && fallbackSub !== sub) {
    ci = await R.prCi(fallbackSub, prUrl).catch(() => null);
    if (ci) sub = fallbackSub;
  }
  let v: { state: string; repoHasCi: boolean } | null = null;
  if (ci) {
    // Sin checks en el PR: ¿es que el repo no tiene CI, o que el PR todavía no lo corre?
    const { hasWorkflows } = await import("./ci-starter.server");
    const repoHasCi = ci.state === "none" && repo ? await hasWorkflows(sub, repo).catch(() => false) : ci.state !== "none";
    v = { state: ci.state, repoHasCi };
  }
  ciCache.set(prUrl, { at: Date.now(), v });
  return v;
}

/**
 * Lo vivo del pedido para la barra del hilo y el panel: estado CALCULADO (`viewState`), el
 * paso que narra el agente ahora y la última actividad. Nada de esto lo declara el modelo.
 */
export async function runLive(run: import("./factory-runs.server").Run) {
  const { dbq } = await import("../../dbq.server");
  const { viewState } = await import("./factory-flow");
  const turns = await import("../turns.server");
  const { currentNamespace } = await import("../tenant.server");
  const live = turns.allLiveTurnStates(await currentNamespace()).find((t) => t.channelId === run.channelId && t.parentId === run.rootMsgId) ?? null;
  const [last] = await dbq(
    `SELECT MAX(COALESCE((SELECT MAX(at) FROM gt_factory_events WHERE run_id = ?), 0),
            COALESCE((SELECT MAX(created_at) FROM gc_messages WHERE channel_id = ? AND parent_id = ?), 0)) AS t`,
    [run.id, run.channelId, run.rootMsgId],
  ).catch(() => [{ t: 0 }]);
  const now = Math.floor(Date.now() / 1000);
  const lastActivityAt = Number(last?.t || now);
  // El rol preguntó y espera a la persona (`waiting_person` es el último evento).
  const [ev] = await dbq("SELECT type, actor FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT 1", [run.id]).catch(() => []);
  const waitingOn = !live && ev?.type === "waiting_person" ? String(ev.actor ?? "") || null : null;
  const view = viewState(run, { lastActivityAt, now, busy: !!live, waitingOn });
  return {
    view,
    waitingOn,
    lastActivityAt,
    currentStep: live?.paso ?? null,
    liveTurnId: live?.id ?? null,
    rootMsgId: run.rootMsgId,
    requestedBy: run.requestedBy,
  };
}

/** ¿Este hilo es un pedido de la fábrica? Su id, o null. La barra del hilo empieza aquí. */
export const factoryRunOfThreadFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; rootMsgId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return null;
    const R = await import("./factory-runs.server");
    const run = await R.runOfThread(Number(data.channelId), Number(data.rootMsgId)).catch(() => null);
    return run ? { runId: run.id } : null;
  });

/** El detalle del pedido para el panel lateral: plan vigente, veredicto y bitácora. */
export const factoryRunDetailFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) return null;
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) return null;
    const { dbq } = await import("../../dbq.server");
    const plan = run.planVersion ? await R.getPlan(run.id, run.planVersion) : null;
    const [v] = await dbq("SELECT verdict_json FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
    const events = await dbq("SELECT id, at, actor, type, data_json FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT 100", [run.id]).catch(() => []);
    // JSON crudo: el server fn sólo serializa tipos concretos; el panel lo parsea.
    return {
      planMd: plan?.planMd ?? null,
      planVersion: run.planVersion,
      verdictJson: (v?.verdict_json ?? null) as string | null,
      events: events.map((e) => ({ id: Number(e.id), at: Number(e.at), actor: (e.actor ?? null) as string | null, type: String(e.type), dataJson: (e.data_json ?? null) as string | null })),
    };
  });

/**
 * Acciones de una persona sobre el pedido desde la barra o el panel (las mismas que el agente
 * hace por tool): detener el turno en vuelo, retomar uno colgado, cancelar.
 */
export const factoryRunActionFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number; action: "stop" | "resume" | "cancel" }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("pedido no encontrado");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    if (data.action === "cancel") {
      const next = await R.applyEvent(run, "cancel", {}, { actor: me.name || me.sub });
      return { ok: true as const, status: next.status };
    }
    const live = await runLive(run);
    if (data.action === "stop") {
      if (!live.liveTurnId) throw new Error("no hay nadie trabajando en este pedido ahora");
      const turns = await import("../turns.server");
      const { currentNamespace } = await import("../tenant.server");
      if (!turns.stopTurn(await currentNamespace(), live.liveTurnId, me.sub)) throw new Error("no pude detenerlo (sólo quien lo pidió puede)");
      await R.logEvent(run.id, "stopped", me.name || me.sub);
      return { ok: true as const, status: run.status };
    }
    // Retomar: el rol de la etapa vuelve a trabajar en el mismo hilo, con un encargo explícito.
    const role = ({ planning: "plan", building: "build", checking: "check" } as const)[run.status as "planning" | "building" | "checking"];
    if (!role) throw new Error("en esta etapa no hay nada que retomar");
    if (live.liveTurnId) throw new Error("ya hay alguien trabajando en este pedido");
    // Esperando lugar: @build no tiene caja todavía. Retomar = volver a pedirla; si sigue sin lugar,
    // se dice y no se despierta a nadie.
    if (run.boxWaiting && role === "build") {
      if ((await R.resumeWaitingRun(run)) === "waiting") throw new Error("sigue en espera de lugar: arranca solo en cuanto se libere uno");
      return { ok: true as const, status: run.status };
    }
    const { reqOrigin } = await import("../../origin.server");
    const ok = await R.handoff(
      run,
      role,
      run.approvedBy ?? me.sub,
      "retomar",
      `${me.name || "Una persona"} pidió retomar este pedido: se quedó sin avanzar. Revisa lo último del hilo y continúa tu paso; ciérralo con tu tool factory_*.` +
        // Las notas pendientes sólo llegan al encargar: retomar también es encargar.
        (role === "build" ? await R.takeNotes(run.id) : ""),
      await reqOrigin().catch(() => ""),
    );
    if (!ok) throw new Error("no pude despertar al agente");
    await dbq0("UPDATE gt_factory_runs SET stale_warned_at = NULL WHERE id = ?", [run.id]);
    await R.logEvent(run.id, "resumed", me.name || me.sub, { role });
    void R.refreshRoom(run.channelId);
    return { ok: true as const, status: run.status };
  });

async function dbq0(sql: string, args: unknown[]) {
  const { dbq } = await import("../../dbq.server");
  return dbq(sql, args as never[]).catch(() => []);
}

/** «Reintentar» la preview del pedido desde su tarjeta. Cualquiera que vea el room. */
export const factoryRetryPreviewFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("no existe el pedido");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    return { retried: await R.retryPreviews({ runId: run.id }) };
  });

/** «Sin preview» / «Encender» desde la tarjeta: apaga o prende la preview de TODO el repo del pedido. */
export const factorySetPreviewOffFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number; off: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("no existe el pedido");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    const pr = run.prUrl ? R.parsePrUrl(run.prUrl) : null;
    const repo = run.repo ?? pr?.repo;
    if (!repo) throw new Error("el pedido no tiene repo");
    await R.setRepoPreviewOff(repo, !!data.off, me.sub);
    await R.logEvent(run.id, data.off ? "preview_off" : "preview_on", me.name || me.sub, { repo });
    return { ok: true as const };
  });

// ── La página «Fábrica» (/factory) ───────────────────────────────────────────

/** ¿La fábrica está instalada? Para la barra lateral: cualquiera con sesión. */
export const factoryInstalledFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return false;
  const { isInstalled } = await import("./installed.server");
  return await isInstalled("factory").catch(() => false);
});

export type FactoryRunRow = {
  id: number;
  title: string;
  status: string;
  repo: string | null;
  loops: number;
  createdAt: number;
  prReadyAt: number | null;
  firstReviewAt: number | null;
  firstReviewState: string | null;
  mergedAt: number | null;
  prUrl: string | null;
  threadUrl: string | null;
  kind: string | null;
  /** Estado calculado (columna del tablero) y a quién le toca: sólo en pedidos abiertos. */
  column: string | null;
  label: string | null;
  turnSub: string | null;
};

/**
 * Lo que ve cualquier miembro en /factory: los pedidos de los rooms que ve (con los números
 * del espacio), el room de la fábrica y sus repos. Lo del dueño (roles, horarios) sigue en
 * `factoryStatusFn`.
 */
export const factoryOverviewFn = createServerFn({ method: "GET" })
  .validator((d: { roomId?: number | null } | undefined) => d ?? {})
  .handler(async ({ data }) => {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const { isInstalled, getAppConfig } = await import("./installed.server");
  const installed = await isInstalled("factory").catch(() => false);
  const cfg = await getAppConfig<FactoryCfg>("factory").catch(() => null);
  const db = await import("../../db.server");
  const channels = await db.listChannels(me.sub, me.isOwner);
  const byId = new Map(channels.map((c) => [c.id, c]));
  // Cada room con repos es una fábrica; la página trabaja uno a la vez (el pedido o el de la
  // instalación). Todo lo de abajo —tablero, sprints, pedidos, números, repos— es de ÉSE.
  const picked = installed ? await pickFactoryRoom(me, cfg, data.roomId).catch(() => null) : null;
  const room = picked?.room ?? null;
  const roomIds = new Set(await factoryRoomIds());
  const rooms = await Promise.all(
    channels
      .filter((c) => roomIds.has(c.id))
      .map(async (c) => ({ id: c.id, slug: c.slug, name: c.name, repos: (await db.listRoomRepos(c.id)).length, isDefault: c.id === cfg?.roomId })),
  );
  const repos = picked?.repos ?? [];
  const { dbq } = await import("../../dbq.server");
  const rows = room
    ? await dbq(
        `SELECT id, channel_id, root_msg_id, title, status, repo, loops, created_at, pr_ready_at, first_review_at, first_review_state, merged_at, pr_url, kind, requested_by, approved_by, box_state,
                MAX(COALESCE((SELECT MAX(at) FROM gt_factory_events e WHERE e.run_id = gt_factory_runs.id), 0),
                    COALESCE((SELECT MAX(created_at) FROM gc_messages m WHERE m.channel_id = gt_factory_runs.channel_id AND m.parent_id = gt_factory_runs.root_msg_id), 0),
                    updated_at) AS last_at
         FROM gt_factory_runs WHERE channel_id = ? AND COALESCE(kind, '') != 'eval' ORDER BY id DESC LIMIT 500`,
        [room.id],
      ).catch(() => [])
    : [];
  // El tablero es una VISTA: la columna sale de `viewState` (estado + última actividad + turno
  // en vuelo), igual que la barra del hilo. Sin datos propios.
  const { viewState } = await import("./factory-flow");
  const turns = await import("../turns.server");
  const { currentNamespace } = await import("../tenant.server");
  const live = turns.allLiveTurnStates(await currentNamespace());
  const now = Math.floor(Date.now() / 1000);
  const viewOf = (r: Record<string, any>) => {
    if (["done", "cancelled"].includes(String(r.status))) return { column: null, label: null, turnSub: null };
    const v = viewState(
      { status: r.status, requestedBy: String(r.requested_by), approvedBy: r.approved_by ?? null, boxWaiting: r.box_state === "waiting" },
      { lastActivityAt: Number(r.last_at ?? now), now, busy: live.some((t) => t.channelId === Number(r.channel_id) && t.parentId === Number(r.root_msg_id)) },
    );
    return { column: v.column, label: v.label, turnSub: v.whoseTurn?.kind === "person" ? v.whoseTurn.sub : null };
  };
  // Sólo los pedidos de rooms que esta persona ve (mismo criterio que la tarjeta viva).
  const runs: FactoryRunRow[] = rows
    .filter((r) => byId.has(Number(r.channel_id)))
    .map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      status: String(r.status),
      repo: r.repo ?? null,
      loops: Number(r.loops ?? 0),
      createdAt: Number(r.created_at ?? 0),
      prReadyAt: r.pr_ready_at != null ? Number(r.pr_ready_at) : null,
      firstReviewAt: r.first_review_at != null ? Number(r.first_review_at) : null,
      firstReviewState: r.first_review_state ?? null,
      mergedAt: r.merged_at != null ? Number(r.merged_at) : null,
      prUrl: r.pr_url ?? null,
      threadUrl: `/c/${byId.get(Number(r.channel_id))!.slug}?thread=${r.root_msg_id}&run=${r.id}`,
      kind: r.kind ?? null,
      ...viewOf(r),
    }));
  const { runStats } = await import("./factory-stats");
  // Sprints de los rooms que ve (con su avance: tickets con merge / incluidos).
  const sprintRows = room
    ? await dbq(
        `SELECT s.id, s.channel_id, s.card_msg_id, s.title, s.status, s.repo, s.created_at,
                SUM(CASE WHEN i.included = 1 THEN 1 ELSE 0 END) AS total,
                SUM(CASE WHEN i.included = 1 AND i.status IN ('merged','skipped') THEN 1 ELSE 0 END) AS merged
         FROM gt_factory_sprints s LEFT JOIN gt_factory_sprint_items i ON i.sprint_id = s.id
         WHERE s.channel_id = ? GROUP BY s.id ORDER BY s.id DESC LIMIT 50`,
        [room.id],
      ).catch(() => [])
    : [];
  const sprints = sprintRows
    .filter((r) => byId.has(Number(r.channel_id)))
    .map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      status: String(r.status),
      repo: r.repo ?? null,
      total: Number(r.total ?? 0),
      merged: Number(r.merged ?? 0),
      url: r.card_msg_id ? `/c/${byId.get(Number(r.channel_id))!.slug}?thread=${r.card_msg_id}` : null,
    }));
  return {
    sprints,
    installed,
    isOwner: !!me.isOwner,
    meSub: me.sub,
    room: room ? { id: room.id, slug: room.slug, name: room.name } : null,
    rooms,
    repos,
    runs,
    stats: runStats(runs),
    // Evals: fuera de los números de pedidos; su propia tabla por agente/modelo.
    evals: room ? summarizeEvals(await (await import("./factory-evals.server")).evalRows(room.id).catch(() => [])) : [],
  };
  });

/** Arranca un eval de un pedido mezclado (sólo el dueño: gasta tokens de su llave). */
export const factoryStartEvalFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number; role?: "plan" | "build" | "check"; agent?: string | null; model?: string | null }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me?.isOwner) throw new Error("sólo el dueño del espacio corre evals");
    const R = await import("./factory-runs.server");
    const src = await R.getRun(Number(data.runId));
    const db = await import("../../db.server");
    if (!src || !(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === src.channelId)) throw new Error("no encuentro ese pedido");
    const { startEval } = await import("./factory-evals.server");
    const origin = await (await import("../../origin.server")).reqOrigin().catch(() => "");
    const role = data.role && ["plan", "build", "check"].includes(data.role) ? data.role : "build";
    const r = await startEval({ sourceRunId: src.id, role, agent: data.agent ?? null, model: data.model ?? null, sub: me.sub, origin });
    if ("error" in r) throw new Error(r.error);
    return r;
  });

/** Datos de la tarjeta de veredicto de @check. */
export const factoryVerdictFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) return null;
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) return null;
    const { dbq } = await import("../../dbq.server");
    const rows = await dbq("SELECT verdict_json FROM gt_factory_runs WHERE id = ?", [run.id]);
    let verdict: {
      prNumber: number | null;
      files: number;
      additions: number;
      deletions: number;
      ci: string;
      ready: boolean;
      planVersion: number;
      loops: number;
      findings: string;
      // Desde el 28-sep; los veredictos anteriores no los traen.
      risk?: import("./factory-risk").RiskLevel;
      riskReasons?: import("./factory-risk").RiskReason[];
      readFirst?: import("./factory-risk").ReadFirst[];
      shots?: import("./factory-shots.server").Shot[];
      shotPath?: string | null;
    } | null = null;
    try {
      verdict = rows[0]?.verdict_json ? JSON.parse(String(rows[0].verdict_json)) : null;
    } catch {
      verdict = null;
    }
    // Las capturas se firman al pintar (la llave es del storage de Teams, privada).
    const storage = await import("../storage.server");
    const shots = (verdict?.shots ?? []).map((s) => ({ label: s.label, url: storage.signedUrlEstable(s.key, 3600) }));
    return { runId: run.id, status: run.status, repo: run.repo, prUrl: run.prUrl, verdict, shots, preview: await R.runPreview(run.id) };
  });

/**
 * «Correr CI» desde la tarjeta del pedido: le trae a la rama lo último de la principal
 * (update-branch), y ese commit dispara el CI. Sin esto había que picar «Merge» en OTRA tarjeta
 * para que el merge se negara y de paso lo pusiera al día (MailMask #10, 4-oct).
 */
export const factoryRunCiFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("no existe el pedido");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    const pr = run.prUrl ? R.parsePrUrl(run.prUrl) : null;
    if (!pr) throw new Error("el pedido no tiene PR");
    const { githubApi } = await import("../connectors/github.server");
    const up = await githubApi(me.sub, `/repos/${pr.repo}/pulls/${pr.number}/update-branch`, { method: "PUT", body: "{}" }).catch((e) => ({ error: String(e) }));
    if (up?.error) {
      // 422 = ya va al día: no hay commit nuevo que lo dispare.
      throw new Error(/422|up to date|no new commits/i.test(String(up.error)) ? "el PR ya va al día con la principal: el CI corre con su siguiente commit" : `GitHub no lo puso al día (¿conflictos?): ${up.error}`);
    }
    await R.logEvent(run.id, "ci_requested", me.name || me.sub);
    ciCache.delete(run.prUrl!);
    return { ok: true as const };
  });

/** «Pedir arreglo a @build» con el CI del PR en rojo: se reabre en la misma rama con qué falló. */
export const factoryFixCiFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("no existe el pedido");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    if (run.status !== "pr_review" || !run.prUrl) throw new Error("el pedido no está esperando revisión");
    const ci = await R.prCi(me.sub, run.prUrl);
    if (ci?.state !== "failure") throw new Error("el CI de este PR ya no está en rojo");
    const by = me.name || me.sub;
    const text = `El CI del PR falló (${ci.failed.join(", ") || "ver checks"}). Lee el log con github_workflow_run_logs y corrígelo en la misma rama; no cierres hasta verlo en verde.`;
    await R.addNote(run.id, by, text);
    await R.postInThread(run, "plan", `🔧 ${by} pidió arreglar el CI del PR (${ci.failed.join(", ") || "checks en rojo"}).`);
    const { reqOrigin } = await import("../../origin.server");
    const next = await R.reopenWithNotes(run, by, "", await reqOrigin().catch(() => ""), { ci: ci.failed });
    if (!next) throw new Error("no pude reabrir el pedido");
    ciCache.delete(run.prUrl);
    void R.refreshRoom(run.channelId);
    return { ok: true as const };
  });

/** «Mezclar» desde la tarjeta del veredicto: con el GitHub de quien pica. */
export const factoryMergeFn = createServerFn({ method: "POST" })
  .validator((d: { runId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const R = await import("./factory-runs.server");
    const run = await R.getRun(Number(data.runId));
    if (!run) throw new Error("no existe el pedido");
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === run.channelId)) throw new Error("no ves ese room");
    if (run.status !== "pr_review") throw new Error("el pedido no está esperando revisión");
    const r = await R.mergeRun(run, me.sub);
    if (!r.ok) throw new Error(r.error);
    return { ok: true as const };
  });



// ── Sprints (ver apps/sprint.server.ts) ─────────────────────────────────────

/** El sprint es de un room: lo ve quien ve el room; lo edita/aprueba el dueño o quien lo pidió. */
async function sprintAccess(sprintId: number) {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const S = await import("./sprint.server");
  const sprint = await S.getSprint(Number(sprintId));
  if (!sprint) throw new Error("no existe ese sprint");
  const db = await import("../../db.server");
  const ch = (await db.listChannels(me.sub, me.isOwner)).find((c) => c.id === sprint.channelId);
  if (!ch) throw new Error("no ves ese room");
  return { me, S, sprint, ch, canEdit: !!me.isOwner || me.sub === sprint.createdBy };
}

export type SprintView = Awaited<ReturnType<typeof readSprint>>;

async function readSprint(sprintId: number) {
  const { S, sprint, ch, canEdit } = await sprintAccess(sprintId);
  const R = await import("./factory-runs.server");
  const items = await S.getSprintItems(sprint.id);
  const out = [];
  for (const it of items) {
    const run = it.runId ? await R.getRun(it.runId) : null;
    out.push({
      id: it.id,
      idx: it.idx,
      key: it.key,
      title: it.title,
      size: it.size,
      dependsOn: it.dependsOn,
      bodyMd: it.bodyMd,
      included: it.included,
      status: it.status,
      runId: run?.id ?? null,
      prUrl: run?.prUrl ?? null,
      issueUrl: it.issueNumber && sprint.repo ? `https://github.com/${sprint.repo}/issues/${it.issueNumber}` : null,
      issueNumber: it.issueNumber,
      // Quién lo tiene AHORA (para la tarjeta chica): un rol o la persona.
      stage: !run ? null : run.boxWaiting && run.status === "building" ? "box_wait" : ({ planning: "@plan", building: "@build", checking: "@check", pr_review: "you_review", escalated: "you_decide" } as Record<string, string>)[run.status] ?? null,
      threadUrl: run ? `/c/${ch.slug}?thread=${run.rootMsgId}` : null,
    });
  }
  return {
    id: sprint.id,
    title: sprint.title,
    goal: sprint.goal,
    repo: sprint.repo,
    status: sprint.status,
    version: sprint.version,
    canEdit,
    threadUrl: sprint.cardMsgId ? `/c/${ch.slug}?thread=${sprint.cardMsgId}` : null,
    items: out,
  };
}

export const factorySprintFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number }) => d)
  .handler(async ({ data }) => readSprint(Number(data.sprintId)).catch(() => null));

/** Borrador: dejar fuera/incluir un ticket o cambiarle el título. */
export const factorySprintEditFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number; itemId: number; included?: boolean; title?: string }) => d)
  .handler(async ({ data }) => {
    const { sprint, canEdit } = await sprintAccess(Number(data.sprintId));
    if (!canEdit) throw new Error("sólo el dueño o quien pidió el sprint lo edita");
    const { dbq } = await import("../../dbq.server");
    // Sprint ya aprobado: sólo se puede SUMAR un ticket que se dejó fuera (arranca solo cuando
    // sus dependencias tengan merge). Antes, lo que no entraba al aprobar quedaba fuera para
    // siempre (MailMask, 01-oct: se aprobaron 2 de 8).
    if (sprint.status !== "draft") {
      if (data.included !== true || sprint.status === "cancelled") throw new Error("el sprint ya se aprobó: sólo puedes sumar tickets que dejaste fuera");
      const { S } = await sprintAccess(Number(data.sprintId));
      const items = await S.getSprintItems(sprint.id);
      const it = items.find((i) => i.id === Number(data.itemId));
      if (!it || it.included) return readSprint(sprint.id);
      const out = new Set(items.filter((i) => !i.included && i.id !== it.id).map((i) => i.key));
      const falta = it.dependsOn.find((d) => out.has(d));
      if (falta) throw new Error(`«${it.title}» depende del ticket ${falta}, que también está fuera: inclúyelo primero`);
      await dbq("UPDATE gt_factory_sprint_items SET included = 1 WHERE id = ? AND sprint_id = ?", [it.id, sprint.id]);
      // Un sprint terminado vuelve a correr con el ticket nuevo.
      await dbq("UPDATE gt_factory_sprints SET status = 'active', updated_at = unixepoch() WHERE id = ? AND status = 'done'", [sprint.id]);
      await S.advanceSprint(sprint.id);
      return readSprint(sprint.id);
    }
    if (typeof data.included === "boolean")
      await dbq("UPDATE gt_factory_sprint_items SET included = ? WHERE id = ? AND sprint_id = ?", [data.included ? 1 : 0, data.itemId, sprint.id]);
    const title = String(data.title ?? "").trim().slice(0, 120);
    if (title) await dbq("UPDATE gt_factory_sprint_items SET title = ? WHERE id = ? AND sprint_id = ?", [title, data.itemId, sprint.id]);
    return readSprint(sprint.id);
  });

/** «Dejar como issue»: el ticket queda en GitHub para después (y su PR lo cerrará si se construye). */
export const factorySprintIssueFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number; itemId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { S, sprint, canEdit } = await sprintAccess(Number(data.sprintId));
    if (!canEdit) throw new Error("sólo el dueño o quien pidió el sprint decide");
    await S.createItemIssue(sprint.id, Number(data.itemId), me.sub);
    return readSprint(sprint.id);
  });

/** «Crear sprint»: una sola aprobación para todos los tickets. */
export const factorySprintApproveFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number }) => d)
  .handler(async ({ data }) => {
    const { me, S, sprint, canEdit } = await sprintAccess(Number(data.sprintId));
    if (!canEdit) throw new Error("sólo el dueño o quien pidió el sprint lo aprueba");
    // Un ticket incluido que depende de uno que se dejó fuera no podría arrancar nunca.
    const items = await S.getSprintItems(sprint.id);
    const out = new Set(items.filter((i) => !i.included).map((i) => i.key));
    const stuck = items.find((i) => i.included && i.dependsOn.some((d) => out.has(d)));
    if (stuck) throw new Error(`«${stuck.title}» depende de un ticket que dejaste fuera: inclúyelo o quita también ése`);
    const { reqOrigin } = await import("../../origin.server");
    await S.approveSprint(sprint.id, me.sub, await reqOrigin().catch(() => ""));
    return readSprint(sprint.id);
  });

/** «Pedir cambios»: @plan rehace el borrador en el hilo de la tarjeta. */
export const factorySprintChangesFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number; note: string }) => d)
  .handler(async ({ data }) => {
    const { me, S, sprint, canEdit } = await sprintAccess(Number(data.sprintId));
    if (!canEdit) throw new Error("sólo el dueño o quien pidió el sprint lo cambia");
    if (sprint.status !== "draft") throw new Error("el sprint ya se aprobó");
    const note = String(data.note ?? "").trim().slice(0, 2000);
    if (!note) throw new Error("di qué cambiar");
    const items = await S.getSprintItems(sprint.id);
    const current = items.map((i) => `${i.key}. ${i.title} [${i.size}]${i.included ? "" : " (fuera)"}${i.dependsOn.length ? ` · tras ${i.dependsOn.join(", ")}` : ""}`).join("\n");
    await wakePlanForSprint(me.sub, sprint.channelId, sprint.cardMsgId, `sprint:${sprint.id}`,
      `${me.name ?? "Una persona"} pidió cambios al sprint «${sprint.title}» (sprint_id ${sprint.id}, repo ${sprint.repo ?? "—"}): «${note}».\n` +
        `Ajústalo y entrégalo otra vez con factory_sprint_submit mandando sprint_id ${sprint.id}. No discutas lo decidido.\n\n## Borrador actual\n${current}`);
    return { ok: true as const };
  });

/** Ticket fallido: reintentarlo o quitarlo del sprint. */
export const factorySprintItemFn = createServerFn({ method: "POST" })
  .validator((d: { sprintId: number; itemId: number; action: "retry" | "skip" }) => d)
  .handler(async ({ data }) => {
    const { S, sprint, canEdit } = await sprintAccess(Number(data.sprintId));
    if (!canEdit) throw new Error("sólo el dueño o quien pidió el sprint decide");
    await S.resolveFailedItem(sprint.id, Number(data.itemId), data.action === "skip" ? "skip" : "retry");
    return readSprint(sprint.id);
  });

/** «Proponer sprint» desde la Fábrica: despierta a @plan con el objetivo. */
export const factoryProposeSprintFn = createServerFn({ method: "POST" })
  .validator((d: { goal: string; repo?: string; roomId?: number | null }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const goal = String(data.goal ?? "").trim().slice(0, 1000);
    if (goal.length < 8) throw new Error("describe el objetivo en una frase");
    const { getAppConfig } = await import("./installed.server");
    const cfg = await getAppConfig<FactoryCfg>("factory");
    if (!cfg?.roomId) throw new Error("la fábrica no está instalada");
    const { room, repos } = await pickFactoryRoom(me, cfg, data.roomId);
    const repo = data.repo && repos.includes(data.repo) ? data.repo : repos.length === 1 ? repos[0] : "";
    if (repos.length > 1 && !repo) throw new Error("elige el repo");
    await wakePlanForSprint(me.sub, room.id, null, "sprint-propose",
      `${me.name ?? "Una persona"} quiere lograr: «${goal}»${repo ? ` en el repo ${repo}` : ""}.\n` +
        `Lee el repo (estructura, código relevante, issues abiertos) y propón un sprint con factory_sprint_submit${repo ? ` (repo ${repo})` : ""}: ` +
        `3 a 8 tickets de ≤ ~3 h, en orden, cada uno con criterios de aceptación verificables y dependencias sólo si son reales. ` +
        `No construyas ni abras ramas: sólo la tarjeta.`);
    return { ok: true as const };
  });

async function wakePlanForSprint(sub: string, channelId: number, parentId: number | null, group: string, text: string): Promise<void> {
  const { resolvedAgents, agentGroupId } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  if (!plan) throw new Error("no hay agente en @plan");
  const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../wakeups.server");
  const { currentNamespace } = await import("../tenant.server");
  const { reqOrigin } = await import("../../origin.server");
  const ns = await currentNamespace();
  await enqueueWakeup({
    // `factory:suggest:` cae en la rama de encargo de fire() (sin la cláusula del OK).
    key: `factory:suggest:${group}:${Date.now()}`,
    ref: mintWakeRef({
      sub,
      ns,
      groupId: await agentGroupId(plan, `factory-${group}`),
      dest: { channelId, ...(parentId ? { parentId } : {}), topic: "general", handle: plan.handle, name: plan.name, avatar: plan.avatar },
    }),
    cause: "proponer sprint",
    text,
    origin: await reqOrigin().catch(() => ""),
    dueAt: Math.floor(Date.now() / 1000),
  });
  armWakeups(ns);
}

/**
 * «Sugerir pedidos»: despierta a @plan en el room de la fábrica con el encargo de leer el
 * repo y publicar pedidos listos para mandar (`factory_suggest` → tarjeta con «Pedir»). Así
 * el primer pedido no depende de que alguien sepa qué pedir. Llave `factory:suggest:` para
 * caer en la rama de encargo de `fire()` (sin la cláusula del OK: aquí siempre hay trabajo).
 */
export const factorySuggestFn = createServerFn({ method: "POST" })
  .validator((d: { repo?: string; roomId?: number | null } | undefined) => d ?? {})
  .handler(async ({ data }) => {
  const user = await requireOwner();
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  if (!cfg?.roomId) throw new Error("la fábrica no está instalada");
  // Con varios repos en el room, sobre cuál se sugiere (lo elige quien pica el botón).
  const { room, repos: roomRepos } = await pickFactoryRoom(user, cfg, data.roomId);
  const repo = data.repo && roomRepos.includes(data.repo) ? data.repo : roomRepos.length === 1 ? roomRepos[0] : "";
  if (roomRepos.length > 1 && !repo) throw new Error("elige de qué repo sugerir");
  const { resolvedAgents, agentGroupId } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  if (!plan) throw new Error("no hay agente en @plan");
  const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../wakeups.server");
  const { currentNamespace } = await import("../tenant.server");
  const { reqOrigin } = await import("../../origin.server");
  const ns = await currentNamespace();
  await enqueueWakeup({
    key: `factory:suggest:${Date.now()}`,
    ref: mintWakeRef({
      sub: user.sub,
      ns,
      groupId: await agentGroupId(plan, "factory-suggest"),
      dest: { channelId: room.id, topic: "general", handle: plan.handle, name: plan.name, avatar: plan.avatar },
    }),
    cause: "sugerir pedidos",
    text:
      `Lee el repo ${repo || "de este room"} (issues abiertos, TODOs, código sin pruebas, CI) y sugiere 3 pedidos con ` +
      `factory_suggest${repo ? ` (repo ${repo} en cada uno)` : ""}: uno chico, uno mediano y uno con pruebas. Prefiere agregar sobre borrar; nada que toque ` +
      "datos ni archivos de producción. No construyas ni planees todavía: sólo la tarjeta.",
    origin: await reqOrigin().catch(() => ""),
    dueAt: Math.floor(Date.now() / 1000),
  });
  armWakeups(ns);
  return { ok: true as const };
  });

// ── Repos de la fábrica: CI y protección de la rama principal ────────────────

export type RepoGuard = { repo: string; ci: boolean; protection: "protected" | "unprotected" | "no_permission" | "plan_required" | "error" };

/** Por repo del room de la fábrica: ¿tiene CI? ¿está protegida la rama principal? */
export const factoryReposFn = createServerFn({ method: "GET" })
  .validator((d: { roomId?: number | null } | undefined) => d ?? {})
  .handler(async ({ data }): Promise<{ repos: RepoGuard[]; ciLabel: string | null; roomId: number | null }> => {
  const user = await requireOwner();
  const { getAppConfig, recordInstall } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  if (!cfg?.roomId) return { repos: [], ciLabel: null, roomId: null };
  const { room, repos } = await pickFactoryRoom(user, cfg, data.roomId);
  // Espacios instalados antes de la caja de CI: se pide aquí, la primera vez que se abre.
  let ciLabel = cfg.ciLabel ?? null;
  if (!ciLabel && repos.length) {
    ciLabel = await requestCiBox(repos);
    if (ciLabel) await recordInstall("factory", user.sub, { ...cfg, ciLabel });
  }
  const { hasWorkflows, protectionState } = await import("./ci-starter.server");
  const out = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      ci: await hasWorkflows(user.sub, repo).catch(() => false),
      protection: await protectionState(user.sub, repo).catch(() => "error" as const),
    })),
  );
  return { repos: out, ciLabel, roomId: room.id };
  });

/**
 * Protege la rama principal de un repo del room de la fábrica (ruleset «Ghosty Factory»).
 * Lo hace la PLATAFORMA con el token de quien hace clic (tiene que ser admin del repo),
 * nunca un agente: con ese permiso, un agente podría quitar la protección.
 */
export const protectMainFn = createServerFn({ method: "POST" })
  .validator((d: { repo: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { isInstalled } = await import("./installed.server");
    if (!(await isInstalled("factory").catch(() => false))) throw new Error("la fábrica no está instalada");
    const db = await import("../../db.server");
    if (!(await db.roomsOfRepo(data.repo)).length) throw new Error("ese repo no está en ningún room");
    const { protectMain } = await import("./ci-starter.server");
    const r = await protectMain(user.sub, data.repo);
    if ("error" in r) throw new Error(r.error);
    const { invalidateReadiness } = await import("./readiness.server");
    invalidateReadiness(data.repo);
    return r;
  });

// ── Equipo por repo (`.ghosty/factory.md`) ───────────────────────────────────

export type RepoTeamView = {
  repo: string;
  hasFile: boolean;
  /** Abre el archivo en GitHub: editarlo si existe, crearlo (con la plantilla) si no. */
  fileUrl: string;
  roles: {
    handle: FactoryHandle;
    agent: { id: string; name: string; engine: string } | null;
    model: string | null;
    agentSource: "message" | "repo" | "space";
    modelSource: "message" | "repo" | "space";
    problem: string | null;
  }[];
};

/**
 * El equipo EFECTIVO de un repo de un room: el del espacio con lo que sobreescriba el archivo
 * del repo. Cualquiera que vea el room lo ve (es lo mismo que verá en el hilo del pedido).
 */
export const factoryRepoTeamFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; repo: string; fresh?: boolean }) => d)
  .handler(async ({ data }): Promise<RepoTeamView> => {
    const { visibleChannel } = await import("../room-repos");
    const { db } = await visibleChannel(Number(data.channelId));
    const row = (await db.listRoomRepos(Number(data.channelId))).find((r) => r.repo === data.repo);
    if (!row) throw new Error("ese repo no está en este room");
    const T = await import("./factory-team.server");
    if (data.fresh) T.invalidateRepoTeamFile(row.repo);
    const rows = await db.listAgents();
    const space = Object.fromEntries(HANDLES.map((h) => [h, rows.find((a) => a.handle === h && a.enabled)?.fleet_id ?? null]));
    const team = await T.effectiveTeam(row.repo, row.connectedBy, space);
    const { githubApi } = await import("../connectors/github.server");
    const info = await githubApi(row.connectedBy, `/repos/${row.repo}`).catch(() => null);
    const branch = encodeURIComponent(String(info?.default_branch ?? "main"));
    const { TEAM_FILE, teamFileTemplate } = await import("./factory-team");
    const template = teamFileTemplate(
      Object.fromEntries(team.roles.filter((r) => r.agent).map((r) => [r.handle, { name: r.agent!.name, model: r.model ?? "" }])),
    );
    const fileUrl = team.hasFile
      ? `https://github.com/${row.repo}/edit/${branch}/${TEAM_FILE}`
      : `https://github.com/${row.repo}/new/${branch}?filename=${encodeURIComponent(TEAM_FILE)}&value=${encodeURIComponent(template)}`;
    return { repo: row.repo, hasFile: team.hasFile, fileUrl, roles: team.roles };
  });

// ── Producción: el uptime del room (sección de /factory) ─────────────────────
// La misma acción que las tools `uptime_*`: la UI y el agente pasan por `uptime.server`.

/** Monitores de un room que esta persona ve. */
export const factoryUptimeFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number }) => d)
  .handler(async ({ data }) => {
    const { visibleChannel } = await import("../room-repos");
    await visibleChannel(Number(data.channelId));
    const { listUptimeChecks } = await import("./uptime.server");
    return await listUptimeChecks(Number(data.channelId));
  });

export const factoryUptimeAddFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; url: string }) => d)
  .handler(async ({ data }) => {
    const { visibleChannel } = await import("../room-repos");
    const { me } = await visibleChannel(Number(data.channelId));
    const U = await import("./uptime.server");
    await U.addUptimeCheck(Number(data.channelId), String(data.url ?? ""), me.sub);
    return await U.listUptimeChecks(Number(data.channelId));
  });

export const factoryUptimeRemoveFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; id: number }) => d)
  .handler(async ({ data }) => {
    const { visibleChannel } = await import("../room-repos");
    await visibleChannel(Number(data.channelId));
    const U = await import("./uptime.server");
    await U.removeUptimeCheck(Number(data.channelId), Number(data.id));
    return await U.listUptimeChecks(Number(data.channelId));
  });
