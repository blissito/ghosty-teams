// ── Pedido de la fábrica que NO nace de una persona (adopciones) ───────────────────────────────
//
// Sacado de `adoptDependabotPr` (10-oct) para que otras adopciones usen lo mismo: un PR de
// Dependabot entra directo a revisión, un lote de alertas de seguridad entra directo a construir
// (`automations/security-fix`). Lo común: el mensaje raíz del hilo lo firma un rol, la fila en
// `gt_factory_runs` con las credenciales de quien conectó el repo, el evento en la bitácora y la
// tarjeta viva. El encargo al rol lo hace quien llama (cada adopción tiene el suyo).
import type { Run } from "./factory-runs.server";

export type AdoptedRunOpts = {
  room: number;
  /** Quien conectó el repo: con SUS credenciales trabaja la fábrica en este pedido. */
  sub: string;
  repo: string;
  title: string;
  /** El mensaje raíz del hilo del pedido. */
  rootBody: string;
  /** El rol que firma el mensaje raíz. */
  rootHandle: "plan" | "build" | "check";
  status: "checking" | "plan_review";
  kind: string;
  taskRef?: string | null;
  prUrl?: string | null;
  headSha?: string | null;
  branch?: string | null;
  planVersion?: number;
  /** Evento de la bitácora («adopted», …) y sus datos. */
  event: { type: string; actor: string; data: Record<string, unknown> };
  /**
   * Arranca solo a esta hora (unix s): el pedido espera en `plan_review` con el plan firmable y el
   * tick (`startDueAdoptedRuns`) lo aprueba a nombre de `dueWho`. Quien llama NO hace `decide`.
   * Sirve para juntar un lote (las alertas de seguridad que llegan en ráfaga).
   */
  dueAt?: number | null;
  dueWho?: string;
  /** Datos del tipo para la tarjeta y su preparación (`kind_meta`). */
  kindMeta?: Record<string, unknown> | null;
};

export async function openAdoptedRun(o: AdoptedRunOpts): Promise<Run> {
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const R = await import("./factory-runs.server");
  const ns = await currentNamespace();
  const { resolvedAgents } = await import("../../agents.server");
  const agent = (await resolvedAgents()).find((a) => a.handle === o.rootHandle);
  const fallbackName = o.rootHandle.charAt(0).toUpperCase() + o.rootHandle.slice(1);
  const { id: rootId } = await db.postAgent(o.room, null, o.rootBody, "msg", o.rootHandle, agent?.name ?? fallbackName, "general", agent?.avatar ?? "");
  const rootMsg = await db.getMessage(rootId);
  if (rootMsg) bus.publish(bus.ch.room(ns, o.room), { t: "message:new", msg: rootMsg });

  const rows = await dbq(
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, approved_by, kind, task_ref, pr_url, head_sha, branch, plan_version, due_at, due_who, kind_meta)
     VALUES (?, ?, 'general', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      o.room,
      rootId,
      o.title.slice(0, 200),
      o.status,
      o.repo,
      o.sub,
      o.sub,
      o.kind,
      o.taskRef ?? null,
      o.prUrl ?? null,
      o.headSha ?? null,
      o.branch ?? null,
      o.planVersion ?? 0,
      o.dueAt != null && o.status === "plan_review" ? Math.floor(o.dueAt) : null,
      o.dueAt != null ? (o.dueWho ?? null) : null,
      o.kindMeta ? JSON.stringify(o.kindMeta) : null,
    ],
  );
  const run = (await R.getRun(Number(rows[0].id)))!;
  await R.logEvent(run.id, o.event.type, o.event.actor, o.event.data);
  await R.ensureRunCard(run);
  return run;
}

/** Pedidos vivos de un tipo en un repo (los topes por repo de cada adopción). */
export async function liveRunsOfKind(kind: string, repo: string): Promise<number> {
  const { dbq } = await import("../../dbq.server");
  const [r] = await dbq(
    "SELECT COUNT(*) AS n FROM gt_factory_runs WHERE kind = ? AND LOWER(repo) = LOWER(?) AND status NOT IN ('done','cancelled')",
    [kind, repo],
  ).catch(() => [{ n: 0 }]);
  return Number(r?.n ?? 0);
}

/**
 * Preparación de un tipo justo antes de arrancar: puede reescribir el plan v1 con datos frescos o
 * decir que ya no hay nada que hacer (`skip` = se cancela con su razón). Import perezoso: el tick
 * no carga las automatizaciones si no hay pedidos que venzan.
 */
export type DuePrep = (run: Run) => Promise<{ skip?: string } | void>;
const DUE_PREP: Record<string, () => Promise<DuePrep>> = {
  security: async () => (await import("../automations/security-fix.server")).prepareSecurityRun,
};

/**
 * Tick de la fábrica: los adoptados cuya hora ya llegó se aprueban solos, del más viejo al más
 * nuevo. `decide` pide la caja y, sin lugar, el pedido se forma en la cola de lugares como
 * cualquier otro. Si alguien firmó antes, el pedido ya no está en `plan_review` y sólo se limpia
 * su hora. Claim atómico: dos ticks a la par no aprueban dos veces. Nunca lanza.
 */
export async function startDueAdoptedRuns(now = Math.floor(Date.now() / 1000)): Promise<number> {
  const { dbq } = await import("../../dbq.server");
  await dbq("UPDATE gt_factory_runs SET due_at = NULL WHERE due_at IS NOT NULL AND status != 'plan_review'", []).catch(() => {});
  const rows = await dbq(
    "SELECT id, due_who FROM gt_factory_runs WHERE due_at IS NOT NULL AND due_at <= ? AND status = 'plan_review' ORDER BY due_at ASC LIMIT 5",
    [now],
  ).catch(() => []);
  const R = await import("./factory-runs.server");
  let started = 0;
  for (const r of rows) {
    const claimed = await dbq("UPDATE gt_factory_runs SET due_at = NULL WHERE id = ? AND due_at IS NOT NULL RETURNING id", [r.id]).catch(() => []);
    if (!claimed.length) continue;
    try {
      let run = await R.getRun(Number(r.id));
      if (!run || run.status !== "plan_review") continue;
      const who = String(r.due_who || "La plataforma");
      const prep = DUE_PREP[run.kind ?? ""];
      const out = prep ? await (await prep())(run).catch((e) => (console.warn(`[factory] preparar #${run!.id}: ${(e as Error).message}`), undefined)) : undefined;
      run = (await R.getRun(run.id)) ?? run;
      if (out?.skip) {
        await R.postInThread(run, "build", out.skip);
        await R.applyEvent(run, "cancel", {}, { actor: who, data: { reason: "nothing_to_do" } });
        void R.refreshRoom(run.channelId);
        continue;
      }
      await R.decide({ run, version: run.planVersion, decision: "approve", sub: run.approvedBy ?? run.requestedBy, who, origin: "" });
      void R.refreshRoom(run.channelId);
      started++;
    } catch (e) {
      console.error(`[factory] arranque a su hora #${r.id}`, e);
    }
  }
  return started;
}
