import { createServerFn } from "@tanstack/react-start";
import type { Readiness } from "./readiness.server";

// «Listo para agentes» en la UI: la calificación del repo (cualquiera que vea el room) y
// «Preparar repo» (sólo el dueño, sólo en el room de la fábrica). Ver readiness.server.ts.

export type ReadinessView = {
  readiness: Readiness | null;
  error: string | null;
  /** ¿Se puede preparar desde aquí? (fábrica instalada, repo de su room, eres dueño) */
  canPrepare: boolean;
  factoryInstalled: boolean;
  isOwner: boolean;
  /** Pedido de preparación vivo para este repo: el botón se vuelve «ver pedido». */
  activePrep: { runId: number; status: string; threadUrl: string | null } | null;
};

async function factoryRoom(): Promise<number | null> {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ roomId?: number }>("factory").catch(() => null);
  return cfg?.roomId ?? null;
}

async function threadUrl(channelId: number, rootMsgId: number): Promise<string | null> {
  const { sessionUser } = await import("../chat");
  const me = await sessionUser();
  if (!me) return null;
  const db = await import("../../db.server");
  const ch = (await db.listChannels(me.sub, me.isOwner)).find((c) => c.id === channelId);
  return ch ? `/c/${ch.slug}?thread=${rootMsgId}` : null;
}

async function activePrepFor(repo: string) {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq(
    `SELECT id, channel_id, root_msg_id, status FROM gt_factory_runs
     WHERE kind = 'prep' AND repo = ? AND status NOT IN ('done','cancelled') ORDER BY id DESC LIMIT 1`,
    [repo],
  ).catch(() => []);
  const r = rows[0];
  return r ? { runId: Number(r.id), status: String(r.status), threadUrl: await threadUrl(Number(r.channel_id), Number(r.root_msg_id)) } : null;
}

export const repoReadinessFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; repo: string; fresh?: boolean }) => d)
  .handler(async ({ data }): Promise<ReadinessView> => {
    const { visibleChannel } = await import("../room-repos");
    const { me, db } = await visibleChannel(Number(data.channelId));
    const row = (await db.listRoomRepos(Number(data.channelId))).find((r) => r.repo === data.repo);
    if (!row) throw new Error("ese repo no está en este room");
    const { repoReadiness } = await import("./readiness.server");
    // Con el token de quien CONECTÓ el repo: así lo ve cualquier miembro del room.
    const r = await repoReadiness(row.connectedBy, data.repo, { fresh: !!data.fresh }).catch((e) => ({ error: String(e?.message ?? e) }));
    const room = await factoryRoom();
    const factoryRepos = room ? (await db.listRoomRepos(room)).map((x) => x.repo) : [];
    return {
      readiness: "error" in r ? null : r,
      error: "error" in r ? r.error : null,
      factoryInstalled: !!room,
      isOwner: !!me.isOwner,
      canPrepare: !!me.isOwner && factoryRepos.includes(data.repo),
      activePrep: await activePrepFor(data.repo),
    };
  });

/**
 * «Preparar repo»: abre un pedido en el room de la fábrica con el plan YA armado (lo que
 * falta, nada más) y la tarjeta para firmar. No despierta a @plan: el plan es determinista y
 * no vale un turno. Al firmar, la estafeta de siempre despierta a @build.
 */
export const prepareRepoFn = createServerFn({ method: "POST" })
  .validator((d: { repo: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("../chat");
    const me = await sessionUser();
    if (!me?.isOwner) throw new Error("sólo el dueño del espacio prepara repos");
    const room = await factoryRoom();
    if (!room) throw new Error("la Software Factory no está instalada");
    const db = await import("../../db.server");
    const row = (await db.listRoomRepos(room)).find((r) => r.repo === data.repo);
    if (!row) throw new Error("ese repo no es de la fábrica");

    const alive = await activePrepFor(data.repo);
    if (alive) return { ...alive, existing: true };

    const { repoReadiness, preparationPlan } = await import("./readiness.server");
    const r = await repoReadiness(row.connectedBy, data.repo, { fresh: true });
    if ("error" in r) throw new Error(r.error);
    const { title, planMd, fixes } = preparationPlan(r);
    if (!fixes.length) throw new Error("no hay nada que preparar en el repo");

    const R = await import("./factory-runs.server");
    const { dbq } = await import("../../dbq.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const ns = await currentNamespace();
    // La raíz del pedido con la cara de @plan, como cualquier otro: todo cuelga de su hilo.
    const { resolvedAgents } = await import("../../agents.server");
    const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
    const rootBody = `🧰 **${title}** — ${me.name ?? "El dueño"} pidió preparar el repo (nivel ${r.level} de 3, ${r.passed}/${r.total}). Firma el plan y @build abre un solo PR.`;
    const { id: rootId } = await db.postAgent(room, null, rootBody, "msg", "plan", plan?.name ?? "Plan", "general", plan?.avatar ?? "");
    const rootMsg = await db.getMessage(rootId);
    if (rootMsg) bus.publish(bus.ch.room(ns, room), { t: "message:new", msg: rootMsg });

    const rows = await dbq(
      `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, kind)
       VALUES (?, ?, 'general', ?, 'planning', ?, ?, 'prep') RETURNING id`,
      [room, rootId, title, data.repo, me.sub],
    );
    let run = (await R.getRun(Number(rows[0].id)))!;
    run = await R.applyEvent(run, "plan_submitted", { plan_version: 1 });
    await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, 1, ?)", [run.id, planMd]);
    const msgId = await R.postInThread(run, "plan", R.planCardFence(run.id, 1));
    if (msgId) await dbq("UPDATE gt_factory_plans SET msg_id = ? WHERE run_id = ? AND version = 1", [msgId, run.id]);
    void R.createTaskFor(run, planMd).catch(() => {});
    await R.ensureRunCard(run);
    void R.refreshRoom(room);
    return { runId: run.id, status: run.status, threadUrl: await threadUrl(room, rootId), existing: false };
  });

/**
 * «Variables» de la preview: el `.env` con que nuestra caja arranca los PRs del repo. Sólo
 * el dueño. Entra a la bóveda de gs y nunca vuelve: la UI sólo ve los NOMBRES.
 */
export const savePreviewEnvFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; repo: string; dotenv: string }) => d)
  .handler(async ({ data }) => {
    const { visibleChannel } = await import("../room-repos");
    const { me, db } = await visibleChannel(Number(data.channelId));
    if (!me.isOwner) throw new Error("sólo el dueño del espacio guarda variables");
    if (!(await db.listRoomRepos(Number(data.channelId))).some((r) => r.repo === data.repo)) throw new Error("ese repo no está en este room");
    const dotenv = String(data.dotenv ?? "").trim();
    if (!dotenv) throw new Error("las variables no pueden ir vacías");
    if (dotenv.length > 32_000) throw new Error("demasiado largo");
    const { gsPreview } = await import("./preview.server");
    const out = await gsPreview("env-set", { repo: data.repo, dotenv });
    const { invalidateReadiness } = await import("./readiness.server");
    invalidateReadiness(data.repo);
    return { keys: (out?.keys ?? []) as string[] };
  });
