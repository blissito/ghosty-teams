import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";
import { FACTORY_ENGINES, FACTORY_HANDLES as HANDLES, ROLE_NAMES, roleAvatar, type FactoryHandle } from "./factory-roles";

// Instalar / desinstalar la Software Factory en ESTE espacio (Ajustes → Apps).
//
// Instalar deja la fábrica lista para trabajar:
//  1. un room (uno existente o `#fabrica`) con el repo del equipo atado (`gt_room_repos`);
//  2. los tres handles (`@plan`, `@build`, `@check`) apuntando a agentes de Studio que elige
//     el dueño (la fábrica NO crea agentes: motor, modelo y llaves se afinan en /app/agents);
//  3. un tablero de Tasks «Fábrica» recordado para el room (las tres columnas estándar: la
//     etapa de cada corrida va en su tarea y su tarjeta, no en columnas propias);
//  4. la fila en `gt_installed_apps`, que es lo que hace aparecer las tools `factory_*` y
//     `alert_webhook_*`.
// Desinstalar apaga los handles y borra la fila; la caja, el tablero y las corridas se
// quedan (desactivar no borra, igual que los agentes de Studio).


/**
 * Config en `gt_installed_apps`. `roles` = a qué agente de Studio apunta cada handle.
 * `ownedHandles` = los handles que CREÓ la instalación: sólo ésos se repuntan o apagan
 * (una fila `@plan` previa de otra cosa nunca se toca).
 * `fleetAgentId`/`boxes` = formato viejo (cajas propias de la fábrica, ya retirado).
 */
type FactoryCfg = {
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

/** Agentes de Studio que puede usar este espacio (scopeado por la firma, como "De Studio"). */
async function studioAgents() {
  const { nativeRuntimeBase } = await import("../ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) return [];
  const { listNativeFleetAgents } = await import("../fleet-native.server");
  const pools = await listNativeFleetAgents(base, "").catch(() => []);
  return pools
    .filter((p) => (p.protocol ?? "sse") === "sse" && (FACTORY_ENGINES as readonly string[]).includes(p.engine ?? ""))
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
        [agent.id, ROLE_NAMES[h], roleAvatar(h), h],
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
  candidates: StudioAgentOption[];
  studioAgentsUrl: string;
};

const IDP = () => process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

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
  return {
    installed: true,
    room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null,
    repos,
    boardId: cfg.boardId ?? null,
    roles,
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

    // 3. El tablero (reusa el de una instalación anterior si sigue vivo).
    const { currentSlug } = await import("../tenant.server");
    const slug = await currentSlug();
    if (!slug) throw new Error("no pude resolver el espacio");
    let boardId: number | null = prev?.boardId ?? null;
    const { listBoards, rememberRoomBoard } = await import("../tasks-boards.server");
    if (boardId && !(await listBoards().catch(() => [])).some((b) => b.id === boardId)) boardId = null;
    if (!boardId) {
      const { callTasks } = await import("../tasks-bridge.server");
      const r = await callTasks(slug, user.sub, 0, "task_board_create", { name: "Fábrica" });
      const id = Number((r as any)?.result?.id);
      boardId = r.ok && Number.isFinite(id) && id > 0 ? id : null;
    }
    if (boardId) await rememberRoomBoard(roomId, boardId, user.sub);

    // 4. La fila que enciende las tools.
    await recordInstall("factory", user.sub, { ...assigned, roomId, boardId });
    const ch = await db.getChannelById(roomId);
    return { ok: true as const, room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null, boardId };
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
    await recordInstall("factory", user.sub, { roomId: cfg.roomId, boardId: cfg.boardId ?? null, ...assigned });
    return { ok: true as const };
  });

export const uninstallFactoryFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { getAppConfig, recordUninstall } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  // Sólo los handles que creó la fábrica; los agentes de Studio no se tocan.
  const owned = (cfg?.ownedHandles ?? []).filter((h) => (HANDLES as readonly string[]).includes(h));
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
    if (!run) throw new Error("corrida no encontrada");
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
      threadUrl: `/c/${ch.slug}?thread=${run.rootMsgId}`,
      // Firmable desde la tarjeta: el plan vigente espera firma (o hay que decidir tras escalar).
      canSign: (run.status === "plan_review" && !!plan && !plan.decision) || run.status === "escalated",
    };
  });
