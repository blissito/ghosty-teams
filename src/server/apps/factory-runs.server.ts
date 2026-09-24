// Corridas de la Software Factory: persistencia, estafeta y publicación en el hilo.
//
// La estafeta la pasa la PLATAFORMA: cuando un rol cierra su paso con su tool `factory_*`
// (o una persona firma el plan), aquí se cambia el estado y se despierta al rol siguiente
// con `enqueueWakeup` en el hilo del pedido. Ningún agente decide a quién le toca: así el
// plan no se construye sin firma y @check no se salta.
import { dbq } from "../../dbq.server";
import { nextStatus, stageLabel, type RunEvent, type RunStatus } from "./factory-flow";

export type Run = {
  id: number;
  channelId: number;
  rootMsgId: number;
  topic: string;
  title: string;
  status: RunStatus;
  planVersion: number;
  loops: number;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  headSha: string | null;
  taskRef: string | null;
  requestedBy: string;
  /** Quien firmó el plan vigente; @build trabaja con sus credenciales. */
  approvedBy: string | null;
};

const toRun = (r: Record<string, any>): Run => ({
  id: Number(r.id),
  channelId: Number(r.channel_id),
  rootMsgId: Number(r.root_msg_id),
  topic: String(r.topic ?? "general"),
  title: String(r.title),
  status: r.status as RunStatus,
  planVersion: Number(r.plan_version ?? 0),
  loops: Number(r.loops ?? 0),
  repo: r.repo ?? null,
  branch: r.branch ?? null,
  prUrl: r.pr_url ?? null,
  headSha: r.head_sha ?? null,
  taskRef: r.task_ref ?? null,
  requestedBy: String(r.requested_by),
  approvedBy: r.approved_by ?? null,
});

