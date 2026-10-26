// ── AutomationCtx: lo que una automatización puede hacer en el room ──────────────────────────
//
// `wake` abre un turno del agente con ese @handle en un hilo PROPIO del room con la misma pieza
// que la estafeta de la fábrica (`enqueueAgentTurn`, cola durable `gt_agent_wakeups`, clave
// `auto:`): si ese agente ya tiene turno en esa conversación se difiere, y un reinicio no pierde
// el encargo. El hilo se reusa por `threadKey`. El turno va marcado `factoryMode: "automation"`:
// un rol de la fábrica no recibe las instrucciones de pedido (veredicto, build_done).
//
// A nombre de quién: de la persona que prendió esa automatización (`gt_repo_automations.owner_sub`);
// sus conectores (GitHub) y su bolsa son con los que trabaja el agente. Sin ella, el dueño del espacio.
import { dbq } from "../../dbq.server";
import type { AutomationCtx, AutomationKind } from "./types";
import { automationGroupSuffix, DEFAULT_DAILY_BUDGET } from "./dispatch";
import { automationRunAs, automationSettings, claimKey, spendBudget } from "./store.server";

type Who = { handle: string; name: string; avatar: string };

async function spaceOwner(): Promise<string | null> {
  const [owner] = await dbq("SELECT sub FROM gc_users WHERE is_owner = 1 AND COALESCE(banned,0) = 0 LIMIT 1", []).catch(() => []);
  return typeof owner?.sub === "string" && owner.sub ? owner.sub : null;
}

/** El origin del espacio cuando no hay request ni fila con origin. */
export async function defaultOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL;
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug().catch(() => null);
  return slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : "";
}

async function publishNew(ns: string, roomId: number, id: number): Promise<void> {
  const db = await import("../../db.server");
  const msg = await db.getMessage(id);
  if (!msg) return;
  const bus = await import("../bus.server");
  bus.publish(bus.ch.room(ns, roomId), { t: "message:new", msg });
}

/**
 * El repo del hilo en `gt_factory_thread_overrides`, como si alguien hubiera escrito «en <repo>»:
 * en un room con varios repos `factoryTurnFor` lo lee de aquí para traer `.ghosty/factory.md`
 * (el turno no trae mensajes de quién lo invocó). Combina con lo que el hilo ya traía (modelos,
 * agentes de un eval) en vez de pisarlo.
 */
export async function pinThreadRepo(roomId: number, rootId: number, repo: string): Promise<void> {
  const rows = await dbq("SELECT overrides FROM gt_factory_thread_overrides WHERE channel_id = ? AND root_msg_id = ?", [roomId, rootId]).catch(() => []);
  let prev: Record<string, unknown> = {};
  try {
    prev = rows[0] ? JSON.parse(String(rows[0].overrides)) : {};
  } catch {}
  if (prev.repo === repo) return;
  await dbq(
    `INSERT INTO gt_factory_thread_overrides (channel_id, root_msg_id, overrides) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, root_msg_id) DO UPDATE SET overrides = excluded.overrides, updated_at = unixepoch()`,
    [roomId, rootId, JSON.stringify({ ...prev, repo })],
  ).catch(() => {});
}

/** El hilo de `threadKey` en el room: el que ya existe, o uno nuevo con `title` como raíz. */
async function threadRoot(roomId: number, repo: string, threadKey: string, title: string, who: Who, ns: string): Promise<number> {
  const db = await import("../../db.server");
  const [row] = await dbq("SELECT root_msg_id FROM gt_automation_threads WHERE room_id = ? AND thread_key = ?", [roomId, threadKey]);
  if (row && (await db.getMessage(Number(row.root_msg_id)).catch(() => null))) {
    // Los hilos de antes de esto no traen su repo: se les pone al reusarlos.
    await pinThreadRepo(roomId, Number(row.root_msg_id), repo);
    return Number(row.root_msg_id);
  }
  const { id } = await db.postAgent(roomId, null, title, "msg", who.handle, who.name, "general", who.avatar);
  await dbq("INSERT OR REPLACE INTO gt_automation_threads (room_id, thread_key, root_msg_id) VALUES (?, ?, ?)", [roomId, threadKey, id]);
  await pinThreadRepo(roomId, id, repo);
  await publishNew(ns, roomId, id);
  return id;
}

