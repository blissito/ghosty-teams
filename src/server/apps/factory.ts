import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";

// Instalar / desinstalar la Software Factory en ESTE espacio (Ajustes → Apps).
//
// Instalar deja la fábrica lista para trabajar:
//  1. un room (uno existente o `#fabrica`) con el repo del equipo atado (`gt_room_repos`);
//  2. las cajas en gs (una por motor: hoy Claude para @plan/@build y DeepSeek para @check) con
//     sus tres handles — las crea gs por HMAC (`internal/workspace-factory/:slug`) porque ahí
//     viven los FleetAgent. El motor de cada rol se cambia en Ajustes → Apps;
//  3. un tablero de Tasks «Fábrica» recordado para el room (las tres columnas estándar: la
//     etapa de cada corrida va en su tarea y su tarjeta, no en columnas propias);
//  4. la fila en `gt_installed_apps`, que es lo que hace aparecer las tools `factory_*` y
//     `alert_webhook_*`.
// Desinstalar apaga los handles y borra la fila; la caja, el tablero y las corridas se
// quedan (desactivar no borra, igual que los agentes de Studio).

const HANDLES = ["plan", "build", "check"] as const;

/** Motores que puede tener un rol (espejo de FACTORY_ENGINES en gs). */
export const FACTORY_ENGINES = ["claude", "deepseek", "codex"] as const;

/** Config guardada en `gt_installed_apps`. `fleetAgentId` = formato viejo (sólo la caja Claude). */
type FactoryCfg = {
  fleetAgentId?: string;
  boxes?: Record<string, string>;
  engines?: Record<string, string>;
  roomId?: number;
  boardId?: number | null;
};

/** Todas las cajas que la fábrica ha usado: un handle que apunta a cualquiera es "nuestro". */
const ownBoxes = (cfg: FactoryCfg | null): Set<string> =>
  new Set([cfg?.fleetAgentId, ...Object.values(cfg?.boxes ?? {})].filter((x): x is string => !!x));

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("sólo el dueño del espacio instala apps");
  return user;
}

/**
 * Pide a gs las cajas y los handles (idempotente: reusa las cajas previas por motor) y
 * declara el canal Teams en cada caja. Devuelve lo que hay que guardar en la config.
 */
