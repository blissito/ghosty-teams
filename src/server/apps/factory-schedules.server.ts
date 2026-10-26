// Tareas programadas de la Software Factory (planes Equipo y Agencia): la revisión nocturna
// y la de dependencias. A su hora, la plataforma despierta a @plan en el room de la fábrica
// con un encargo fijo.
//
// Nada se construye solo: si @plan encuentra algo accionable, PROPONE un plan
// (`factory_plan_submit`) y queda esperando firma humana, como cualquier corrida. Si no hay
// nada, contesta `OK` y no deja burbuja — la llave `sched:` cae en la rama «⏰ Turno
// programado… contesta OK» de `fire()` (wakeups.server.ts), que borra la respuesta OK.
//
// Tick y claim atómico calcados de `reminders.server.ts`; las fechas, de su reloj de pared.
import { dbq } from "../../dbq.server";
import { withNamespace } from "../tenant.server";
import { nextRunAt, SCHEDULE_DEFAULTS, type ScheduleKind } from "./factory-schedule-time";
import { DEFAULT_DAY, scheduleToCron } from "./factory-repo-schedule";

const TICK_MS = 30_000;

const ENCARGO: Record<ScheduleKind, string> = {
  nightly:
    "Revisión nocturna de la Software Factory. Mira lo que pasó hoy en el repo de este room: PRs con merge, " +
    "CI en rojo (github_workflow_runs), alertas de Sentry o del webhook de monitoreo en este canal, issues nuevos. " +
    "Si hay algo que atender, resúmelo en máximo 5 renglones. Si hay un arreglo claro y chico, propón UN plan con " +
    "factory_plan_submit (queda esperando firma: no construyas). Si no hay nada que atender, contesta exactamente: OK",
  deps:
    "Revisión semanal de dependencias de la Software Factory. Revisa las dependencias del repo de este room " +
    "(manifiestos y lockfile, avisos de seguridad, versiones mayores pendientes). Si hay actualizaciones que valgan " +
    "la pena, propón UN plan agrupado con factory_plan_submit (queda esperando firma: no construyas). " +
    "Si no hay nada, contesta exactamente: OK",
};

export type FactorySchedule = { kind: ScheduleKind; enabled: boolean; hour: number; weekdaysOnly: boolean; tz: string; nextAt: number | null };

export async function listSchedules(): Promise<FactorySchedule[]> {
  const rows = await dbq("SELECT * FROM gt_factory_schedules", []).catch(() => []);
  return (["nightly", "deps"] as ScheduleKind[]).map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    const d = SCHEDULE_DEFAULTS[kind];
    return {
      kind,
      enabled: !!r?.enabled,
      hour: r ? Number(r.hour) : d.hour,
      weekdaysOnly: r ? !!r.weekdays_only : d.weekdaysOnly,
      tz: r?.tz ?? "America/Mexico_City",
      nextAt: r?.next_at != null ? Number(r.next_at) : null,
    };
  });
}

/**
 * `origin` se guarda AL PROGRAMAR (hay request): el tick corre sin request, y un turno sin
 * origin no puede acuñar su tool-token → el agente trabajaría SIN tools
 * (`gotcha_turno_fuera_de_request_sin_tools`).
 */
export async function saveSchedule(
  kind: ScheduleKind,
  patch: { enabled: boolean; hour: number },
  ownerSub: string,
  tz: string,
  origin: string,
) {
  const d = SCHEDULE_DEFAULTS[kind];
  const hour = Math.max(0, Math.min(23, Math.floor(patch.hour)));
  const now = Math.floor(Date.now() / 1000);
  const next = patch.enabled ? nextRunAt(kind, hour, d.weekdaysOnly, tz, now) : null;
  await dbq(
    `INSERT INTO gt_factory_schedules (kind, enabled, hour, weekdays_only, tz, next_at, owner_sub, origin, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled, hour = excluded.hour, tz = excluded.tz,
       next_at = excluded.next_at, owner_sub = excluded.owner_sub, origin = excluded.origin, updated_at = unixepoch()`,
    [kind, patch.enabled ? 1 : 0, hour, d.weekdaysOnly ? 1 : 0, tz, next, ownerSub, origin],
  );
  return next;
}