export async function getRun(id: number): Promise<Run | null> {
  const rows = await dbq("SELECT * FROM gt_factory_runs WHERE id = ?", [id]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function runOfThread(channelId: number, rootMsgId: number): Promise<Run | null> {
  const rows = await dbq("SELECT * FROM gt_factory_runs WHERE channel_id = ? AND root_msg_id = ?", [channelId, rootMsgId]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function getPlan(runId: number, version: number) {
  const rows = await dbq("SELECT * FROM gt_factory_plans WHERE run_id = ? AND version = ?", [runId, version]);
  const r = rows[0];
  return r
    ? {
        runId,
        version,
        planMd: String(r.plan_md),
        msgId: r.msg_id != null ? Number(r.msg_id) : null,
        decision: (r.decision ?? null) as "approve" | "changes" | null,
        decidedBy: (r.decided_by ?? null) as string | null,
        note: (r.note ?? null) as string | null,
      }
    : null;
}

/**
 * Aplica un evento: valida la transición y guarda. Lanza con un mensaje para el agente o
 * la persona si el evento no aplica (p.ej. construir sin firma).
 */
export async function applyEvent(run: Run, event: RunEvent, patch: Partial<Record<string, unknown>> = {}): Promise<Run> {
  const next = nextStatus(run.status, event, run.loops);
  if (!next) throw new Error(`el pedido #${run.id} está en «${stageLabel(run.status)}»: no se puede ${event} ahora`);
  const cols = Object.keys(patch);
  const sets = ["status = ?", "updated_at = unixepoch()", ...cols.map((c) => `${c} = ?`)];
  // Guarda contra carreras (dos firmas a la vez): sólo si sigue en el estado leído.
  // Guarda también la VERSIÓN del plan: una firma de v1 que llega mientras @plan sube v2
  // pasaría el filtro de estado (plan_review → plan_review) y aprobaría un plan que ya no es.
  const rows = await dbq(
    `UPDATE gt_factory_runs SET ${sets.join(", ")} WHERE id = ? AND status = ? AND plan_version = ? RETURNING *`,
    [next, ...cols.map((c) => patch[c] as never), run.id, run.status, run.planVersion],
  );
  if (!rows[0]) throw new Error(`el pedido #${run.id} cambió mientras tanto; vuelve a mirarla`);
  const updated = toRun(rows[0]);
  void syncTask(updated).catch(() => {});
  void refreshRoom(updated.channelId);
  return updated;
}

// ── Publicar en el hilo ──────────────────────────────────────────────────────

async function agentIdentity(handle: string) {
  const { resolvedAgents } = await import("../../agents.server");
  const a = (await resolvedAgents()).find((x) => x.handle === handle);
  return { handle, name: a?.name ?? handle, avatar: a?.avatar ?? "" };
}

/** Publica en el hilo del pedido con la cara de un rol. `postAgent`: no despierta a nadie. */
export async function postInThread(run: Run, handle: string, body: string): Promise<number | null> {
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const who = await agentIdentity(handle);
    const { id } = await db.postAgent(run.channelId, run.rootMsgId, body, "msg", who.handle, who.name, run.topic, who.avatar);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(await currentNamespace(), run.channelId), { t: "message:new", msg });
    return id;
  } catch (e) {
    console.error("[factory] no pude publicar en el hilo", e);
    return null;
  }
}

/** El fence de la tarjeta de plan. La tarjeta lee estado y texto al pintar. */
export const planCardFence = (runId: number, version: number) =>
  "```gt-plan\n" + JSON.stringify({ runId, version }) + "\n```";

// ── La estafeta ──────────────────────────────────────────────────────────────

/**
 * Despierta al rol siguiente en el hilo del pedido. `sub` = de quién son las credenciales
 * del turno (su GitHub): quien firmó, o quien pidió.
 */
export async function handoff(run: Run, to: "plan" | "build" | "check", sub: string, cause: string, text: string, origin: string): Promise<boolean> {
  const { resolvedAgents, agentGroupId } = await import("../../agents.server");
  const agent = (await resolvedAgents()).find((a) => a.handle === to);
  if (!agent) {
    await postInThread(run, "plan", `⚠️ No encuentro a @${to} en este espacio: la fábrica está desinstalada o su handle cambió.`);
    return false;
  }
  const { currentNamespace } = await import("../tenant.server");
  const ns = await currentNamespace();
  // Una conversación por corrida y rol: el contexto viaja en el encargo, y @check no hereda
  // lo que @build pensó.
  const groupId = await agentGroupId(agent, `factory-${run.id}`);
  const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../wakeups.server");
  const ok = await enqueueWakeup({
    key: `factory:${run.id}:${to}:${Date.now()}`,
    ref: mintWakeRef({
      sub,
      ns,
      groupId,
      dest: { channelId: run.channelId, parentId: run.rootMsgId, topic: run.topic, handle: agent.handle, name: agent.name, avatar: agent.avatar },
    }),
    cause,
    text: `[Pedido #${run.id} · «${run.title}»${run.repo ? ` · repo ${run.repo}` : ""}]\n${text}`,
    origin,
    dueAt: Math.floor(Date.now() / 1000) + 2,
  });
  if (ok) armWakeups(ns);
  return ok;
}

// ── Tasks (best-effort: la corrida no depende del tablero) ───────────────────

async function tasksCall(sub: string, name: string, args: Record<string, unknown>) {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ boardId?: number | null }>("factory");
  if (!cfg?.boardId) return null;
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug();
  if (!slug) return null;
  const { callTasks } = await import("../tasks-bridge.server");
  const r = await callTasks(slug, sub, cfg.boardId, name, args);
  return r.ok ? (r.result as Record<string, any>) : null;
}

export async function createTaskFor(run: Run, planMd: string): Promise<void> {
  // La corrida nació de una tarea de Tasks (asignada a @plan): ya tiene la suya.
  if (run.taskRef) return;
  const r = await tasksCall(run.requestedBy, "task_create", {
    title: run.title,
    description: planMd.slice(0, 8000),
    labels: [stageLabel(run.status)],
  }).catch(() => null);
  const ref = r ? String(r.ref ?? r.id ?? "") : "";
  if (ref) await dbq("UPDATE gt_factory_runs SET task_ref = ? WHERE id = ?", [ref, run.id]);
}

async function syncTask(run: Run): Promise<void> {
  if (!run.taskRef) return;
  // `set_labels` de Tasks es add/remove: la etapa nueva entra y las demás salen.
  const all: RunStatus[] = ["planning", "plan_review", "building", "checking", "pr_review", "escalated", "done", "cancelled"];
  const now = stageLabel(run.status);
  await tasksCall(run.requestedBy, "task_labels", {
    id: run.taskRef,
    add: [now],
    remove: all.map(stageLabel).filter((l) => l !== now),
  });
  if (run.status === "building") await tasksCall(run.requestedBy, "task_move", { id: run.taskRef, column: "In Progress" });
  if (run.status === "done" || run.status === "cancelled")
    await tasksCall(run.requestedBy, "task_move", { id: run.taskRef, column: "Done" });
}

export async function linkPrToTask(run: Run, url: string): Promise<void> {
  if (!run.taskRef) return;
  await tasksCall(run.requestedBy, "task_link", { id: run.taskRef, url, title: `PR · ${run.title}` }).catch(() => null);
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = String(url ?? "").match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** La cabeza del PR y si es borrador. null si GitHub no contesta. */
export async function prHead(sub: string, url: string): Promise<{ sha: string; draft: boolean } | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_get_pr");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error || !r.headSha) return null;
    return { sha: String(r.headSha), draft: !!r.draft };
  } catch {
    return null;
  }
}

