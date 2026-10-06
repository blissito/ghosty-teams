// Corridas de la Software Factory: persistencia, estafeta y publicación en el hilo.
//
// La estafeta la pasa la PLATAFORMA: cuando un rol cierra su paso con su tool `factory_*`
// (o una persona firma el plan), aquí se cambia el estado y se despierta al rol siguiente
// con `enqueueWakeup` en el hilo del pedido. Ningún agente decide a quién le toca: así el
// plan no se construye sin firma y @check no se salta.
import { dbq } from "../../dbq.server";
import { nextStatus, stageLabel, type RunEvent, type RunStatus } from "./factory-flow";
import { classifyPrRisk, type PrFile } from "./factory-risk";

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
  /** La cabeza del PR que @check revisó en su último veredicto (ver `countsLoop`). */
  checkedSha?: string | null;
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
  checkedSha: r.checked_sha ?? null,
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
        /** Crítico del plan: pending | pass | fail | timeout, o null si no pasó por él. */
        critique: (r.critique ?? null) as string | null,
        critiqueNotes: (r.critique_notes ?? null) as string | null,
      }
    : null;
}

/**
 * Aplica un evento: valida la transición y guarda. Lanza con un mensaje para el agente o
 * la persona si el evento no aplica (p.ej. construir sin firma).
 */
export async function applyEvent(
  run: Run,
  event: RunEvent,
  patch: Partial<Record<string, unknown>> = {},
  /** Para la bitácora: quién (persona o @rol) y el dato que explica la transición. */
  meta: { actor?: string | null; data?: Record<string, unknown> } = {},
): Promise<Run> {
  // `check_fail` llega con las vueltas YA decididas (`countsLoop`): `nextStatus` suma una a lo
  // que recibe, así que se le pasa lo de antes de esa suma. Sin vuelta contada, no escala.
  const loopsBefore = event === "check_fail" && typeof patch.loops === "number" ? patch.loops - 1 : run.loops;
  const next = nextStatus(run.status, event, loopsBefore);
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
  void logEvent(updated.id, event, meta.actor ?? null, { from: run.status, to: next, ...meta.data });
  void notifyRunTurn(updated, run.status);
  // Pedido de un sprint que llega a PR, merge o se cancela: puede destrabar el siguiente ticket.
  if (updated.status === "done" || updated.status === "cancelled" || updated.status === "pr_review")
    void import("./sprint.server").then((S) => S.onSprintRunChanged(updated.id)).catch(() => {});
  // Pedido terminado o cancelado: su preview (si es nuestra caja) ya no sirve.
  if ((updated.status === "done" || updated.status === "cancelled") && updated.prUrl) {
    const pr = parsePrUrl(updated.prUrl);
    if (pr) void import("./preview.server").then((P) => P.gsPreview("down", { repo: pr.repo, pr: pr.number })).catch(() => {});
    // Y se olvida la liga: @plan la leía del pedido cerrado y la daba como «lista» (MailMask #11, 5-oct).
    void dbq("UPDATE gt_factory_runs SET preview_state = NULL, preview_url = NULL WHERE id = ?", [updated.id]).catch(() => {});
  }
  void syncRunTask(updated, run.status).catch(() => {});
  void refreshRoom(updated.channelId);
  return updated;
}

// ── La tarjeta de Tasks sigue al pedido ──────────────────────────────────────
// `task_ref` existía y nadie lo leía: la única vía a Done era el botón «Merge» de la tarjeta
// de PR (`cierraTareaDelPr`), así que un PR mezclado en GitHub o un pedido en construcción
// dejaban el tablero mintiendo (palmera-legal, 3-oct: SEO en To Do con su PR en revisión).
// Columnas por NOMBRE (cada proyecto nombra las suyas): la primera que exista gana.
const TASK_COLUMNS: Partial<Record<RunStatus, string[]>> = {
  building: ["In Progress", "Doing", "En curso", "En progreso"],
  pr_review: ["QA/Review", "Review", "In Review", "En revisión", "Revisión"],
  done: ["Done", "Hecho", "Terminado"],
};

