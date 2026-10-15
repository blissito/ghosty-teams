import { createFileRoute } from "@tanstack/react-router";

// ── Endpoint interno: un PR cambió en GitHub ─────────────────────────────────────────────────
//
// gs es el receptor único del webhook de la GitHub App (`ghosty-studio/app/lib/github/
// app-hook.server.ts`): verifica, guarda y reparte con reintentos al Teams de cada workspace.
// Aquí se avisa en los rooms que tienen ese repo (gt_room_repos) y, si el PR es de un pedido de
// la fábrica, se cierra el pedido AL INSTANTE (antes lo veía un sondeo cada 2 min y un PR normal
// no lo veía nadie). Un merge además ENCOLA la vigilancia del deploy (`apps/post-merge.server`);
// la red la hace el tick, nunca esta petición.
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
  action: "opened" | "reopened" | "ready_for_review" | "merged" | "closed" | "review" | "comment" | "ci";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  by: string | null;
  draft: boolean;
  /** Sólo en `review`: una PERSONA revisó (gs ya filtró los bots). */
  review?: { state: string; at: string };
  /** Lo que alguien del repo le pidió a Ghosty (comentario con @ghosty o «Request changes»). */
  ask?: { text: string; url: string; path?: string; line?: number };
  /** Sólo en `ci`: terminó el CI de la cabeza del PR. */
  ci?: { conclusion: string; sha: string };
};

const LINE: Record<PrEvent["action"], (ev: PrEvent) => string> = {
  opened: (ev) => `🟢 **PR #${ev.number} abierto**${ev.author ? ` por @${ev.author}` : ""}`,
  ready_for_review: (ev) => `🟢 **PR #${ev.number} listo para revisión**${ev.by ? ` (@${ev.by})` : ""}`,
  reopened: (ev) => `🔄 **PR #${ev.number} reabierto**${ev.by ? ` por @${ev.by}` : ""}`,
  merged: (ev) => `🟣 **PR #${ev.number} con merge**${ev.by ? ` por @${ev.by}` : ""}`,
  closed: (ev) => `⚪ **PR #${ev.number} cerrado sin merge**${ev.by ? ` por @${ev.by}` : ""}`,
  // Una review no se anuncia en los rooms (se sale antes de avisar); sólo se mide.
  review: () => "",
  comment: () => "",
  // El fin del CI no se anuncia: sólo adelanta los barridos de la fábrica.
  ci: () => "",
};

/** Pinta en la tarjeta `gt-gh` de cada room cómo salió el CI del PR (sin aviso en el hilo). */
async function paintPrCardCi(repo: string, number: number, conclusion: string): Promise<void> {
  const { dbq } = await import("../dbq.server");
  const db = await import("../db.server");
  const bus = await import("../server/bus.server");
  const { currentNamespace } = await import("../server/tenant.server");
  const ns = await currentNamespace();
  const cards = await dbq("SELECT channel_id, msg_id FROM gt_pr_cards WHERE repo = ? AND number = ?", [repo.toLowerCase(), number]);
  for (const c of cards as unknown as { channel_id: number; msg_id: number }[]) {
    const msg = await db.getMessage(Number(c.msg_id));
    if (!msg) continue;
    let changed = false;
    // Sólo el fence de ESTE PR; lo demás del cuerpo (el aviso) se queda igual.
    const body = msg.body.replace(/```gt-gh\n([\s\S]*?)\n```/g, (whole: string, raw: string) => {
      try {
        const card = JSON.parse(raw) as Record<string, unknown>;
        if (card.kind !== "pr" || String(card.ref) !== String(number) || card.ci === conclusion) return whole;
        changed = true;
        return "```gt-gh\n" + JSON.stringify({ ...card, ci: conclusion }) + "\n```";
      } catch {
        return whole;
      }
    });
    if (!changed) continue;
    await db.editMessage(msg.id, body);
    bus.publish(bus.ch.room(ns, Number(c.channel_id)), { t: "message:edited", id: msg.id, body, edited_at: Math.floor(Date.now() / 1000) });
  }
}