async function provisionInGs(prev: FactoryCfg | null, engines: Record<string, string>) {
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug();
  if (!slug) throw new Error("no pude resolver el espacio");
  const boxes = { ...(prev?.fleetAgentId ? { claude: prev.fleetAgentId } : {}), ...(prev?.boxes ?? {}) };
  const body = JSON.stringify({ boxes, engines });
  const crypto = await import("node:crypto");
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!).update(`${ts}.${slug}.${body}`).digest("hex");
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const res = await fetch(`${IDP}/internal/workspace-factory/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const out = (await res.json().catch(() => null)) as {
    ok?: boolean;
    boxes?: Record<string, string>;
    engines?: Record<string, string>;
    error?: string;
  } | null;
  if (!res.ok || !out?.ok || !out.boxes) throw new Error(out?.error || `gs no pudo crear las cajas (${res.status})`);
  // Igual que al activar un agente de Studio: el canal Teams se declara en Studio, por caja.
  const { connectTeamsChannel } = await import("../agent-config");
  for (const id of new Set(Object.values(out.boxes))) await connectTeamsChannel(id, "", "gs-native").catch(() => {});
  // Las cajas que ya no usa ningún rol se conservan en la config: si se regresa a ese motor,
  // se reusa la misma caja con su /data.
  return { boxes: { ...boxes, ...out.boxes }, engines: out.engines ?? engines };
}

export type FactoryRoleView = { handle: string; engine: string; fleetAgentId: string | null; studioUrl: string | null };

export type FactoryStatus = {
  installed: boolean;
  room: { id: number; slug: string; name: string } | null;
  repos: string[];
  handles: string[];
  boardId: number | null;
  roles: FactoryRoleView[];
  engineOptions: readonly string[];
};

export const factoryStatusFn = createServerFn({ method: "GET" }).handler(async (): Promise<FactoryStatus> => {
  await requireOwner();
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  const empty = { installed: false, room: null, repos: [], handles: [], boardId: null, roles: [], engineOptions: FACTORY_ENGINES };
  if (!cfg) return empty;
  const db = await import("../../db.server");
  const ch = cfg.roomId ? await db.getChannelById(cfg.roomId) : null;
  const repos = cfg.roomId ? (await db.listRoomRepos(cfg.roomId)).map((r) => r.repo) : [];
  const agents = await db.listAgents();
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  // El motor de cada rol sale de la caja a la que apunta su handle HOY (la verdad), no de la
  // config: si alguien lo repuntó a mano, se ve.
  const engineOfBox = new Map<string, string>(Object.entries(cfg.boxes ?? (cfg.fleetAgentId ? { claude: cfg.fleetAgentId } : {})).map(([e, id]) => [id, e]));
  const roles: FactoryRoleView[] = HANDLES.map((h) => {
    const a = agents.find((x) => x.handle === h && x.enabled);
    const id = a?.fleet_id ?? null;
    return {
      handle: h,
      engine: (id && engineOfBox.get(id)) || cfg.engines?.[h] || "claude",
      fleetAgentId: id,
      // Modelo, prompt y llaves de la caja se ajustan en Studio.
      studioUrl: id ? `${IDP}/app/agents/${id}` : null,
    };
  });
  return {
    installed: true,
    room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null,
    repos,
    handles: agents.filter((a) => a.enabled && (HANDLES as readonly string[]).includes(a.handle)).map((a) => a.handle),
    boardId: cfg.boardId ?? null,
    roles,
    engineOptions: FACTORY_ENGINES,
  };
});

function cleanEngines(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const h of HANDLES) {
    const e = String(obj[h] ?? "");
    if ((FACTORY_ENGINES as readonly string[]).includes(e)) out[h] = e;
  }
  return out;
}

export const installFactoryFn = createServerFn({ method: "POST" })
  .validator((d: { roomId?: number | null; repo: string; engines?: Record<string, string> }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../../db.server");
    const { normalizeRepo } = await import("../connectors/github.server");
    const repo = normalizeRepo(String(data.repo ?? ""));
    if (!repo) throw new Error('elige el repositorio (va como "dueño/repo")');

    const { getAppConfig, recordInstall } = await import("./installed.server");
    // La instalación anterior (aunque se haya desinstalado): sus cajas y su tablero se reusan.
    const prev = await getAppConfig<FactoryCfg>("factory", { includeUninstalled: true });
    // Un handle sólo se toma si está libre o si ya es de una caja de la fábrica. Una fila sin
    // `fleet_id` (webhook, A2A, ACP de un tercero) también es de OTRO: gs la repuntaría.
    const mine = ownBoxes(prev);
    for (const h of HANDLES) {
      const a = await db.getAgentByHandle(h);
      if (a && (!a.fleet_id || !mine.has(a.fleet_id)))
        throw new Error(`@${h} ya lo usa otro agente de este espacio: renómbralo antes de instalar la fábrica`);
    }

    // 1. El room.
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

    // 2. Las cajas y los tres handles, en gs.
    const prov = await provisionInGs(prev, { ...(prev?.engines ?? {}), ...cleanEngines(data.engines) });

    // 3. El tablero (reusa el de una instalación anterior si sigue vivo).
    const { currentSlug } = await import("../tenant.server");
    const slug = (await currentSlug())!;
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
    await recordInstall("factory", user.sub, { boxes: prov.boxes, engines: prov.engines, roomId, boardId });
    const ch = await db.getChannelById(roomId);
    return { ok: true as const, room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null, boardId };
  });

/**
 * Cambia el motor de uno o más roles sin reinstalar: gs crea (o reusa) la caja del motor
 * nuevo y repunta el handle. Las corridas en curso siguen; el siguiente turno del rol ya
 * corre en la caja nueva.
 */
export const setFactoryEnginesFn = createServerFn({ method: "POST" })
  .validator((d: { engines: Record<string, string> }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const cfg = await getAppConfig<FactoryCfg>("factory");
    if (!cfg) throw new Error("la fábrica no está instalada");
    const prov = await provisionInGs(cfg, { ...(cfg.engines ?? {}), ...cleanEngines(data.engines) });
    await recordInstall("factory", user.sub, { ...cfg, fleetAgentId: undefined, boxes: prov.boxes, engines: prov.engines });
    return { ok: true as const, engines: prov.engines };
  });

export const uninstallFactoryFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { getAppConfig, recordUninstall } = await import("./installed.server");
  const cfg = await getAppConfig<FactoryCfg>("factory");
  const boxes = [...ownBoxes(cfg)];
  if (boxes.length) {
    const { dbq } = await import("../../dbq.server");
    await dbq(
      `UPDATE gc_agents SET enabled = 0 WHERE fleet_id IN (${boxes.map(() => "?").join(",")}) AND handle IN (${HANDLES.map(() => "?").join(",")})`,
      [...boxes, ...HANDLES],
    );
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
