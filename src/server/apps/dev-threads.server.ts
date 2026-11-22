// El hilo de un pedido en un room = la VISTA de la conversación `dev:<id>` de gs (una sola fábrica, 22-nov).
// Teams guarda sólo el mapeo hilo ↔ pendiente y dos cursores; el estado, las fases, el merge y a quién le toca los
// decide gs. Tres movimientos:
//   · `startDevThread`: el pedido nace en gs (`op:start`) y el hilo queda ligado.
//   · `tellDevThread`: lo que la persona escribe en el hilo le llega al escritor (`op:tell`), sin despertar roles.
//   · `syncDevThreads`: el barrido publica en el hilo lo que dice el escritor y los cambios de fase.
import { dbq } from "../../dbq.server";
import { devRunsCall } from "./dev-engine.server";

export type DevThread = {
  runId: string;
  channelId: number;
  rootMsgId: number;
  requestedBy: string | null;
  convSeq: number;
  eventSeq: number;
  phase: string | null;
  closed: boolean;
};

// Las fases cerradas de gs (`DevRunPhase`): ya no hay nada que espejar.
const CLOSED_PHASES = new Set(["merged", "done", "failed", "stopped"]);
export const isClosedPhase = (phase: string | null | undefined) => !!phase && CLOSED_PHASES.has(phase);

// Lo que se dice en el hilo cuando el pendiente cambia de fase (sólo las que piden algo o cierran: lo demás lo
// cuenta la tarjeta fija, sin ruido). Puro.
const PHASE_LINE: Record<string, string> = {
  needs_person: "✋ **Te toca decidir.** El escritor necesita a una persona; contesta aquí mismo.",
  ready: "✅ **Listo para mezclar.** CI, revisión y smoke en verde; mézclalo desde la tarjeta de arriba.",
  merged: "🎉 **Mezclado.** Los cambios ya están en la rama base.",
  failed: "⛔ **El pendiente falló.** El detalle está en la tarjeta.",
  stopped: "⏹️ **Pendiente detenido.**",
  done: "🏁 **Pendiente cerrado sin cambios.**",
};
export function phaseLine(prev: string | null, next: string | null): string | null {
  if (!next || prev === next) return null;
  return PHASE_LINE[next] ?? null;
}

/** El fence de la tarjeta del pendiente de gs en el hilo (la pinta `DevRunCard`). Puro. */
export const devRunFence = (runId: string) => "```gt-devrun\n" + JSON.stringify({ runId }) + "\n```";

function rowToThread(r: any): DevThread {
  return {
    runId: String(r.run_id),
    channelId: Number(r.channel_id),
    rootMsgId: Number(r.root_msg_id),
    requestedBy: r.requested_by ? String(r.requested_by) : null,
    convSeq: Number(r.conv_seq) || 0,
    eventSeq: Number(r.event_seq) || 0,
    phase: r.phase ? String(r.phase) : null,
    closed: Number(r.closed) === 1,
  };
}

export async function devThreadOf(channelId: number, rootMsgId: number): Promise<DevThread | null> {
  const [r] = await dbq("SELECT * FROM gt_dev_threads WHERE channel_id = ? AND root_msg_id = ?", [channelId, rootMsgId]).catch(() => []);
  return r ? rowToThread(r) : null;
}

export async function devThreadByRun(runId: string): Promise<DevThread | null> {
  const [r] = await dbq("SELECT * FROM gt_dev_threads WHERE run_id = ?", [runId]).catch(() => []);
  return r ? rowToThread(r) : null;
}

async function emailOf(sub: string): Promise<string | null> {
  const [r] = await dbq("SELECT email FROM gc_users WHERE sub = ?", [sub]).catch(() => []);
  return r?.email ? String(r.email).toLowerCase() : null;
}

async function postAs(channelId: number, rootMsgId: number, body: string, who: { handle: string; name: string; avatar?: string }) {
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { id } = await db.postAgent(channelId, rootMsgId, body, "msg", who.handle, who.name, "general", who.avatar ?? "");
  const msg = await db.getMessage(id);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), channelId), { t: "message:new", msg });
  return id;
}

/**
 * El pedido nace en gs. Devuelve el id del pendiente o el error de gs en palabras (sin repo conectado, sin agente…).
 * `rootMsgId` = el mensaje de la persona: el hilo del pedido cuelga de él.
 */