/** Saca el PR de borrador con las credenciales de `sub`. true si quedó listo (o ya lo estaba). */
export async function markPrReady(sub: string, url: string): Promise<boolean> {
  const pr = parsePrUrl(url);
  if (!pr) return false;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_mark_ready");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    return !!r && !r.error && (r.alreadyReady === true || r.draft === false);
  } catch {
    return false;
  }
}

// ── La firma humana (botón de la tarjeta o respuesta en el hilo) ─────────────

/**
 * Aprobar o pedir cambios sobre la versión vigente del plan. `sub` firma: sus credenciales
 * (GitHub) son con las que @build trabaja después. Sólo aplica a la ÚLTIMA versión: firmar
 * una tarjeta vieja sería aprobar un plan que ya no existe.
 */
export async function decide(opts: {
  run: Run;
  version: number;
  decision: "approve" | "changes";
  note?: string;
  sub: string;
  who: string;
  origin: string;
}): Promise<Run> {
  const { run, version, decision, sub, who } = opts;
  if (version !== run.planVersion) throw new Error(`ese es el plan v${version}; el vigente es v${run.planVersion}`);
  const note = (opts.note ?? "").trim().slice(0, 2000);
  if (decision === "changes" && !note) throw new Error("di qué cambiar");
  // Replanear reinicia las vueltas de check (si no, un plan nuevo tras escalar volvía a
  // escalar al primer hallazgo). Aprobar deja registrado con qué credenciales se construye.
  const next = await applyEvent(
    run,
    decision === "approve" ? "approve" : "changes",
    decision === "approve" ? (run.status === "escalated" ? { approved_by: sub } : { approved_by: sub, loops: 0 }) : { loops: 0 },
  );
  await dbq("UPDATE gt_factory_plans SET decision = ?, decided_by = ?, note = ? WHERE run_id = ? AND version = ?", [
    decision,
    who,
    note || null,
    run.id,
    version,
  ]);
  const plan = await getPlan(run.id, version);
  if (decision === "approve") {
    // Desde `escalated` también se aprueba («otra vuelta»): el encargo lo dice.
    const again = run.status === "escalated";
    await handoff(
      next,
      "build",
      sub,
      again ? "otra vuelta tras escalar" : "construir el plan aprobado",
      (again
        ? `${who} pidió otra vuelta. Revisa los últimos hallazgos de @check en este hilo, corrige en la misma rama y cierra con factory_build_done.`
        : `${who} aprobó el plan v${version}. Constrúyelo: rama nueva, código, pruebas, PR en BORRADOR, y cierra con factory_build_done.`) +
        `\n\n## Plan aprobado (v${version})\n${plan?.planMd ?? ""}`,
      opts.origin,
    );
  } else {
    await handoff(
      next,
      "plan",
      sub,
      "rehacer el plan",
      `${who} pidió cambios al plan v${version}: «${note}». Ajusta el plan (no discutas lo decidido) y entrégalo otra vez con factory_plan_submit.\n\n## Plan v${version}\n${plan?.planMd ?? ""}`,
      opts.origin,
    );
  }
  return next;
}