// ── Por room+repo ────────────────────────────────────────────────────────────
//
// Un room puede tener varios repos y cada uno su horario: una fila de
// `gt_factory_repo_schedules` le gana a la del espacio para ESE room+repo (con `enabled = 0` lo
// apaga ahí). El horario es un cron de 5 campos en hora de CDMX, el mismo reloj del
// mantenimiento (`automations/maintenance.server.ts`: `dueSlotAt`).

export type RepoSchedule = { roomId: number; repo: string; kind: ScheduleKind; enabled: boolean; cron: string; ownerSub: string; origin: string };

/** El cron equivalente a «a las `hour`:00» de cada tarea: nocturna L–V, dependencias los lunes. */
export function defaultCron(kind: ScheduleKind, hour: number): string {
  return scheduleToCron(DEFAULT_DAY[kind], hour);
}

const isKind = (k: unknown): k is ScheduleKind => k === "nightly" || k === "deps";

export async function listRepoSchedules(): Promise<RepoSchedule[]> {
  const rows = await dbq("SELECT * FROM gt_factory_repo_schedules", []).catch(() => []);
  return rows
    .filter((r) => isKind(r.kind))
    .map((r) => ({
      roomId: Number(r.room_id),
      repo: String(r.repo),
      kind: r.kind as ScheduleKind,
      enabled: !!r.enabled,
      cron: String(r.cron),
      ownerSub: String(r.owner_sub),
      origin: String(r.origin ?? ""),
    }));
}

/**
 * Guarda el horario de un room+repo. `patch = null` lo quita y el repo vuelve al default del
 * espacio. `cron` gana sobre `hour`; un cron inválido se rechaza (no se guarda algo que nunca corre).
 */
export async function saveRepoSchedule(
  roomId: number,
  repo: string,
  kind: ScheduleKind,
  patch: { enabled: boolean; hour?: number; cron?: string } | null,
  ownerSub: string,
  origin: string,
): Promise<RepoSchedule | null> {
  if (!patch) {
    await dbq("DELETE FROM gt_factory_repo_schedules WHERE room_id = ? AND repo = ? AND kind = ?", [roomId, repo, kind]);
    return null;
  }
  const cron = patch.cron?.trim() || defaultCron(kind, patch.hour ?? SCHEDULE_DEFAULTS[kind].hour);
  const { parseCron } = await import("../automations/maintenance.server");
  if (!parseCron(cron)) throw new Error(`horario inválido: «${cron}» (cron de 5 campos, hora de CDMX)`);
  await dbq(
    `INSERT INTO gt_factory_repo_schedules (room_id, repo, kind, enabled, cron, owner_sub, origin, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(room_id, repo, kind) DO UPDATE SET enabled = excluded.enabled, cron = excluded.cron,
       owner_sub = excluded.owner_sub, origin = excluded.origin, updated_at = unixepoch()`,
    [roomId, repo, kind, patch.enabled ? 1 : 0, cron, ownerSub, origin],
  );
  return { roomId, repo, kind, enabled: patch.enabled, cron, ownerSub, origin };
}

const pairKey = (roomId: number, repo: string, kind: ScheduleKind) => `${roomId}:${repo.toLowerCase()}:${kind}`;

export type RepoScheduleJob = { roomId: number; repo: string; kind: ScheduleKind; key: string; ownerSub: string; origin: string };

