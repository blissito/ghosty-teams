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
  /** La pregunta del escritor cuando le toca a una persona (`note` del run) y sus opciones (último `asked_person`). */
  question: string | null;
  options: string[];
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
    label: String(typeof d?.stage === "string" && Number.isNaN(Number(d.stage)) ? d.stage : (d?.estado ?? phase)),
    repo: d?.repo ? String(d.repo) : null,
    issue: Number(d?.issue) || null,
    prUrl: d?.prUrl ? String(d.prUrl) : null,
    issueUrl: d?.issueUrl ? String(d.issueUrl) : null,
    needsPerson: phase === "needs_person",
    question: phase === "needs_person" && d?.note ? String(d.note) : null,
    options: phase === "needs_person" ? lastAskOptions(d?.events) : [],
    canMerge: d?.canMerge === true || (d?.ready === true && LIVE.has(phase) && phase !== "merging"),
    live: LIVE.has(phase),
  };
}

/** Las opciones de la última pregunta del escritor (`asked_person`), si las dio. Puro. */
export function lastAskOptions(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  const ask = [...events].reverse().find((e: any) => e?.kind === "asked_person");
  const opts = (ask as any)?.data?.options;
  return Array.isArray(opts) ? opts.map((o: unknown) => String(typeof o === "object" && o ? ((o as any).label ?? (o as any).text ?? "") : o)).filter(Boolean).slice(0, 6) : [];
}

// La tarjeta llega por `runId` (el fence); la barra del hilo, por (channel, raíz). Las dos comprueban que quien mira
// vea el room del pendiente.
async function ctxFor(q: { runId?: string; channelId?: number; rootMsgId?: number }) {
  const me = await sessionUser();
  if (!me) return null;
  const { devThreadByRun, devThreadOf } = await import("./dev-threads.server");
  const t = q.runId ? await devThreadByRun(String(q.runId)) : q.channelId && q.rootMsgId ? await devThreadOf(Number(q.channelId), Number(q.rootMsgId)) : null;
  if (!t) return null;
  const db = await import("../../db.server");
  if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === t.channelId)) return null;
  return { me, t };
}

async function emailFor(sub: string | null): Promise<string | null> {
  if (!sub) return null;
  const { dbq } = await import("../../dbq.server");
  const [r] = await dbq("SELECT email FROM gc_users WHERE sub = ?", [sub]).catch(() => []);
  return r?.email ? String(r.email).toLowerCase() : null;
}

type Q = { runId?: string; channelId?: number; rootMsgId?: number };

/** El estado del pendiente (lo lee gs en vivo con la cuenta de quien mira). null si no es un pendiente de gs. */
export const devThreadCardFn = createServerFn({ method: "POST" })
  .validator((d: Q) => d)
  .handler(async ({ data }): Promise<(DevRunView & { rootMsgId: number }) | null> => {
    const ctx = await ctxFor(data);
    if (!ctx) return null;
    const { devRunsCall } = await import("./dev-engine.server");
    const email = (await emailFor(ctx.me.sub)) ?? (await emailFor(ctx.t.requestedBy));
    const r = email ? await devRunsCall("status", { id: ctx.t.runId, email, after: 0 }) : null;
    return { ...devRunView(ctx.t.runId, r?.ok ? r.data : { phase: "queued" }), rootMsgId: ctx.t.rootMsgId };
  });

export type DevChatMessage = { seq: number; role: "writer" | "person"; text: string; at: string | null };

/** La conversación del escritor, leída de gs en vivo (`after` = último seq que ya tiene la tarjeta). Nada se guarda aquí. */
export const devThreadConversationFn = createServerFn({ method: "POST" })
  .validator((d: Q & { after?: number }) => d)
  .handler(async ({ data }): Promise<{ messages: DevChatMessage[] } | null> => {
    const ctx = await ctxFor(data);
    if (!ctx) return null;
    const email = await emailFor(ctx.me.sub);
    if (!email) return null;
    const { devRunsCall } = await import("./dev-engine.server");
    const r = await devRunsCall("conversation", { id: ctx.t.runId, after: Number(data.after) || 0, email });
    if (!r.ok) return { messages: [] };
    return { messages: chatMessages(r.data?.messages) };
  });

/** Los mensajes de gs para el chat de la tarjeta (puro): el escritor y las personas, sin los de sistema ni vacíos. */
export function chatMessages(raw: unknown): DevChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => (m?.role === "assistant" || m?.role === "user") && String(m?.text ?? "").trim())
    .map((m: any) => ({ seq: Number(m.seq) || 0, role: m.role === "assistant" ? ("writer" as const) : ("person" as const), text: String(m.text).trim(), at: m.at ? String(m.at) : null }));
}

/** Lo que se escribe en el composer de la tarjeta: al escritor por `op:tell` (gs lo guarda y lo muestra). */
export const devThreadTellFn = createServerFn({ method: "POST" })
  .validator((d: Q & { text: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await ctxFor(data);
    if (!ctx) throw new Error("no autorizado");
    const text = String(data.text ?? "").trim();
    if (!text) throw new Error("mensaje vacío");
    const { tellDevThread } = await import("./dev-threads.server");
    const r = await tellDevThread(ctx.t, ctx.me.sub, text);
    if (!r.ok) throw new Error(r.message ?? "gs no respondió");
    return { ok: true as const };
  });

/** Mezclar o detener desde la tarjeta, con la cuenta de quien da el clic (gs comprueba que pueda). */
export const devThreadActionFn = createServerFn({ method: "POST" })
  .validator((d: Q & { action: "merge" | "stop" }) => d)
  .handler(async ({ data }) => {
    const ctx = await ctxFor(data);
    if (!ctx) throw new Error("no autorizado");
    if (data.action !== "merge" && data.action !== "stop") throw new Error("acción inválida");
    const email = await emailFor(ctx.me.sub);
    if (!email) throw new Error("no encuentro tu correo en este espacio");
    const { devRunsCall } = await import("./dev-engine.server");
    const r = await devRunsCall(data.action, { id: ctx.t.runId, email });
    if (!r.ok) throw new Error(String(r.data?.message ?? r.data?.error ?? `gs respondió ${r.status}`));
    return { ok: true as const };
  });
