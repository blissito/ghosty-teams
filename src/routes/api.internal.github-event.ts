import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: un PR cambió en GitHub ─────────────────────────────────────────────────
//
// gs es el receptor único del webhook de la GitHub App (`ghosty-studio/app/lib/github/
// app-hook.server.ts`): verifica, guarda y reparte con reintentos al Teams de cada workspace.
// Aquí se avisa en los rooms que tienen ese repo (gt_room_repos) y, si el PR es de un pedido de
// la fábrica, se cierra el pedido AL INSTANTE (antes lo veía un sondeo cada 2 min y un PR normal
// no lo veía nadie).
//
// Firma de partner sobre el CUERPO crudo (`ts.<rawBody>`), como `api/internal/board-event`; el
// namespace lo resuelve el HOST. Idempotente por `delivery` (gt_github_deliveries): gs reintenta
// y GitHub reenvía.

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

/** Lo que manda gs (`PrEvent` en app-hook.server.ts). */
type PrEvent = {
  delivery: string;
  action: "opened" | "reopened" | "ready_for_review" | "merged" | "closed";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  by: string | null;
  draft: boolean;
};

const LINE: Record<PrEvent["action"], (ev: PrEvent) => string> = {
  opened: (ev) => `🟢 **PR #${ev.number} abierto**${ev.author ? ` por @${ev.author}` : ""}`,
  ready_for_review: (ev) => `🟢 **PR #${ev.number} listo para revisión**${ev.by ? ` (@${ev.by})` : ""}`,
  reopened: (ev) => `🔄 **PR #${ev.number} reabierto**${ev.by ? ` por @${ev.by}` : ""}`,
  merged: (ev) => `🟣 **PR #${ev.number} mezclado**${ev.by ? ` por @${ev.by}` : ""}`,
  closed: (ev) => `⚪ **PR #${ev.number} cerrado sin mezclar**${ev.by ? ` por @${ev.by}` : ""}`,
};

/** Aviso + tarjeta `gt-gh` (sin botones: es un hecho, no algo que accionar desde aquí). */
export function prMessageBody(ev: PrEvent): string {
  const state = ev.action === "merged" ? "merged" : ev.action === "closed" ? "closed" : "open";
  const card = { kind: "pr", repo: ev.repo, ref: String(ev.number), title: ev.title, url: ev.url, state, author: ev.author ?? "" };
  return `${LINE[ev.action](ev)} · \`${ev.repo}\`\n\n\`\`\`gt-gh\n${JSON.stringify(card)}\n\`\`\``;
}

/**
 * Quién da el aviso: un AGENTE del room, no un «GitHub» sin cara. El último agente que habló en
 * ese room (fuera de los roles de la fábrica), o el primero del espacio. Se publica con
 * `postAgent`, que no despierta a nadie (`mentions_ghosty = 0`).
 */
async function roomAgent(channelId: number): Promise<{ handle: string; name: string; avatar: string }> {
  const { resolvedAgents } = await import("../agents.server");
  const { dbq } = await import("../dbq.server");
  const agents = (await resolvedAgents()).filter((a) => !["plan", "build", "check"].includes(a.handle));
  const [last] = await dbq(
    `SELECT agent_handle FROM gc_messages WHERE channel_id = ? AND agent_handle IS NOT NULL AND agent_handle NOT IN ('plan','build','check')
     ORDER BY id DESC LIMIT 1`,
    [channelId],
  ).catch(() => []);
  const a = agents.find((x) => x.handle === last?.agent_handle) ?? agents[0];
  return a ? { handle: a.handle, name: a.name, avatar: a.avatar } : { handle: "ghosty", name: "Ghosty", avatar: "" };
}