export async function startDevThread(a: {
  channelId: number;
  rootMsgId: number;
  sub: string;
  repo: string;
  title: string;
  goal?: string;
  criteria?: string[];
  issue?: number | null;
  threadUrl?: string | null;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const email = await emailOf(a.sub);
  if (!email) return { ok: false, error: "no encuentro tu correo en este espacio" };
  const args: Record<string, unknown> = { repo: a.repo, title: a.title.slice(0, 120) };
  if (a.goal) args.goal = a.goal.slice(0, 2000);
  if (a.criteria?.length) args.criteria = a.criteria.slice(0, 15);
  if (a.issue) args.issue = a.issue;
  if (a.threadUrl) args.askedIn = { url: a.threadUrl };
  const r = await devRunsCall("start", { email, args });
  const runId = r.data?.id ?? r.data?.run?.id ?? r.data?.result?.id;
  if (!r.ok || !runId) return { ok: false, error: String(r.data?.message ?? r.data?.error ?? `gs respondió ${r.status}`) };
  await dbq("INSERT OR IGNORE INTO gt_dev_threads (run_id, channel_id, root_msg_id, requested_by) VALUES (?, ?, ?, ?)", [String(runId), a.channelId, a.rootMsgId, a.sub]);
  await postAs(a.channelId, a.rootMsgId, devRunFence(String(runId)), { handle: "ghosty", name: "Ghosty" }).catch(() => null);
  return { ok: true, runId: String(runId) };
}

/** Lo que la persona escribe en el hilo, al escritor. gs decide por fase (steer, otra vuelta, cancelar automerge). */
export async function tellDevThread(t: DevThread, sub: string, text: string): Promise<{ ok: boolean; message?: string }> {
  const email = await emailOf(sub);
  if (!email) return { ok: false, message: "no encuentro tu correo en este espacio" };
  let r = await devRunsCall("tell", { id: t.runId, note: text.slice(0, 4000), email });
  // Mientras `tell` no esté en el gs desplegado, `resume` hace lo mismo para la nota.
  if (!r.ok && r.status === 400 && r.data?.error === "op") r = await devRunsCall("resume", { id: t.runId, note: text.slice(0, 4000), email });
  return r.ok ? { ok: true } : { ok: false, message: String(r.data?.message ?? r.data?.error ?? `gs respondió ${r.status}`) };
}

/** Los criterios de aceptación del plan de @plan: los renglones de lista bajo un encabezado de criterios. Puro. */
export function planCriteria(planMd: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of planMd.split("\n")) {
    const h = line.match(/^#+\s*(.+)$/) ?? line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (h) {
      inside = /criterio|listo cuando|aceptaci/i.test(h[1]);
      continue;
    }
    const item = inside && line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (item) out.push(item[1].trim());
  }
  return out.slice(0, 15);
}

/** ¿El mensaje del hilo es para el escritor? Sin menciones, o sólo a @ghosty. Si menciona a otro agente o persona, no. Puro. */
export function routesToWriter(mentions: string[]): boolean {
  return mentions.every((h) => h.toLowerCase() === "ghosty");
}

/** Un mensaje del escritor para el hilo (puro): sólo lo que el escritor le dice a la persona, recortado. */
export function writerMessages(messages: { seq: number; role: string; text: string }[]): { seq: number; text: string }[] {
  return messages
    .filter((m) => m.role === "assistant" && m.text && m.text.trim())
    .map((m) => ({ seq: m.seq, text: m.text.trim().slice(0, 6000) }));
}

/** Espeja un pendiente: lo que dijo el escritor y su cambio de fase. Nunca lanza. */
export async function syncDevThread(t: DevThread): Promise<void> {
  if (t.closed) return;
  const email = t.requestedBy ? await emailOf(t.requestedBy) : null;
  if (!email) return;
  const conv = await devRunsCall("conversation", { id: t.runId, after: t.convSeq, email });
  let convSeq = t.convSeq;
  if (conv.ok && Array.isArray(conv.data?.messages)) {
    for (const m of writerMessages(conv.data.messages)) {
      await postAs(t.channelId, t.rootMsgId, m.text, { handle: "ghosty", name: "Ghosty" }).catch(() => null);
    }
    for (const m of conv.data.messages) convSeq = Math.max(convSeq, Number(m.seq) || 0);
  }
  const st = await devRunsCall("status", { id: t.runId, after: t.eventSeq, email });
  let eventSeq = t.eventSeq;
  let phase = t.phase;
  if (st.ok) {
    for (const e of Array.isArray(st.data?.events) ? st.data.events : []) eventSeq = Math.max(eventSeq, Number(e.seq) || 0);
    const next = String(st.data?.phase ?? st.data?.run?.phase ?? "") || null;
    const line = phaseLine(phase, next);
    if (line) await postAs(t.channelId, t.rootMsgId, line, { handle: "ghosty", name: "Ghosty" }).catch(() => null);
    phase = next ?? phase;
  }
  if (convSeq !== t.convSeq || eventSeq !== t.eventSeq || phase !== t.phase) {
    await dbq("UPDATE gt_dev_threads SET conv_seq = ?, event_seq = ?, phase = ?, closed = ? WHERE run_id = ?", [convSeq, eventSeq, phase, isClosedPhase(phase) ? 1 : 0, t.runId]).catch(() => {});
    const { refreshRoom } = await import("./factory-runs.server");
    void refreshRoom(t.channelId);
  }
}

/** El barrido del tenant (lo llama `sweepTenant`): todos los pendientes ligados y vivos. */
export async function syncDevThreads(): Promise<void> {
  const rows = await dbq("SELECT * FROM gt_dev_threads WHERE closed = 0 ORDER BY created_at DESC LIMIT 50", []).catch(() => []);
  for (const r of rows) await syncDevThread(rowToThread(r)).catch((e) => console.warn(`[dev-threads] ${r.run_id}: ${(e as Error).message}`));
}
