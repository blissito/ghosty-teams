// Funciones de la tarjeta del pendiente de gs en un hilo del room (`DevRunBar`). Todo lo lee y lo manda gs; aquí sólo
// se comprueba que quien mira vea el room y se habla con la puerta firmada.
import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";

export type DevRunView = {
  runId: string;
  title: string;
  phase: string;
  label: string;
  repo: string | null;
  issue: number | null;
  prUrl: string | null;
  issueUrl: string | null;
  needsPerson: boolean;
  canMerge: boolean;
  live: boolean;
};

const LIVE = new Set(["queued", "working", "waiting_ci", "reviewing", "needs_person", "merging"]);

/** El estado de gs en lo que pinta la tarjeta. Puro (con su test). */
export function devRunView(runId: string, d: any): DevRunView {
  const phase = String(d?.phase ?? "queued");
  return {
    runId,
    title: String(d?.title ?? "Pendiente"),
    phase,
    label: String(d?.stage ?? d?.estado ?? phase),
    repo: d?.repo ? String(d.repo) : null,
    issue: Number(d?.issue) || null,
    prUrl: d?.prUrl ? String(d.prUrl) : null,
    issueUrl: d?.issueUrl ? String(d.issueUrl) : null,
    needsPerson: phase === "needs_person",
    canMerge: d?.canMerge === true || (d?.ready === true && LIVE.has(phase) && phase !== "merging"),
    live: LIVE.has(phase),
  };
}

async function threadFor(channelId: number, rootMsgId: number) {
  const me = await sessionUser();
  if (!me) return null;
  const db = await import("../../db.server");
  if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === channelId)) return null;
  const { devThreadOf } = await import("./dev-threads.server");
  const t = await devThreadOf(channelId, rootMsgId);
  return t ? { me, t } : null;
}

async function emailFor(sub: string | null): Promise<string | null> {
  if (!sub) return null;
  const { dbq } = await import("../../dbq.server");
  const [r] = await dbq("SELECT email FROM gc_users WHERE sub = ?", [sub]).catch(() => []);
  return r?.email ? String(r.email).toLowerCase() : null;
}

/** La tarjeta del hilo: null si el hilo no es de un pendiente de gs. */
export const devThreadCardFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; rootMsgId: number }) => d)
  .handler(async ({ data }): Promise<DevRunView | null> => {
    const ctx = await threadFor(Number(data.channelId), Number(data.rootMsgId));
    if (!ctx) return null;
    const { devRunsCall } = await import("./dev-engine.server");
    // El pendiente es de quien lo pidió: gs lo lee con su cuenta.
    const email = await emailFor(ctx.t.requestedBy);
    const r = email ? await devRunsCall("status", { id: ctx.t.runId, email, after: 1e12 }) : null;
    if (!r?.ok) return devRunView(ctx.t.runId, { phase: ctx.t.phase ?? "queued" });
    return devRunView(ctx.t.runId, r.data);
  });

/** Mezclar o detener desde la tarjeta, con la cuenta de quien da el clic (gs comprueba que pueda). */
export const devThreadActionFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; rootMsgId: number; action: "merge" | "stop" }) => d)
  .handler(async ({ data }) => {
    const ctx = await threadFor(Number(data.channelId), Number(data.rootMsgId));
    if (!ctx) throw new Error("no autorizado");
    if (data.action !== "merge" && data.action !== "stop") throw new Error("acción inválida");
    const email = await emailFor(ctx.me.sub);
    if (!email) throw new Error("no encuentro tu correo en este espacio");
    const { devRunsCall } = await import("./dev-engine.server");
    const r = await devRunsCall(data.action, { id: ctx.t.runId, email });
    if (!r.ok) throw new Error(String(r.data?.message ?? r.data?.error ?? `gs respondió ${r.status}`));
    const { syncDevThread } = await import("./dev-threads.server");
    await syncDevThread(ctx.t).catch(() => {});
    return { ok: true as const };
  });
