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
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, approved_by, kind, task_ref, pr_url, head_sha, branch, plan_version)
     VALUES (?, ?, 'general', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
