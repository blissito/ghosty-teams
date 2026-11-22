// El hilo de un pedido en un room = la VISTA de la conversación `dev:<id>` de gs (una sola fábrica, 22-nov).
// Teams guarda sólo el mapeo hilo ↔ pendiente y dos cursores; el estado, las fases, el merge y a quién le toca los
// decide gs. Tres movimientos:
//   · `startDevThread`: el pedido nace en gs (`op:start`) y el hilo queda ligado.
//   · `tellDevThread`: lo que la persona escribe en el hilo le llega al escritor (`op:tell`), sin despertar roles.
//   · `syncDevThreads`: el barrido adopta los pendientes vivos que aún no tienen tarjeta. NO copia mensajes: la tarjeta
//     lee la conversación de gs en vivo (gs es la única fuente).
import { dbq } from "../../dbq.server";
import { devRunsCall } from "./dev-engine.server";

export type DevThread = {
  runId: string;
  channelId: number;
  rootMsgId: number;
  requestedBy: string | null;
};

/** El fence de la tarjeta del pendiente de gs en el hilo (la pinta `DevRunCard`). Puro. */
export const devRunFence = (runId: string) => "```gt-devrun\n" + JSON.stringify({ runId }) + "\n```";

function rowToThread(r: any): DevThread {
  return {
    runId: String(r.run_id),
    channelId: Number(r.channel_id),
    rootMsgId: Number(r.root_msg_id),
    requestedBy: r.requested_by ? String(r.requested_by) : null,
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

// Las caras de la fábrica (avatares 3D): lo que dice el escritor sale como @build (Worker); la cabeza del pedido y los
// avisos de fase, como @plan (Arqui). Antes salía «Ghosty» sin avatar y rompía la imagen de la fábrica.
type Face = "writer" | "platform";
async function faceOf(face: Face): Promise<{ handle: string; name: string; avatar: string }> {
  const handle = face === "writer" ? "build" : "plan";
  const { resolvedAgents } = await import("../../agents.server");
  const { ROLE_NAMES, roleAvatar } = await import("./factory-roles");
  const a = (await resolvedAgents().catch(() => [])).find((x) => x.handle === handle);
  return { handle, name: a?.name ?? ROLE_NAMES[handle], avatar: a?.avatar || roleAvatar(handle) };
}

async function postAs(channelId: number, rootMsgId: number | null, body: string, face: Face) {
  const who = await faceOf(face);
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { id } = await db.postAgent(channelId, rootMsgId, body, "msg", who.handle, who.name, "general", who.avatar);
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
  await postAs(a.channelId, a.rootMsgId, devRunFence(String(runId)), "platform").catch(() => null);
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

/** ¿El mensaje del hilo es para el escritor? Sólo si menciona a @ghosty y a nadie más: en el hilo también platica el
 *  equipo y eso no debe distraer al escritor (sin @ no le llega). Puro. */
export function routesToWriter(mentions: string[]): boolean {
  return mentions.length > 0 && mentions.every((h) => h.toLowerCase() === "ghosty");
}

/** Un mensaje del escritor para el hilo (puro): sólo lo que el escritor le dice a la persona, recortado. */
export function writerMessages(messages: { seq: number; role: string; text: string }[]): { seq: number; text: string }[] {
  return messages
    .filter((m) => m.role === "assistant" && m.text && m.text.trim())
    .map((m) => ({ seq: m.seq, text: m.text.trim().slice(0, 6000) }));
}

/** El primer mensaje del hilo de un pendiente que nació fuera del room (gs, la app, la terminal). Puro. */
export function adoptedRootText(run: { issue?: number | null; title?: string | null; repo?: string | null }): string {
  const n = run.issue ? ` #${run.issue}` : "";
  return `🛠️ **Pendiente${n}** · ${String(run.title ?? "").trim() || "sin título"} — ${run.repo ?? ""}`.trim();
}

/** El room que espeja un repo (sin distinguir mayúsculas). Puro. */
export function roomForRepo(rooms: { channel_id: number; repo: string; connected_by: string }[], repo: string) {
  const r = repo.toLowerCase();
  return rooms.find((x) => String(x.repo).toLowerCase() === r) ?? null;
}

/**
 * Una sola fuente de verdad (22-nov): TODO pendiente vivo de un repo conectado a un room tiene su hilo ahí, nazca donde
 * nazca. Los que aún no lo tienen se adoptan: mensaje en el room, tarjeta en su hilo y el espejo desde el principio.
 */
export async function adoptLiveRuns(): Promise<void> {
  const { devEngineOf } = await import("./dev-engine.server");
  if ((await devEngineOf()) !== "unified") return;
  const rooms = (await dbq("SELECT channel_id, repo, connected_by FROM gt_room_repos ORDER BY id", []).catch(() => [])) as {
    channel_id: number;
    repo: string;
    connected_by: string;
  }[];
  if (!rooms.length) return;
  let email: string | null = null;
  for (const r of rooms) if ((email = await emailOf(r.connected_by))) break;
  if (!email) return;
  const live = await devRunsCall("live", { email });
  if (!live.ok || !Array.isArray(live.data?.runs)) return;
  for (const run of live.data.runs) {
    const runId = String(run.id ?? "");
    if (!runId || !run.repo || (await devThreadByRun(runId))) continue;
    const room = roomForRepo(rooms, String(run.repo));
    if (!room) continue;
    // UN solo mensaje en el room: la tarjeta. La conversación la lee la tarjeta de gs; Teams no la copia.
    const root = await postAs(room.channel_id, null, devRunFence(runId), "platform").catch(() => null);
    if (!root) continue;
    await dbq("INSERT OR IGNORE INTO gt_dev_threads (run_id, channel_id, root_msg_id, requested_by) VALUES (?, ?, ?, ?)", [runId, room.channel_id, root, room.connected_by]);
  }
}

/**
 * Limpieza (22-nov): el primer puente copiaba al hilo los mensajes del escritor y la cabeza era texto. gs es la única fuente:
 * en el room queda SÓLO la tarjeta. Borra las respuestas que publicó el puente en los hilos adoptados y deja la raíz como
 * la tarjeta. Idempotente (no encuentra nada en la segunda vuelta).
 */
async function cleanupCopiedMirror(): Promise<void> {
  const roots = await dbq(
    "SELECT t.run_id, t.channel_id, t.root_msg_id FROM gt_dev_threads t JOIN gc_messages m ON m.id = t.root_msg_id WHERE m.sender_sub IS NULL AND m.body LIKE '🛠️ **Pendiente%'",
    [],
  ).catch(() => []);
  for (const r of roots) {
    await dbq("DELETE FROM gc_messages WHERE parent_id = ? AND channel_id = ? AND sender_sub IS NULL", [r.root_msg_id, r.channel_id]).catch(() => {});
    await dbq("UPDATE gc_messages SET body = ? WHERE id = ?", [devRunFence(String(r.run_id)), r.root_msg_id]).catch(() => {});
    const { refreshRoom } = await import("./factory-runs.server");
    void refreshRoom(Number(r.channel_id));
  }
}

/** Aviso corto de la plataforma en el hilo de un pendiente (con la cara de Arqui). */
export async function postDevNote(channelId: number, rootMsgId: number, text: string): Promise<void> {
  await postAs(channelId, rootMsgId, text, "platform").catch(() => null);
}

/** El barrido del tenant (lo llama `sweepTenant`): sólo adopta pendientes sin tarjeta. NO espeja: gs es la única fuente. */
export async function syncDevThreads(): Promise<void> {
  await cleanupCopiedMirror().catch(() => {});
  await adoptLiveRuns().catch((e) => console.warn(`[dev-threads] adoptar: ${(e as Error).message}`));
}