/**
 * El contexto de una automatización en un room. `kind` lo pone el despachador (cada automatización
 * recibe el suyo); el mantenimiento programado lo arma igual, sin `origin` (sale de la fila).
 */
export function automationCtx(p: { ns: string; roomId: number; repo: string; origin?: string; kind?: AutomationKind }): AutomationCtx {
  const defaultTitle = (threadKey: string) => `🤖 ${threadKey} · \`${p.repo}\``;
  return {
    ns: p.ns,
    roomId: String(p.roomId),
    repo: p.repo,
    async wake({ handle, text, threadKey, title, delayS }) {
      const { resolvedAgents, agentGroupId } = await import("../../agents.server");
      const agent = (await resolvedAgents()).find((a) => a.handle === handle);
      if (!agent) {
        console.warn(`[automations] ${p.repo}: no hay @${handle} en este espacio; no se despierta`);
        return;
      }
      const runAs = p.kind ? await automationRunAs(p.roomId, p.repo, p.kind) : { sub: null, origin: null };
      const sub = runAs.sub ?? (await spaceOwner());
      if (!sub) {
        console.warn(`[automations] ${p.repo}: sin persona a cuyo nombre trabajar; no se despierta`);
        return;
      }
      const db = await import("../../db.server");
      const channel = await db.getChannelById(p.roomId);
      if (!channel || channel.archived) return;
      const who = { handle: agent.handle, name: agent.name, avatar: agent.avatar };
      const rootId = await threadRoot(p.roomId, p.repo, threadKey, title?.trim() || defaultTitle(threadKey), who, p.ns);
      const groupId = await agentGroupId(agent, automationGroupSuffix(channel.slug, threadKey));
      const { enqueueAgentTurn } = await import("../agent-turn.server");
      await enqueueAgentTurn({
        ns: p.ns,
        sub,
        groupId,
        dest: {
          channelId: p.roomId, parentId: rootId, topic: "general", handle: agent.handle, name: agent.name, avatar: agent.avatar,
          factoryMode: "automation", automationRepo: p.repo, ...(p.kind ? { automation: p.kind } : {}),
        },
        key: `auto:${p.roomId}:${threadKey}:${Date.now()}`,
        cause: title?.trim() || threadKey,
        text,
        origin: p.origin || runAs.origin || (await defaultOrigin()),
        delayS,
      });
    },
    async post(text, opts = {}) {
      if (!text.trim()) return;
      const { resolvedAgents } = await import("../../agents.server");
      const agents = await resolvedAgents();
      const a = agents.find((x) => x.handle === (opts.handle ?? "ghosty")) ?? agents[0];
      const who = a ? { handle: a.handle, name: a.name, avatar: a.avatar } : { handle: "ghosty", name: "Ghosty", avatar: "" };
      const db = await import("../../db.server");
      const channel = await db.getChannelById(p.roomId);
      if (!channel || channel.archived) return;
      const parent = opts.threadKey ? await threadRoot(p.roomId, p.repo, opts.threadKey, opts.title?.trim() || defaultTitle(opts.threadKey), who, p.ns) : null;
      // `postAgent` no despierta a nadie (mentions_ghosty = 0): es un aviso, no un turno.
      const { id } = await db.postAgent(p.roomId, parent, text, "msg", who.handle, who.name, "general", who.avatar);
      // Un aviso suelto es raíz de un hilo posible: si alguien le contesta con @build, el rol sabe el repo.
      if (parent == null) await pinThreadRepo(p.roomId, id, p.repo);
      await publishNew(p.ns, p.roomId, id);
    },
    claim: (kind, key, ttlMs) => claimKey(kind, key, ttlMs),
    async budget(kind) {
      const s = await automationSettings(p.roomId, p.repo, kind);
      const limit = typeof s.dailyLimit === "number" && s.dailyLimit >= 0 ? Math.floor(s.dailyLimit) : DEFAULT_DAILY_BUDGET;
      return spendBudget(p.repo, kind, limit);
    },
    settings: async <T = Record<string, unknown>>(kind: AutomationKind) => (await automationSettings(p.roomId, p.repo, kind)) as T,
  };
}
