import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";

// Instalar / desinstalar la Software Factory en ESTE espacio (Ajustes → Apps).
//
// Instalar deja la fábrica lista para trabajar:
//  1. un room (uno existente o `#fabrica`) con el repo del equipo atado (`gt_room_repos`);
//  2. la caja en gs con sus tres handles (`@plan`, `@build`, `@check`) — la crea gs por HMAC
//     (`internal/workspace-factory/:slug`) porque ahí vive el FleetAgent;
//  3. un tablero de Tasks «Fábrica» recordado para el room (las tres columnas estándar: la
//     etapa de cada corrida va en su tarea y su tarjeta, no en columnas propias);
//  4. la fila en `gt_installed_apps`, que es lo que hace aparecer las tools `factory_*` y
//     `alert_webhook_*`.
// Desinstalar apaga los handles y borra la fila; la caja, el tablero y las corridas se
// quedan (desactivar no borra, igual que los agentes de Studio).

const HANDLES = ["plan", "build", "check"] as const;

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("sólo el dueño del espacio instala apps");
  return user;
}

export type FactoryStatus = {
  installed: boolean;
  room: { id: number; slug: string; name: string } | null;
  repos: string[];
  handles: string[];
  boardId: number | null;
};

export const factoryStatusFn = createServerFn({ method: "GET" }).handler(async (): Promise<FactoryStatus> => {
  await requireOwner();
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ roomId?: number; boardId?: number | null }>("factory");
  if (!cfg) return { installed: false, room: null, repos: [], handles: [], boardId: null };
  const db = await import("../../db.server");
  const ch = cfg.roomId ? await db.getChannelById(cfg.roomId) : null;
  const repos = cfg.roomId ? (await db.listRoomRepos(cfg.roomId)).map((r) => r.repo) : [];
  const agents = await db.listAgents();
  return {
    installed: true,
    room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null,
    repos,
    handles: agents.filter((a) => a.enabled && (HANDLES as readonly string[]).includes(a.handle)).map((a) => a.handle),
    boardId: cfg.boardId ?? null,
  };
});

export const installFactoryFn = createServerFn({ method: "POST" })
  .validator((d: { roomId?: number | null; repo: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../../db.server");
    const { normalizeRepo } = await import("../connectors/github.server");
    const repo = normalizeRepo(String(data.repo ?? ""));
    if (!repo) throw new Error('elige el repositorio (va como "dueño/repo")');

    // Los handles no pueden estar tomados por OTRO agente del espacio.
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const prev = await getAppConfig<{ fleetAgentId?: string; roomId?: number; boardId?: number | null }>("factory");
    for (const h of HANDLES) {
      const a = await db.getAgentByHandle(h);
      if (a && a.fleet_id && a.fleet_id !== prev?.fleetAgentId)
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

    // 2. La caja y sus tres handles, en gs.
    const { currentSlug } = await import("../tenant.server");
    const slug = await currentSlug();
    if (!slug) throw new Error("no pude resolver el espacio");
    const body = JSON.stringify({ fleetAgentId: prev?.fleetAgentId ?? null });
    const crypto = await import("node:crypto");
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!)
      .update(`${ts}.${slug}.${body}`)
      .digest("hex");
    const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
    const res = await fetch(`${IDP}/internal/workspace-factory/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; fleetAgentId?: string; error?: string } | null;
    if (!res.ok || !out?.ok || !out.fleetAgentId) throw new Error(out?.error || `gs no pudo crear la caja (${res.status})`);
    // Igual que al activar un agente de Studio: el canal Teams se declara en Studio.
    const { connectTeamsChannel } = await import("../agent-config");
    await connectTeamsChannel(out.fleetAgentId, "", "gs-native").catch(() => {});

    // 3. El tablero (reusa el de una instalación anterior si sigue vivo).
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
    await recordInstall("factory", user.sub, { fleetAgentId: out.fleetAgentId, roomId, boardId });
    const ch = await db.getChannelById(roomId);
    return { ok: true as const, room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null, boardId };
  });

export const uninstallFactoryFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { getAppConfig, recordUninstall } = await import("./installed.server");
  const cfg = await getAppConfig<{ fleetAgentId?: string }>("factory");
  if (cfg?.fleetAgentId) {
    const { dbq } = await import("../../dbq.server");
    await dbq(
      `UPDATE gc_agents SET enabled = 0 WHERE fleet_id = ? AND handle IN (${HANDLES.map(() => "?").join(",")})`,
      [cfg.fleetAgentId, ...HANDLES],
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