/**
 * Firma escrita en el hilo: «✅», «aprobado», «cambios: …». Sólo aplica si el hilo tiene una
 * corrida esperando firma; lo demás es conversación normal y no se toca. Nunca lanza.
 */
export async function maybeThreadDecision(opts: {
  channelId: number;
  rootId: number;
  text: string;
  sub: string;
  who: string;
  origin: string;
}): Promise<boolean> {
  try {
    const { isInstalled } = await import("./installed.server");
    if (!(await isInstalled("factory"))) return false;
    const { parseThreadDecision } = await import("./factory-flow");
    const d = parseThreadDecision(opts.text);
    if (!d) return false;
    const run = await runOfThread(opts.channelId, opts.rootId);
    if (!run || (run.status !== "plan_review" && run.status !== "escalated")) return false;
    await decide({
      run,
      version: run.planVersion,
      decision: d.decision,
      note: d.decision === "changes" ? d.note : undefined,
      sub: opts.sub,
      who: opts.who,
      origin: opts.origin,
    });
    return true;
  } catch (e) {
    console.error("[factory] firma en el hilo", e);
    return false;
  }
}

// ── Arranque desde Tasks: una tarea asignada a @plan ─────────────────────────

/**
 * Abre una corrida a partir de una tarea de Tasks asignada a `@plan`: publica el pedido en el
 * room de la fábrica (con la cara de @plan) y lo despierta en ese hilo. La tarea YA existe:
 * la corrida guarda su `task_ref` y no se crea otra (`createTaskFor` la respeta).
 *
 * Idempotente por `task_ref`: reasignar la misma tarea con una corrida viva no abre otra.
 */
export async function startRunFromTask(opts: {
  taskRef: string;
  title: string;
  description: string;
  requestedBy: string;
  origin: string;
}): Promise<{ runId: number; existing: boolean } | { error: string }> {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ roomId?: number }>("factory");
  if (!cfg?.roomId) return { error: "la Software Factory no está instalada en este espacio" };
  const alive = await dbq(
    `SELECT id FROM gt_factory_runs WHERE task_ref = ? AND status NOT IN ('done','cancelled') ORDER BY id DESC LIMIT 1`,
    [opts.taskRef],
  );
  if (alive[0]) return { runId: Number(alive[0].id), existing: true };

  const title = opts.title.trim().slice(0, 120) || `Tarea ${opts.taskRef}`;
  const db = await import("../../db.server");
  const repos = (await db.listRoomRepos(cfg.roomId)).map((r) => r.repo);
  // El mensaje raíz del pedido, en el room de la fábrica y con la cara de @plan: todo lo de la
  // corrida (tarjeta de plan, firmas, PR) cuelga de este hilo.
  const who = await agentIdentity("plan");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const body =
    `📋 **Tarea #${opts.taskRef} asignada a @plan desde Tasks:** ${title}` +
    (opts.description.trim() ? `\n\n${opts.description.trim().slice(0, 1500)}` : "");
  const { id: rootId } = await db.postAgent(cfg.roomId, null, body, "msg", who.handle, who.name, "general", who.avatar);
  const msg = await db.getMessage(rootId);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), cfg.roomId), { t: "message:new", msg });

  const rows = await dbq(
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, task_ref, requested_by)
     VALUES (?, ?, 'general', ?, 'planning', ?, ?, ?) RETURNING id`,
    [cfg.roomId, rootId, title, repos.length === 1 ? repos[0] : null, opts.taskRef, opts.requestedBy],
  );
  const run = (await getRun(Number(rows[0].id)))!;
  await ensureRunCard(run);
  await handoff(
    run,
    "plan",
    opts.requestedBy,
    "tarea asignada desde Tasks",
    `Te asignaron la tarea #${opts.taskRef} en Tasks. Es el pedido:\n\n**${title}**\n${opts.description.trim().slice(0, 4000)}\n\n` +
      `Lee el repo y entrega el plan con factory_plan_submit (runId ${run.id}). La tarea ya existe en el tablero: no crees otra.`,
    opts.origin,
  );
  return { runId: run.id, existing: false };
}

