// ── AutomationCtx: lo que una automatización puede hacer en el room ──────────────────────────
//
// `wake` abre un turno del agente con ese @handle en un hilo PROPIO del room, por la misma cola
// durable de despertadores que usan el relevo entre agentes y la revisión de alertas
// (`gt_agent_wakeups`, clave `auto:`): si ese agente ya tiene turno en esa conversación se
// difiere, y un reinicio no pierde el encargo. El hilo se reusa por `threadKey`.
//
// A nombre de quién: de la persona que prendió esa automatización (`gt_repo_automations.updated_by`);
// sus conectores (GitHub) y su bolsa son con los que trabaja el agente. Sin ella, el dueño del espacio.
import { dbq } from "../../dbq.server";
import type { AutomationCtx, AutomationKind } from "./types";
import { automationGroupSuffix, DEFAULT_DAILY_BUDGET } from "./dispatch";
import { automationOwner, automationSettings, claimKey, spendBudget } from "./store.server";

async function spaceOwner(): Promise<string | null> {
  const [owner] = await dbq("SELECT sub FROM gc_users WHERE is_owner = 1 AND COALESCE(banned,0) = 0 LIMIT 1", []).catch(() => []);
  return typeof owner?.sub === "string" && owner.sub ? owner.sub : null;
}

/** El origin del espacio cuando no hay request (turnos programados de mantenimiento). */
export async function defaultOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL;
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug().catch(() => null);
  return slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : "";
}

/** El hilo de `threadKey` en el room: el que ya existe, o uno nuevo con `title` como raíz. */
async function threadRoot(roomId: number, threadKey: string, title: string, who: { handle: string; name: string; avatar: string }, ns: string): Promise<number> {
  const db = await import("../../db.server");
  const [row] = await dbq("SELECT root_msg_id FROM gt_automation_threads WHERE room_id = ? AND thread_key = ?", [roomId, threadKey]);
  if (row && (await db.getMessage(Number(row.root_msg_id)).catch(() => null))) return Number(row.root_msg_id);
  const { id } = await db.postAgent(roomId, null, title, "msg", who.handle, who.name, "general", who.avatar);
  await dbq("INSERT OR REPLACE INTO gt_automation_threads (room_id, thread_key, root_msg_id) VALUES (?, ?, ?)", [roomId, threadKey, id]);
  const msg = await db.getMessage(id);
  if (msg) {
    const bus = await import("../bus.server");
    bus.publish(bus.ch.room(ns, roomId), { t: "message:new", msg });
  }
  return id;
}

/**
 * El contexto de una automatización en un room. `kind` lo pone el despachador (cada automatización
 * recibe el suyo); el mantenimiento programado lo arma a mano con su `kind` y sin `origin`.
 */
export function automationCtx(p: { ns: string; roomId: number; repo: string; origin?: string; kind?: AutomationKind }): AutomationCtx {
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
      const sub = (p.kind ? await automationOwner(p.roomId, p.repo, p.kind) : null) ?? (await spaceOwner());
      if (!sub) {
        console.warn(`[automations] ${p.repo}: sin persona a cuyo nombre trabajar; no se despierta`);
        return;
      }
      const db = await import("../../db.server");
      const channel = await db.getChannelById(p.roomId);
      if (!channel || channel.archived) return;
      const who = { handle: agent.handle, name: agent.name, avatar: agent.avatar };
      const rootId = await threadRoot(p.roomId, threadKey, title?.trim() || `🤖 ${threadKey} · \`${p.repo}\``, who, p.ns);
      const groupId = await agentGroupId(agent, automationGroupSuffix(channel.slug, threadKey));
      const { enqueueWakeup, mintWakeRef, kickWakeups, armWakeups } = await import("../wakeups.server");
      const ok = await enqueueWakeup({
        key: `auto:${p.roomId}:${threadKey}:${Date.now()}`,
        ref: mintWakeRef({
          sub,
          ns: p.ns,
          groupId,
          // `automation` marca el turno: no es un pedido, `factoryContext` no le pone el papel del rol.
          dest: { channelId: p.roomId, parentId: rootId, topic: "general", handle: agent.handle, name: agent.name, avatar: agent.avatar,
                  ...(p.kind ? { automation: p.kind, automationRepo: p.repo } : {}) },
        }),
        cause: title?.trim() || threadKey,
        text,
        origin: p.origin ?? (await defaultOrigin()),
        dueAt: Math.floor(Date.now() / 1000) + (delayS && delayS > 0 ? Math.floor(delayS) : 0),
      });
      // Con retraso no se patea: el barrido de la cola lo levanta cuando vence.
      if (ok) (delayS && delayS > 0 ? armWakeups : kickWakeups)(p.ns);
    },
    async post(text) {
      const db = await import("../../db.server");
      const channel = await db.getChannelById(p.roomId);
      if (!channel || channel.archived || !text.trim()) return null;
      // Firma un agente del espacio que no es rol de la fábrica (como los avisos de PR).
      const { resolvedAgents } = await import("../../agents.server");
      const agents = (await resolvedAgents()).filter((a) => !["plan", "build", "check", "eval"].includes(a.handle));
      const who = agents[0] ?? { handle: "ghosty", name: "Ghosty", avatar: "" };
      const { id } = await db.postAgent(p.roomId, null, text, "msg", who.handle, who.name, "general", who.avatar);
      const msg = await db.getMessage(id);
      if (msg) {
        const bus = await import("../bus.server");
        bus.publish(bus.ch.room(p.ns, p.roomId), { t: "message:new", msg });
      }
      return id;
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
