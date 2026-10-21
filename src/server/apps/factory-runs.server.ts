// Corridas de la Software Factory: persistencia, estafeta y publicación en el hilo.
//
// La estafeta la pasa la PLATAFORMA: cuando un rol cierra su paso con su tool `factory_*`
// (o una persona firma el plan), aquí se cambia el estado y se despierta al rol siguiente
// con `enqueueWakeup` en el hilo del pedido. Ningún agente decide a quién le toca: así el
// plan no se construye sin firma y @check no se salta.
import { dbq } from "../../dbq.server";
import {
  ESCALATION_ACTIONS,
  MAX_LOOPS,
  RATE_LIMIT_RETRY_S,
  clipReason,
  deduceEscalationKind,
  isEscalationKind,
  isGithubRateLimit,
  nextStatus,
  rateLimitReason,
  stageLabel,
  type EscalationAction,
  type EscalationKind,
  type RunEvent,
  type RunStatus,
} from "./factory-flow";
import { classifyPrRisk, type PrFile } from "./factory-risk";
import { briefMessage, parseBrief, shouldPostBrief, wantsBrief, type EscalationBrief } from "./factory-brief";

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
  /** Lo único que @check revisa en la siguiente vuelta (lo pone quien decide un escalado). */
  checkScope?: string | null;
  /** Firmado pero sin lugar en el tier: espera su caja (`box_state = 'waiting'`). */
  boxWaiting?: boolean;
  /** `sprint`, `dependabot`… (NULL en los pedidos sueltos). */
  kind?: string | null;
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
  boxWaiting: r.box_state === "waiting",
  approvedBy: r.approved_by ?? null,
  checkedSha: r.checked_sha ?? null,
  checkScope: r.check_scope ?? null,
  kind: r.kind ?? null,
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
        /** @plan declaró que se prueba en la preview; null = plan anterior a la marca. */
        requiresPreview: r.requires_preview == null ? null : Number(r.requires_preview) === 1,
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
  // Toda transición rearma el vigía: el aviso de «colgado» era de UN atasco. Sin esto, un pedido
  // avisado una vez quedaba fuera del barrido para siempre aunque luego avanzara y se volviera a
  // atorar (business #136, 21-oct: avisado a las 20:48, atorado de nuevo a las 00:49, 13 h sin nadie).
  const sets = ["status = ?", "updated_at = unixepoch()", "stale_warned_at = NULL", ...cols.map((c) => `${c} = ?`)];
  // Guarda contra carreras (dos firmas a la vez): sólo si sigue en el estado leído.
  // Guarda también la VERSIÓN del plan: una firma de v1 que llega mientras @plan sube v2
  // pasaría el filtro de estado (plan_review → plan_review) y aprobaría un plan que ya no es.
  const rows = await dbq(
    `UPDATE gt_factory_runs SET ${sets.join(", ")} WHERE id = ? AND status = ? AND plan_version = ? RETURNING *`,
    [next, ...cols.map((c) => patch[c] as never), run.id, run.status, run.planVersion],
  );
  if (!rows[0]) throw new Error(`el pedido #${run.id} cambió mientras tanto; vuelve a mirarla`);
  const updated = toRun(rows[0]);
  // Se espera (logEvent no lanza): gs lee el escalado de la bitácora para su brief, y antes la
  // fila podía no estar escrita cuando se le preguntaba.
  await logEvent(updated.id, event, meta.actor ?? null, { from: run.status, to: next, ...meta.data });
  void notifyRunTurn(updated, run.status, meta.data);
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
  // Pedido cerrado: su caja (y la preview que vive en ella) se destruye.
  if (updated.status === "done" || updated.status === "cancelled") void gsRunBox("down", { runId: updated.id }).catch(() => {});
  void syncRunTask(updated, run.status).catch(() => {});
  void refreshRoom(updated.channelId);
  // Al cerrar o escalar: si el pedido no fue sano, gs dice por qué y lo dejamos en el hilo.
  if (["done", "escalated", "cancelled"].includes(updated.status)) void postWhyIfUnhealthy(updated);
  return updated;
}

/** El análisis de gs (`ghosty factory runs why`) tal como lo devuelve con `full`. */
export type RunWhy = {
  healthy: boolean;
  category: string;
  incomplete: string[] | null;
  note: string | null;
  why?: {
    reasons: string[];
    acceptance?: { criterion: string; [k: string]: unknown }[];
    category: string;
    impact: "high" | "medium" | "low";
    summary: string;
    criticalStep: { role: string | null; at: string | null; command: string | null; evidence: string } | null;
    actions: { type: string; text: string }[];
    source: string;
    createdAt?: string;
  };
};

/**
 * El análisis del pedido en gs (`/api/v2/factory/why`, firma de partner con el workspace). `full`
 * trae el análisis entero (lo lee Arqui con `factory_run_review`); `refresh` lo rehace. null si gs
 * no contesta. Nunca lanza.
 */
export async function fetchRunWhy(runId: number, opts: { full?: boolean; refresh?: boolean } = {}): Promise<RunWhy | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const { currentNamespace } = await import("../tenant.server");
    const base = await nativeRuntimeBase();
    const ns = await currentNamespace();
    if (!base || !ns) return null;
    const body = JSON.stringify({ runId, ...(opts.full ? { full: true } : {}), ...(opts.refresh ? { refresh: true } : {}) });
    const res = await fetch(`${base}/api/v2/factory/why`, { method: "POST", headers: partnerHeaders(body, ns), body, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return (await res.json()) as RunWhy;
  } catch (e) {
    console.error("[factory] por qué", e);
    return null;
  }
}

export type RunAdvice = {
  decision: "fix" | "replan";
  why: string;
  buildNote: { point: string; cites: string }[];
  checkScope: string;
  confidence: "high" | "medium" | "low";
  /** La nota lista para mandarla con la decisión: un renglón por punto. */
  note: string;
};

/**
 * «¿Qué hago?» con un pedido escalado (gs `/api/v2/factory/why` con `advise`): arreglar o rehacer
 * el plan, la nota para @build y el alcance de @check. Lanza con el mensaje de gs (no escalado,
 * modelo sin contestar) para que la tarjeta lo enseñe.
 */
export async function fetchRunAdvice(runId: number): Promise<RunAdvice> {
  const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
  const { currentNamespace } = await import("../tenant.server");
  const base = await nativeRuntimeBase();
  const ns = await currentNamespace();
  if (!base || !ns) throw new Error("sin conexión con Ghosty Studio");
  const body = JSON.stringify({ runId, advise: true });
  const res = await fetch(`${base}/api/v2/factory/why`, { method: "POST", headers: partnerHeaders(body, ns), body, signal: AbortSignal.timeout(60_000) });
  const j = (await res.json().catch(() => null)) as { advice?: RunAdvice; message?: string } | null;
  if (!res.ok || !j?.advice) throw new Error(j?.message ?? `gs ${res.status}`);
  return j.advice;
}

/**
 * El brief de decisión de un escalado (gs `/api/v2/factory/why` con `brief`): qué pasa en llano, lo
 * que la plataforma ya verificó y la acción recomendada. Tarda (modelo): 45 s de tope. null si gs no
 * contesta, no está escalado (409), el modelo no respondió (503) o gs aún no lo sabe hacer. Nunca lanza.
 */
export async function fetchRunBrief(runId: number): Promise<EscalationBrief | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const { currentNamespace } = await import("../tenant.server");
    const base = await nativeRuntimeBase();
    const ns = await currentNamespace();
    if (!base || !ns) return null;
    const body = JSON.stringify({ runId, brief: true });
    const res = await fetch(`${base}/api/v2/factory/why`, { method: "POST", headers: partnerHeaders(body, ns), body, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    return parseBrief(await res.json().catch(() => null));
  } catch (e) {
    console.error("[factory] brief", e);
    return null;
  }
}

/**
 * El aviso de un escalado en el hilo. decision/fix/env: si gs da el brief, va ése (con los hallazgos
 * de @check al final); si no, `fallback` tal cual. Un brief por escalado (`brief_posted` con su `at`).
 */
export async function postEscalation(run: Run, kind: EscalationKind, findings: string, fallback: string): Promise<void> {
  const brief = wantsBrief(kind) ? await fetchRunBrief(run.id) : null;
  if (brief) {
    const rows = await dbq("SELECT data_json FROM gt_factory_events WHERE run_id = ? AND type = 'brief_posted'", [run.id]).catch(() => []);
    const posted = rows.map((r) => {
      try {
        return (JSON.parse(String(r.data_json ?? "{}")) as { at?: string | null }).at ?? null;
      } catch {
        return null;
      }
    });
    // Ya se publicó el de este escalado: no se repite, ni el brief ni el aviso viejo.
    if (!shouldPostBrief(brief.at, posted)) return;
    await logEvent(run.id, "brief_posted", "plataforma", { at: brief.at, action: brief.recommend.action });
    await postInThread(run, "check", briefMessage(brief, findings, kind));
    return;
  }
  await postInThread(run, "check", fallback);
}

/**
 * Le pide a gs el análisis del pedido y, si no fue sano (atascos, @build de más de 30 min,
 * vueltas, CI rojo, escalado), deja sus 3 líneas en el hilo: qué pasó, el paso crítico y qué
 * cambiar para la próxima. Patrón de Devin Session Insights, que sólo analiza las sesiones
 * «unhealthy». Si se aprobó sin cumplir un criterio del plan, además despierta a @plan con un
 * postmortem (una vez por pedido). Nunca lanza.
 */
export async function postWhyIfUnhealthy(run: Run): Promise<void> {
  try {
    const j = await fetchRunWhy(run.id);
    if (!j || j.healthy || !j.note) return;
    await postInThread(run, "check", j.note);
    if (j.category === "approved_unmet_criterion") await requestPostmortem(run);
  } catch (e) {
    console.error("[factory] por qué", e);
  }
}

/**
 * Se aprobó (o mezcló) sin cumplir un criterio del plan: @plan revisa el pedido con
 * `factory_run_review` y propone barandales con `factory_suggest`. Una vez por pedido
 * (`postmortem_requested`). true si lo encargó.
 */