// ── La tarjeta viva de la corrida (top-level en el room) ─────────────────────

/** Avisa al room que algo de una corrida cambió: la tarjeta viva y la de plan se releen. */
export async function refreshRoom(channelId: number): Promise<void> {
  try {
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    bus.publish(bus.ch.room(await currentNamespace(), channelId), { t: "refresh", channelId, parentId: null, dmId: null } as never);
  } catch {
    /* sin bus, la tarjeta se actualiza al recargar */
  }
}

/**
 * Publica UNA vez la tarjeta viva de la corrida en el room (top-level, con la cara de @plan).
 * Dice en qué etapa va y deja firmar ahí mismo; el detalle vive en el hilo del pedido. Nunca
 * lanza: sin tarjeta, la corrida funciona igual.
 */
export async function ensureRunCard(run: Run): Promise<void> {
  try {
    const rows = await dbq("SELECT card_msg_id FROM gt_factory_runs WHERE id = ?", [run.id]);
    if (rows[0]?.card_msg_id) return;
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const who = await agentIdentity("plan");
    const body = "```gt-run\n" + JSON.stringify({ runId: run.id }) + "\n```";
    const { id } = await db.postAgent(run.channelId, null, body, "msg", who.handle, who.name, run.topic, who.avatar);
    await dbq("UPDATE gt_factory_runs SET card_msg_id = ? WHERE id = ? AND card_msg_id IS NULL", [id, run.id]);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(await currentNamespace(), run.channelId), { t: "message:new", msg });
  } catch (e) {
    console.error("[factory] no pude publicar la tarjeta viva", e);
  }
}

/**
 * Estado del CI del PR (Actions y statuses externos: Vercel, CircleCI…), con la misma tool
 * que usa el agente. `none` = el repo no tiene CI (NO es verde). null si GitHub no contesta.
 */
export async function prCi(sub: string, url: string): Promise<{ state: string; failed: string[] } | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_pr_checks");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error) return null;
    const failed = Array.isArray(r.failed) ? r.failed.map((f: any) => String(f?.name ?? f)).slice(0, 5) : [];
    return { state: String(r.state ?? "none"), failed };
  } catch {
    return null;
  }
}

// ── Rol que termina sin cerrar su paso ───────────────────────────────────────

/** En qué estado se queda la corrida mientras el rol no cierra su paso. */
const OPEN_STATUS: Record<string, RunStatus> = { plan: "planning", build: "building", check: "checking" };
const CLOSE_TOOL: Record<string, string> = { plan: "factory_plan_submit", build: "factory_build_done", check: "factory_check_verdict" };

/**
 * Llamado al terminar un turno de la estafeta (`factory:<run>:<rol>:…`). Si la corrida
 * sigue en el estado de ese rol, el rol no cerró su paso: se le da UN empujón (mismo hilo,
 * misma conversación) y, si tampoco cierra, se avisa en el hilo a quien pidió.
 */