/** La tarea del pedido: `task_ref` (id numérico) o, si no hay, la que tenga ligado su PR. */
async function runTaskId(run: Run): Promise<number | null> {
  const ref = Number(String(run.taskRef ?? "").replace(/^#/, ""));
  if (Number.isInteger(ref) && ref > 0) return ref;
  if (!run.prUrl) return null;
  const rows = await dbq("SELECT task_id FROM task_links WHERE LOWER(url) = LOWER(?) LIMIT 1", [run.prUrl]).catch(() => []);
  const id = Number(rows[0]?.task_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Mueve la tarjeta del pedido a la columna de su etapa (y liga el PR al llegar a revisión).
 * Va por el puente de Tasks, como `cierraTareaDelPr`: publica en el bus, deja bitácora y
 * comprueba permisos. Best-effort: un tablero sin esa columna o sin Tasks no pasa nada.
 */
export async function syncRunTask(run: Run, prevStatus: string): Promise<void> {
  if (run.status === prevStatus) return;
  const wanted = TASK_COLUMNS[run.status];
  if (!wanted) return;
  const taskId = await runTaskId(run);
  if (!taskId) return;
  const [task] = await dbq("SELECT project_id FROM task_tasks WHERE id = ?", [taskId]).catch(() => []);
  const projectId = Number(task?.project_id);
  if (!Number.isInteger(projectId)) return;
  const sub = run.approvedBy ?? run.requestedBy;
  if (run.status === "pr_review" && run.prUrl) {
    const ya = await dbq("SELECT 1 FROM task_links WHERE task_id = ? AND LOWER(url) = LOWER(?)", [taskId, run.prUrl]).catch(() => []);
    const pr = parsePrUrl(run.prUrl);
    if (!ya.length)
      await dbq("INSERT INTO task_links (task_id, kind, url, ref, title, state, created_by) VALUES (?, 'pr', ?, ?, ?, 'open', ?)", [
        taskId, run.prUrl, pr ? `#${pr.number}` : null, run.title ?? null, sub,
      ]).catch(() => {});
  }
  const cols = (await dbq("SELECT name FROM task_columns WHERE project_id = ?", [projectId]).catch(() => [])).map((c) => String(c.name));
  const column = wanted.map((w) => cols.find((c) => c.toLowerCase() === w.toLowerCase())).find(Boolean);
  if (!column) return;
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug();
  if (!slug || !sub) return;
  const { callTasks } = await import("../tasks-bridge.server");
  await callTasks(slug, sub, projectId, "task_move", { id: taskId, column });
}

// ── Bitácora y avisos ────────────────────────────────────────────────────────

/** Un renglón INMUTABLE de la bitácora del pedido. Best-effort: nunca tumba la transición. */
export async function logEvent(runId: number, type: string, actor: string | null = null, data: Record<string, unknown> | null = null): Promise<void> {
  await dbq("INSERT INTO gt_factory_events (run_id, actor, type, data_json) VALUES (?, ?, ?, ?)", [
    runId,
    actor,
    type,
    data ? JSON.stringify(data) : null,
  ]).catch((e) => console.error("[factory] bitácora", e));
}

/** ¿El último `check_fail` del pedido fue una vuelta NO contada? (bitácora, `counted: false`) */
export async function lastFailUncounted(runId: number): Promise<boolean> {
  const [row] = await dbq("SELECT data_json FROM gt_factory_events WHERE run_id = ? AND type = 'check_fail' ORDER BY id DESC LIMIT 1", [runId]).catch(() => []);
  try {
    return row?.data_json ? JSON.parse(String(row.data_json)).counted === false : false;
  } catch {
    return false;
  }
}

// ── Crítico del plan ─────────────────────────────────────────────────────────

/** Cuánto se espera al crítico antes de seguir sin él (sprint) o dejar de marcarlo pendiente. */
export const CRITIQUE_TIMEOUT_S = 15 * 60;

/**
 * Manda el plan recién entregado a @check (conversación aparte, `-critic`) antes de construir.
 * Una sola vuelta por pedido: si una versión anterior ya falló con el crítico, la nueva va
 * directo a la firma humana (sin ping-pong). `autoApprove` = ticket de sprint: al pasar el
 * crítico se aprueba solo, con quien aprobó el sprint. Devuelve si el crítico quedó corriendo.
 */
export async function startCritique(run: Run, version: number, origin: string, autoApprove?: { sub: string; who: string }): Promise<boolean> {
  const failedBefore = await dbq("SELECT 1 FROM gt_factory_plans WHERE run_id = ? AND version < ? AND critique = 'fail' LIMIT 1", [run.id, version]).catch(() => []);
  if (failedBefore.length) return false;
  const plan = await getPlan(run.id, version);
  if (!plan) return false;
  const db = await import("../../db.server");
  const root = await db.getMessage(run.rootMsgId).catch(() => null);
  await dbq(
    "UPDATE gt_factory_plans SET critique = 'pending', critique_at = unixepoch(), auto_approve_by = ?, auto_approve_who = ? WHERE run_id = ? AND version = ?",
    [autoApprove?.sub ?? null, autoApprove?.who ?? null, run.id, version],
  );
  const { criticBrief } = await import("./factory-roles");
  const ok = await handoff(run, "check", autoApprove?.sub ?? run.requestedBy, "revisar el plan", criticBrief(run.id, version, plan.planMd, String(root?.body ?? run.title)), origin, "-critic");
  if (!ok) await dbq("UPDATE gt_factory_plans SET critique = NULL WHERE run_id = ? AND version = ?", [run.id, version]);
  return ok;
}

/**
 * Cierre del crítico. `pass`: el plan queda marcado «revisado por @check» y, si es ticket de
 * sprint, se aprueba solo como antes. `fail`: vuelve a @plan como un «cambios: …» firmado por
 * @check. Si una persona ya firmó mientras tanto, no se toca nada.
 */
export async function finishCritique(run: Run, pass: boolean, findings: string, origin: string): Promise<{ ok: boolean; error?: string; status?: string }> {
  const [row] = await dbq("SELECT critique, auto_approve_by, auto_approve_who, decision FROM gt_factory_plans WHERE run_id = ? AND version = ?", [run.id, run.planVersion]).catch(() => []);
  if (!row || row.critique !== "pending") return { ok: false, error: "este plan no espera crítica (ya se revisó o ya lo firmó alguien)" };
  if (run.status !== "plan_review" || row.decision) {
    await dbq("UPDATE gt_factory_plans SET critique = ?, critique_notes = ? WHERE run_id = ? AND version = ?", [pass ? "pass" : "fail", findings.slice(0, 4000) || null, run.id, run.planVersion]);
    return { ok: true, status: run.status };
  }
  await dbq("UPDATE gt_factory_plans SET critique = ?, critique_notes = ? WHERE run_id = ? AND version = ?", [pass ? "pass" : "fail", findings.slice(0, 4000) || null, run.id, run.planVersion]);
  if (pass) {
    await postInThread(run, "check", `🔎 Revisé el plan v${run.planVersion}: se puede construir así.${findings.trim() ? `\n\n${findings.trim()}` : ""}`);
    if (row.auto_approve_by) {
      const next = await decide({ run, version: run.planVersion, decision: "approve", sub: String(row.auto_approve_by), who: String(row.auto_approve_who ?? "Quien aprobó el sprint"), origin });
      return { ok: true, status: next.status };
    }
    void refreshRoom(run.channelId);
    return { ok: true, status: run.status };
  }
  const next = await decide({
    run,
    version: run.planVersion,
    decision: "changes",
    note: `Hallazgos del crítico del plan (@check):\n${findings.trim()}`,
    sub: run.requestedBy,
    who: "@check",
    origin,
  });
  return { ok: true, status: next.status };
}

/** Críticos que no cerraron (turno muerto): a los 15 min se sigue sin ellos. */
async function sweepStaleCritiques(): Promise<void> {
  const rows = await dbq(
    `SELECT p.run_id, p.version, p.auto_approve_by, p.auto_approve_who FROM gt_factory_plans p JOIN gt_factory_runs r ON r.id = p.run_id
     WHERE p.critique = 'pending' AND p.critique_at < unixepoch() - ? LIMIT 10`,
    [CRITIQUE_TIMEOUT_S],
  ).catch(() => []);
  for (const p of rows) {
    const claimed = await dbq("UPDATE gt_factory_plans SET critique = 'timeout' WHERE run_id = ? AND version = ? AND critique = 'pending' RETURNING run_id", [p.run_id, p.version]).catch(() => []);
    if (!claimed.length) continue;
    const run = await getRun(Number(p.run_id));
    if (!run || run.status !== "plan_review" || run.planVersion !== Number(p.version)) continue;
    void logEvent(run.id, "critique_timeout", null, { version: run.planVersion });
    if (p.auto_approve_by) {
      const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
      await decide({ run, version: run.planVersion, decision: "approve", sub: String(p.auto_approve_by), who: String(p.auto_approve_who ?? "Quien aprobó el sprint"), origin: String(w?.origin ?? "") }).catch((e) => console.error("[factory] crítico vencido", e));
    } else void refreshRoom(run.channelId);
  }
}

/**
 * Lo que @check dejó al escalar (bloqueo o vueltas agotadas), para pintarlo ARRIBA en la tarjeta:
 * quien aprueba tiene que ver qué está aprobando (mercadito #7: se aprobó en 2 min un cambio a CI
 * y una cifra doble que sólo estaban en un mensaje del hilo). null si no está escalado.
 */
export async function escalationOf(run: Run): Promise<{ findings: string; at: number } | null> {
  if (run.status !== "escalated") return null;
  const [row] = await dbq(
    "SELECT data_json, at FROM gt_factory_events WHERE run_id = ? AND type IN ('check_blocked', 'check_fail') ORDER BY id DESC LIMIT 1",
    [run.id],
  ).catch(() => []);
  try {
    const findings = row?.data_json ? String(JSON.parse(String(row.data_json)).findings ?? "") : "";
    return findings ? { findings, at: Number(row.at) } : null;
  } catch {
    return null;
  }
}

/** Los hallazgos como viñetas (una por punto), para enseñar los primeros arriba. */
export function findingPoints(findings: string): string[] {
  const bullets = findings.split(/\n(?=\s*[-*•]\s)/).map((x) => x.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
  return bullets.length ? bullets : [findings.trim()];
}

// ── Notas del pedido (`factory_note`) ───────────────────────────────────────

export type RunNote = { by: string; text: string };

/** El bloque que se agrega al encargo de @build. Vacío sin notas. */
export function notesBlock(notes: RunNote[]): string {
  if (!notes.length) return "";
  return `\n\n## Notas de la persona y del equipo\n${notes.map((n) => `- ${n.by}: ${n.text}`).join("\n")}`;
}

/** Guarda una nota sobre el pedido (tabla + bitácora). */
export async function addNote(runId: number, by: string, text: string): Promise<number | null> {
  const rows = await dbq("INSERT INTO gt_factory_notes (run_id, text, by) VALUES (?, ?, ?) RETURNING id", [runId, text, by]);
  await logEvent(runId, "note", by, { text: text.slice(0, 500) });
  return rows[0]?.id != null ? Number(rows[0].id) : null;
}

/** La nota ya le llegó en vivo al rol: no se repite en su siguiente encargo. */
export async function consumeNote(noteId: number): Promise<void> {
  await dbq("UPDATE gt_factory_notes SET consumed_at = unixepoch() WHERE id = ? AND consumed_at IS NULL", [noteId]).catch(() => {});
}

/**
 * Las notas sin consumir, ya marcadas como consumidas (un solo UPDATE … RETURNING: dos
 * encargos encimados no se las llevan las dos veces). Las llama cada encargo de @build.
 */
export async function takeNotes(runId: number): Promise<string> {
  const rows = await dbq(
    "UPDATE gt_factory_notes SET consumed_at = unixepoch() WHERE run_id = ? AND consumed_at IS NULL RETURNING id, by, text",
    [runId],
  ).catch(() => []);
  return notesBlock(
    rows
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => ({ by: String(r.by), text: String(r.text) })),
  );
}

/**
 * Aviso (push/correo) SÓLO cuando el pedido espera a una persona o terminó. Planear,
 * construir y revisar no avisan: sólo refrescan la tarjeta (patrón de Slack/Linear: editar
 * en silencio, timbrar cuando te toca).
 */
export async function notifyRunTurn(run: Run, from: RunStatus | null): Promise<void> {
  if (from === run.status) return;
  const copy: Partial<Record<RunStatus, string>> = {
    plan_review: "El plan está listo: falta tu firma.",
    pr_review: "El PR está listo para que lo revises y le hagas merge.",
    escalated: "La fábrica necesita que decidas cómo seguir.",
    done: "Terminó.",
  };
  const body = copy[run.status];
  if (!body) return;
  const to = new Set([run.requestedBy, run.status === "pr_review" || run.status === "done" ? run.approvedBy : null].filter(Boolean) as string[]);
  await notifyRun(run, [...to], body, `factory:${run.id}:${run.status}`);
}

async function notifyRun(run: Run, subs: string[], body: string, tag: string): Promise<void> {
  try {
    const db = await import("../../db.server");
    const ch = await db.getChannelById(run.channelId);
    if (!ch || !subs.length) return;
    const recipients = await db.filterMutedOut(subs, "room", run.channelId).catch(() => subs);
    const { notify } = await import("../notify.server");
    const { currentNamespace } = await import("../tenant.server");
    await notify(
      {
        kind: "factory",
        recipients,
        title: `Pedido #${run.id} · ${run.title}`.slice(0, 120),
        body,
        url: `/c/${ch.slug}?thread=${run.rootMsgId}&run=${run.id}`,
        tag,
      },
      await currentNamespace(),
    );
  } catch (e) {
    console.error("[factory] aviso", e);
  }
}

/** Minutos sin actividad para que un pedido abierto cuente como colgado (Linear: 30). */
export const STALE_SECONDS = 30 * 60;

/**
 * Barrido: pedidos abiertos sin un solo evento ni mensaje en 30 min y sin turno en vuelo →
 * un aviso, UNA vez, a quien lo pidió. Lo llama el timer de wakeups.
 */
export async function sweepStaleRuns(isBusy: (run: Run) => boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await dbq(
    `SELECT r.*, MAX(COALESCE((SELECT MAX(at) FROM gt_factory_events e WHERE e.run_id = r.id), 0),
            COALESCE((SELECT MAX(created_at) FROM gc_messages m WHERE m.parent_id = r.root_msg_id AND m.channel_id = r.channel_id), 0),
            r.updated_at) AS last_at
       FROM gt_factory_runs r
      WHERE r.status IN ('planning','building','checking') AND r.stale_warned_at IS NULL AND (r.kind IS NULL OR r.kind != 'eval')`,
  ).catch(() => []);
  for (const r of rows) {
    if (now - Number(r.last_at ?? now) < STALE_SECONDS) continue;
    const run = toRun(r);
    if (isBusy(run)) continue;
    // Primero la plataforma lo retoma SOLA, una vez por atasco: el rol terminó su turno sin
    // cerrar su paso y nadie lo iba a mover. Una persona no sabe que existe «Retomar» (MailMask,
    // 4-oct: @build parado una hora con la tarjeta diciendo «construyendo…»). Si tras eso sigue
    // parado (su último evento sigue siendo el auto-retomar), ahora sí se avisa.
    const [lastEv] = await dbq("SELECT type FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT 1", [run.id]).catch(() => []);
    // `waiting_person`: el rol preguntó y espera a la persona; retomarlo solo sería contestarse.
    if (lastEv?.type !== "auto_resumed" && lastEv?.type !== "waiting_person") {
      const role = ({ planning: "plan", building: "build", checking: "check" } as const)[run.status as "planning" | "building" | "checking"];
      const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
      const origin = String(w?.origin ?? "");
      if (role && origin) {
        const ok = await handoff(
          run,
          role,
          run.approvedBy ?? run.requestedBy,
          "retomar (automático)",
          `Este pedido lleva 30 min sin avanzar y nadie está trabajando en él: tu turno anterior terminó sin cerrar tu paso. ` +
            `Revisa lo último del hilo, continúa y ciérralo con tu tool factory_*.` +
            (role === "build" ? await takeNotes(run.id) : ""),
          origin,
        ).catch(() => false);
        if (ok) {
          await logEvent(run.id, "auto_resumed", null, { role });
          await postInThread(run, role, `🔁 Llevaba 30 min sin avanzar: retomo el pedido.`).catch(() => null);
          void refreshRoom(run.channelId);
          continue;
        }
      }
    }
    const marked = await dbq("UPDATE gt_factory_runs SET stale_warned_at = ? WHERE id = ? AND stale_warned_at IS NULL RETURNING id", [now, run.id]).catch(() => []);
    if (!marked.length) continue;
    await logEvent(run.id, "stale", null, { status: run.status });
    await notifyRun(run, [run.requestedBy], "Lleva 30 min sin avanzar. Ábrelo para retomarlo o detenerlo.", `factory:${run.id}:stale`);
    void refreshRoom(run.channelId);
  }
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
export async function handoff(
  run: Run,
  to: "plan" | "build" | "check" | "eval",
  sub: string,
  cause: string,
  text: string,
  origin: string,
  /** Otra conversación del mismo rol en el mismo pedido (el juez de un eval de @check). */
  groupSuffix = "",
): Promise<boolean> {
  const t0 = Date.now();
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
  const groupId = await agentGroupId(agent, `factory-${run.id}${groupSuffix}`);
  // Las skills del paso van en el encargo, junto a la tarea: en el prompt del rol no se seguían.
  let skills = "";
  if ((to === "build" || to === "check") && !groupSuffix) {
    const plan = run.planVersion ? await getPlan(run.id, run.planVersion).catch(() => null) : null;
    skills = `\n\n${(await import("./factory-roles")).roleSkillsLine(to, `${run.title}\n${plan?.planMd ?? ""}`)}`;
  }
  const { enqueueWakeup, mintWakeRef } = await import("../wakeups.server");
  const ok = await enqueueWakeup({
    key: `factory:${run.id}:${to}:${Date.now()}`,
    ref: mintWakeRef({
      sub,
      ns,
      groupId,
      dest: { channelId: run.channelId, parentId: run.rootMsgId, topic: run.topic, handle: agent.handle, name: agent.name, avatar: agent.avatar },
    }),
    cause,
    text: `[Pedido #${run.id} · «${run.title}»${run.repo ? ` · repo ${run.repo}` : ""}]\n${text}${skills}`,
    origin,
    // Vencido YA: con +2 s el barrido inmediato de `kickWakeups` lo veía «aún no» y el relevo
    // esperaba al siguiente tick (pedir cambios tardó ~30 s en arrancar a @plan, MailMask #15).
    dueAt: Math.floor(Date.now() / 1000),
  });
  console.log(`[lat] handoff #${run.id} → @${to} encolado en ${Date.now() - t0}ms`);
  // `kick`, no `arm`: con sólo armar, el relevo esperaba al siguiente tick (hasta 30 s) y la
  // persona veía «nada pasó» tras firmar (MailMask, 2026-10-01).
  if (ok) (await import("../wakeups.server")).kickWakeups(ns);
  return ok;
}

/**
 * Un pedido con su PR listo recibe más trabajo (nota de una persona o ticket de un sprint que
 * lo continúa): se reabre (`rework` → building) y se le encarga ya a @build en la MISMA rama.
 * Las notas sólo se leían al encargar, así que sin esto se quedaban dormidas (MailMask, 4-oct).
 * null si el pedido ya no estaba en `pr_review`.
 */
export async function reopenWithNotes(run: Run, by: string, extra: string, origin: string, data: Record<string, unknown> = {}): Promise<Run | null> {
  if (run.status !== "pr_review") return null;
  const next = await applyEvent(run, "rework", { merge_asked: null, loops: 0 }, { actor: by, data }).catch(() => null);
  if (!next) return null;
  if (!origin) {
    const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
    origin = String(w?.origin ?? "");
  }
  await handoff(
    next,
    "build",
    next.approvedBy ?? next.requestedBy,
    "ampliar el PR",
    `Pidieron más sobre el PR ${run.prUrl ?? ""}, que ya estaba listo. Trabaja en la MISMA rama (no abras otro PR), corre las pruebas, ` +
      `EMPUJA y cierra otra vez con factory_build_done (runId ${run.id}); @check lo vuelve a revisar.` +
      (await takeNotes(run.id)) +
      extra,
    origin,
  );
  return next;
}

/**
 * Lo que alguien del repo le pidió a Ghosty en el PR desde GitHub (comentario con @ghosty o
 * review «Request changes»). Mismo camino que la nota de @plan: PR listo → se reabre y @build
 * trabaja en la misma rama; @build a media obra → entra a su turno vivo; si no, va en su
 * siguiente encargo. Devuelve qué pasó, para contarlo en el hilo.
 */
export async function noteFromGithub(run: Run, by: string, ask: { text: string; url: string; path?: string; line?: number }): Promise<"reopened" | "steered" | "queued" | "closed"> {
  if (run.status === "done" || run.status === "cancelled") return "closed";
  const where = ask.path ? ` (en \`${ask.path}${ask.line ? `:${ask.line}` : ""}\`)` : "";
  // Como Copilot/Devin/Cursor: 👀 al recibir (lo pone la plataforma) y respuesta en el MISMO lugar al terminar.
  const reply = ask.path
    ? "Al terminar, contéstale en ese comentario en línea con github_reply_review_comment"
    : "Al terminar, contéstale en el PR con github_comment";
  const text = `${ask.text}${where} — ${ask.url}\n${reply}: 1 o 2 renglones con qué cambiaste y en qué commit (sin escribir @ghosty).`;
  const who = `@${by} en GitHub`;
  const noteId = await addNote(run.id, who, text);
  if (run.repo) void import("../connectors/github.server").then((g) => g.ackGithubComment(run.repo!, ask.url));
  await postInThread(run, "plan", `💬 ${who}${where}: ${ask.text.slice(0, 600)}${ask.text.length > 600 ? "…" : ""} ([ver](${ask.url}))`);
  if (run.status === "pr_review") return (await reopenWithNotes(run, who, "", "", { github: ask.url })) ? "reopened" : "queued";
  if (run.status === "building" && (await steerRole(run, "build", `Pedido de ${who} sobre este PR (le gana a lo anterior si choca): ${text}`))) {
    if (noteId) await consumeNote(noteId);
    return "steered";
  }
  return "queued";
}

/**
 * Mete `text` al turno VIVO del rol en este pedido (steer), sin abrir uno nuevo: `injectOnly`
 * hace que gs conteste `not_live` si no hay turno. true sólo si gs confirma `injected`. Sin
 * esto una nota a media obra esperaba al siguiente encargo y @build terminaba con el alcance
 * viejo (MailMask, 4-oct). Nunca lanza.
 */
export async function steerRole(run: Run, role: "build" | "check", text: string): Promise<boolean> {
  try {
    const { resolvedAgents, agentGroupId } = await import("../../agents.server");
    const agent = (await resolvedAgents()).find((a) => a.handle === role);
    if (!agent || agent.backend.kind !== "fleet") return false;
    const { runtimeFor } = await import("../agent-runtime.server");
    const rt = await runtimeFor(agent.backend);
    if (rt.kind !== "gs-native" || !rt.headers) return false;
    const { factoryTurnFor } = await import("./factory-team.server");
    const ft = await factoryTurnFor(role, { channelId: run.channelId, parentId: run.rootMsgId }, agent.backend.id).catch(() => null);
    const fleetId = ft?.fleetId ?? agent.backend.id;
    const groupId = await agentGroupId(agent, `factory-${run.id}`);
    const body = JSON.stringify({ groupId, configGroupId: "teams", sender: "plataforma", text, inject: true, injectOnly: true });
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${fleetId}/message-stream`, {
      method: "POST",
      headers: rt.headers(body, agent.backend.token),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !res.body) return false;
    // `injected` = entró; `not_live`/`error`/`done` = no. Lo demás (progreso) se ignora.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        buf += dec.decode(value, { stream: true });
        for (const line of buf.split("\n")) {
          const m = /^data:\s*(.+)$/.exec(line.trim());
          if (!m) continue;
          const ev = JSON.parse(m[1]) as { type?: string };
          if (ev.type === "injected") return true;
          if (ev.type === "not_live" || ev.type === "error" || ev.type === "done") return false;
        }
        buf = buf.slice(buf.lastIndexOf("\n") + 1);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  } catch {
    return false;
  }
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
  const t0 = Date.now();
  const lap = (what: string) => console.log(`[lat] decide #${run.id} ${what} +${Date.now() - t0}ms`);
  if (version !== run.planVersion) throw new Error(`ese es el plan v${version}; el vigente es v${run.planVersion}`);
  const note = (opts.note ?? "").trim().slice(0, 2000);
  if (decision === "changes" && !note) throw new Error("di qué cambiar");
  // Replanear reinicia las vueltas de check (si no, un plan nuevo tras escalar volvía a
  // escalar al primer hallazgo). Aprobar deja registrado con qué credenciales se construye.
  const next = await applyEvent(
    run,
    decision === "approve" ? "approve" : "changes",
    decision === "approve" ? (run.status === "escalated" ? { approved_by: sub } : { approved_by: sub, loops: 0 }) : { loops: 0 },
    { actor: who, data: { version, ...(note ? { note } : {}) } },
  );
  await dbq("UPDATE gt_factory_plans SET decision = ?, decided_by = ?, note = ? WHERE run_id = ? AND version = ?", [
    decision,
    who,
    note || null,
    run.id,
    version,
  ]);
  lap("evento+plan guardados");
  const plan = await getPlan(run.id, version);
  lap("plan leído");
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
        (await takeNotes(run.id)) +
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
    // Escalado: un «✅» suelto no aprueba. Se le enseñan los puntos y se pide «✅ confirmo»,
    // para que nadie apruebe a ciegas lo que @check frenó (mercadito #7, 5-oct).
    if (run.status === "escalated" && d.decision === "approve" && !("confirmed" in d && d.confirmed)) {
      const esc = await escalationOf(run);
      if (esc) {
        const points = findingPoints(esc.findings);
        await postInThread(
          run,
          "check",
          `Antes de otra vuelta, esto es lo que frené (${points.length} punto${points.length === 1 ? "" : "s"}):\n\n` +
            points.map((p, i) => `${i + 1}. ${p}`).join("\n") +
            `\n\nSi lo leíste y va, contesta «✅ confirmo». Para cambiar algo, «cambios: …».`,
        );
        return true;
      }
    }
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
const OPEN_STATUS: Record<string, RunStatus> = { plan: "planning", build: "building", check: "checking", eval: "checking" };
const CLOSE_TOOL: Record<string, string> = { plan: "factory_plan_submit", build: "factory_build_done", check: "factory_check_verdict", eval: "factory_eval_score" };

/**
 * Llamado al terminar un turno de la estafeta (`factory:<run>:<rol>:…`). Si la corrida
 * sigue en el estado de ese rol, el rol no cerró su paso: se le da UN empujón (mismo hilo,
 * misma conversación) y, si tampoco cierra, se avisa en el hilo a quien pidió.
 */
/** Se cayó el CAMINO, no el agente: gs o Teams reiniciando, conexión cortada. */
// Sólo los mensajes que escribe la PLATAFORMA cuando se cae el camino (`⚠️ No pude contactar a @…`
// y sus motivos), no palabras sueltas: un agente que cita «process terminated» no es un corte.
const TRANSPORT_CUT = /⚠️ No pude contactar a @|fleet-stream 404|turno no existe|upstream unreachable/i;
const CUT_GRACE_MS = process.env.NODE_ENV === "test" ? 0 : 90_000;

/**
 * ¿El rol terminó su turno con una PREGUNTA para la persona? Un `gt-ask`, o prosa (sin bloques de
 * código ni fences) cuyo último párrafo termina en «?». Entonces no se le empuja ni se alarma:
 * @build pidió los datos del equipo y salió «terminó dos veces sin cerrar su paso» (palmera-legal, 4-oct).
 */
export function asksPerson(reply: string): boolean {
  if (/```gt-ask\b/.test(reply)) return true;
  const prose = reply.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").trim();
  const last = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop() ?? "";
  return /[?？]\s*[)*_]*\s*$/.test(last);
}

export async function afterFactoryTurn(
  w: { key: string; ref: string; origin: string },
  ref: { sub: string },
  reply = "",
): Promise<void> {
  const m = /^factory:(\d+):(plan|build|check|eval):/.exec(w.key);
  if (!m) return;
  const run = await getRun(Number(m[1]));
  const role = m[2];
  if (!run || run.status !== OPEN_STATUS[role]) return; // cerró su paso (o el pedido siguió)
  // CORTE DE TRANSPORTE (infra reiniciando, gs caído un momento): el agente no falló, se cayó
  // el camino. Se repite el MISMO encargo en 60 s, una vez. Empujarlo a los 5 s con «cierra tu
  // paso» caía en la misma ventana caída (MailMask, 2026-10-01).
  const cut = TRANSPORT_CUT.test(reply);
  if (cut && !w.key.endsWith(":retry")) {
    await logEvent(run.id, "stalled", role, { reason: reply.replace(/^[\s\S]*No pude contactar a @\w+:\s*/, "").slice(0, 200) });
    const { enqueueWakeup, armWakeups } = await import("../wakeups.server");
    const { currentNamespace } = await import("../tenant.server");
    const original = await dbq("SELECT cause, text FROM gt_agent_wakeups WHERE key = ?", [w.key]).catch(() => []);
    await enqueueWakeup({
      key: `${w.key.replace(/:nudge$/, "")}:retry`,
      ref: w.ref,
      cause: String(original[0]?.cause ?? "retomar tras un corte"),
      text: String(original[0]?.text ?? `[Pedido #${run.id}] Se cortó la conexión a media tarea. Retoma tu paso donde lo dejaste.`),
      origin: w.origin,
      dueAt: Math.floor(Date.now() / 1000) + 60,
    });
    armWakeups(await currentNamespace());
    return;
  }
  // El turno SE CAYÓ (vacío o cortado): empujar no sirve, el agente no está contestando.
  if (!reply.trim() || cut || /se cort[óo] antes de terminar/i.test(reply)) {
    if (w.key.endsWith(":nudge")) return; // ya se avisó en el intento anterior
    // Un corte de conexión NO termina el turno en gs: el agente suele cerrar su paso segundos
    // después (palmera-legal, 3-oct: el veredicto llegó 40 s tras el aviso). Se espera antes
    // de decir nada, y si el pedido avanzó, no hay nada que avisar.
    const lastEvent = async () => Number((await dbq("SELECT MAX(id) AS n FROM gt_factory_events WHERE run_id = ?", [run.id]).catch(() => []))[0]?.n ?? 0);
    const before = await lastEvent();
    await new Promise((r) => setTimeout(r, CUT_GRACE_MS));
    const now = await getRun(run.id);
    if (!now || now.status !== run.status || (await lastEvent()) !== before) return;
    await postInThread(
      run,
      role,
      cut
        ? `⚠️ Se cortó dos veces la conexión con @${role} (el servidor se reinició). Menciónalo en este hilo para que retome su paso.`
        : `⚠️ @${role} no pudo contestar (su turno se cortó). Revisa su agente en Studio (motor, modelo o llave) ` +
            `o asígnale otro en Ajustes → Apps, y vuelve a mencionarlo.`,
    );
    return;
  }
  // Pregunta legítima a la persona: se espera su respuesta, sin empujón ni alarma, y el barrido
  // no lo retoma solo. Su respuesta en el hilo (sin @) le llega a este rol (`factoryFollowHandle`).
  if (asksPerson(reply)) {
    await logEvent(run.id, "waiting_person", role);
    // Push a quien pidió: un rol esperando respuesta es justo el momento de avisar. Si el rol ya
    // lo @mencionó, `notify` agrupa por tag y no llega doble.
    await notifyRun(run, [run.requestedBy], `@${role} te hizo una pregunta: contéstale en el hilo.`, `factory:${run.id}:waiting`);
    void refreshRoom(run.channelId);
    return;
  }
  const nudged = w.key.endsWith(":nudge");
  // En un eval, el juez cierra con su propia tool.
  const meta = role === "check" ? await import("./factory-evals.server").then((E) => E.evalMeta(run.id)).catch(() => null) : null;
  // En un eval, el juez cierra con su propia tool (el @check evaluado, con su veredicto de siempre).
  const closeTool = meta && (meta.config.role !== "check" || meta.stepDoneAt) ? "factory_eval_score" : CLOSE_TOOL[role];
  if (!nudged) {
    const { enqueueWakeup, armWakeups } = await import("../wakeups.server");
    const { currentNamespace } = await import("../tenant.server");
    await enqueueWakeup({
      key: `factory:${run.id}:${role}:${Date.now()}:nudge`,
      ref: w.ref,
      cause: "cerrar el paso",
      text:
        `[Pedido #${run.id}] Terminaste tu turno sin cerrar tu paso y el pedido está detenido. ` +
        `Si ya acabaste, ciérralo AHORA con ${closeTool} (runId ${run.id}). ` +
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

/** Estado del PR en GitHub y si ya tiene una aprobación. null si no contesta. */
/** ¿El PR ya se mezcló? false si GitHub no contesta. */
export async function prIsMerged(sub: string, url: string): Promise<boolean> {
  return (await prOutcome(sub, url))?.outcome === "merged";
}

/** El cierre festivo al mezclarse: confeti y una línea. */
export function mergedMessage(run: Run): string {
  return "```gt-fx\n" + JSON.stringify({ fx: "confetti" }) + "\n```\n" + `🎉 **Pedido terminado:** PR merged. ${run.prUrl ?? ""}`;
}

/**
 * Cómo se resuelve un PR con conflictos. Va en todo encargo a @build que lo necesite: el de
 * `onPrConflict` y el regreso de @check. Sin él, @build copiaba los archivos de la principal
 * encima SIN commit de merge y GitHub seguía marcando choques (PR #8 de palmera-legal, 3-oct).
 */
export const MERGE_FROM_HINT =
  "Fusiona la rama principal en la tuya con github_push_files y `mergeFrom` = la rama principal: es un commit de MERGE de verdad (dos padres). " +
  "Lo que cambió allá y tú no tocaste entra solo, y en `files` va el contenido final de los archivos que chocan (resuélvelos SIN cambiar el alcance del plan). " +
  "Copiar los archivos de la principal sin `mergeFrom` NO quita los conflictos: GitHub mira la historia, no el contenido.";

/** ¿GitHub marca el PR con choques contra su base? `null` si no se sabe (aún lo calcula). */
export async function prConflicted(sub: string, url: string): Promise<boolean | null> {
  const o = await prOutcome(sub, url);
  return o?.outcome === "open" ? (o.conflicted ?? null) : null;
}

async function prOutcome(
  sub: string,
  url: string,
): Promise<{ outcome: "merged" | "closed" | "open"; approved: boolean; conflicted?: boolean; headSha?: string } | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_get_pr");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error) return null;
    const approved = Array.isArray(r.reviews) && r.reviews.some((v: any) => String(v?.state).toUpperCase() === "APPROVED");
    if (r.merged) return { outcome: "merged", approved };
    // `mergeable: false` = choques con la base; `null` = GitHub aún lo calcula (no se toca).
    return { outcome: String(r.state ?? "").toLowerCase() === "closed" ? "closed" : "open", approved, conflicted: r.mergeable === false, headSha: r.headSha };
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
// Una vez por ESPACIO (por proceso): con una bandera global, el primer tenant del tick se
// la llevaba y los demás nunca se reparaban.
const titlesRepaired = new Set<string>();

/** Una vez por proceso: pedidos que quedaron titulados con un encabezado de sección
 *  («Historia») recuperan su nombre del plan v1. */
async function repairRunTitles(): Promise<void> {
  const { currentNamespace } = await import("../tenant.server");
  const ns = await currentNamespace().catch(() => "");
  if (titlesRepaired.has(ns)) return;
  titlesRepaired.add(ns);
  const rows = await dbq(
    `SELECT r.id, r.title, p.plan_md FROM gt_factory_runs r JOIN gt_factory_plans p ON p.run_id = r.id AND p.version = 1`,
    [],
  ).catch(() => []);
  const { planTitle, SECTION_HEADING } = await import("./factory-tools.server");
  const db = await import("../../db.server");
  for (const r of rows.filter((x) => SECTION_HEADING.test(String(x.title ?? "")))) {
    // El título de la v1 vive en la raíz del hilo («**Plan:** <título>»); si no, del plan.
    const run = await getRun(Number(r.id));
    const root = run ? await db.getMessage(run.rootMsgId).catch(() => null) : null;
    const fromRoot = /^\*\*[^*]+:\*\*\s*(.+)$/m.exec(String(root?.body ?? ""))?.[1]?.trim();
    const title = (fromRoot && !SECTION_HEADING.test(fromRoot) ? fromRoot : planTitle(undefined, String(r.plan_md ?? ""))).slice(0, 120);
    if (title) await dbq("UPDATE gt_factory_runs SET title = ? WHERE id = ?", [title, Number(r.id)]).catch(() => {});
  }
}

/** Revisa ya el PR de un pedido (CI rojo, aprobado → «¿hago merge?», choques), sin esperar
 *  los 2 min del tick. Lo dispara el fin del CI (`check_suite` de GitHub vía gs). */
export async function sweepRunNow(run: Run): Promise<void> {
  lastPrCheck.delete(run.id);
  await closeFinishedRuns().catch((e) => console.error("[factory] barrido por CI", e));
}

export async function closeFinishedRuns(): Promise<void> {
  await repairRunTitles();
  await sweepStaleCritiques();
  // Autocorrección: un pedido cancelado (reciente) cuyo PR SÍ se mezcló es un pedido
  // terminado. Pasa cuando alguien lo cierra a mano antes de que el tick vea el merge.
  const wrong = await dbq(
    `SELECT * FROM gt_factory_runs WHERE status = 'cancelled' AND pr_url IS NOT NULL AND updated_at > unixepoch() - 3*86400 ORDER BY updated_at DESC LIMIT 5`,
    [],
  ).catch(() => []);
  for (const row of wrong) {
    const run = toRun(row);
    if (lastPrCheck.has(-run.id)) continue; // una vez por proceso basta
    lastPrCheck.set(-run.id, Date.now());
    if (!(await prIsMerged(run.approvedBy ?? run.requestedBy, run.prUrl!))) continue;
    const fixed = await dbq("UPDATE gt_factory_runs SET status = 'done', updated_at = unixepoch() WHERE id = ? AND status = 'cancelled' RETURNING *", [run.id]);
    if (fixed[0]) {
      const done = toRun(fixed[0]);
      void logEvent(done.id, "merged", null, { from: "cancelled", to: "done" });
      void refreshRoom(done.channelId);
      void import("./sprint.server").then((S) => S.onSprintRunChanged(done.id)).catch(() => {});
    }
  }

  const rows = await dbq(
    // No sólo en etapa PR: alguien puede mezclar en GitHub sin esperar a @check.
    `SELECT * FROM gt_factory_runs WHERE status IN ('building','checking','escalated','pr_review') AND pr_url IS NOT NULL ORDER BY updated_at LIMIT 20`,
    [],
  ).catch(() => []);
  for (const row of rows) {
    const run = toRun(row);
    const last = lastPrCheck.get(run.id) ?? 0;
    if (Date.now() - last < PR_CHECK_EVERY_MS) continue;
    lastPrCheck.set(run.id, Date.now());
    const pr = await prOutcome(run.approvedBy ?? run.requestedBy, run.prUrl!);
    const outcome = pr?.outcome ?? null;
    // Aprobado por una persona y CI en verde: el agente PROPONE mezclar y pregunta. Mezcla
    // sólo si le contestan que sí (`maybeMergeReply`), con las credenciales de quien contesta.
    // Un solo `prCi` por vuelta: lo usan la propuesta de merge y el regreso por CI en rojo.
    const ci = outcome === "open" && run.status === "pr_review" ? await prCi(run.approvedBy ?? run.requestedBy, run.prUrl!) : null;
    if (ci?.state === "failure") await onPrCiRed(run, pr?.headSha ?? null, ci.failed);
    if (outcome === "open" && run.status === "pr_review" && pr?.approved && !row.merge_asked) {
      if (ci?.state === "success" || ci?.state === "none") {
        const asked = await dbq("UPDATE gt_factory_runs SET merge_asked = 1 WHERE id = ? AND merge_asked IS NULL RETURNING id", [run.id]);
        if (asked.length)
          await postInThread(
            run,
            "build",
            `✅ El PR ya tiene aprobación${ci.state === "success" ? " y el CI está en verde" : ""}. ¿Hago merge? Contesta **«merge»** en este hilo y lo hago. ${run.prUrl}`,
          );
      }
    }
    if (outcome === "open" && run.status === "pr_review" && pr?.conflicted) await onPrConflict(run, pr.headSha ?? null);
    if (outcome === "merged" || outcome === "closed") await onPrEvent(run, outcome);
  }
}

/**
 * El PR esperaba merge y otro PR del mismo repo entró antes: ya no mezcla limpio. Sin esto se
 * quedaba en «PR listo» con un botón de merge que GitHub no deja usar. @build trae la base a su
 * rama y @check vuelve a mirar. Una vez por cabeza: si @build no lo resolvió, decide una persona.
 */
async function onPrConflict(run: Run, headSha: string | null): Promise<void> {
  const prevs = await dbq("SELECT data_json FROM gt_factory_events WHERE run_id = ? AND type = 'conflict' ORDER BY id DESC", [run.id]).catch(() => []);
  const prevSha = prevs[0]?.data_json ? (JSON.parse(String(prevs[0].data_json)).sha ?? null) : undefined;
  if (prevs.length && prevSha === headSha) return; // ya se intentó con esta cabeza: lo ve una persona
  // Tope: dos vueltas por choques. Si vuelve a chocar, que lo vea una persona (una vez).
  const pideAyuda = async (por: string) => {
    const ya = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'conflict_help' AND json_extract(data_json, '$.sha') IS ?", [run.id, headSha]).catch(() => []);
    if (ya.length) return;
    await logEvent(run.id, "conflict_help", null, { sha: headSha, por });
    await postInThread(run, "build", `⚠️ El PR ${run.prUrl ?? ""} sigue con conflictos con la rama principal (${por}). Necesita que una persona lo resuelva o pida a @build que lo intente otra vez.`);
  };
  if (prevs.length >= 2) return pideAyuda("ya lo intenté dos veces");
  // El tick no tiene request: el origin sale del último encargo de este pedido.
  const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
  const origin = String(w?.origin ?? "");
  if (!origin) return pideAyuda("no pude mandarle el encargo a @build");
  // Al resolverse, se vuelve a preguntar «¿hago merge?» con la cabeza nueva.
  await dbq("UPDATE gt_factory_runs SET merge_asked = NULL WHERE id = ?", [run.id]).catch(() => {});
  const next = await applyEvent(run, "conflict", {}, { data: { sha: headSha } }).catch(() => null);
  if (!next) return;
  await postInThread(next, "build", `🔀 Otro PR entró antes y éste ya tiene conflictos con la rama principal. Lo pongo al día. ${run.prUrl ?? ""}`);
  await handoff(
    next,
    "build",
    run.approvedBy ?? run.requestedBy,
    "PR con conflictos",
    `El PR ${run.prUrl} tiene conflictos con la rama principal (otro PR entró antes con merge). ${MERGE_FROM_HINT} Corre las pruebas y cierra con factory_build_done.`,
    origin,
  );
}

/**
 * El PR esperaba revisión y su CI está en rojo (llegó el CI después, o un check cambió): vuelve
 * solo a @build en la misma rama, como Copilot/Stripe; antes dependía de que alguien picara
 * «Pedir arreglo» (MailMask #8, 4-oct). Mismo patrón que `onPrConflict`: una vez por cabeza y
 * dos vueltas; a la tercera lo ve una persona.
 */
export async function onPrCiRed(run: Run, headSha: string | null, failed: string[]): Promise<void> {
  const prevs = await dbq("SELECT data_json FROM gt_factory_events WHERE run_id = ? AND type = 'ci_red' ORDER BY id DESC", [run.id]).catch(() => []);
  const prevSha = prevs[0]?.data_json ? (JSON.parse(String(prevs[0].data_json)).sha ?? null) : undefined;
  if (prevs.length && prevSha === headSha) return; // ya se regresó con esta cabeza
  const what = failed.join(", ") || "checks en rojo";
  const pideAyuda = async (por: string) => {
    const ya = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'ci_red_help' AND json_extract(data_json, '$.sha') IS ?", [run.id, headSha]).catch(() => []);
    if (ya.length) return;
    await logEvent(run.id, "ci_red_help", null, { sha: headSha, por });
    await postInThread(run, "build", `⚠️ El CI del PR ${run.prUrl ?? ""} sigue en rojo (${what}; ${por}). Necesita que una persona revise el log o le diga a @build qué cambiar.`);
  };
  if (prevs.length >= 2) return pideAyuda("ya se lo regresé a @build dos veces");
  const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
  const origin = String(w?.origin ?? "");
  if (!origin) return pideAyuda("no pude mandarle el encargo a @build");
  await logEvent(run.id, "ci_red", null, { sha: headSha, failed });
  await addNote(run.id, "plataforma", `El CI del PR falló (${what}). Lee el log con github_workflow_run_logs, corrígelo en la misma rama y no cierres hasta verlo en verde.`);
  await postInThread(run, "plan", `🔧 El CI del PR falló (${what}): se lo regresé a @build.`);
  await reopenWithNotes(run, "plataforma", "", origin, { ci: failed });
}

/**
 * El PR de un pedido ya se mezcló y el CI de la rama principal truena (lo detecta
 * `post-merge.server.ts`). Sólo queda en la bitácora del pedido, una vez por sha: el arreglo lo
 * pide una persona como ticket nuevo. Un encargo automático a @build duplicaba el ticket que la
 * persona ya había abierto y llegaba sin GitHub por ser un pedido cerrado (palmera-legal #9, 3-oct).
 */
export async function onDeployFailed(
  repo: string,
  prNumber: number,
  channelId: number,
  failure: { sha: string | null; workflow: string; url: string; conclusion: string },
): Promise<void> {
  for (const run of await runsByPr(repo, prNumber)) {
    if (run.channelId !== channelId) continue;
    const prevs = await dbq("SELECT data_json FROM gt_factory_events WHERE run_id = ? AND type = 'deploy_failed'", [run.id]).catch(() => []);
    if (prevs.some((e) => e?.data_json && JSON.parse(String(e.data_json)).sha === failure.sha)) continue;
    await logEvent(run.id, "deploy_failed", null, failure);
  }
}

/**
 * El PR de un pedido se mezcló o se cerró. Un solo lugar para el sondeo de arriba, para
 * `mergeRun` y para el webhook de la GitHub App (`api.internal.github-event`), que llega en
 * segundos. Idempotente: `applyEvent` sólo avanza una vez, así que webhook + sondeo (o un
 * reenvío de GitHub) no dejan dos mensajes. Devuelve la corrida si ESTA llamada la cerró.
 */
/** Primera revisión humana del PR de un pedido (las siguientes no cambian nada). Sólo cuenta
 *  si el PR ya había salido de la fábrica (`pr_ready_at`): comentar un borrador no es revisar. */
export async function recordFirstReview(runId: number, state: string, at: string): Promise<boolean> {
  const ts = Math.floor(Date.parse(at) / 1000) || Math.floor(Date.now() / 1000);
  const rows = await dbq(
    `UPDATE gt_factory_runs SET first_review_at = ?, first_review_state = ?
     WHERE id = ? AND first_review_at IS NULL AND pr_ready_at IS NOT NULL AND ? >= pr_ready_at RETURNING id`,
    [ts, state, runId, ts],
  );
  return rows.length > 0;
}

export async function onPrEvent(run: Run, outcome: "merged" | "closed", role: "check" | "build" = "check"): Promise<Run | null> {
  if (outcome === "merged") {
    // Lo mezclado cambia la calificación «Listo para agentes» del repo.
    if (run.repo) void import("./readiness.server").then((m) => m.invalidateReadiness(run.repo!));
    if (run.status === "cancelled") {
      // Cancelado a mano antes de que alguien viera el merge: el pedido sí terminó.
      const fixed = await dbq("UPDATE gt_factory_runs SET status = 'done', merged_at = COALESCE(merged_at, unixepoch()), updated_at = unixepoch() WHERE id = ? AND status = 'cancelled' RETURNING *", [run.id]);
      if (!fixed[0]) return null;
      const done = toRun(fixed[0]);
      void logEvent(done.id, "merged", null, { from: "cancelled", to: "done" });
      void refreshRoom(done.channelId);
      void import("./sprint.server").then((S) => S.onSprintRunChanged(done.id)).catch(() => {});
      return done;
    }
    await dbq("UPDATE gt_factory_runs SET merged_at = COALESCE(merged_at, unixepoch()) WHERE id = ?", [run.id]);
    const done = await applyEvent(run, "merged").catch(() => null);
    if (done) await postInThread(done, role, mergedMessage(run));
    return done;
  }
  const gone = await applyEvent(run, "cancel").catch(() => null);
  if (gone) await postInThread(gone, role, `⏹️ El PR se cerró sin merge: pedido cancelado. ${run.prUrl}`);
  return gone;
}

/** Pedidos cuyo PR es `repo#number` (webhook), en cualquier estado: `onPrEvent` es idempotente
 *  (un pedido ya terminado no cambia) y los cancelados entran por la autocorrección. */
export async function runsByPr(repo: string, number: number): Promise<Run[]> {
  const rows = await dbq(
    `SELECT * FROM gt_factory_runs WHERE pr_url IS NOT NULL AND LOWER(pr_url) LIKE ?`,
    [`%github.com/${repo.toLowerCase()}/pull/${number}%`],
  ).catch(() => []);
  return rows
    .map(toRun)
    .filter((r) => {
      const pr = parsePrUrl(r.prUrl ?? "");
      return !!pr && pr.repo.toLowerCase() === repo.toLowerCase() && pr.number === number;
    });
}

const lastPreviewCheck = new Map<number, number>();

/**
 * La preview del PR de cada pedido vivo: la del hosting si la publica (Vercel, Netlify…) y,
 * si no, la de NUESTRA caja (gs la construye). Se guarda en la fila (`preview_*`) para la
 * tarjeta y @check, y se avisa UNA vez por commit en el hilo: lista o por qué no arrancó.
 * Lo llama el mismo tick que `closeFinishedRuns`.
 */
export async function announcePreviews(): Promise<void> {
  const rows = await dbq(
    // También construyendo y escalado: con cada commit nuevo del PR la preview se rehace, para
    // que la persona vea el cambio antes de decidir (antes se quedaba en el commit viejo hasta
    // la siguiente revisión — pedido #10, 01-oct).
    `SELECT * FROM gt_factory_runs WHERE status IN ('building','checking','escalated','pr_review') AND pr_url IS NOT NULL ORDER BY updated_at DESC LIMIT 10`,
    [],
  ).catch(() => []);
  const P = await import("./preview.server");
  for (const row of rows) {
    const run = toRun(row);
    // Construyendo se mira cada 20 s; lista o fallida, cada 2 min (por si hubo push nuevo).
    const every = row.preview_state === "pending" ? 20_000 : 120_000;
    if (Date.now() - (lastPreviewCheck.get(run.id) ?? 0) < every) continue;
    lastPreviewCheck.set(run.id, Date.now());
    const sub = run.approvedBy ?? run.requestedBy;
    const pr = parsePrUrl(run.prUrl!);
    const head = await prHead(sub, run.prUrl!);
    if (!pr || !head) continue;
    // Preview apagada para el repo: gris y sin avisos en el hilo.
    if (await repoPreviewOff(pr.repo)) {
      if (row.preview_state !== "off") {
        await dbq("UPDATE gt_factory_runs SET preview_state = 'off', preview_url = NULL, preview_error = NULL WHERE id = ?", [run.id]).catch(() => {});
        void refreshRoom(run.channelId);
      }
      continue;
    }
    // Sin estado (nuevo o «Reintentar») cuenta como commit nuevo: se vuelve a pedir `up`.
    const sameSha = row.preview_sha === head.sha && !!row.preview_state;
    // Una preview «lista» de NUESTRA caja puede morir (la caja se recicla o caduca) y la tarjeta
    // seguía en verde con un 404 (MailMask #10, 4-oct). Se pregunta a gs si la caja sigue; si no,
    // se borra el estado y el siguiente tick la reconstruye.
    if (sameSha && row.preview_state === "ready" && !(await P.hostingHasPreviews(sub, pr.repo))) {
      const st = await P.gsPreview("status", { repo: pr.repo, pr: pr.number }).catch(() => undefined);
      if (st !== undefined && (!st?.status || st.status.phase !== "ready" || st.status.sha !== head.sha)) {
        await dbq("UPDATE gt_factory_runs SET preview_state = NULL, preview_url = NULL WHERE id = ?", [run.id]).catch(() => {});
        lastPreviewCheck.delete(run.id);
        void refreshRoom(run.channelId);
      }
      continue;
    }
    if (sameSha && (row.preview_state === "ready" || row.preview_state === "failed" || row.preview_state === "needs_env")) continue;
    // Commit nuevo: la liga vieja ya no muestra el PR de hoy. Se quita YA (pendiente), aunque
    // pedir la nueva falle; antes, si `up` fallaba, la tarjeta seguía en verde con la vieja.
    if (!sameSha && row.preview_state === "ready") {
      await dbq("UPDATE gt_factory_runs SET preview_state = 'pending', preview_url = NULL, preview_sha = ? WHERE id = ?", [head.sha, run.id]).catch(() => {});
      void refreshRoom(run.channelId);
    }

    let next: { state: "pending" | "ready" | "failed" | "needs_env"; url: string | null; provider: string | null; error: string | null } | null = null;
    if (await P.hostingHasPreviews(sub, pr.repo)) {
      const p = await P.commitPreview(sub, pr.repo, head.sha);
      if (p.state === "ready") next = { state: "ready", url: p.url, provider: p.provider, error: null };
      else if (p.state === "failed") next = { state: "failed", url: null, provider: p.provider, error: "el hosting no pudo publicar la preview" };
      else next = { state: "pending", url: null, provider: p.provider, error: null };
    } else if (await missingPreviewEnv(sub, pr.repo)) {
      // Con .env.example y sin variables guardadas, la app no arrancaría: no se gasta una caja,
      // se piden en el hilo (guardarlas la reintenta sola).
      next = { state: "needs_env", url: null, provider: null, error: null };
    } else {
      try {
        // Pendiente del mismo commit: se pregunta cómo va; si la caja ya no existe, se vuelve a pedir.
        let b: import("./preview.server").BoxPreview | null =
          sameSha && row.preview_state === "pending" ? (await P.gsPreview("status", { repo: pr.repo, pr: pr.number })).status : null;
        if (!b) b = await P.gsPreview("up", { repo: pr.repo, pr: pr.number, sha: head.sha });
        if (!b || b.sha !== head.sha) next = { state: "pending", url: null, provider: null, error: null };
        else if (b.phase === "ready") next = { state: "ready", url: b.url, provider: null, error: null };
        else if (b.phase === "failed") next = { state: "failed", url: null, provider: null, error: b.error };
        else next = { state: "pending", url: null, provider: null, error: null };
      } catch (e) {
        // Sin capacidad o gs caído: se reintenta en el siguiente tick, sin avisar a nadie.
        console.warn(`[factory] preview #${run.id}: ${(e as Error).message}`);
        continue;
      }
    }
    const changed = await dbq(
      `UPDATE gt_factory_runs SET preview_state = ?, preview_url = ?, preview_sha = ?, preview_error = ?
       WHERE id = ? AND NOT (COALESCE(preview_state,'') = ? AND COALESCE(preview_sha,'') = ?) RETURNING id`,
      [next.state, next.url, head.sha, next.error, run.id, next.state, head.sha],
    );
    if (!changed.length) continue;
    void refreshRoom(run.channelId);
    if (next.state === "ready")
      // Mientras Build sigue empujando commits no se anuncia cada uno (sería ruido): la tarjeta
      // ya muestra la liga vigente. Se anuncia al llegar a revisión, escalado o PR listo.
      {
        if (run.status !== "building")
          await postInThread(run, "build", `🔎 **Preview ${row.preview_sha && !sameSha ? "actualizada" : "lista"}**${next.provider ? ` (${next.provider})` : ""} · [Abrir](${next.url})`);
      }
    else if (next.state === "needs_env")
      await postInThread(
        run,
        "build",
        `🔑 **La preview necesita las variables de \`${pr.repo}\`.** Guárdalas con datos de prueba y arranca sola: ` +
          `[Guardar variables](/factory?repo=${encodeURIComponent(pr.repo)})`,
      );
    else if (next.state === "failed")
      // Tarjeta con paso, causa, qué hacer y el log plegado (ver lib/preview-errors.ts).
      await postInThread(run, "build", "```gt-preview-error\n" + JSON.stringify({ runId: run.id }) + "\n```\n⚠️ La preview no arrancó.");
  }
}

/**
 * Vuelve a intentar las previews que fallaron (de un pedido, o de todos los de un repo): se
 * olvida el estado y el siguiente tick las levanta otra vez. Lo usan «Reintentar» en la
 * tarjeta y guardar variables.
 */
export async function retryPreviews(by: { runId?: number; repo?: string }): Promise<number> {
  const rows = await dbq(
    by.runId
      ? `UPDATE gt_factory_runs SET preview_state = 'pending', preview_sha = NULL, preview_error = NULL WHERE id = ? AND preview_state IN ('failed','needs_env') RETURNING id, channel_id`
      : `UPDATE gt_factory_runs SET preview_state = 'pending', preview_sha = NULL, preview_error = NULL WHERE repo = ? AND preview_state IN ('failed','needs_env') RETURNING id, channel_id`,
    [by.runId ?? by.repo ?? ""],
  ).catch(() => []);
  for (const r of rows) {
    lastPreviewCheck.delete(Number(r.id));
    void refreshRoom(Number(r.channel_id));
  }
  return rows.length;
}

/** ¿El dueño apagó la preview de este repo («Sin preview»)? */
export async function repoPreviewOff(repo: string): Promise<boolean> {
  const rows = await dbq("SELECT preview_off FROM gt_factory_repo_prefs WHERE repo = ?", [repo.toLowerCase()]).catch(() => []);
  return Number(rows[0]?.preview_off ?? 0) === 1;
}

/**
 * «Sin preview» / «Encender» desde la tarjeta: vale para TODO el repo. Al apagar se bajan las
 * cajas de sus PRs vivos y los pedidos quedan en `off`; al encender se olvida el estado y el
 * siguiente tick la levanta (o pide variables) como siempre.
 */
export async function setRepoPreviewOff(repo: string, off: boolean, by: string): Promise<void> {
  const key = repo.toLowerCase();
  await dbq(
    `INSERT INTO gt_factory_repo_prefs (repo, preview_off, updated_by, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(repo) DO UPDATE SET preview_off = excluded.preview_off, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, off ? 1 : 0, by],
  );
  const rows = await dbq(
    off
      ? `UPDATE gt_factory_runs SET preview_state = 'off', preview_url = NULL, preview_error = NULL WHERE LOWER(repo) = ? AND status NOT IN ('done','cancelled') RETURNING id, channel_id, pr_url`
      : `UPDATE gt_factory_runs SET preview_state = NULL, preview_sha = NULL WHERE LOWER(repo) = ? AND preview_state = 'off' RETURNING id, channel_id, pr_url`,
    [key],
  ).catch(() => []);
  const P = off ? await import("./preview.server") : null;
  for (const r of rows) {
    lastPreviewCheck.delete(Number(r.id));
    const pr = r.pr_url ? parsePrUrl(String(r.pr_url)) : null;
    if (P && pr) void P.gsPreview("down", { repo: pr.repo, pr: pr.number }).catch(() => {});
    void refreshRoom(Number(r.channel_id));
  }
  const { invalidateReadiness } = await import("./readiness.server");
  invalidateReadiness(repo);
}

/** ¿El repo pide variables (.env.example) y no hay ninguna guardada para su preview? */
async function missingPreviewEnv(sub: string, repo: string): Promise<boolean> {
  const { repoReadiness } = await import("./readiness.server");
  const r = await repoReadiness(sub, repo).catch(() => null);
  if (!r || "error" in r) return false;
  return r.facts.envExampleKeys.length > 0 && !r.facts.envSavedKeys;
}

export type RunPreviewState = "none" | "pending" | "ready" | "failed" | "needs_env" | "off";

/** Lo que la tarjeta y @check saben de la preview del pedido (leído de la fila). */
export async function runPreview(runId: number): Promise<{ state: RunPreviewState; url: string | null; error: string | null }> {
  const rows = await dbq("SELECT status, preview_state, preview_url, preview_error FROM gt_factory_runs WHERE id = ?", [runId]).catch(() => []);
  const r = rows[0];
  // Cerrado = su caja ya se bajó: las filas viejas aún guardan la liga muerta.
  const closed = r?.status === "done" || r?.status === "cancelled";
  const state = (closed ? "none" : (r?.preview_state ?? "none")) as RunPreviewState;
  return { state, url: state === "ready" ? (r?.preview_url ?? null) : null, error: state === "failed" ? (r?.preview_error ?? null) : null };
}

/**
 * «mézclalo» (o «sí», «dale», «merge») en el hilo de un pedido al que ya se le preguntó:
 * mezcla el PR con las credenciales de QUIEN contesta y avisa. true = el mensaje se consumió
 * (nadie más lo contesta). Nunca lanza.
 */
export async function maybeMergeReply(opts: { channelId: number; rootId: number; text: string; sub: string }): Promise<boolean> {
  try {
    if (!/^(s[ií]|m[eé]zclalo|mezcla|mergea(lo)?|merge|dale|va|adelante)[\s.!]*$/i.test(opts.text.trim())) return false;
    const run = await runOfThread(opts.channelId, opts.rootId);
    if (!run || run.status !== "pr_review" || !run.prUrl) return false;
    const asked = await dbq("SELECT merge_asked FROM gt_factory_runs WHERE id = ?", [run.id]);
    if (!asked[0]?.merge_asked) return false;
    const r = await mergeRun(run, opts.sub);
    if (!r.ok) await postInThread(run, "build", `⚠️ No pude hacer el merge: ${r.error}. ${run.prUrl}`);
    return true;
  } catch (e) {
    console.error("[factory] mezclar desde el hilo", e);
    return false;
  }
}

/**
 * Mezcla el PR del pedido con las credenciales de QUIEN lo pide (GitHub decide si puede:
 * aprobación, CI, permisos) y cierra el pedido. Lo usan «mézclalo» en el hilo y «Mezclar»
 * en la tarjeta del veredicto. Nunca lanza.
 */
export async function mergeRun(run: Run, sub: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const pr = run.prUrl ? parsePrUrl(run.prUrl) : null;
  if (!pr) return { ok: false, error: "el pedido no tiene PR" };
  try {
    const { allTools, githubApi } = await import("../connectors/github.server");
    // Base vieja: su CI verde no dice nada del main de hoy (palmera-legal #9 entró sobre el #7 y
    // main tronó). Se pone al día y el merge se vuelve a ofrecer con el CI de la cabeza nueva.
    // Si GitHub no contesta, se mezcla como antes: una caída no traba los merges.
    const info = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null);
    const base = info?.base?.ref, head = info?.head?.sha;
    if (base && head) {
      const cmp = await githubApi(sub, `/repos/${pr.repo}/compare/${encodeURIComponent(base)}...${head}`).catch(() => null);
      if (Number(cmp?.behind_by) > 0) {
        const up = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}/update-branch`, { method: "PUT", body: "{}" }).catch(() => null);
        await dbq("UPDATE gt_factory_runs SET merge_asked = NULL WHERE id = ?", [run.id]).catch(() => {});
        await logEvent(run.id, "behind_main", null, { behindBy: Number(cmp.behind_by), updated: !up?.error });
        // Choques: GitHub no puede ponerlo al día solo. Antes sólo se decía en la tarjeta y el
        // pedido se quedaba en PR (MailMask #17, 5-oct); ahora va a @build como cualquier choque.
        if (up?.error && /conflict/i.test(String(up.error))) {
          await onPrConflict(run, head);
          return { ok: false, error: `El PR tiene conflictos con ${base}: se lo regresé a Build para resolverlos; el merge se vuelve a ofrecer al terminar.` };
        }
        return {
          ok: false,
          error: up?.error
            ? `El PR va ${cmp.behind_by} commit(s) atrás de ${base} y no lo pude poner al día (¿conflictos?): ${up.error}`
            : `El PR iba ${cmp.behind_by} commit(s) atrás de ${base}: lo puse al día y vuelvo a ofrecer el merge cuando su CI pase.`,
        };
      }
    }
    // CI en rojo o corriendo: no se mezcla. Sin CI (`none`) o si GitHub no contesta, como antes:
    // el chip de la tarjeta era la única señal y «Merge» entraba igual (MailMask #8, 4-oct).
    const ci = await prCi(sub, run.prUrl!);
    if (ci?.state === "failure")
      return { ok: false, error: `El CI del PR está en rojo (${ci.failed.join(", ") || "ver checks"}): pídele el arreglo a @build antes del merge.` };
    if (ci?.state === "pending") return { ok: false, error: "El CI del PR sigue corriendo: espera a que termine." };
    const tool = allTools().find((t) => t.name === "github_merge_pr");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error) return { ok: false, error: String(r?.error ?? "GitHub no contestó") };
    // Si el webhook ya cerró el pedido, `onPrEvent` no repite el confeti (antes posteaba con
    // `done ?? run` aunque `applyEvent` hubiera fallado: dos mensajes de «terminado»).
    await onPrEvent(run, "merged", "build");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ¿El PR toca `.github/` (workflows, CODEOWNERS)? false si GitHub no contesta. */
// Archivos del PR (los primeros 100) con sus líneas; [] si GitHub no contesta.
export async function prFiles(sub: string, url: string): Promise<PrFile[]> {
  const pr = parsePrUrl(url);
  if (!pr) return [];
  try {
    const { githubApi } = await import("../connectors/github.server");
    const files = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`);
    return Array.isArray(files)
      ? files.map((f: any) => ({ filename: String(f?.filename ?? ""), additions: Number(f?.additions ?? 0), deletions: Number(f?.deletions ?? 0) }))
      : [];
  } catch {
    return [];
  }
}

export async function prTouchesGithubDir(sub: string, url: string): Promise<boolean> {
  return classifyPrRisk(await prFiles(sub, url)).reasons.includes("github");
}

/**
 * Si el pedido viene de un issue, su PR lo cierra al mezclarse: la plataforma agrega `Closes #N`
 * a la descripción (no se le deja al modelo). Best-effort: nunca lanza.
 */
export async function ensurePrClosesIssue(runId: number, sub: string, url: string): Promise<void> {
  try {
    const rows = await dbq("SELECT issue_number FROM gt_factory_runs WHERE id = ?", [runId]);
    const n = Number(rows[0]?.issue_number ?? 0);
    const pr = parsePrUrl(url);
    if (!n || !pr) return;
    const { allTools, githubApi } = await import("../connectors/github.server");
    const info = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}`);
    if (!info || info.error) return;
    const { withClosingRef } = await import("./factory-flow");
    const body = withClosingRef(info.body, n);
    if (body === String(info.body ?? "")) return;
    const tool = allTools().find((t) => t.name === "github_update_pr");
    await tool?.handler(sub, { repo: pr.repo, number: pr.number, body });
  } catch (e) {
    console.warn(`[factory] Closes #issue en el PR del pedido #${runId}: ${(e as Error).message}`);
  }
}