/** Puro: qué horarios por repo tocan AHORA. La llave (única en `gt_agent_wakeups`) es el claim. */
export async function dueRepoJobs(rows: RepoSchedule[], now: number): Promise<RepoScheduleJob[]> {
  const { dueSlotAt } = await import("../automations/maintenance.server");
  const out: RepoScheduleJob[] = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    const slot = dueSlotAt({ cron: r.cron }, now);
    if (!slot) continue;
    out.push({ roomId: r.roomId, repo: r.repo, kind: r.kind, ownerSub: r.ownerSub, origin: r.origin,
      key: `sched:factory-${r.kind}:${r.roomId}:${r.repo}:${slot.date}T${slot.time}` });
  }
  return out;
}

/**
 * ¿La revisión de dependencias de la fábrica cubre este room+repo? Fábrica instalada y la tarea
 * prendida (la del repo, o la del espacio si el repo no tiene la suya). Con eso el mantenimiento
 * no corre su receta `deps`: una sola vía.
 */
export async function factoryDepsCoverage(): Promise<(roomId: number, repo: string) => boolean> {
  const { isInstalled } = await import("./installed.server");
  if (!(await isInstalled("factory").catch(() => false))) return () => false;
  const spaceOn = (await listSchedules()).some((x) => x.kind === "deps" && x.enabled);
  const own = new Map((await listRepoSchedules()).filter((r) => r.kind === "deps").map((r) => [pairKey(r.roomId, r.repo, "deps"), r.enabled]));
  return (roomId, repo) => own.get(pairKey(roomId, repo, "deps")) ?? spaceOn;
}

// ── El tick ──────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Llamado desde ensureSchema: este tenant existe y su tabla está lista. */
export function armFactorySchedules(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => {
    void sweep();
  }, TICK_MS);
  timer.unref?.();
  void sweep();
}

async function sweep(): Promise<void> {
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
    } catch {
      /* un tenant caído no deja sin tareas a los demás */
    }
  }
}

export async function sweepTenant(ns: string): Promise<void> {
  // De paso, los pedidos cuyo PR ya se mezcló se cierran solos (mismo tick, sin otro timer).
  const { closeFinishedRuns } = await import("./factory-runs.server");
  await closeFinishedRuns().catch(() => {});
  const { announcePreviews, retryWaitingRunBoxes } = await import("./factory-runs.server");
  await retryWaitingRunBoxes().catch(() => {});
  const { retryWaitingPrPreviews } = await import("./pr-preview.server");
  await retryWaitingPrPreviews().catch(() => {});
  await announcePreviews().catch(() => {});
  // Pausados porque GitHub limitó las peticiones (#137): a su hora @check revisa otra vez sola.
  const { recheckRateLimited } = await import("./factory-runs.server");
  await recheckRateLimited().catch(() => {});
  const { adoptOpenDependabotPrs } = await import("./dependabot.server");
  await adoptOpenDependabotPrs(ns);
  // Adoptados que arrancan a su hora (el lote de alertas de seguridad) y, después, el barrido de
  // alertas abiertas que nadie cubre (repos con «Arreglar alertas» prendido).
  const { startDueAdoptedRuns } = await import("./factory-adopt.server");
  await startDueAdoptedRuns().catch((e) => console.error("[factory] arranques a su hora", e));
  const { sweepSecurityAlerts } = await import("../automations/security-fix.server");
  await sweepSecurityAlerts(ns).catch((e) => console.error("[security_fix] barrido", e));
  const rows = await dbq(
    `SELECT * FROM gt_factory_schedules WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= unixepoch()`,
    [],
  ).catch(() => []);
  for (const r of rows) {
    const kind = r.kind as ScheduleKind;
    const now = Math.floor(Date.now() / 1000);
    const next = nextRunAt(kind, Number(r.hour), !!r.weekdays_only, String(r.tz), now);
    // CLAIM atómico: sólo quien mueve `next_at` dispara (dos ticks traslapados, un solo turno).
    const claimed = await dbq(
      `UPDATE gt_factory_schedules SET next_at = ? WHERE kind = ? AND next_at = ? RETURNING kind`,
      [next, kind, r.next_at],
    );
    if (!claimed.length) continue;
    await fireSchedule(ns, kind, String(r.owner_sub), String(r.origin ?? "")).catch((e) => console.error(`[factory] tarea ${kind}`, e));
  }
  await sweepRepoSchedules(ns).catch((e) => console.error("[factory] tareas por repo", e));
}

