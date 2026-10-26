// ── Despachador: un RepoEvent → las automatizaciones prendidas en cada room con ese repo ─────
//
// Lo llama `api/internal/github-event` SIN esperar (la respuesta a gs sale ya); cada `handle`
// corre aparte con sus errores atrapados: una automatización que truena no tumba a las demás ni
// hace que gs reintente la entrega.
import type { RepoEvent } from "./types";
import { pickAutomations, prNumbersOf } from "./dispatch";
import { enabledByRoom } from "./store.server";
import { automationCtx } from "./ctx.server";

export async function dispatchRepoEvent(ev: RepoEvent, opts: { ns: string; origin: string }): Promise<{ ran: number }> {
  if (!ev?.repo || !ev.event) return { ran: 0 };
  const enabled = await enabledByRoom(ev.repo);
  if (!enabled.size) return { ran: 0 };
  const { AUTOMATIONS } = await import("./registry.server");
  const db = await import("../../db.server");
  const live = new Set(await db.roomsOfRepo(ev.repo));
  const jobs: { roomId: number; kind: string; run: () => Promise<void> }[] = [];
  for (const [roomId, e] of enabled) {
    if (!live.has(roomId)) continue; // el repo ya no está en el room (o el room se archivó)
    for (const a of pickAutomations(AUTOMATIONS, e.kinds, ev))
      jobs.push({
        roomId,
        kind: a.kind,
        run: () => a.handle(ev, automationCtx({ ns: opts.ns, roomId, repo: ev.repo, origin: opts.origin, kind: a.kind })),
      });
  }
  if (!jobs.length) return { ran: 0 };
  // Un PR de un pedido de la fábrica ya lo vigila ella (`pr-watches`, @check, @build): no se duplica.
  const prs = prNumbersOf(ev);
  if (prs.length) {
    const { runsByPr } = await import("../apps/factory-runs.server");
    for (const n of prs) if ((await runsByPr(ev.repo, n).catch(() => [])).length) return { ran: 0 };
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  results.forEach((r, i) => {
    if (r.status === "rejected")
      console.error(`[automations] ${jobs[i].kind} ${ev.repo} room=${jobs[i].roomId} ${ev.event}.${ev.action ?? ""}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  });
  return { ran: jobs.length };
}