export const Route = createFileRoute("/api/internal/github-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const ok = await verify(request.headers.get("x-ghosty-ts") ?? "", request.headers.get("x-ghosty-sig") ?? "", raw);
        if (!ok) return new Response("firma inválida", { status: 403 });

        let ev: PrEvent;
        try {
          ev = JSON.parse(raw) as PrEvent;
        } catch {
          return new Response("json inválido", { status: 400 });
        }
        if (!ev.delivery || !ev.repo || !ev.number || !/^https:\/\/github\.com\//.test(ev.url ?? "") || !LINE[ev.action]) {
          return new Response("evento inválido", { status: 400 });
        }

        await (await import("../server/schema.server")).ensureSchema().catch(() => {});
        const { dbq } = await import("../dbq.server");
        // Se reclama la entrega ANTES de avisar; si algo truena se suelta para que el reintento de
        // gs la procese entera. Un reintento de algo ya avisado contesta `repeated`.
        const claimed = await dbq("INSERT OR IGNORE INTO gt_github_deliveries (delivery) VALUES (?) RETURNING delivery", [ev.delivery]);
        if (!claimed.length) return Response.json({ ok: true, repeated: true });

        try {
          const db = await import("../db.server");
          // 1. Pedidos de la fábrica con ese PR: se cierran ya y lo dice el HILO del pedido (con la
          //    cara de @check/@build). En esos rooms no va tarjeta suelta: la de veredicto del
          //    pedido ya trae «Ver PR / Mezclar», y repetirla es ruido.
          const runRooms = new Set<number>();
          const { runsByPr, onPrEvent } = await import("../server/apps/factory-runs.server");
          for (const run of await runsByPr(ev.repo, ev.number)) {
            runRooms.add(run.channelId);
            if (ev.action === "merged" || ev.action === "closed") await onPrEvent(run, ev.action);
          }
          const rooms = (await db.roomsOfRepo(ev.repo)).filter((c) => !runRooms.has(c));
          if (!rooms.length) return Response.json({ ok: true, rooms: 0, factoryRooms: runRooms.size });

          const bus = await import("../server/bus.server");
          const { currentNamespace } = await import("../server/tenant.server");
          const { dbq: q } = await import("../dbq.server");
          const ns = await currentNamespace();
          const body = prMessageBody(ev);
          let posted = 0;
          for (const channelId of rooms) {
            const [card] = await q("SELECT msg_id FROM gt_pr_cards WHERE repo = ? AND number = ? AND channel_id = ?", [
              ev.repo.toLowerCase(),
              ev.number,
              channelId,
            ]);
            const cardMsg = card ? await db.getMessage(Number(card.msg_id)) : null;
            if (cardMsg) {
              // Ya hay tarjeta de este PR en el room: se ACTUALIZA (deja de decir «abierto») y el
              // cambio se cuenta en su hilo, para que el merge se note y no sólo se corrija en silencio.
              await db.editMessage(cardMsg.id, body);
              bus.publish(bus.ch.room(ns, channelId), { t: "message:edited", id: cardMsg.id, body, edited_at: Math.floor(Date.now() / 1000) });
              const who = await roomAgent(channelId);
              const { id } = await db.postAgent(channelId, cardMsg.id, LINE[ev.action](ev), "msg", who.handle, who.name, "general", who.avatar);
              const reply = await db.getMessage(id);
              if (reply) bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: reply });
              posted++;
              continue;
            }
            // Un borrador recién abierto todavía no es noticia: se avisa cuando pase a revisión.
            if (ev.action === "opened" && ev.draft) continue;
            const who = await roomAgent(channelId);
            const { id } = await db.postAgent(channelId, null, body, "msg", who.handle, who.name, "general", who.avatar);
            await q("INSERT OR REPLACE INTO gt_pr_cards (repo, number, channel_id, msg_id) VALUES (?, ?, ?, ?)", [
              ev.repo.toLowerCase(),
              ev.number,
              channelId,
              id,
            ]);
            const creado = await db.getMessage(id);
            if (creado) bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: creado });
            posted++;
          }
          return Response.json({ ok: true, rooms: posted, factoryRooms: runRooms.size });
        } catch (e) {
          await dbq("DELETE FROM gt_github_deliveries WHERE delivery = ?", [ev.delivery]).catch(() => {});
          console.error(`[github-event] ${ev.repo}#${ev.number} ${ev.action}: ${e instanceof Error ? e.message : e}`);
          return new Response("falló al avisar", { status: 500 });
        }
      },
    },
  },
});