/** Aviso + tarjeta `gt-gh` (sin botones: es un hecho, no algo que accionar desde aquí). */
export function prMessageBody(ev: PrEvent, ci?: string): string {
  const state = ev.action === "merged" ? "merged" : ev.action === "closed" ? "closed" : "open";
  const card = { kind: "pr", repo: ev.repo, ref: String(ev.number), title: ev.title, url: ev.url, state, author: ev.author ?? "", ...(ci ? { ci } : {}) };
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
  const agents = (await resolvedAgents()).filter((a) => !["plan", "build", "check", "eval"].includes(a.handle));
  const [last] = await dbq(
    `SELECT agent_handle FROM gc_messages WHERE channel_id = ? AND agent_handle IS NOT NULL AND agent_handle NOT IN ('plan','build','check','eval')
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
          const { runsByPr, onPrEvent, onPrReopened, recordFirstReview } = await import("../server/apps/factory-runs.server");
          // Una review no se anuncia en los rooms: sólo se mide (¿la fábrica pasó a la primera?).
          // Terminó el CI del PR: lo que el sondeo de 2 min haría, ya. @check despierta por su
          // vigilancia (`pr-watches`) y un rojo en «PR listo» regresa a @build sin esperar.
          if (ev.action === "ci") {
            const runs = await runsByPr(ev.repo, ev.number);
            const { sweepRunNow } = await import("../server/apps/factory-runs.server");
            for (const run of runs) if (run.status === "pr_review") await sweepRunNow(run);
            // GitHub avisa del fin de un check antes de que su estado combinado lo refleje: una
            // segunda mirada a los 10 s agarra el verde final sin esperar al tick.
            const later = runs.filter((r) => r.status === "pr_review");
            if (later.length) setTimeout(() => void Promise.all(later.map((r) => sweepRunNow(r))).catch(() => {}), 10_000).unref?.();
            // Terminó un CI: las tarjetas de esos pedidos se repintan ya (paso CI y «entra solo»).
            const { refreshRoom } = await import("../server/apps/factory-runs.server");
            for (const c of new Set(runs.map((r) => r.channelId))) void refreshRoom(c);
            await (await import("../server/pr-watches.server")).sweepPrWatchesNow();
            // La tarjeta del aviso «PR abierto» enseña cómo salió el CI, también en un PR que
            // no es pedido de la fábrica (antes sólo lo veían las tarjetas de pedido).
            if (ev.ci?.conclusion) await paintPrCardCi(ev.repo, ev.number, ev.ci.conclusion).catch((e) => console.warn("[github-event] ci en tarjeta", e));
            return Response.json({ ok: true, runs: runs.length });
          }
          if (ev.action === "review" || ev.action === "comment") {
            let recorded = 0;
            const asked: string[] = [];
            const { noteFromGithub } = await import("../server/apps/factory-runs.server");
            for (const run of await runsByPr(ev.repo, ev.number)) {
              if (ev.review) recorded += (await recordFirstReview(run.id, ev.review.state, ev.review.at)) ? 1 : 0;
              // Un pedido desde GitHub le llega a @build como la nota de @plan.
              if (ev.ask?.text && ev.by) asked.push(await noteFromGithub(run, ev.by, ev.ask));
            }
            return Response.json({ ok: true, recorded, asked });
          }
          const { enqueuePostMerge } = await import("../server/apps/post-merge.server");
          // Un PR de Dependabot recién abierto se vuelve pedido de revisión (no aviso suelto).
          if (ev.action === "opened" && !ev.draft) {
            const { adoptDependabotPr } = await import("../server/apps/dependabot.server");
            for (const c of await adoptDependabotPr(ev)) runRooms.add(c);
          }
          const prRuns = await runsByPr(ev.repo, ev.number);
          // PR sin pedido: si alguien le levantó preview con el botón de su tarjeta, su caja aparte
          // se tira al mezclar o cerrar (la de un pedido la tira `onPrEvent`). Sin caja, gs no hace nada.
          if ((ev.action === "merged" || ev.action === "closed") && !prRuns.length)
            void import("../server/apps/preview.server")
              .then((P) => P.gsPreview("down", { repo: ev.repo, pr: ev.number }))
              .catch(() => {});
          for (const run of prRuns) {
            runRooms.add(run.channelId);
            if (ev.action === "merged" || ev.action === "closed") await onPrEvent(run, ev.action);
            if (ev.action === "reopened") await onPrReopened(run);
            if (ev.action === "merged") {
              // El ✅ del deploy va en el «Pedido terminado» del hilo (no en la raíz: ahí el ✅ es la firma).
              const [notice] = await dbq(
                `SELECT id FROM gc_messages WHERE channel_id = ? AND parent_id = ? AND agent_handle IS NOT NULL
                 ORDER BY (body LIKE '%Pedido terminado%') DESC, id DESC LIMIT 1`,
                [run.channelId, run.rootMsgId],
              ).catch(() => []);
              await enqueuePostMerge({
                channelId: run.channelId,
                parentId: run.rootMsgId,
                noticeMsgId: notice ? Number(notice.id) : null,
                repo: ev.repo,
                pr: ev.number,
                fallbackSub: run.approvedBy ?? run.requestedBy,
              }).catch((e) => console.error("[github-event] post-merge", e));
              // `onPrEvent` ya repintó la tarjeta, pero antes de que existiera la vigilancia: sin esto
              // el paso «Prod» salía hasta el primer sondeo, mucho después del merge (bliss, 11-oct).
              const { refreshRoom } = await import("../server/apps/factory-runs.server");
              await refreshRoom(run.channelId).catch(() => {});
            }
          }
          // Rooms con los avisos de este repo prendidos, más los que YA tienen la tarjeta de este
          // PR: apagar el aviso no puede dejar una tarjeta congelada en «abierto».
          const { dbq: queryCards } = await import("../dbq.server");
          const roomsWithCard = (await queryCards("SELECT channel_id FROM gt_pr_cards WHERE repo = ? AND number = ?", [ev.repo.toLowerCase(), ev.number]).catch(() => []))
            .map((r: any) => Number(r.channel_id));
          const liveRooms = new Set(await db.roomsOfRepo(ev.repo));
          const rooms = [...new Set([...(await db.notifyRoomsOfRepo(ev.repo)), ...roomsWithCard.filter((c) => liveRooms.has(c))])]
            .filter((c) => !runRooms.has(c));
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
              // El CI ya pintado se conserva al pasar a merged/closed.
              const { extractAllGh } = await import("../lib/ebdoc");
              const ci = extractAllGh(cardMsg.body).find((g) => g.kind === "pr")?.ci;
              const edited = ci ? prMessageBody(ev, ci) : body;
              await db.editMessage(cardMsg.id, edited);
              bus.publish(bus.ch.room(ns, channelId), { t: "message:edited", id: cardMsg.id, body: edited, edited_at: Math.floor(Date.now() / 1000) });
              const who = await roomAgent(channelId);
              const { id } = await db.postAgent(channelId, cardMsg.id, LINE[ev.action](ev), "msg", who.handle, who.name, "general", who.avatar);
              const reply = await db.getMessage(id);
              if (reply) bus.publish(bus.ch.room(ns, channelId), { t: "message:new", msg: reply });
              if (ev.action === "merged") await enqueuePostMerge({ channelId, parentId: cardMsg.id, noticeMsgId: id, repo: ev.repo, pr: ev.number }).catch(() => {});
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
            if (ev.action === "merged") await enqueuePostMerge({ channelId, parentId: id, noticeMsgId: id, repo: ev.repo, pr: ev.number }).catch(() => {});
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
