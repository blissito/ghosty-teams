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
          // 1. Pedidos de la fábrica con ese PR: se cierran ya (el hilo del pedido lo dice).
          const runRooms = new Set<number>();
          if (ev.action === "merged" || ev.action === "closed") {
            const { runsByPr, onPrEvent } = await import("../server/apps/factory-runs.server");
            for (const run of await runsByPr(ev.repo, ev.number)) {
              await onPrEvent(run, ev.action);
              runRooms.add(run.channelId);
            }
          }
          // 2. Aviso en cada room con ese repo. En el room de la fábrica no se repite si el PR es
          //    de un pedido: ahí ya lo dice su hilo y su tarjeta.
          if (ev.action === "opened" && ev.draft) return Response.json({ ok: true, rooms: 0, draft: true });
          const rooms = (await db.roomsOfRepo(ev.repo)).filter((c) => !runRooms.has(c));
          if (!rooms.length) return Response.json({ ok: true, rooms: 0 });
          const bus = await import("../server/bus.server");
          const { currentNamespace } = await import("../server/tenant.server");
          const ns = await currentNamespace();
          const body = prMessageBody(ev);
          for (const channelId of rooms) {
            const { id } = await db.createMessage({ channelId, parentId: null, sender: "GitHub", senderSub: null, body, topic: "general" });
            const creado = await db.getMessage(id);
            if (creado) bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: creado });
          }
          return Response.json({ ok: true, rooms: rooms.length });
        } catch (e) {
          await dbq("DELETE FROM gt_github_deliveries WHERE delivery = ?", [ev.delivery]).catch(() => {});
          console.error(`[github-event] ${ev.repo}#${ev.number} ${ev.action}: ${e instanceof Error ? e.message : e}`);
          return new Response("falló al avisar", { status: 500 });
        }
      },
    },
  },
});