async function sweepRepoSchedules(ns: string, now = Date.now()): Promise<void> {
  const jobs = await dueRepoJobs(await listRepoSchedules(), now);
  if (!jobs.length) return;
  const { isInstalled } = await import("./installed.server");
  if (!(await isInstalled("factory").catch(() => false))) return;
  const db = await import("../../db.server");
  let fired = 0;
  for (const job of jobs) {
    // El room tiene que seguir teniendo ese repo: desconectarlo apaga su tarea de hecho.
    const link = (await db.listRoomRepos(job.roomId).catch(() => [])).find((x) => x.repo.toLowerCase() === job.repo.toLowerCase());
    if (!link) continue;
    if (await wakePlan(ns, job.kind, job.roomId, link.repo, job.ownerSub || link.connectedBy, job.origin, job.key)) fired++;
  }
  if (fired) (await import("../wakeups.server")).armWakeups(ns);
}

/** Despierta a @plan con el encargo de `kind` sobre UN repo, top-level en su room. */
async function wakePlan(ns: string, kind: ScheduleKind, roomId: number, repo: string, ownerSub: string, origin: string, key: string): Promise<boolean> {
  const { resolvedAgents, agentGroupId } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  if (!plan) return false;
  const { enqueueWakeup, mintWakeRef } = await import("../wakeups.server");
  return enqueueWakeup({
    key,
    ref: mintWakeRef({
      sub: ownerSub,
      ns,
      groupId: await agentGroupId(plan, `factory-sched-${kind}-${repo}`),
      // Top-level en el room: si propone un plan, `factory_plan_submit` publica la raíz.
      // `factorySched` le pone los safe-outputs de la tarea (sólo leer y proponer con firma);
      // `automationRepo` le dice a la fábrica de qué repo es (room con varios).
      dest: { channelId: roomId, topic: "general", handle: plan.handle, name: plan.name, avatar: plan.avatar, factorySched: kind, automationRepo: repo },
    }),
    cause: kind === "nightly" ? "revisión nocturna" : "revisión de dependencias",
    text: `[factory-sched:${kind}] Trabaja SÓLO sobre el repo ${repo} (pásalo en \`repo\` si propones un plan). ` + ENCARGO[kind],
    // El origin guardado al programar (aquí no hay request).
    origin,
    dueAt: Math.floor(Date.now() / 1000),
  }).catch(() => false);
}

async function fireSchedule(ns: string, kind: ScheduleKind, ownerSub: string, origin: string): Promise<void> {
  const { isInstalled } = await import("./installed.server");
  if (!(await isInstalled("factory").catch(() => false))) return; // sin fábrica no hay a quién despertar
  const day = new Date().toISOString().slice(0, 10);
  // Los repos con horario propio (prendido o apagado) no siguen el del espacio.
  const own = new Set((await listRepoSchedules()).filter((r) => r.kind === kind).map((r) => pairKey(r.roomId, r.repo, kind)));
  // UN despertar por repo de CADA room de la fábrica (todo room con repos lo es): cada revisión
  // es un turno aislado (si uno falla o tarda, los demás no) y cae en el room de su repo.
  const db = await import("../../db.server");
  const { factoryRoomIds } = await import("./factory");
  for (const roomId of await factoryRoomIds()) {
    for (const { repo } of await db.listRoomRepos(roomId)) {
      if (own.has(pairKey(roomId, repo, kind))) continue;
      await wakePlan(ns, kind, roomId, repo, ownerSub, origin, `sched:factory-${kind}:${roomId}:${repo}:${day}`);
    }
  }
  const { armWakeups } = await import("../wakeups.server");
  armWakeups(ns);
}