export async function requestPostmortem(run: Run): Promise<boolean> {
  const [seen] = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'postmortem_requested' LIMIT 1", [run.id]).catch(() => []);
  if (seen) return false;
  await logEvent(run.id, "postmortem_requested", "plataforma");
  const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
  const text = [
    `Postmortem del pedido #${run.id}: se aprobó sin cumplir un criterio del plan.`,
    `Lee el análisis con factory_run_review {runId: ${run.id}}, di en 2-3 líneas qué criterio faltó y por qué pasó, y propón con factory_suggest los barandales que lo habrían frenado (setup del repo, reglas de @check, CI o una ficha en docs/agents/).`,
    "Habla del proceso, nunca culpes a personas. No reabras el pedido ni le encargues trabajo a @build.",
  ].join("\n");
  return handoff(run, "plan", run.approvedBy ?? run.requestedBy, "postmortem", text, String(w?.origin ?? ""), "", { keySuffix: ":postmortem", skills: false });
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
/** Firmado pero esperando caja: todavía no se trabaja, la tarjeta se queda (o vuelve) a To Do. */
const TASK_WAITING = ["To Do", "Todo", "Por hacer", "Pendiente", "Pendientes", "Backlog"];

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
  const wanted = run.boxWaiting ? TASK_WAITING : TASK_COLUMNS[run.status];
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
/** El último evento `type` del pedido si fue en el commit `sha` (smoke_fail, merge_without_preview). */
export async function lastEventAt(runId: number, type: string, sha: string | null): Promise<{ actor: string | null; data: { sha?: string; fails?: string } } | null> {
  if (!sha) return null;
  const [e] = await dbq("SELECT actor, data_json FROM gt_factory_events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1", [runId, type]).catch(() => []);
  let data: { sha?: string; fails?: string } = {};
  try {
    data = e?.data_json ? JSON.parse(String(e.data_json)) : {};
  } catch { /* bitácora ilegible: como si no hubiera */ }
  return e && data.sha === sha ? { actor: e.actor ? String(e.actor) : null, data } : null;
}

export async function logEvent(runId: number, type: string, actor: string | null = null, data: Record<string, unknown> | null = null): Promise<void> {
  await dbq("INSERT INTO gt_factory_events (run_id, actor, type, data_json) VALUES (?, ?, ?, ?)", [
    runId,
    actor,
    type,
    data ? JSON.stringify(data) : null,
  ]).catch((e) => console.error("[factory] bitácora", e));
}

/**
 * Pedido cancelado: en qué etapa iba (el `from` del evento `cancel`) y por qué. La tarjeta lo usa
 * para dejar con ✓ lo que sí se hizo, como una corrida cancelada de GitHub Actions.
 */
export async function cancelInfo(runId: number): Promise<{ from: string | null; reason: "pr_closed" | "closed_by_person" | "manual"; actor: string | null } | null> {
  const [row] = await dbq("SELECT actor, data_json FROM gt_factory_events WHERE run_id = ? AND type = 'cancel' ORDER BY id DESC LIMIT 1", [runId]).catch(() => []);
  if (!row) return null;
  let data: { from?: string; reason?: string } = {};
  try {
    data = row.data_json ? JSON.parse(String(row.data_json)) : {};
  } catch {}
  const reason = data.reason === "pr_closed" || data.reason === "closed_by_person" ? data.reason : "manual";
  return { from: data.from ?? null, reason, actor: row.actor ? String(row.actor) : null };
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
  // Una versión nueva reemplaza a la que el crítico estuviera revisando.
  await dbq("UPDATE gt_factory_plans SET critique = 'superseded' WHERE run_id = ? AND version < ? AND critique = 'pending'", [run.id, version]).catch(() => {});
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
export async function finishCritique(
  run: Run,
  pass: boolean,
  findings: string,
  origin: string,
  version = run.planVersion,
): Promise<{ ok: boolean; error?: string; status?: string }> {
  const [row] = await dbq("SELECT critique, auto_approve_by, auto_approve_who, decision FROM gt_factory_plans WHERE run_id = ? AND version = ?", [run.id, version]).catch(() => []);
  if (!row || row.critique !== "pending")
    return { ok: false, error: row?.critique === "superseded" ? `el plan v${version} ya fue reemplazado: termina sin repetir nada` : "este plan no espera crítica (ya se revisó)" };
  // Una persona firmó mientras tanto (o el pedido siguió): el veredicto se guarda y, si pide
  // cambios, le llega a @build como nota para que no se pierda.
  if (version !== run.planVersion || run.status !== "plan_review" || row.decision) {
    await dbq("UPDATE gt_factory_plans SET critique = ?, critique_notes = ? WHERE run_id = ? AND version = ?", [pass ? "pass" : "fail", findings.slice(0, 4000) || null, run.id, version]);
    if (!pass && version === run.planVersion && !["done", "cancelled"].includes(run.status)) {
      await addNote(run.id, "@check (crítico del plan)", `Lo que el crítico encontró en el plan v${version} (ya estaba firmado):\n${findings.trim()}`);
      // En el hilo sólo el aviso: el detalle ya viaja a @build en la nota (antes se pegaba entero).
      const n = findings.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s/.test(l)).length;
      await postInThread(run, "check", `🔎 Revisé el plan v${version} después de la firma: ${n > 1 ? `${n} ajustes` : n === 1 ? "un ajuste" : "ajustes"}, ya le llegaron a @build como nota.`);
    }
    return { ok: true, status: run.status };
  }
  await dbq("UPDATE gt_factory_plans SET critique = ?, critique_notes = ? WHERE run_id = ? AND version = ?", [pass ? "pass" : "fail", findings.slice(0, 4000) || null, run.id, version]);
  if (pass) {
    // Sin aviso en el hilo: la tarjeta del plan ya dice «Revisado por @check» y despliega las
    // sugerencias (`critiqueNotes`); al firmar viajan a @build en su encargo (`decide`).
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

/** El escalado de un pedido: tipo, motivo de un renglón, los puntos y lo que se le ofrece a la persona. */
export type Escalation = {
  kind: EscalationKind;
  reason: string;
  points: string[];
  findings: string;
  at: number;
  actions: EscalationAction[];
};

/**
 * Lo que @check dejó al escalar (bloqueo o vueltas agotadas), para pintarlo ARRIBA en la tarjeta:
 * quien aprueba tiene que ver qué está aprobando (mercadito #7: se aprobó en 2 min un cambio a CI
 * y una cifra doble que sólo estaban en un mensaje del hilo). null si no está escalado.
 * Desde el 20-oct (easybits) lleva `kind` y `reason`; los escalados viejos se deducen.
 */
export async function escalationOf(run: Run): Promise<Escalation | null> {
  if (run.status !== "escalated") return null;
  const [row] = await dbq(
    "SELECT data_json, at FROM gt_factory_events WHERE run_id = ? AND type IN ('check_blocked', 'check_fail') ORDER BY id DESC LIMIT 1",
    [run.id],
  ).catch(() => []);
  let data: Record<string, unknown> = {};
  try {
    data = row?.data_json ? JSON.parse(String(row.data_json)) : {};
  } catch {
    return null;
  }
  return escalationFromEvent(data, Number(row?.at ?? 0));
}

/** Pura: el escalado a partir del `data` de su evento (`check_blocked`/`check_fail`). */
export function escalationFromEvent(data: Record<string, unknown>, at: number): Escalation | null {
  const findings = String(data.findings ?? "");
  if (!findings && !data.reason) return null;
  const kind = isEscalationKind(data.kind) ? data.kind : deduceEscalationKind(findings);
  const points = findings ? findingPoints(findings) : [];
  // Límite de GitHub (#137): no hay preview que reintentar, sólo que @check revise otra vez.
  const rateLimited = kind === "platform" && (data.cause === "github_rate_limit" || isGithubRateLimit(`${findings}\n${data.reason ?? ""}`));
  const reason = clipReason(String(data.reason ?? "") || (rateLimited ? "GitHub limitó las peticiones; @check revisa otra vez sola." : points[0]) || "");
  return { kind, reason, points, findings, at, actions: rateLimited ? ["recheck"] : ESCALATION_ACTIONS[kind] };
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
export async function notifyRunTurn(run: Run, from: RunStatus | null, data?: Record<string, unknown>): Promise<void> {
  if (from === run.status) return;
  const body = turnNoticeBody(run.status, data);
  if (!body) return;
  const to = new Set([run.requestedBy, run.status === "pr_review" || run.status === "done" ? run.approvedBy : null].filter(Boolean) as string[]);
  await notifyRun(run, [...to], body, `factory:${run.id}:${run.status}`);
}

/**
 * El texto del aviso al cambiar de etapa (null = no se avisa). Un escalado dice su motivo, no un
 * texto fijo: en easybits (20-oct) llegaron ocho «La fábrica necesita que decidas» sin decir qué.
 * Una falla de la plataforma no timbra a nadie: se reintenta sola y se avisa una vez por repo.
 */
export function turnNoticeBody(status: RunStatus, data?: Record<string, unknown>): string | null {
  if (status === "escalated") {
    if (data?.kind === "platform") return null;
    const reason = clipReason(String(data?.reason ?? ""));
    return reason || "La fábrica necesita que decidas cómo seguir.";
  }
  const copy: Partial<Record<RunStatus, string>> = {
    plan_review: "El plan está listo: falta tu firma.",
    pr_review: "El PR está listo para que lo revises y le hagas merge.",
    done: "Terminó.",
  };
  return copy[status] ?? null;
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

/** Un pedido ya avisado como colgado se vuelve a retomar solo cada tanto… */
export const STALE_RETRY_SECONDS = 2 * 3600;
/** …con tope por día: si cuatro intentos no lo movieron, el problema no se arregla insistiendo. */
export const MAX_AUTO_RESUMES_PER_DAY = 4;

/**
 * El origin con el que se despierta a un rol cuando quien encarga no trae uno (barrido, recheck de
 * la plataforma): el último de los encargos de este pedido; si no, el de cualquier encargo del
 * espacio (respeta dominios propios); si no, el subdominio del espacio. Sin esto el auto-retomar
 * no encontraba origin y saltaba directo al aviso (business #137, 20-oct: todos sus encargos
 * venían de la plataforma, con origin vacío). Nunca lanza; "" si de plano no hay.
 */
export async function fallbackOrigin(runId: number): Promise<string> {
  try {
    const [w] = await dbq(
      "SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1",
      [`factory:${runId}:%`],
    ).catch(() => []);
    if (w?.origin) return String(w.origin);
    const [any] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1").catch(() => []);
    if (any?.origin) return String(any.origin);
    const { currentSlug } = await import("../tenant.server");
    const slug = await currentSlug().catch(() => null);
    return slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : "";
  } catch {
    return "";
  }
}

/** Despierta al rol de la etapa con el encargo de «retomar (automático)». true si quedó encolado. */
async function autoResume(run: Run, retry: boolean): Promise<boolean> {
  const role = ({ planning: "plan", building: "build", checking: "check" } as const)[run.status as "planning" | "building" | "checking"];
  if (!role) return false;
  const origin = await fallbackOrigin(run.id);
  if (!origin) return false;
  const ok = await handoff(
    run,
    role,
    run.approvedBy ?? run.requestedBy,
    "retomar (automático)",
    `Este pedido lleva ${retry ? "horas" : "30 min"} sin avanzar y nadie está trabajando en él: tu turno anterior terminó sin cerrar tu paso. ` +
      `Revisa lo último del hilo, continúa y ciérralo con tu tool factory_*.` +
      (role === "build" ? await takeNotes(run.id) : ""),
    origin,
  ).catch(() => false);
  if (!ok) return false;
  await logEvent(run.id, "auto_resumed", null, retry ? { role, retry: true } : { role });
  await postInThread(run, role, retry ? `🔁 Sigue sin avanzar: lo retomo otra vez.` : `🔁 Llevaba 30 min sin avanzar: retomo el pedido.`).catch(() => null);
  void refreshRoom(run.channelId);
  return true;
}

/**
 * Barrido: pedidos abiertos sin un solo evento ni mensaje en 30 min y sin nadie trabajando. Lo
 * llama el timer de wakeups.
 *
 * 1. La plataforma lo retoma SOLA, una vez por atasco.
 * 2. Si tras eso sigue parado, se avisa UNA vez a quien lo pidió (`stale_warned_at`).
 * 3. Avisado, la plataforma sigue intentando cada `STALE_RETRY_SECONDS`, hasta
 *    `MAX_AUTO_RESUMES_PER_DAY` al día. Antes quedaba estacionado hasta que una persona lo
 *    retomara (business #137, 20-oct: 16 h en «checking»).
 *
 * Entran también los que esperan caja fuera de `building`: sólo ésos los reintenta el tick de
 * cajas, y un planning/checking en espera se quedaba colgado sin que nadie lo mirara.
 */
export async function sweepStaleRuns(isBusy: (run: Run) => boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await dbq(
    `SELECT r.*, MAX(COALESCE((SELECT MAX(at) FROM gt_factory_events e WHERE e.run_id = r.id), 0),
            COALESCE((SELECT MAX(created_at) FROM gc_messages m WHERE m.parent_id = r.root_msg_id AND m.channel_id = r.channel_id), 0),
            r.updated_at) AS last_at
       FROM gt_factory_runs r
      WHERE r.status IN ('planning','building','checking') AND (r.kind IS NULL OR r.kind != 'eval')
        AND NOT (COALESCE(r.box_state, '') = 'waiting' AND r.status = 'building')`,
  ).catch(() => []);
  for (const r of rows) {
    if (now - Number(r.last_at ?? now) < STALE_SECONDS) continue;
    const run = toRun(r);
    if (isBusy(run)) continue;
    const warnedAt = Number(r.stale_warned_at ?? 0);
    const [lastEv] = await dbq("SELECT type FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT 1", [run.id]).catch(() => []);
    // `waiting_person`: el rol preguntó y espera a la persona; retomarlo solo sería contestarse.
    const waitingPerson = lastEv?.type === "waiting_person";
    if (warnedAt) {
      if (waitingPerson) continue;
      const tries = await dbq(
        "SELECT at FROM gt_factory_events WHERE run_id = ? AND type = 'auto_resumed' AND at > ? ORDER BY id DESC",
        [run.id, now - 86400],
      ).catch(() => []);
      if (tries.length >= MAX_AUTO_RESUMES_PER_DAY) continue;
      if (now - Math.max(warnedAt, Number(tries[0]?.at ?? 0)) < STALE_RETRY_SECONDS) continue;
      await autoResume(run, true);
      continue;
    }
    // Primero la plataforma lo retoma SOLA, una vez por atasco: el rol terminó su turno sin
    // cerrar su paso y nadie lo iba a mover. Una persona no sabe que existe «Retomar» (MailMask,
    // 4-oct: @build parado una hora con la tarjeta diciendo «construyendo…»). Si tras eso sigue
    // parado (su último evento sigue siendo el auto-retomar), ahora sí se avisa.
    if (lastEv?.type !== "auto_resumed" && !waitingPerson && (await autoResume(run, false))) continue;
    const marked = await dbq("UPDATE gt_factory_runs SET stale_warned_at = ? WHERE id = ? AND stale_warned_at IS NULL RETURNING id", [now, run.id]).catch(() => []);
    if (!marked.length) continue;
    await logEvent(run.id, "stale", null, { status: run.status });
    await notifyRun(run, [run.requestedBy], "Lleva 30 min sin avanzar. Ábrelo para retomarlo o detenerlo.", `factory:${run.id}:stale`);
    void refreshRoom(run.channelId);
  }
}

// ── Atascos en vivo ──────────────────────────────────────────────────────────

/** Frame `stalled` de gs: su vigilante vio un atasco en el turno de un rol (reglas deterministas). */
export type StalledFrame = { rule?: string; detail?: string; count?: number; secs?: number | null; human?: string; steer?: string };

/** Un mismo atasco (regla + comando) no se vuelve a avisar en este lapso. */
const STUCK_REARM_SECONDS = 30 * 60;

/**
 * gs avisa que el turno de un rol de la fábrica está atascado (un comando de 8+ min, el mismo
 * comando repetido, errores en fila, ir y venir, apt a mano). Escalera, sin matar ni abortar nada:
 * aviso en el hilo + steer al rol (le llega con el siguiente resultado de tool, justo cuando decide
 * si lo vuelve a esperar); desde el segundo atasco del pedido, push a quien lo pidió (una vez).
 * Nació del #13 de mercadito-verde (6-oct): cinco esperas de ~10 min sin que nadie se enterara.
 * Nunca lanza.
 */
export async function onRoleStalled(groupId: string, ev: StalledFrame): Promise<void> {
  try {
    const m = /-([a-z0-9_]+)-factory-(\d+)$/.exec(groupId);
    const role = m?.[1];
    if (!m || (role !== "plan" && role !== "build" && role !== "check")) return;
    const run = await getRun(Number(m[2]));
    if (!run || !["planning", "building", "checking"].includes(run.status)) return;
    const rule = String(ev.rule ?? "");
    const detail = String(ev.detail ?? "").slice(0, 240);
    const now = Math.floor(Date.now() / 1000);
    const prior = await dbq("SELECT at, data_json FROM gt_factory_events WHERE run_id = ? AND type = 'stuck' ORDER BY id", [run.id]).catch(() => []);
    const same = prior.some((p: Record<string, unknown>) => {
      try {
        const d = JSON.parse(String(p.data_json ?? "{}"));
        return d.rule === rule && d.detail === detail && now - Number(p.at) < STUCK_REARM_SECONDS;
      } catch {
        return false;
      }
    });
    if (same) return;
    const firstOfRun = prior.length === 0;
    const human = String(ev.human ?? `parece atascado (${rule}).`);
    // `human` va en la bitácora: el teléfono la pinta tal cual («se atoró: lleva 6 min en …»).
    await logEvent(run.id, "stuck", null, { role, rule, detail, count: ev.count ?? null, secs: ev.secs ?? null, human: human.slice(0, 300) });
    // Atasco de RAZONAMIENTO de Worker (no del entorno): entra Arqui (su modelo fuerte) como
    // asesor. Lo de entorno (comando colgado, apt) sigue con el aviso de siempre.
    // Primero el empujón gratis (el steer de abajo); desde el segundo atasco de Worker en el pedido,
    // el asesor (Gemini CLI y OpenHands también avisan antes de escalar).
    const priorBuild = prior.some((p: Record<string, unknown>) => {
      try {
        return JSON.parse(String(p.data_json ?? "{}")).role === "build";
      } catch {
        return false;
      }
    });
    if (role === "build" && priorBuild && ADVICE_RULES.has(rule)) {
      const r = await requestAdvice(run, { by: "auto", what: human, tried: detail });
      if (r.ok) {
        await steerRole(run, "build", `${ev.steer ?? ""} Le pedí consejo a Arqui: te llega en vivo. Mientras, no repitas lo mismo.`.trim());
        void refreshRoom(run.channelId);
        return;
      }
    }
    const steered = ev.steer ? await steerRole(run, role, String(ev.steer)) : false;
    await postInThread(run, role, `⏳ @${role} ${human}${steered ? " Ya le pedí revisarlo en cuanto regrese el comando." : ""}`);
    if (!firstOfRun) {
      const [sent] = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'stuck_notified' LIMIT 1", [run.id]).catch(() => []);
      if (!sent) {
        await logEvent(run.id, "stuck_notified", null, { role });
        await notifyRun(run, [run.requestedBy], `@${role} parece atascado: ${human}`, `factory:${run.id}:stuck`);
      }
    }
    void refreshRoom(run.channelId);
  } catch (e) {
    console.error("[factory] atasco", e);
  }
}

// ── Refuerzo: Arqui como asesor de Worker ─────────────────────────────────────

/** Atascos de razonamiento (no del entorno) que llaman al asesor solos. */
const ADVICE_RULES = new Set(["repeat", "repeat_error", "ping_pong"]);
/** Consejos por pedido: el asesor es caro y no debe volverse el constructor de tiempo completo. */
export const MAX_ADVICE = 2;

/**
 * Worker se atoró: Arqui (el agente de @check, con su modelo: Opus) le da diagnóstico y siguiente paso en
 * un turno aparte que SÓLO aconseja (`ADVISOR_ROLE`). Lo pide Worker con `factory_help` o el
 * vigilante al ver un atasco de razonamiento. El consejo sale en el hilo y le llega a Worker en
 * vivo (`deliverAdvice`). Tope `MAX_ADVICE` por pedido. Nunca lanza.
 */
export async function requestAdvice(
  run: Run,
  ask: { by: "worker" | "auto"; what: string; tried: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (run.status !== "building") return { ok: false, error: "el asesor sólo entra mientras Worker construye" };
    const [n] = await dbq("SELECT COUNT(*) AS n FROM gt_factory_events WHERE run_id = ? AND type = 'advice'", [run.id]).catch(() => []);
    if (Number(n?.n ?? 0) >= MAX_ADVICE) return { ok: false, error: `ya van ${MAX_ADVICE} consejos en este pedido: decide con lo que tienes o pregúntale a la persona en el hilo` };
    const { resolvedAgents } = await import("../../agents.server");
    const arqui = (await resolvedAgents()).find((a) => a.handle === "check");
    if (!arqui || arqui.backend.kind !== "fleet") return { ok: false, error: "no hay un Arqui (@check) en este espacio" };
    const [w] = await dbq("SELECT origin FROM gt_agent_wakeups WHERE key LIKE ? AND origin IS NOT NULL AND origin != '' ORDER BY rowid DESC LIMIT 1", [`factory:${run.id}:%`]).catch(() => []);
    const nth = Number(n?.n ?? 0) + 1;
    await logEvent(run.id, "advice", ask.by === "worker" ? "build" : null, { by: ask.by, what: ask.what.slice(0, 300) });
    await postInThread(run, "build", `🛟 Refuerzo ${nth}/${MAX_ADVICE} · ${ask.by === "worker" ? "Worker pidió ayuda" : "Worker se atoró"}: Arqui le da diagnóstico y siguiente paso.`).catch(() => null);
    const plan = run.planVersion ? await getPlan(run.id, run.planVersion).catch(() => null) : null;
    const text =
      `Worker (el rol @build) se atoró construyendo este pedido y necesita tu consejo.\n\n` +
      `Qué falla: ${ask.what.slice(0, 1500)}\n` +
      `Qué intentó: ${ask.tried.slice(0, 1500) || "(no lo dijo)"}\n` +
      (run.branch ? `Rama: ${run.branch}\n` : "") +
      (plan?.planMd ? `\nPlan aprobado (resumen):\n${plan.planMd.slice(0, 4000)}` : "");
    const ok = await handoff(run, "check", run.approvedBy ?? run.requestedBy, ask.by === "worker" ? "refuerzo pedido por Worker" : "refuerzo por atasco", text, String(w?.origin ?? ""), "-advisor", {
      keySuffix: ":advice",
      skills: false,
      dest: { factoryMode: "advisor" },
    });
    return ok ? { ok: true } : { ok: false, error: "no pude despertar al asesor" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** El consejo de Arqui-asesor llega a Worker: en vivo si está trabajando; si no, lo despierta. */
async function deliverAdvice(run: Run, reply: string, origin: string): Promise<void> {
  const advice = reply.trim();
  const now = (await getRun(run.id)) ?? run;
  if (!advice || now.status !== "building") return;
  const body = `Consejo de Arqui para destrabarte:\n${advice.slice(0, 3000)}\n\nSíguelo y continúa tu paso; no lo repitas en el hilo.`;
  if (await steerRole(now, "build", body)) return;
  await handoff(now, "build", now.approvedBy ?? now.requestedBy, "consejo de Arqui", body, origin, "", { keySuffix: ":msg", skills: false });
}

// ── Caja por pedido ──────────────────────────────────────────────────────────

/** Llamada firmada a gs `internal/workspace-runbox` (mismo esquema que `gsPreview`). */
export async function gsRunBox(op: "up" | "status" | "down" | "slot" | "release" | "notify_admin", body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug();
  if (!slug) throw new Error("sin espacio");
  const raw = JSON.stringify({ op, ...body });
  const crypto = await import("node:crypto");
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET!).update(`${ts}.${slug}.${raw}`).digest("hex");
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const res = await fetch(`${IDP}/internal/workspace-runbox/${encodeURIComponent(slug)}?ts=${ts}&sig=${sig}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Los agentes de Studio que harán @build y @check en este pedido (los que podrán usar la caja). */
async function runBoxAgents(run: Run): Promise<string[]> {
  const { resolvedAgents } = await import("../../agents.server");
  const { factoryTurnFor } = await import("./factory-team.server");
  const agents = await resolvedAgents();
  const ids: string[] = [];
  for (const role of ["build", "check"] as const) {
    const a = agents.find((x) => x.handle === role);
    const def = a?.backend.kind === "fleet" ? a.backend.id : "";
    const ft = await factoryTurnFor(role, { channelId: run.channelId, parentId: run.rootMsgId }, def).catch(() => null);
    const id = ft?.fleetId ?? def;
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * La caja del pedido (una `dev-box` de 4 GB en gs). `ready` = existe; `waiting` = el espacio ya
 * tiene tantos pedidos en curso como su tier (F1 = 1) y éste espera; `off` = sin repo o gs no
 * pudo, y el pedido sigue por el camino de antes (el agente pide su caja con `ensure`).
 */
export async function ensureRunBox(run: Run): Promise<"ready" | "waiting" | "off"> {
  if (!run.repo) return "off";
  try {
    const r = await gsRunBox("up", { runId: run.id, repo: run.repo, agents: await runBoxAgents(run) });
    if (r.status === 200 && r.json?.boxId) {
      // Un pedido desplaza previews sueltas: su botón dirá que se soltó para dar lugar.
      if (Array.isArray(r.json.evicted) && r.json.evicted.length)
        await (await import("./pr-preview.server")).recordEvictedPreviews(r.json.evicted).catch(() => {});
      const [prev] = await dbq("SELECT box_state FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
      await dbq("UPDATE gt_factory_runs SET box_id = ?, box_state = 'ready' WHERE id = ?", [String(r.json.boxId), run.id]);
      if (prev?.box_state === "waiting") await logEvent(run.id, "box_ready", null, { box: r.json.boxId });
      // Cortesía de lugar (gs, 21-oct): no cabía y gs le prestó lugar este mes. La nota va al hilo UNA vez
      // por pedido (si la caja se rehace con la misma cortesía, no se repite).
      const c = r.json.courtesy;
      if (c?.note) {
        const seen = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'box_courtesy' LIMIT 1", [run.id]).catch(() => []);
        if (!seen.length) {
          await logEvent(run.id, "box_courtesy", null, { slots: c.slots, month: c.month });
          await postInThread(run, "build", courtesyText(String(c.note), await plansLink())).catch(() => null);
        }
      }
      return "ready";
    }
    if (r.status === 409 && r.json?.error === "no_slot") {
      const [prev] = await dbq("SELECT box_state FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
      if (prev?.box_state !== "waiting") {
        await dbq("UPDATE gt_factory_runs SET box_state = 'waiting' WHERE id = ?", [run.id]);
        await logEvent(run.id, "box_waiting", null, { tier: r.json.tier, busy: r.json.busy, courtesyUsed: !!r.json.courtesyUsed });
        void syncRunTask({ ...run, boxWaiting: true }, "waiting").catch(() => {});
        void import("./sprint.server").then((S) => S.onSprintRunChanged(run.id)).catch(() => {});
        // gs manda su nota (quién ocupa cada lugar, cortesía usada y cuándo se renueva) desde el 21-oct.
        const text = typeof r.json.note === "string" && r.json.note ? queuedText(r.json.note, await plansLink()) : waitingForSlotText(r.json.tier, Number(r.json.max), r.json.busy ?? []);
        await postInThread(run, "build", text).catch(() => null);
        void refreshRoom(run.channelId);
      }
      return "waiting";
    }
    console.warn(`[factory] caja del pedido #${run.id}: gs ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[factory] caja del pedido #${run.id}: ${(e as Error).message}`);
  }
  await dbq("UPDATE gt_factory_runs SET box_state = 'off' WHERE id = ?", [run.id]).catch(() => {});
  return "off";
}

/**
 * Un pedido en espera vuelve a pedir su caja; si la obtiene, recibe el encargo que quedó guardado y
 * todas las vistas (tarjeta, barra, tablero, sprint, Tasks) se repintan. Lo usan el tick y «Retomar».
 */
export async function resumeWaitingRun(run: Run): Promise<"ready" | "waiting" | "off"> {
  const st = await ensureRunBox(run);
  if (st === "waiting") return st;
  const [r] = await dbq("SELECT box_handoff FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
  let h: { sub: string; why: string; text: string; origin: string } | null = null;
  try {
    h = JSON.parse(String(r?.box_handoff ?? "null"));
  } catch {}
  await dbq("UPDATE gt_factory_runs SET box_handoff = NULL WHERE id = ?", [run.id]);
  const fresh = (await getRun(run.id)) ?? run;
  void syncRunTask(fresh, "plan_review").catch(() => {});
  void import("./sprint.server").then((S) => S.onSprintRunChanged(run.id)).catch(() => {});
  void refreshRoom(run.channelId);
  // El encargo guardado es de @build: si el pedido ya cambió de etapa (otra vuelta, recheck) ya
  // no aplica, y al rol de la etapa lo mueve el vigía de colgados (ahora que ya no está en espera).
  if (h && fresh.status === "building")
    await handoff(fresh, "build", h.sub, h.why, h.text, h.origin).catch((e) => console.warn(`[factory] encargo en cola #${run.id}: ${(e as Error).message}`));
  return st;
}

/**
 * Tick: los pedidos en cola por caja vuelven a pedirla, del más viejo al más nuevo. Todas las
 * etapas abiertas, no sólo `building`: un pedido que pasó a planning/checking con la caja aún en
 * espera no lo miraba nadie y se quedaba así para siempre.
 */
export async function retryWaitingRunBoxes(): Promise<void> {
  const rows = await dbq(
    "SELECT * FROM gt_factory_runs WHERE box_state = 'waiting' AND status IN ('planning','building','checking') ORDER BY updated_at ASC LIMIT 5",
  ).catch(() => []);
  for (const r of rows) {
    if ((await resumeWaitingRun(toRun(r))) === "waiting") break; // el primero no cupo: los demás tampoco
  }
}

/**
 * ¿La caja del pedido sigue viva? gs la puede haber tirado (a mano, el barrido de cajas) y el
 * pedido seguía diciendo `ready` con un id muerto: @build y @check trabajaban contra una caja
 * que ya no existe (business #134, 21-oct). Si gs dice que no está, se vuelve a pedir. Si gs no
 * contesta se deja como está. Devuelve el estado con el que queda; null = sin caja que revisar.
 */
export async function verifyRunBox(run: Run): Promise<"ready" | "waiting" | "off" | null> {
  const boxId = await runBoxIdOf(run.id);
  if (!boxId) return null;
  try {
    const r = await gsRunBox("status", { runId: run.id });
    if (r.status !== 200 || !r.json?.ok) return "ready";
    const now = r.json.boxId ? String(r.json.boxId) : null;
    if (now === boxId) return "ready";
    await logEvent(run.id, "box_lost", null, { box: boxId, now });
    if (now) {
      await dbq("UPDATE gt_factory_runs SET box_id = ? WHERE id = ?", [now, run.id]);
      return "ready";
    }
    console.warn(`[factory] la caja ${boxId} del pedido #${run.id} ya no existe: se pide otra`);
    await dbq("UPDATE gt_factory_runs SET box_id = NULL, box_state = NULL WHERE id = ?", [run.id]);
    return await ensureRunBox(run);
  } catch {
    return "ready";
  }
}

/** El id de la caja del pedido de un hilo (null = sin caja). */
export async function runBoxIdOf(runId: number): Promise<string | null> {
  const [r] = await dbq("SELECT box_id, box_state FROM gt_factory_runs WHERE id = ?", [runId]).catch(() => []);
  return r?.box_state === "ready" && r?.box_id ? String(r.box_id) : null;
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

/**
 * Línea de relevo en el hilo (estilo Grok: «Message from…», «Handed to…»): dice QUE dos roles se
 * hablaron o se pasaron el trabajo, nunca el texto. La pinta `RelayLine` (message.tsx).
 */
export type RelayKind = "message" | "handoff";
export const relayFence = (d: { from: string; to: string; kind: RelayKind }) => "```gt-relay\n" + JSON.stringify(d) + "\n```";
export function postRelay(run: Run, d: { from: string; to: string; kind: RelayKind }): void {
  void postInThread(run, d.from, relayFence(d));
}

/** Las sugerencias del crítico que pasó el plan (`critique_notes` con `pass`), para el encargo de
 *  @build. Antes se guardaban y nadie las leía: la persona las veía y @build no. */
export async function critiqueSuggestions(runId: number, version: number): Promise<string> {
  const [row] = await dbq("SELECT critique, critique_notes FROM gt_factory_plans WHERE run_id = ? AND version = ?", [runId, version]).catch(() => []);
  const notes = String(row?.critique_notes ?? "").trim();
  if (row?.critique !== "pass" || !notes) return "";
  return `\n\n## Sugerencias del crítico (opcionales; aplícalas si no cambian el alcance)\n${notes}`;
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
  /** `from`: el rol que pasa el trabajo (pinta la línea de relevo); `keySuffix`: marca del
   *  despertador (`:msg` = mensaje entre roles); `skills: false` = sin la línea de skills. */
  opts: { from?: string; keySuffix?: string; skills?: boolean; dest?: { factoryMode?: "advisor" } } = {},
): Promise<boolean> {
  const t0 = Date.now();
  // Sin origin (barrido, recheck de la plataforma), el de los encargos anteriores o el del espacio.
  if (!origin) origin = await fallbackOrigin(run.id);
  // @build y @check trabajan en la caja del pedido: si gs ya la tiró, se pide otra antes del
  // encargo. Sin lugar, el encargo de @build espera en cola igual que al aprobar (`decide`).
  if ((to === "build" || to === "check") && !groupSuffix) {
    const box = await verifyRunBox(run);
    if (box === "waiting" && to === "build") {
      await dbq("UPDATE gt_factory_runs SET box_handoff = ? WHERE id = ?", [JSON.stringify({ sub, why: cause, text, origin }), run.id]);
      return true;
    }
  }
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
  if ((to === "build" || to === "check") && !groupSuffix && opts.skills !== false) {
    const plan = run.planVersion ? await getPlan(run.id, run.planVersion).catch(() => null) : null;
    skills = `\n\n${(await import("./factory-roles")).roleSkillsLine(to, `${run.title}\n${plan?.planMd ?? ""}`)}`;
  }
  const { enqueueWakeup, mintWakeRef } = await import("../wakeups.server");
  const ok = await enqueueWakeup({
    key: `factory:${run.id}:${to}:${Date.now()}${opts.keySuffix ?? ""}`,
    ref: mintWakeRef({
      sub,
      ns,
      groupId,
      dest: { channelId: run.channelId, parentId: run.rootMsgId, topic: run.topic, handle: agent.handle, name: agent.name, avatar: agent.avatar, ...(opts.dest ?? {}) },
    }),
    cause,
    text: `[Pedido #${run.id} · «${run.title}»${run.repo ? ` · repo ${run.repo}` : ""}]\n${text}${skills}`,
    origin,
    // Vencido YA: con +2 s el barrido inmediato de `kickWakeups` lo veía «aún no» y el relevo
    // esperaba al siguiente tick (pedir cambios tardó ~30 s en arrancar a @plan, MailMask #15).
    dueAt: Math.floor(Date.now() / 1000),
  });
  console.log(`[lat] handoff #${run.id} → @${to} encolado en ${Date.now() - t0}ms`);
  if (ok && opts.from && !groupSuffix && opts.keySuffix !== ":msg") postRelay(run, { from: opts.from, to, kind: "handoff" });
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
 * hace que gs conteste `409 run_not_live` si no hay turno. true sólo si gs confirma `injected`. Sin
 * esto una nota a media obra esperaba al siguiente encargo y @build terminaba con el alcance
 * viejo (MailMask, 4-oct). Nunca lanza.
 */
export async function steerRole(run: Run, role: "plan" | "build" | "check", text: string): Promise<boolean> {
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
    // AG-UI: `steer: true` = el run vivo de este hilo; con `injectOnly`, gs contesta
    // `409 run_not_live` (o `run_active` si no pudo meterlo) en vez de abrir un turno.
    const { buildRunInput } = await import("../gs-agui.server");
    const runId = `teams:${crypto.randomUUID()}`;
    const body = JSON.stringify(
      buildRunInput({
        threadId: groupId,
        runId,
        message: { id: `${runId}:u`, text },
        forwardedProps: { configGroupId: "teams", sender: "plataforma", steer: true, injectOnly: true },
      }),
    );
    const res = await fetch(`${rt.base}/api/v2/fleet-agents/${fleetId}/agui`, {
      method: "POST",
      headers: { ...rt.headers(body, agent.backend.token), Accept: "text/event-stream" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    // `ghosty.injected` = entró. Cualquier fin de run o error = no. Cerrar NO corta el run vivo.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5).trim()) as { type?: string; name?: string };
          if (ev.type === "CUSTOM" && ev.name === "ghosty.injected") return true;
          if (ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") return false;
        }
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
export async function prHead(sub: string, url: string): Promise<{ sha: string; draft: boolean; ref: string | null } | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_get_pr");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error || !r.headSha) return null;
    return { sha: String(r.headSha), draft: !!r.draft, ref: typeof r.head === "string" ? r.head : null };
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
/**
 * «Ya lo resolví, que @check revise otra vez»: el pedido escaló por algo que @build no puede hacer
 * (variables de la preview, un permiso) y una persona lo resolvió. @check vuelve a revisar el MISMO
 * PR sin que @build gaste otra vuelta (#125, 20-oct: faltaban 5 variables y la tarjeta sólo
 * ofrecía «Que @build lo arregle»). No cuenta vuelta.
 */
export async function recheck(opts: { run: Run; sub: string; who: string; note?: string; origin: string }): Promise<Run> {
  const { run } = opts;
  const note = (opts.note ?? "").trim().slice(0, 2000);
  const next = await applyEvent(run, "recheck", {}, { actor: opts.who, data: note ? { note } : {} });
  await postInThread(next, "check", `🔁 ${opts.who} resolvió lo que me bloqueaba${note ? `: ${note}` : ""}. Reviso el PR otra vez.`).catch(() => {});
  const plan = await getPlan(run.id, run.planVersion);
  const previewNeeded = await previewRequired(next);
  await handoff(
    next,
    "check",
    opts.sub,
    "volver a revisar",
    `${opts.who} resolvió lo que te bloqueó en tu revisión anterior${note ? `: «${note}»` : ""}. Revisa OTRA VEZ el PR ${run.prUrl ?? ""} ` +
      `contra el plan APROBADO (v${run.planVersion}). @build no cambió nada: no repitas hallazgos de código que ya diste por buenos.\n\n` +
      `## Plan aprobado\n${plan?.planMd ?? "(no encontré el plan)"}\n\n` +
      (previewNeeded
        ? `Este pedido EXIGE la preview: pide la URL con factory_preview (runId ${run.id}); si se está reconstruyendo con las variables nuevas, ` +
          `espera a que esté lista. Comprueba AHÍ los criterios de aceptación (incluida una acción que envíe datos) y cita la URL en tu veredicto. `
        : `Si el repo publica previews, pide la URL con factory_preview (runId ${run.id}) y comprueba ahí lo que se ve en pantalla. `) +
      `Si sigue faltando algo que @build no puede resolver, vuelve a usar pass=false con su kind (env, skip o decision) y reason, y di exactamente qué. NO edites ni empujes nada. ` +
      `Cierra con factory_check_verdict (runId ${run.id}).`,
    opts.origin,
    "",
  );
  return next;
}

/** El comentario que le pide a Dependabot ignorar la versión mayor o la dependencia. */
export function dependabotIgnoreComment(ignore: "major" | "dependency"): string {
  return ignore === "major" ? "@dependabot ignore this major version" : "@dependabot ignore this dependency";
}

/**
 * «Cerrar PR» / «Cerrar e ignorar esta versión» de un escalado `skip` (easybits #129, 20-oct: un
 * major que el repo no puede adoptar). Con las credenciales de quien conectó el repo (las mismas
 * con que se adoptó el PR); si no hay, las de quien aprobó o pidió. Con `ignore`, primero el
 * comentario a Dependabot (con el PR abierto, o no lo lee) y luego se cierra. El pedido se cancela
 * ANTES, con motivo `closed_by_person`: el webhook del cierre lo encontraría vivo y lo marcaría
 * `pr_closed` (que se reabre solo si alguien reabre el PR).
 */
export async function closeRunPr(run: Run, opts: { ignore: "major" | "dependency" | null; who: string }): Promise<Run> {
  if (run.status === "done" || run.status === "cancelled") throw new Error(`el pedido ya está ${run.status === "done" ? "terminado" : "cancelado"}`);
  const pr = run.prUrl ? parsePrUrl(run.prUrl) : null;
  if (!pr) throw new Error("el pedido no tiene PR que cerrar");
  const db = await import("../../db.server");
  const repoRow = (await db.listRoomRepos(run.channelId).catch(() => [])).find((r) => r.repo.toLowerCase() === pr.repo.toLowerCase());
  const sub = repoRow?.connectedBy ?? run.approvedBy ?? run.requestedBy;
  const next = await applyEvent(run, "cancel", {}, { actor: opts.who, data: { reason: "closed_by_person", ...(opts.ignore ? { ignore: opts.ignore } : {}) } });
  const { githubApi } = await import("../connectors/github.server");
  if (opts.ignore) {
    // Con la cuenta de la persona (no el bot): Dependabot sólo obedece a quien tiene escritura.
    const c = await githubApi(sub, `/repos/${pr.repo}/issues/${pr.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: dependabotIgnoreComment(opts.ignore) }),
    }).catch((e) => ({ error: (e as Error).message }));
    if (c?.error) throw new Error(`el pedido quedó cancelado, pero no pude comentarle a Dependabot: ${c.error}`);
  }
  // Dependabot cierra solo al leer «ignore»; cerrar otra vez un PR cerrado no falla.
  const r = await githubApi(sub, `/repos/${pr.repo}/pulls/${pr.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }).catch((e) => ({
    error: (e as Error).message,
  }));
  if (r?.error) throw new Error(`el pedido quedó cancelado, pero GitHub no cerró el PR: ${r.error}`);
  await postInThread(
    next,
    "check",
    `⏹️ ${opts.who} cerró el PR${opts.ignore ? ` y le pidió a Dependabot ignorar ${opts.ignore === "major" ? "esta versión mayor" : "esta dependencia"}` : ""}. Pedido cancelado. ${run.prUrl}`,
  ).catch(() => {});
  return next;
}

/** El encargo a @build sobre un PR de Dependabot (también en «otra vuelta»: antes se perdía, easybits 20-oct). */
export function dependabotBuildHint(run: Pick<Run, "kind">): string {
  return run.kind === "dependabot"
    ? ` Es una subida de Dependabot: si un paquete exige a sus hermanos en la misma versión (peer dependencies, p. ej. \`@scope/*\`), súbelos juntos ` +
        `y regenera el lockfile con el gestor del repo. En el mismo PR agrega a .github/dependabot.yml un grupo (\`groups\` con \`patterns\`) ` +
        `para esa familia, así la próxima subida llega completa. Tu push detiene los rebases de Dependabot en esa rama: es lo esperado.`
    : "";
}

/**
 * El arranque del encargo a @build al aprobar. Pura para probarla. Desde `escalated` («otra vuelta»)
 * un PR que ya existe (Dependabot, adoptado) también se arregla EN su rama y con el encargo de
 * Dependabot: el 20-oct «Que @build lo arregle» en easybits #132 perdía lo de subir los hermanos.
 */
export function approveBriefLead(run: Pick<Run, "prUrl" | "branch" | "kind">, o: { who: string; version: number; again: boolean }): string {
  const onPr = run.prUrl
    ? `trabaja y empuja en SU rama${run.branch ? ` (${run.branch})` : ""} con factory_git_remote, no abras otro PR, y cierra con factory_build_done.`
    : "";
  if (o.again)
    return (
      `${o.who} pidió otra vuelta. Revisa lo que pide (abajo, en las notas) y los últimos hallazgos de @check en este hilo, corrige en la misma rama y cierra con factory_build_done.` +
      (run.prUrl && run.kind === "dependabot" ? ` El PR es ${run.prUrl}: ${onPr}${dependabotBuildHint(run)}` : "")
    );
  if (run.prUrl)
    // El PR ya existe (Dependabot, PR adoptado): se arregla EN su rama, o su CI y su preview
    // se quedan rojos para siempre mientras el arreglo vive en otro PR.
    return `${o.who} aprobó el plan v${o.version}. Constrúyelo sobre el PR que ya existe (${run.prUrl}): ${onPr}${dependabotBuildHint(run)}`;
  return `${o.who} aprobó el plan v${o.version}. Constrúyelo: rama nueva, código, pruebas, PR en BORRADOR, y cierra con factory_build_done.`;
}

export async function decide(opts: {
  run: Run;
  version: number;
  decision: "approve" | "changes";
  note?: string;
  /** Lo único que @check revisa en la siguiente vuelta; lo nuevo va como nota, no como hallazgo. */
  checkScope?: string;
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
  const checkScope = (opts.checkScope ?? "").trim().slice(0, 2000);
  const scope = checkScope ? { check_scope: checkScope } : {};
  // Replanear reinicia las vueltas de check (si no, un plan nuevo tras escalar volvía a
  // escalar al primer hallazgo). Aprobar deja registrado con qué credenciales se construye.
  // «Otra vuelta» tras escalar deja UNA vuelta real: sin bajar `loops`, el siguiente check_fail
  // escalaba al instante (#115, 19-oct). Un escalado por check_blocked conserva las suyas.
  const next = await applyEvent(
    run,
    decision === "approve" ? "approve" : "changes",
    decision === "approve"
      ? run.status === "escalated"
        ? { approved_by: sub, loops: Math.min(run.loops, MAX_LOOPS - 1), ...scope }
        : { approved_by: sub, loops: 0, ...scope }
      : { loops: 0, ...scope },
    { actor: who, data: { version, ...(note ? { note } : {}), ...(checkScope ? { checkScope } : {}) } },
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
    // La nota de quien decide va con las demás: antes sólo quedaba en gt_factory_plans y @build no la veía.
    if (again && note) await addNote(run.id, who, note);
    const why = again ? "otra vuelta tras escalar" : "construir el plan aprobado";
    const text =
      approveBriefLead(run, { who, version, again }) +
      (await takeNotes(run.id)) +
      (again ? "" : await critiqueSuggestions(run.id, version)) +
      `\n\n## Plan aprobado (v${version})\n${plan?.planMd ?? ""}`;
    // La caja del pedido antes del encargo: sin lugar en el tier, el pedido espera en cola con el
    // encargo guardado y el tick lo entrega en cuanto se libere uno.
    if ((await ensureRunBox(next)) === "waiting") {
      await dbq("UPDATE gt_factory_runs SET box_handoff = ? WHERE id = ?", [JSON.stringify({ sub, why, text, origin: opts.origin }), run.id]);
      lap("en espera de caja");
      return next;
    }
    await handoff(next, "build", sub, why, text, opts.origin);
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
    // Escalado: un «✅» en el hilo no aprueba a ciegas lo que @check frenó (mercadito #7, 5-oct).
    // Se contesta con la tarjeta: los puntos arriba y la decisión con clics, sin escribir nada.
    if (run.status === "escalated" && d.decision === "approve" && (await escalationOf(run))) {
      await postInThread(run, "check", "Antes de otra vuelta, lee lo que frené y decide en la tarjeta de abajo.");
      await postRunCard(run);
      return true;
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

/** La tarjeta viva de un pedido (`RunCard`): estado y botones para decidir. */
export const runCardFence = (runId: number) => "```gt-run\n" + JSON.stringify({ runId }) + "\n```";

/** Huella de una tarjeta que ya no es la viva: cómo iba el pedido cuando la reemplazaron. */
export type RunFossil = { runId: number; title: string; status: string; planVersion: number; prUrl: string | null; at: number; liveMsgId: number };
export const runFossilFence = (f: RunFossil) => "```gt-run-fossil\n" + JSON.stringify(f) + "\n```";
const RUN_FENCE = /```gt-run(?!-)[^\n]*\n[\s\S]*?```/;

/**
 * Una sola tarjeta viva por pedido (bliss, 19-oct). Publica la tarjeta abajo del hilo («también
 * en el room») y la anterior queda como FÓSIL: su mensaje se reescribe a ```gt-run-fossil``` con
 * cómo iba el pedido, sin botones y con liga a la viva. Antes la tarjeta se publicaba una vez y,
 * perdida hilo arriba o borrada, no había forma de volver a traerla. Nunca lanza.
 */
export async function postRunCard(run: Run): Promise<number | null> {
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const ns = await currentNamespace();
    const prevId = Number((await dbq("SELECT card_msg_id FROM gt_factory_runs WHERE id = ?", [run.id]))[0]?.card_msg_id) || null;
    const who = await agentIdentity("plan");
    const body = runCardFence(run.id);
    // Dentro del hilo del pedido y «también en el room» (8-oct): antes salía suelta en el room y
    // parecía que el trabajo se mudaba a otro lado. Un pedido sin hilo la deja en el room.
    const { id } = run.rootMsgId
      ? await db.postAgent(run.channelId, run.rootMsgId, body, "msg", who.handle, who.name, run.topic, who.avatar, { alsoInChannel: true })
      : await db.postAgent(run.channelId, null, body, "msg", who.handle, who.name, run.topic, who.avatar);
    await dbq("UPDATE gt_factory_runs SET card_msg_id = ? WHERE id = ?", [id, run.id]);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(ns, run.channelId), { t: "message:new", msg });
    const prev = prevId ? await db.getMessage(prevId) : null;
    if (prev && RUN_FENCE.test(prev.body)) {
      const fossil = runFossilFence({ runId: run.id, title: run.title, status: run.status, planVersion: run.planVersion, prUrl: run.prUrl, at: Math.floor(Date.now() / 1000), liveMsgId: id });
      const next = prev.body.replace(RUN_FENCE, fossil);
      // Sin `edited_at`: no la editó nadie, la plataforma la dejó como huella.
      await dbq("UPDATE gc_messages SET body = ? WHERE id = ?", [next, prev.id]);
      bus.publish(bus.ch.room(ns, run.channelId), { t: "message:edited", id: prev.id, body: next, edited_at: 0 } as never);
    }
    return id;
  } catch (e) {
    console.error("[factory] no pude publicar la tarjeta viva", e);
    return null;
  }
}

/**
 * Asegura la tarjeta viva del pedido. Sin `force`, sólo la publica si no hay una viva (nunca se
 * publicó o su mensaje se borró); con `force` la baja al final del hilo aunque exista. Nunca lanza:
 * sin tarjeta, la corrida funciona igual.
 */
export async function ensureRunCard(run: Run, opts: { force?: boolean } = {}): Promise<number | null> {
  try {
    if (!opts.force) {
      const cur = Number((await dbq("SELECT card_msg_id FROM gt_factory_runs WHERE id = ?", [run.id]))[0]?.card_msg_id) || null;
      if (cur) {
        const db = await import("../../db.server");
        const msg = await db.getMessage(cur);
        if (msg && RUN_FENCE.test(msg.body)) return cur;
      }
    }
    return await postRunCard(run);
  } catch (e) {
    console.error("[factory] no pude publicar la tarjeta viva", e);
    return null;
  }
}

/**
 * Estado del CI del PR (Actions y statuses externos: Vercel, CircleCI…), con la misma tool
 * que usa el agente. `none` = el repo no tiene CI (NO es verde). null si GitHub no contesta.
 */
export async function prCi(sub: string, url: string): Promise<{ state: string; failed: string[]; checks: import("../connectors/github-checks").CheckItem[] } | null> {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_pr_checks");
    const r = (await tool?.handler(sub, { repo: pr.repo, number: pr.number })) as any;
    if (!r || r.error) return null;
    const failed = Array.isArray(r.failed) ? r.failed.map((f: any) => String(f?.name ?? f)).slice(0, 5) : [];
    return { state: String(r.state ?? "none"), failed, checks: Array.isArray(r.checks) ? r.checks : [] };
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
  // El consejo de Arqui-asesor va a Worker, no cierra ningún paso.
  if (w.key.endsWith(":advice")) {
    if (run) await deliverAdvice(run, reply, w.origin).catch((e) => console.warn(`[factory] consejo #${run.id}: ${(e as Error).message}`));
    return;
  }
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

export async function prOutcome(
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
    const o = await prOutcome(run.approvedBy ?? run.requestedBy, run.prUrl!);
    // Reabierto sin que llegara el webhook (o antes de que existiera `onPrReopened`).
    if (o?.outcome === "open") {
      await onPrReopened(run).catch((e) => console.error("[factory] reabrir", run.id, e));
      continue;
    }
    if (o?.outcome !== "merged") continue;
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
    // Con merge en cola se mira en CADA vuelta (30 s): entre el último check en verde y el merge
    // había hasta 2 min de «Merge en cola» con todo verde (MailMask #43, 10-oct).
    if (Date.now() - last < (row.merge_queued_by ? 0 : PR_CHECK_EVERY_MS)) continue;
    lastPrCheck.set(run.id, Date.now());
    const pr = await prOutcome(run.approvedBy ?? run.requestedBy, run.prUrl!);
    const outcome = pr?.outcome ?? null;
    // Aprobado por una persona y CI en verde: el agente PROPONE mezclar y pregunta. Mezcla
    // sólo si le contestan que sí (`maybeMergeReply`), con las credenciales de quien contesta.
    // Un solo `prCi` por vuelta: lo usan la propuesta de merge y el regreso por CI en rojo.
    const ci = outcome === "open" && run.status === "pr_review" ? await prCi(run.approvedBy ?? run.requestedBy, run.prUrl!) : null;
    if (ci?.state === "failure") {
      // Un rojo cancela el merge en cola: lo que entra tiene que haber pasado.
      // Y el automerge vuelve a mirarlo cuando @build lo arregle y @check lo apruebe otra vez.
      if (row.merge_queued_by || Number(row.merge_queued_auto) === 1)
        await dbq("UPDATE gt_factory_runs SET merge_queued_by = NULL, merge_queued_auto = NULL WHERE id = ?", [run.id]).catch(() => {});
      await onPrCiRed(run, pr?.headSha ?? null, ci.failed);
    }
    // Automerge del room (default encendido): lo que @check aprobó se forma en la cola de merge
    // a nombre de quien firmó el plan, y el bloque de abajo lo mete en cuanto el CI pasa.
    if (outcome === "open" && run.status === "pr_review" && !row.merge_queued_by && row.merge_queued_auto == null && ci?.state !== "failure") {
      const { getRoomAutoMerge } = await import("../../db.server");
      const am = await getRoomAutoMerge(run.channelId).catch(() => null);
      const by = run.approvedBy ?? run.requestedBy;
      // Un major de Dependabot nunca entra solo: semver dice que puede romper.
      const { blocksAutoMerge } = await import("./dependabot.server");
      const took = am?.on && by && !blocksAutoMerge(run.taskRef)
        ? await dbq("UPDATE gt_factory_runs SET merge_queued_by = ?, merge_queued_auto = 1 WHERE id = ? AND merge_queued_by IS NULL AND merge_queued_auto IS NULL RETURNING id", [by, run.id]).catch(() => [])
        : [];
      if (took.length) {
        row.merge_queued_by = by;
        await logEvent(run.id, "merge_queued", by, { auto: true });
        void refreshRoom(run.channelId);
      }
    }
    // Merge en cola (picado con el CI corriendo): entra solo en cuanto pasa, con las credenciales
    // de quien lo picó. Antes había que volver a picar y nadie avisaba cuándo (MailMask #34, 10-oct).
    if (outcome === "open" && run.status === "pr_review" && row.merge_queued_by && (ci?.state === "success" || ci?.state === "none")) {
      const by = String(row.merge_queued_by);
      await dbq("UPDATE gt_factory_runs SET merge_queued_by = NULL WHERE id = ?", [run.id]).catch(() => {});
      const r = await mergeRun(run, by);
      if (!r.ok) {
        // Se volvió a quedar atrás de main: mergeRun ya lo puso al día; sigue en cola.
        if (r.queue) await dbq("UPDATE gt_factory_runs SET merge_queued_by = ? WHERE id = ?", [by, run.id]).catch(() => {});
        else await postInThread(run, "build", `⚠️ El merge en cola no entró: ${r.error}. ${run.prUrl}`);
      }
      continue;
    }
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
  // Dependabot no tiene @build detrás: un rojo se le dice a una persona, con la pista de si viene
  // de main (la plataforma puso la rama al día) o de la subida misma.
  if (String(run.taskRef ?? "").startsWith("dependabot:")) {
    const ya = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'ci_red_help' AND json_extract(data_json, '$.sha') IS ?", [run.id, headSha]).catch(() => []);
    if (ya.length) return;
    await logEvent(run.id, "ci_red_help", null, { sha: headSha, por: "dependabot" });
    await postInThread(run, "check", `⚠️ El CI de este PR de Dependabot salió en rojo (${what}), así que no entra solo. Mira si el mismo check truena en main (entonces no es la subida); si es la subida, «Pedir arreglo a @build» lo corrige en esta rama. ${run.prUrl ?? ""}`);
    void refreshRoom(run.channelId);
    return;
  }
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
    // El análisis guardado era el de antes del deploy: se rehace para que Arqui no lea el viejo.
    void fetchRunWhy(run.id, { refresh: true });
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
  const gone = await applyEvent(run, "cancel", {}, { data: { reason: "pr_closed" } }).catch(() => null);
  if (gone) await postInThread(gone, role, `⏹️ El PR se cerró sin merge: pedido cancelado. ${run.prUrl}`);
  return gone;
}

/**
 * PR reabierto en GitHub: el pedido que se canceló SÓLO porque el PR se cerró vuelve a la etapa en que
 * iba (el `from` de su evento `cancel`). Uno cancelado a mano se queda cancelado. Antes nada lo sacaba
 * de `cancelled` y la tarjeta seguía en rojo con el PR abierto (bliss, 15-oct).
 */
export async function onPrReopened(run: Run): Promise<Run | null> {
  if (run.status !== "cancelled") return null;
  const info = await cancelInfo(run.id);
  if (info?.reason !== "pr_closed") return null;
  const to = info.from && info.from !== "cancelled" && info.from !== "done" ? info.from : "pr_review";
  const fixed = await dbq("UPDATE gt_factory_runs SET status = ?, updated_at = unixepoch() WHERE id = ? AND status = 'cancelled' RETURNING *", [to, run.id]);
  if (!fixed[0]) return null;
  const back = toRun(fixed[0]);
  void logEvent(back.id, "reopened", null, { from: "cancelled", to });
  void import("./factory").then((F) => F.forgetPrClosed(back.id)).catch(() => {});
  void refreshRoom(back.channelId);
  void import("./sprint.server").then((S) => S.onSprintRunChanged(back.id)).catch(() => {});
  await postInThread(back, "check", `🔄 El PR se reabrió: el pedido sigue donde iba. ${back.prUrl ?? ""}`.trim());
  return back;
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

// ── Vigilante de la preview (easybits, 20-oct) ───────────────────────────────
//
// Cinco PRs de Dependabot se quedaron 24 h con la preview en `pending`: el hosting «publicaba
// previews» por un despliegue de 2025, gs nunca recibió el `up` y nadie lo supo. Ahora ninguna
// preview se queda muda: lo que espera lugar dice por qué (`waiting`), lo que no avanza en 15 min
// queda `failed` con el motivo, y el hosting que no dice nada en 5 min cede a la caja de gs.

/** Pedidos mirados por vuelta del tick y cuántos a la vez (antes: `LIMIT 10 ORDER BY updated_at`, y los viejos nunca llegaban). */
export const PREVIEW_TICK_MAX = 24;
const PREVIEW_CONCURRENCY = 4;
/** Una preview `pending` sin cambiar de fase en este tiempo queda `failed`. */
export const PREVIEW_STUCK_S = 15 * 60;
/** El hosting no dice nada del commit en este tiempo: se le pide la caja a gs. */
export const HOSTING_SILENT_S = 5 * 60;
/** Reintentos solos de una preview que falló por la plataforma, y cada cuánto. */
const PLATFORM_RETRIES = 3;
const PLATFORM_RETRY_S = 30 * 60;

/** Cada cuánto se mira un pedido según su preview (ms). */
export function previewCheckEvery(state: unknown): number {
  if (state === "pending") return 20_000;
  if (state === "waiting") return 60_000;
  return 120_000;
}

/** Los pedidos que ya toca mirar, el que lleva más tiempo sin mirarse primero. Pura. */
export function previewDue<T extends Record<string, any>>(rows: T[], last: Map<number, number>, now: number, max: number): T[] {
  const seen = (r: T) => last.get(Number(r.id)) ?? 0;
  return rows
    .filter((r) => now - seen(r) >= previewCheckEvery(r.preview_state))
    .sort((a, b) => seen(a) - seen(b))
    .slice(0, max);
}

/** ¿gs no tiene lugar ahora? (409 `no_slot` o 503 de capacidad): el motivo para `waiting`. Puro. */
export function waitingFromGsError(e: unknown): string | null {
  const err = e as { status?: number; body?: any; message?: string };
  if (err?.status === 409 && err.body?.error === "no_slot") {
    const busy: number[] = Array.isArray(err.body?.busy) ? err.body.busy.map(Number).filter((n: number) => n > 0) : [];
    // «esperando lugar de caja (2 ocupados: #120, #121)»: lo mismo lee la app en gs (`previewStatus`).
    return `esperando lugar de caja (${busy.length ? `${busy.length} ocupados: ${busy.map((n) => `#${n}`).join(", ")}` : "todos ocupados"}); arranca sola al liberarse uno`;
  }
  if (err?.status === 503) return String(err.body?.error ?? "no hay capacidad para otra caja ahora mismo; se reintenta sola");
  return null;
}

type BoxStatus = { phase?: string; sha?: string | null; url?: string | null; error?: string | null } | null | undefined;

/** ¿Hay que volver a pedir `up`? Sin caja, otro commit, o gs olvidó el commit (tras reiniciar sale `sha: null`). Puro. */
export function boxNeedsUp(b: BoxStatus, sha: string): boolean {
  if (!b) return true;
  // Creándose, gs todavía no sabe el commit: no es olvido.
  if (b.phase === "creating") return false;
  return b.sha !== sha;
}

type NextPreview = { state: "pending" | "ready" | "failed" | "needs_env" | "waiting"; url: string | null; provider: string | null; error: string | null };

/** El estado del pedido a partir de la caja de gs. Puro. */
export function boxPreviewNext(b: BoxStatus, sha: string): NextPreview {
  if (b && b.sha === sha && b.phase === "ready") return { state: "ready", url: b.url ?? null, provider: null, error: null };
  if (b && b.sha === sha && b.phase === "failed") return { state: "failed", url: null, provider: null, error: b.error ?? null };
  return { state: "pending", url: null, provider: null, error: null };
}

/**
 * El vigilante: null si la preview sigue a tiempo; si lleva `PREVIEW_STUCK_S` en `pending` sin
 * avanzar, el motivo con el que queda `failed` («la preview no arrancó: …»). Puro.
 */
export function stuckPreviewReason(
  p: { since: number | null; phase: string | null; provider: string | null; lastError: string | null },
  now: number,
): string | null {
  if (!p.since || now - p.since < PREVIEW_STUCK_S) return null;
  const min = Math.round((now - p.since) / 60);
  const why = p.lastError
    ? `gs no respondió en ${min} min (${p.lastError.slice(0, 80)})`
    : p.phase
      ? `la caja se quedó en «${p.phase}» ${min} min`
      : p.provider
        ? `${p.provider} no la publicó en ${min} min`
        : `nadie empezó a construirla en ${min} min`;
  return `la preview no arrancó: ${why}`;
}

/** Corre `fn` sobre `items` con a lo más `n` a la vez. */
async function inPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * La preview del PR de cada pedido vivo: la del hosting si la publica (Vercel, Netlify…) y,
 * si no, la de NUESTRA caja (gs la construye). Se guarda en la fila (`preview_*`) para la
 * tarjeta y @check, y se avisa UNA vez por commit en el hilo: lista o por qué no arrancó.
 * Lo llama el mismo tick que `closeFinishedRuns`.
 */
export async function announcePreviews(opts: { concurrency?: number } = {}): Promise<void> {
  const rows = await dbq(
    // También construyendo y escalado: con cada commit nuevo del PR la preview se rehace, para
    // que la persona vea el cambio antes de decidir (antes se quedaba en el commit viejo hasta
    // la siguiente revisión — pedido #10, 01-oct). Todos los elegibles: el orden lo pone `previewDue`.
    `SELECT * FROM gt_factory_runs WHERE status IN ('building','checking','escalated','pr_review') AND pr_url IS NOT NULL`,
    [],
  ).catch(() => []);
  const P = await import("./preview.server");
  // PRs mirados en esta vuelta: al final se publica su check «Ghosty · Preview» en GitHub.
  const touched: { repo: string; number: number; sha: string }[] = [];
  const due = previewDue(rows, lastPreviewCheck, Date.now(), PREVIEW_TICK_MAX);
  for (const row of due) lastPreviewCheck.set(Number(row.id), Date.now());
  await inPool(due, opts.concurrency ?? PREVIEW_CONCURRENCY, (row) =>
    announceRunPreview(row, P, touched).catch((e) => console.warn(`[factory] preview #${row.id}: ${(e as Error).message}`)),
  );
  if (touched.length) {
    const C = await import("./factory-preview-check.server");
    for (const t of touched) await C.syncPrCheck(t.repo, t.number, t.sha);
  }
}

async function announceRunPreview(row: Record<string, any>, P: typeof import("./preview.server"), touched: { repo: string; number: number; sha: string }[]): Promise<void> {
  const run = toRun(row);
  const sub = run.approvedBy ?? run.requestedBy;
  const pr = parsePrUrl(run.prUrl!);
  const head = await prHead(sub, run.prUrl!);
  if (!pr || !head) return;
  touched.push({ ...pr, sha: head.sha });
  // Preview apagada para el repo: gris y sin avisos en el hilo.
  if (await repoPreviewOff(pr.repo)) {
    if (row.preview_state !== "off") {
      await dbq("UPDATE gt_factory_runs SET preview_state = 'off', preview_url = NULL, preview_error = NULL WHERE id = ?", [run.id]).catch(() => {});
      void refreshRoom(run.channelId);
    }
    return;
  }
  // Sin estado (nuevo o «Reintentar») cuenta como commit nuevo: se vuelve a pedir `up`.
  const sameSha = row.preview_sha === head.sha && !!row.preview_state;
  const boxOpts = { repo: pr.repo, pr: pr.number, ...(row.box_id ? { runId: Number(row.id) } : {}) };
  // Una preview «lista» de NUESTRA caja puede morir (la caja se recicla o caduca) y la tarjeta
  // seguía en verde con un 404 (MailMask #10, 4-oct). Se pregunta a gs si la caja sigue; si no,
  // se borra el estado y el siguiente tick la reconstruye.
  if (sameSha && row.preview_state === "ready" && !(await P.hostingHasPreviews(sub, pr.repo))) {
    // Con caja por pedido la preview vive en la caja del pedido: sin `runId` gs buscaba una caja de
    // preview suelta, no la hallaba, se borraba el estado y el siguiente tick la «actualizaba» —
    // un aviso cada 2 min (pedido #17, 7-oct).
    const st = await P.gsPreview("status", boxOpts).catch(() => undefined);
    if (st !== undefined && (!st?.status || st.status.phase !== "ready" || st.status.sha !== head.sha)) {
      await dbq("UPDATE gt_factory_runs SET preview_state = NULL, preview_url = NULL WHERE id = ?", [run.id]).catch(() => {});
      lastPreviewCheck.delete(run.id);
      void refreshRoom(run.channelId);
    }
    return;
  }
  if (sameSha && (row.preview_state === "failed" || row.preview_state === "needs_env")) {
    if (row.preview_state === "failed" && (await retryPlatformPreview(run, row))) return;
    await warnPreviewBlocking(run, row.preview_state, pr.repo);
    return;
  }
  if (sameSha && row.preview_state === "ready") return;
  // Commit nuevo: la liga vieja ya no muestra el PR de hoy. Se quita YA (pendiente), aunque
  // pedir la nueva falle; antes, si `up` fallaba, la tarjeta seguía en verde con la vieja.
  if (!sameSha && row.preview_state === "ready") {
    await dbq("UPDATE gt_factory_runs SET preview_state = 'pending', preview_url = NULL, preview_sha = ?, preview_since = unixepoch(), preview_phase = NULL WHERE id = ?", [
      head.sha,
      run.id,
    ]).catch(() => {});
    void refreshRoom(run.channelId);
  }

  // Desde cuándo está pendiente este commit (para el vigilante y el respaldo del hosting). Las
  // filas de antes del vigilante no lo tienen: el reloj empieza ahora.
  const nowS = Math.floor(Date.now() / 1000);
  const stillPending = sameSha && row.preview_state === "pending";
  let since = row.preview_since != null ? Number(row.preview_since) : null;
  if (stillPending && since == null) {
    since = nowS;
    await dbq("UPDATE gt_factory_runs SET preview_since = ? WHERE id = ? AND preview_since IS NULL", [nowS, run.id]).catch(() => {});
  }
  const pendingFor = stillPending && since ? nowS - since : 0;

  let next: NextPreview | null = null;
  let phase: string | null = null;
  let lastError: string | null = null;
  let hosting = await P.hostingHasPreviews(sub, pr.repo);
  if (hosting) {
    const p = await P.commitPreview(sub, pr.repo, head.sha);
    if (p.state === "ready") next = { state: "ready", url: p.url, provider: p.provider, error: null };
    else if (p.state === "failed") next = { state: "failed", url: null, provider: p.provider, error: "el hosting no pudo publicar la preview" };
    else if (p.state === "pending") next = { state: "pending", url: null, provider: p.provider, error: null };
    else if (pendingFor >= HOSTING_SILENT_S) {
      // El hosting no dijo NADA de este commit en 5 min: no publica previews (o dejó de hacerlo).
      // Se le pide la caja a gs en esta misma vuelta.
      P.markHostingSilent(pr.repo);
      hosting = false;
      await logEvent(run.id, "preview_fallback", null, { repo: pr.repo, after: pendingFor });
    } else next = { state: "pending", url: null, provider: null, error: null };
  }
  if (!next && !hosting) {
    if (await missingPreviewEnv(sub, pr.repo)) {
      // Con .env.example y sin variables guardadas, la app no arrancaría: no se gasta una caja,
      // se piden en el hilo (guardarlas la reintenta sola).
      next = { state: "needs_env", url: null, provider: null, error: null };
    } else {
      try {
        // Pendiente del mismo commit: se pregunta cómo va. Si la caja ya no existe, va por otro
        // commit o gs olvidó cuál era (reinicio: `sha: null`), se vuelve a pedir.
        let b: BoxStatus = stillPending ? (await P.gsPreview("status", boxOpts))?.status : null;
        if (boxNeedsUp(b, head.sha)) {
          const out = await P.gsPreview("up", { ...boxOpts, sha: head.sha });
          // gs soltó previews sueltas para darle lugar a ésta: su botón dirá por qué ya no están.
          if (Array.isArray(out?.evicted) && out.evicted.length)
            await (await import("./pr-preview.server")).recordEvictedPreviews(out.evicted).catch(() => {});
          b = out;
        }
        phase = b?.phase ?? null;
        next = boxPreviewNext(b, head.sha);
      } catch (e) {
        // Sin lugar o sin capacidad: `waiting` con el motivo, visible en la tarjeta (antes era un
        // console.warn y la preview se quedaba «en camino» para siempre). Lo demás (gs caído) sigue
        // pendiente y lo vence el vigilante.
        const waiting = waitingFromGsError(e);
        if (waiting) next = { state: "waiting", url: null, provider: null, error: waiting };
        else {
          lastError = (e as Error).message;
          console.warn(`[factory] preview #${run.id}: ${lastError}`);
          next = { state: "pending", url: null, provider: null, error: null };
        }
      }
    }
  }
  if (!next) return;

  // Vigilante: pendiente del mismo commit y sin cambiar de fase en 15 min → falla con motivo.
  let stuck = false;
  if (next.state === "pending" && stillPending) {
    if (phase && phase !== (row.preview_phase ?? null)) {
      // Cambió de fase (installing → building…): eso es avance, el reloj vuelve a empezar.
      await dbq("UPDATE gt_factory_runs SET preview_phase = ?, preview_since = unixepoch() WHERE id = ?", [phase, run.id]).catch(() => {});
    } else {
      const why = stuckPreviewReason({ since, phase: phase ?? row.preview_phase ?? null, provider: next.provider, lastError }, nowS);
      if (why) {
        next = { state: "failed", url: null, provider: next.provider, error: why };
        stuck = true;
      }
    }
  }

  const changed = await dbq(
    `UPDATE gt_factory_runs SET preview_state = ?, preview_url = ?, preview_sha = ?, preview_error = ?, preview_since = unixepoch(), preview_phase = ?
     WHERE id = ? AND NOT (COALESCE(preview_state,'') = ? AND COALESCE(preview_sha,'') = ?) RETURNING id`,
    [next.state, next.url, head.sha, next.error, phase, run.id, next.state, head.sha],
  );
  if (!changed.length) {
    // Sigue esperando lugar: el motivo puede cambiar (otros pedidos en curso) aunque el estado no.
    if (next.state === "waiting")
      await dbq("UPDATE gt_factory_runs SET preview_error = ? WHERE id = ? AND COALESCE(preview_error,'') <> ?", [next.error, run.id, next.error ?? ""]).catch(() => {});
    return;
  }
  void refreshRoom(run.channelId);
  if (next.state === "ready")
    // Mientras Build sigue empujando commits no se anuncia cada uno (sería ruido): la tarjeta
    // ya muestra la liga vigente. Se anuncia al llegar a revisión, escalado o PR listo.
    {
      const url = next.url;
      // En el PR de GitHub también (Deployment `preview` del commit), una vez por commit: el
      // UPDATE de arriba sólo pasa cuando cambian estado o sha. Una preview de hosting externo
      // (Vercel…) ya la registró su proveedor.
      if (!next.provider && url)
        void import("../connectors/github.server")
          .then((G) => G.publishPreviewDeployment(sub, pr.repo, head.sha, url))
          .then((r) => { if ("error" in r) console.warn(`[factory] preview #${run.id} en el PR: ${r.error}`); })
          .catch(() => {});
      if (run.status !== "building") {
        // Con variables de producción se dice en el mismo aviso: probarla escribe en lo real (#96).
        const risks = next.provider ? [] : await P.gsPreview("env-keys", { repo: pr.repo }).then((r) => (Array.isArray(r?.risks) ? r.risks : [])).catch(() => []);
        const { envRisksText } = await import("./factory-preview-gate");
        const prod = risks.length ? ` · ⚠ usa prod: ${envRisksText(risks, 3)}` : "";
        await postInThread(run, "build", `🔎 **Preview ${row.preview_sha && !sameSha ? "actualizada" : "lista"}**${next.provider ? ` (${next.provider})` : ""} · [Abrir](${url})${prod}`);
      }
      // Smoke de acción en cada preview nueva (también tras un push con el PR ya aprobado): un
      // POST con el Origin real. Sólo se avisa si falla (#96, 16-oct).
      if (url) {
        const S = await import("./factory-smoke.server");
        const fails = S.smokeFailures(await S.runActionSmoke(url, pr.repo, sub));
        if (fails) {
          await logEvent(run.id, "smoke_fail", null, { sha: head.sha, fails: fails.slice(0, 800) });
          await postInThread(run, "build", `⛔ **La preview rechaza envíos** (POST con el Origin real, como el navegador):\n${fails}\nNo lo mezcles así.`);
        }
      }
      // Si @check ya dio su veredicto con otra versión (o sin preview), las capturas de su
      // tarjeta se rehacen con ésta: la tarjeta se corrige sola aunque @check se adelantara.
      let verdict: { shotSha?: string; shotPath?: string | null; evidencePath?: string | null } | null = null;
      try {
        verdict = row.verdict_json ? JSON.parse(String(row.verdict_json)) : null;
      } catch { /* veredicto ilegible: sin capturas */ }
      if (verdict && verdict.shotSha !== head.sha)
        void import("./factory-shots.server").then((S) => S.captureVerdictShots(run.id, verdict.shotPath ?? verdict.evidencePath ?? null));
      // Escalado SÓLO porque la preview no llegaba: ya llegó, @check revisa otra vez solo.
      if (run.status === "escalated" && (await escalationOf(run))?.kind === "platform" && !(await rateLimitPending(run.id)))
        await recheck({ run, sub, who: "La plataforma", note: "la preview ya está lista", origin: "" }).catch((e) =>
          console.warn(`[factory] recheck #${run.id}: ${(e as Error).message}`),
        );
    }
  else if (next.state === "needs_env")
    await postInThread(
      run,
      "build",
      `🔑 **La preview necesita las variables de \`${pr.repo}\`.** Guárdalas con datos de prueba y arranca sola: ` +
        `[Guardar variables](/factory?repo=${encodeURIComponent(pr.repo)})`,
    );
  else if (next.state === "failed") {
    // Tarjeta con paso, causa, qué hacer y el log plegado (ver lib/preview-errors.ts).
    await postInThread(run, "build", "```gt-preview-error\n" + JSON.stringify({ runId: run.id }) + "\n```\n⚠️ La preview no arrancó.");
    // No arrancó por la plataforma (el vigilante): @check no puede hacer nada y una persona tampoco.
    if (stuck) await escalatePlatform(run, next.error ?? "la preview no arrancó", pr.repo);
  }
}

/**
 * La preview que @check necesita no arrancó por la plataforma: el pedido escala con tipo
 * `platform` (no cuenta en «Te toca», no timbra), se avisa UNA vez por repo y, en cuanto la
 * preview quede lista, @check revisa solo. Sólo si @check está revisando y la preview se exige.
 */
export async function escalatePlatform(run: Run, why: string, repo: string): Promise<Run | null> {
  if (run.status !== "checking") return null;
  if (!(await previewRequired(run))) return null;
  const reason = clipReason(why);
  const next = await applyEvent(run, "check_blocked", {}, {
    actor: null,
    data: { kind: "platform", reason, findings: `- ${why}\n- La plataforma la reintenta sola; en cuanto esté lista, @check revisa otra vez.` },
  }).catch(() => null);
  if (!next) return null;
  await postInThread(
    next,
    "check",
    `⏸️ **En pausa por la plataforma:** ${reason}. Nadie tiene que decidir nada: la reintento sola y, en cuanto esté lista, reviso otra vez.`,
  ).catch(() => {});
  await noticePlatformOnce(next, repo, reason);
  return next;
}

/**
 * @check no pudo leer el PR porque GitHub limitó las peticiones (#137 de business, 20-oct: salía
 * como «decision» y «Te toca»). Escala con tipo `platform` (sin push), guarda cuándo se libera
 * (`x-ratelimit-reset` si GitHub lo dijo; si no, 15 min) y `recheckRateLimited` le pide a @check
 * que revise otra vez a esa hora. Un solo aviso por repo, como la preview caída.
 */
export async function escalateRateLimit(run: Run, opts: { findings: string; resetAt?: number | null; extra?: Record<string, unknown> }): Promise<Run | null> {
  if (run.status !== "checking") return null;
  const now = Math.floor(Date.now() / 1000);
  // Un minuto de colchón tras el reset de GitHub; nunca antes de 2 min ni después de 1 h.
  const retryAt = opts.resetAt && opts.resetAt > now ? Math.min(Math.max(opts.resetAt + 60, now + 120), now + 3600) : now + RATE_LIMIT_RETRY_S;
  const reason = rateLimitReason(retryAt, now);
  const next = await applyEvent(run, "check_blocked", opts.extra ?? {}, {
    actor: "check",
    data: { kind: "platform", cause: "github_rate_limit", reason, retryAt, findings: opts.findings.slice(0, 4000) },
  }).catch(() => null);
  if (!next) return null;
  await postInThread(next, "check", `⏸️ **En pausa por la plataforma:** ${reason} Nadie tiene que decidir nada.`).catch(() => {});
  await postRunCard(next).catch(() => {});
  const pr = run.prUrl ? parsePrUrl(run.prUrl) : null;
  if (pr)
    await noticePlatformOnce(
      next,
      pr.repo,
      reason,
      `⚠️ **GitHub está limitando las peticiones de \`${pr.repo}\`.** Es de la plataforma, no de los PRs: ` +
        "los pedidos que @check no pudo leer quedan en pausa sin pedirte nada y se revisan solos en cuanto GitHub se libere.",
    );
  return next;
}

/** Cuándo toca que @check revise otra vez un escalado por límite de GitHub (null = no es de ésos). Pura. */
export function rateLimitRetryAt(data: Record<string, unknown>, at: number): number | null {
  if (data.kind !== "platform" && isEscalationKind(data.kind)) return null;
  const rateLimited = data.cause === "github_rate_limit" || (!isEscalationKind(data.kind) && isGithubRateLimit(String(data.findings ?? "")));
  if (!rateLimited) return null;
  const r = Number(data.retryAt);
  return Number.isFinite(r) && r > 0 ? r : at + RATE_LIMIT_RETRY_S;
}

/** ¿El pedido está en pausa por el límite de GitHub y todavía no llega su hora? */
async function rateLimitPending(runId: number): Promise<boolean> {
  const [ev] = await dbq(
    "SELECT data_json, at FROM gt_factory_events WHERE run_id = ? AND type IN ('check_blocked', 'check_fail') ORDER BY id DESC LIMIT 1",
    [runId],
  ).catch(() => []);
  try {
    const due = rateLimitRetryAt(ev?.data_json ? JSON.parse(String(ev.data_json)) : {}, Number(ev?.at ?? 0));
    return due !== null && due > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Del tick: los pedidos en pausa por el límite de GitHub cuya hora ya llegó vuelven a @check. */
export async function recheckRateLimited(): Promise<number> {
  const rows = await dbq("SELECT * FROM gt_factory_runs WHERE status = 'escalated'", []).catch(() => []);
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const row of rows) {
    const run = toRun(row);
    const [ev] = await dbq(
      "SELECT data_json, at FROM gt_factory_events WHERE run_id = ? AND type IN ('check_blocked', 'check_fail') ORDER BY id DESC LIMIT 1",
      [run.id],
    ).catch(() => []);
    let data: Record<string, unknown> = {};
    try {
      data = ev?.data_json ? JSON.parse(String(ev.data_json)) : {};
    } catch {
      continue;
    }
    const due = rateLimitRetryAt(data, Number(ev?.at ?? 0));
    if (due === null || due > now) continue;
    await recheck({ run, sub: run.approvedBy ?? run.requestedBy, who: "La plataforma", note: "GitHub ya liberó las peticiones", origin: "" })
      .then(() => n++)
      .catch((e) => console.warn(`[factory] recheck #${run.id} tras el límite de GitHub: ${(e as Error).message}`));
  }
  return n;
}

/** Un solo aviso por repo (cada 6 h a lo más) en el room del pedido, no uno por pedido. */
async function noticePlatformOnce(run: Run, repo: string, reason: string, text?: string): Promise<void> {
  const claimed = await dbq(
    `INSERT INTO gt_factory_repo_prefs (repo, platform_notice_at) VALUES (?, unixepoch())
     ON CONFLICT(repo) DO UPDATE SET platform_notice_at = excluded.platform_notice_at
     WHERE COALESCE(gt_factory_repo_prefs.platform_notice_at, 0) < unixepoch() - 21600 RETURNING repo`,
    [repo.toLowerCase()],
  ).catch(() => []);
  if (!claimed.length) return;
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const body =
      text ??
      `⚠️ **Las previews de \`${repo}\` no están arrancando** (${reason}). Es una falla de la plataforma, no de los PRs: ` +
      `los pedidos que la esperan quedan en pausa sin pedirte nada y se reanudan solos en cuanto arranque.`;
    const { id } = await db.postAgent(run.channelId, null, body, "msg", "check", "Check", "general", "");
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(await currentNamespace(), run.channelId), { t: "message:new", msg });
  } catch (e) {
    console.warn(`[factory] aviso de plataforma ${repo}: ${(e as Error).message}`);
  }
}

/**
 * Escalado por la plataforma con la preview caída: se reintenta sola cada 30 min, hasta 3 veces
 * (luego queda «Reintentar preview» en la tarjeta). true = se reintentó.
 */
async function retryPlatformPreview(run: Run, row: Record<string, any>): Promise<boolean> {
  if (run.status !== "escalated") return false;
  const since = Number(row.preview_since ?? 0);
  if (since && Math.floor(Date.now() / 1000) - since < PLATFORM_RETRY_S) return false;
  if ((await escalationOf(run))?.kind !== "platform") return false;
  const [n] = await dbq("SELECT COUNT(*) AS n FROM gt_factory_events WHERE run_id = ? AND type = 'preview_retry'", [run.id]).catch(() => [{ n: PLATFORM_RETRIES }]);
  if (Number(n?.n ?? 0) >= PLATFORM_RETRIES) return false;
  await logEvent(run.id, "preview_retry", null, { auto: true });
  return (await retryPreviews({ runId: run.id, force: true })) > 0;
}

/**
 * Preview exigida que no llega (`needs_env` / `failed`): se avisa otra vez al entrar a revisión y
 * a PR listo, no sólo al primer commit. En el #96 el único aviso se perdió en el hilo y la tarjeta
 * siguió en verde hasta el merge (16-oct). Una vez por etapa (la bitácora lo recuerda).
 */
async function warnPreviewBlocking(run: Run, state: "failed" | "needs_env", repo: string): Promise<void> {
  if (run.status !== "checking" && run.status !== "pr_review") return;
  if (!(await previewRequired(run))) return;
  const seen = await dbq("SELECT 1 FROM gt_factory_events WHERE run_id = ? AND type = 'preview_blocking' AND data_json LIKE ? LIMIT 1", [
    run.id,
    `%"stage":"${run.status}"%`,
  ]).catch(() => [1]);
  if (seen.length) return;
  await logEvent(run.id, "preview_blocking", null, { stage: run.status, state });
  const why =
    state === "needs_env"
      ? `faltan las variables de \`${repo}\`: [Guardar variables](/factory?repo=${encodeURIComponent(repo)}) y arranca sola`
      : "no arrancó (el motivo está en la tarjeta)";
  await postInThread(
    run,
    "build",
    `⛔ **Este pedido exige la preview y ${why}.** Sin ella @check no puede aprobar y el merge está bloqueado. ` +
      `Si de verdad no hace falta, «Mezclar sin preview» en la tarjeta (queda registrado).`,
  );
}

/**
 * Vuelve a intentar las previews que fallaron (de un pedido, o de todos los de un repo): se
 * olvida el estado y el siguiente tick las levanta otra vez. Lo usan «Reintentar» en la
 * tarjeta y guardar variables.
 */
export async function retryPreviews(by: { runId?: number; repo?: string; envChanged?: boolean; force?: boolean }): Promise<number> {
  // Variables nuevas: también las previews vivas (lista o construyéndose) de los pedidos abiertos,
  // que seguían con el `.env` viejo (#106, 16-oct). Sin sha, el tick vuelve a pedir `up` y gs
  // reconstruye el mismo commit con el `.env` nuevo. `force` («Reintentar preview» de un escalado
  // por la plataforma): cualquier estado salvo apagada, también la que espera o sigue «en camino».
  const which = by.force
    ? "COALESCE(preview_state, 'none') <> 'off'"
    : by.envChanged
      ? "preview_state IN ('failed','needs_env','ready','pending','waiting')"
      : "preview_state IN ('failed','needs_env')";
  const open = by.envChanged || by.force ? " AND status NOT IN ('done','cancelled')" : "";
  const reset = "preview_state = 'pending', preview_sha = NULL, preview_error = NULL, preview_since = unixepoch(), preview_phase = NULL";
  const rows = await dbq(
    by.runId
      ? `UPDATE gt_factory_runs SET ${reset} WHERE id = ? AND ${which}${open} RETURNING *`
      : `UPDATE gt_factory_runs SET ${reset} WHERE repo = ? AND ${which}${open} RETURNING *`,
    [by.runId ?? by.repo ?? ""],
  ).catch(() => []);
  for (const r of rows) {
    lastPreviewCheck.delete(Number(r.id));
    void refreshRoom(Number(r.channel_id));
    if (by.envChanged) void postInThread(toRun(r), "build", "🔁 Reconstruyo la preview con las variables nuevas.").catch(() => {});
  }
  return rows.length;
}

/**
 * «Reintentar preview» de una persona (la app, la tarjeta), en CUALQUIER etapa con PR — no sólo en
 * un escalado `platform`: el #131 de easybits se quedó horas en `pr_review` con la preview atorada
 * y nada que tocar (20-oct). Se olvida el estado y se pide YA (no al siguiente tick), para contestar
 * cómo quedó: `pending` (construyéndose), `waiting` con su motivo (sin lugar de caja) o `failed`.
 * Sólo toca las columnas `preview_*`: la etapa del pedido no cambia. null = la preview está apagada.
 */
export async function retryRunPreviewNow(run: Run): Promise<{ state: RunPreviewState; error: string | null } | null> {
  if (!(await retryPreviews({ runId: run.id, force: true }))) return null;
  const [row] = await dbq("SELECT * FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
  if (row?.pr_url) {
    lastPreviewCheck.set(run.id, Date.now());
    const P = await import("./preview.server");
    const touched: { repo: string; number: number; sha: string }[] = [];
    await announceRunPreview(row, P, touched).catch((e) => console.warn(`[factory] reintentar preview #${run.id}: ${(e as Error).message}`));
    if (touched.length) {
      const C = await import("./factory-preview-check.server");
      for (const t of touched) await C.syncPrCheck(t.repo, t.number, t.sha).catch(() => {});
    }
  }
  const pv = await runPreview(run.id);
  return { state: pv.state, error: pv.error };
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

export type RunPreviewState = "none" | "pending" | "ready" | "failed" | "needs_env" | "off" | "waiting";

/** ¿El pedido exige la preview para aprobarse y mezclarse? Regla en `factory-preview-gate.ts`. */
export async function previewRequired(run: Run): Promise<boolean> {
  const repo = run.repo ?? (run.prUrl ? parsePrUrl(run.prUrl)?.repo : null);
  const { previewRequiredFrom } = await import("./factory-preview-gate");
  const { dependabotLevelOf } = await import("./dependabot.server");
  const plan = run.planVersion ? await getPlan(run.id, run.planVersion).catch(() => null) : null;
  return previewRequiredFrom({
    repoOff: repo ? await repoPreviewOff(repo) : false,
    requiresPreview: plan?.requiresPreview ?? null,
    planMd: plan?.planMd ?? null,
    dependabotLevel: dependabotLevelOf(run.taskRef),
  });
}

/**
 * La puerta de la preview para un pedido: null si no la exige o ya está lista en la cabeza;
 * si no, el motivo y si se resuelve sola (`waits`). La aplican @check y el merge.
 */
export async function previewGate(run: Run, headSha: string | null): Promise<{ reason: string; waits: boolean } | null> {
  if (!run.prUrl || !(await previewRequired(run))) return null;
  const { previewGateBlock } = await import("./factory-preview-gate");
  return previewGateBlock(await runPreview(run.id, { fresh: true }), headSha);
}

/**
 * Lo que la tarjeta y @check saben de la preview del pedido (leído de la fila).
 *
 * `fresh`: además compara el commit de la preview con la cabeza del PR (una llamada a GitHub).
 * Tras un push, la fila sigue «lista» con la caja VIEJA hasta el siguiente tick (≤ 2 min): las
 * capturas del veredicto salieron del 404 de la caja que se rehacía y @check revisó la versión
 * anterior (MailMask #20, 6-oct). Con sha distinto cuenta como `pending`. Sólo lo piden quien
 * captura y la tool de @check; la tarjeta lee la fila tal cual.
 */
export async function runPreview(
  runId: number,
  opts: { fresh?: boolean } = {},
): Promise<{ state: RunPreviewState; url: string | null; error: string | null; sha: string | null }> {
  const rows = await dbq(
    "SELECT status, preview_state, preview_url, preview_error, preview_sha, pr_url, approved_by, requested_by FROM gt_factory_runs WHERE id = ?",
    [runId],
  ).catch(() => []);
  const r = rows[0];
  // Cerrado = su caja ya se bajó: las filas viejas aún guardan la liga muerta.
  const closed = r?.status === "done" || r?.status === "cancelled";
  let state = (closed ? "none" : (r?.preview_state ?? "none")) as RunPreviewState;
  if (opts.fresh && state === "ready" && r?.pr_url) {
    const head = await prHead(String(r.approved_by ?? r.requested_by ?? ""), String(r.pr_url)).catch(() => null);
    if (head && head.sha !== r.preview_sha) state = "pending";
  }
  return {
    state,
    url: state === "ready" ? (r?.preview_url ?? null) : null,
    // `waiting` también lleva su motivo («sin lugar: 2 pedidos en curso…»).
    error: state === "failed" || state === "waiting" ? (r?.preview_error ?? null) : null,
    sha: state === "ready" ? (r?.preview_sha ?? null) : null,
  };
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
    if (!r.ok && r.queue) {
      await queueMerge(run.id, opts.sub);
      await postInThread(run, "build", `⏳ ${r.error} Queda en cola: hago el merge en cuanto el CI pase. ${run.prUrl}`);
    } else if (!r.ok) await postInThread(run, "build", `⚠️ No pude hacer el merge: ${r.error}. ${run.prUrl}`);
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
/** Deja el merge en cola a nombre de `sub`: el tick lo hace en cuanto el CI pase. */
export async function queueMerge(runId: number, sub: string): Promise<void> {
  await dbq("UPDATE gt_factory_runs SET merge_queued_by = ? WHERE id = ?", [sub, runId]);
  await logEvent(runId, "merge_queued", sub);
  const run = await getRun(runId);
  if (run) void refreshRoom(run.channelId);
}

/** `queue`: no entró por el CI (corriendo, o recién lanzado al poner la rama al día); puede quedar en cola. */
export async function mergeRun(
  run: Run,
  sub: string,
  /** `skipPreview`: «Mezclar sin preview», la salida explícita de una persona (queda en la bitácora). */
  opts: { skipPreview?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; queue?: boolean }> {
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
        // La rama se puso al día y el CI vuelve a correr: la tarjeta lo dice ya, no en su siguiente consulta.
        void refreshRoom(run.channelId);
        // Choques: GitHub no puede ponerlo al día solo. Antes sólo se decía en la tarjeta y el
        // pedido se quedaba en PR (MailMask #17, 5-oct); ahora va a @build como cualquier choque.
        if (up?.error && /conflict/i.test(String(up.error))) {
          await onPrConflict(run, head);
          return { ok: false, error: `El PR tiene conflictos con ${base}: se lo regresé a Build para resolverlos; el merge se vuelve a ofrecer al terminar.` };
        }
        return {
          ok: false,
          queue: !up?.error,
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
    if (ci?.state === "pending") return { ok: false, queue: true, error: "El CI del PR sigue corriendo: espera a que termine." };
    // Preview exigida y no lista en la cabeza: no se mezcla, como un required deployment de GitHub
    // (el #96 entró con la preview en `needs_env` y tumbó la reserva de Deník 18 h, 16-oct). Cubre
    // la tarjeta, el «mézclalo» del hilo y la cola. Construyéndose: queda en cola y entra al estar.
    // El check requerido «Ghosty · Preview» va antes del merge: si no, GitHub lo rechaza (en
    // «Mezclar sin preview» sale `neutral` con quién la omitió, como el bypass de un admin).
    const C = await import("./factory-preview-check.server");
    if (opts.skipPreview) {
      await logEvent(run.id, "merge_without_preview", sub, head ? { sha: head } : null);
      if (head) await C.syncPrCheck(pr.repo, pr.number, head);
    } else {
      const gate = await previewGate(run, head ?? null);
      if (gate)
        return gate.waits
          ? { ok: false, queue: true, error: `La preview del PR ${gate.reason}: el merge entra en cuanto esté lista.` }
          : { ok: false, error: `Falta la preview que exige este pedido (${gate.reason}). Arréglala o usa «Mezclar sin preview»` };
      // La preview de ESTA cabeza rechazó el POST del smoke: es lo que se iba a romper en prod.
      const failed = await lastEventAt(run.id, "smoke_fail", head ?? null);
      if (failed)
        return { ok: false, error: `La preview de este commit rechaza envíos (${String(failed.data.fails ?? "").split("\n")[0]}). Pídele el arreglo a @build o usa «Mezclar sin preview»` };
      if (head) await C.syncPrCheck(pr.repo, pr.number, head);
    }
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

/** El aviso de «en espera de lugar»: qué es un lugar (pedidos a la vez), quién lo ocupa y cómo
 *  tener más. Sólo el tier da lugares (F1 2 · F2 4 · F3 6, `FACTORY_TIERS` de gs); la CI extra no. */
const NEXT_TIER: Record<string, { tier: string; slots: number }> = { F1: { tier: "F2", slots: 4 }, F2: { tier: "F3", slots: 6 } };
/** Dónde se agrega un lugar o se ve el plan (mientras «Agregar 1 lugar» no tenga precio, lleva al plan). */
const plansLink = async () => {
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug().catch(() => null);
  return slug ? `https://www.ghosty.studio/app/workspaces/${encodeURIComponent(slug)}/plan` : "https://www.ghosty.studio/planes?factory=F2#a-tu-medida";
};

/** La nota de la cortesía de lugar (texto de gs) con sus ligas. Puro salvo la liga. */
export function courtesyText(note: string, link = "https://www.ghosty.studio/planes"): string {
  return `🎁 **Cortesía de lugar.** ${note} [Agregar 1 lugar](${link}) · [Ver planes](${link})`;
}

/** La fila tras usar la cortesía del mes (texto de gs). Sin tono de error. */
export function queuedText(note: string, link = "https://www.ghosty.studio/planes"): string {
  return `⏳ **En la fila.** ${note} [Agregar 1 lugar](${link}) · [Ver planes](${link})`;
}

export function waitingForSlotText(tier: string, max: number, busy: number[]): string {
  const ids = busy.map((n) => `#${n}`);
  const list = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} y ${ids[ids.length - 1]}` : ids[0] ?? "";
  const capacity = max === 1 ? "1 pedido a la vez" : `${max} pedidos a la vez`;
  const going = list ? (ids.length === 1 ? ` y ya va ${list}` : ` y ya van ${list}`) : " y ya están ocupados";
  const wait = `Este arranca solo en cuanto ${max === 1 ? "termine" : "uno termine"}.`;
  const next = NEXT_TIER[tier];
  const upsell = next
    ? ` ¿Quieres más a la vez? Con ${next.tier} son ${next.slots}: [subir a ${next.tier}](https://www.ghosty.studio/planes?factory=${next.tier}#a-tu-medida).`
    : "";
  return `⏳ **En espera de lugar.** Tu plan ${tier} deja construir **${capacity}**${going}. ${wait}${upsell}`;
}
