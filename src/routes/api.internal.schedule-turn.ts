import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: programar un TURNO de un agente en un room o en un hilo ───
//
// Lo llama gs (`ghosty schedule add <agente> "…" --teams <espacio>#<room>[/<hilo>]`). Antes la
// única forma de que un agente hablara en un hilo a una hora era un recordatorio
// (`gc_reminders`), que publica un TEXTO fijo con la cara del agente: no abre turno, no entra
// en el hilo y no acepta `@agente`. El debut de @minighosty (1-oct) se tuvo que detonar a mano.
//
// Por dentro es un despertador (`gt_agent_wakeups`) con `due_at` a futuro y clave
// `sched:turn:…`: el mismo tick, el mismo claim atómico y la misma regla de diferir si hay un
// turno en vuelo. Al vencer, el agente contesta en el hilo como si alguien lo mencionara.
//
// Firma de partner sobre el cuerpo crudo (`ts.<rawBody>`), como `api/internal/agent-wake`. El
// namespace lo resuelve el HOST. gs ya comprobó que quien programa puede usar el agente en
// este espacio; `sub` es su id (el mismo en gs y en Teams).
//
//   POST {action:"create", handle, channel, parentId?, text, dueAt, sub, by?} → {id, dueAt, channel, parentId}
//   POST {action:"list", handle?}                                             → {scheduled:[…]}
//   POST {action:"cancel", id}                                                → {ok}

const PREFIX = "sched:turn:";

async function verify(ts: string, sig: string, rawBody: string): Promise<boolean> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

type Body = { action?: string; handle?: string; channel?: string | number; parentId?: number | null; text?: string; dueAt?: number; sub?: string; by?: string; id?: string };

export const Route = createFileRoute("/api/internal/schedule-turn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw))) {
          return new Response("firma inválida", { status: 403 });
        }
        let body: Body;
        try {
          body = JSON.parse(raw) as Body;
        } catch {
          return bad("json inválido");
        }
        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const { dbq } = await import("../dbq.server");
        const db = await import("../db.server");

        if (body.action === "list") {
          const rows = await dbq(
            `SELECT id, key, cause, text, due_at FROM gt_agent_wakeups WHERE key LIKE ? AND fired_at IS NULL ORDER BY due_at LIMIT 100`,
            [`${PREFIX}%`],
          );
          const scheduled = [];
          for (const r of rows) {
            // sched:turn:<channelId>:<parentId|0>:<handle>:<n>
            const [, , channelId, parentId, handle] = String(r.key).split(":");
            if (body.handle && handle !== body.handle) continue;
            const ch = await db.getChannelById(Number(channelId)).catch(() => null);
            scheduled.push({ id: String(r.id), handle, channel: ch?.slug ?? channelId, parentId: Number(parentId) || null, dueAt: Number(r.due_at), by: String(r.cause ?? ""), text: String(r.text) });
          }
          return Response.json({ scheduled });
        }

        if (body.action === "cancel") {
          if (!body.id) return bad("falta id");
          const rows = await dbq(`DELETE FROM gt_agent_wakeups WHERE id = ? AND key LIKE ? AND fired_at IS NULL RETURNING id`, [body.id, `${PREFIX}%`]);
          return rows.length ? Response.json({ ok: true }) : bad("no hay un turno pendiente con ese id (¿ya corrió?)", 404);
        }

        if (body.action !== "create") return bad("action: create | list | cancel");
        const text = String(body.text ?? "").trim();
        const dueAt = Number(body.dueAt);
        if (!body.handle || !body.channel || !text || !body.sub) return bad("faltan handle, channel, text o sub");
        if (!Number.isFinite(dueAt) || dueAt < Math.floor(Date.now() / 1000) - 60) return bad("dueAt tiene que ser una fecha futura (epoch en segundos)");

        const { resolvedAgents, agentGroupId } = await import("../agents.server");
        const agent = (await resolvedAgents()).find((a) => a.handle === body.handle);
        if (!agent) return bad(`@${body.handle} no está activo en este espacio`, 404);
        const ch = typeof body.channel === "number" || /^\d+$/.test(String(body.channel))
          ? await db.getChannelById(Number(body.channel))
          : await db.getChannel(String(body.channel).replace(/^#/, ""));
        if (!ch) return bad(`no hay un room «${body.channel}» en este espacio`, 404);

        // Hilo: tiene que ser un mensaje RAÍZ de ese room (las respuestas de un hilo cuelgan de él).
        let topic = "general";
        const parentId = body.parentId ? Number(body.parentId) : null;
        if (parentId) {
          const root = await db.getMessage(parentId);
          if (!root || root.channel_id !== ch.id) return bad(`el mensaje ${parentId} no es de #${ch.slug}`, 404);
          if (root.parent_id) return bad(`el mensaje ${parentId} es una respuesta; usa el del inicio del hilo (${root.parent_id})`);
          topic = root.topic ?? "general";
        }

        // Quien programa: si no es miembro de este Teams (staff de Ghosty), corre a nombre del dueño.
        const users = await import("../users.server");
        const members = await users.listAllMembers().catch(() => []);
        const sub = members.some((m) => m.sub === body.sub && !m.banned) ? body.sub : members.find((m) => m.isOwner)?.sub;
        if (!sub) return bad("no encuentro a nombre de quién correr el turno", 409);

        const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../server/wakeups.server");
        const { currentNamespace } = await import("../server/tenant.server");
        const ns = await currentNamespace();
        const crypto = await import("node:crypto");
        const key = `${PREFIX}${ch.id}:${parentId ?? 0}:${agent.handle}:${crypto.randomUUID().slice(0, 8)}`;
        await enqueueWakeup({
          key,
          ref: mintWakeRef({
            sub,
            ns,
            // La misma memoria de room que una mención (`agent-handoff`): el agente recuerda el hilo.
            groupId: await agentGroupId(agent, `${ch.slug}-flow`),
            dest: { channelId: ch.id, ...(parentId ? { parentId } : {}), topic, handle: agent.handle, name: agent.name, avatar: agent.avatar },
          }),
          cause: String(body.by ?? "programado").slice(0, 60),
          text: text.slice(0, 4000),
          origin: new URL(request.url).origin,
          dueAt: Math.floor(dueAt),
        });
        armWakeups(ns);
        const [row] = await dbq(`SELECT id FROM gt_agent_wakeups WHERE key = ?`, [key]);
        return Response.json({ id: String(row?.id ?? ""), handle: agent.handle, channel: ch.slug, parentId, dueAt: Math.floor(dueAt) });
      },
    },
  },
});