export async function afterFactoryTurn(
  w: { key: string; ref: string; origin: string },
  ref: { sub: string },
  reply = "",
): Promise<void> {
  const m = /^factory:(\d+):(plan|build|check):/.exec(w.key);
  if (!m) return;
  const run = await getRun(Number(m[1]));
  const role = m[2];
  if (!run || run.status !== OPEN_STATUS[role]) return; // cerró su paso (o el pedido siguió)
  // El turno SE CAYÓ (vacío o cortado): empujar no sirve, el agente no está contestando.
  // Se dice una vez qué pasa y dónde revisarlo (su motor, modelo o llave en Studio).
  if (!reply.trim() || /se cort[óo] antes de terminar/i.test(reply)) {
    if (w.key.endsWith(":nudge")) return; // ya se avisó en el intento anterior
    await postInThread(
      run,
      role,
      `⚠️ @${role} no pudo contestar (su turno se cortó). Revisa su agente en Studio (motor, modelo o llave) ` +
        `o asígnale otro en Ajustes → Apps, y vuelve a mencionarlo.`,
    );
    return;
  }
  const nudged = w.key.endsWith(":nudge");
  if (!nudged) {
    const { enqueueWakeup, armWakeups } = await import("../wakeups.server");
    const { currentNamespace } = await import("../tenant.server");
    await enqueueWakeup({
      key: `factory:${run.id}:${role}:${Date.now()}:nudge`,
      ref: w.ref,
      cause: "cerrar el paso",
      text:
        `[Pedido #${run.id}] Terminaste tu turno sin cerrar tu paso y el pedido está detenido. ` +
        `Si ya acabaste, ciérralo AHORA con ${CLOSE_TOOL[role]} (runId ${run.id}). ` +
        `Si no puedes terminar, dilo en una línea con el motivo concreto.`,
      origin: w.origin,
      dueAt: Math.floor(Date.now() / 1000) + 5,
    });
    armWakeups(await currentNamespace());
    return;
  }
  // Ya se le empujó una vez: que lo vea una persona.
  const requester = await dbq("SELECT handle FROM gc_users WHERE sub = ?", [run.requestedBy]).catch(() => []);
  const who = requester[0]?.handle ? `@${requester[0].handle} ` : "";
  await postInThread(
    run,
    role,
    `⚠️ ${who}@${role} terminó dos veces sin cerrar su paso y el pedido #${run.id} está detenido. ` +
      `Revisa su último mensaje en este hilo y dile qué hacer (o menciónalo para que retome).`,
  );
  void refreshRoom(run.channelId);
  void ref;
}

// ── Cierre solo: el PR se mezcló (o se cerró) ────────────────────────────────

/** Estado del PR en GitHub: mezclado, cerrado sin mezclar o abierto. null si no contesta. */
async function prOutcome(sub: string, url: string): Promise<"merged" | "closed" | "open" | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_get_pr");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error) return null;
    if (r.merged) return "merged";
    return String(r.state ?? "").toLowerCase() === "closed" ? "closed" : "open";
  } catch {
    return null;
  }
}

const lastPrCheck = new Map<number, number>();
const PR_CHECK_EVERY_MS = 120_000;

/**
 * Los pedidos en etapa PR se cierran SOLOS cuando su PR se mezcla (o se cancelan si se
 * cierra sin mezclar), con un mensaje al final del hilo: así nadie tiene que adivinar si
 * la fábrica sigue trabajando. Lo llama el tick de `factory-schedules.server.ts`.
 */
export async function closeFinishedRuns(): Promise<void> {
  const rows = await dbq(
    `SELECT * FROM gt_factory_runs WHERE status = 'pr_review' AND pr_url IS NOT NULL ORDER BY updated_at LIMIT 10`,
    [],
  ).catch(() => []);
  for (const row of rows) {
    const run = toRun(row);
    const last = lastPrCheck.get(run.id) ?? 0;
    if (Date.now() - last < PR_CHECK_EVERY_MS) continue;
    lastPrCheck.set(run.id, Date.now());
    const outcome = await prOutcome(run.approvedBy ?? run.requestedBy, run.prUrl!);
    if (outcome === "merged") {
      const done = await applyEvent(run, "close").catch(() => null);
      if (done) await postInThread(done, "check", `✅ **Pedido terminado:** el PR se mezcló. ${run.prUrl}`);
    } else if (outcome === "closed") {
      const gone = await applyEvent(run, "cancel").catch(() => null);
      if (gone) await postInThread(gone, "check", `⏹️ El PR se cerró sin mezclar: pedido cancelado. ${run.prUrl}`);
    }
  }
}
