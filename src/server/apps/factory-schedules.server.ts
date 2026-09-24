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

const TICK_MS = 30_000;

const ENCARGO: Record<ScheduleKind, string> = {
  nightly:
    "Revisión nocturna de la Software Factory. Mira lo que pasó hoy en el repo de este room: PRs mezclados, " +
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
  const { announcePreviews } = await import("./factory-runs.server");
  await announcePreviews().catch(() => {});
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
}

async function fireSchedule(ns: string, kind: ScheduleKind, ownerSub: string, origin: string): Promise<void> {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<{ roomId?: number }>("factory");
  if (!cfg?.roomId) return; // sin fábrica instalada no hay a quién despertar
  const { resolvedAgents, agentGroupId } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  if (!plan) return;
  const { enqueueWakeup, mintWakeRef, armWakeups } = await import("../wakeups.server");
  const day = new Date().toISOString().slice(0, 10);
  // UN despertar por repo del room: cada revisión es un turno aislado (si uno falla o tarda,
  // los demás no), y el plan que proponga ya sabe de qué repo es.
  const db = await import("../../db.server");
  const repos = (await db.listRoomRepos(cfg.roomId)).map((r) => r.repo);
  for (const repo of repos.length ? repos : [null]) {
    await enqueueWakeup({
      key: `sched:factory-${kind}:${repo ?? "room"}:${day}`,
      ref: mintWakeRef({
        sub: ownerSub,
        ns,
        groupId: await agentGroupId(plan, `factory-sched-${kind}${repo ? `-${repo}` : ""}`),
        // Top-level en el room: si propone un plan, `factory_plan_submit` publica la raíz.
        dest: { channelId: cfg.roomId, topic: "general", handle: plan.handle, name: plan.name, avatar: plan.avatar },
      }),
      cause: kind === "nightly" ? "revisión nocturna" : "revisión de dependencias",
      text:
        `[factory-sched:${kind}] ` +
        (repo ? `Trabaja SÓLO sobre el repo ${repo} (pásalo en \`repo\` si propones un plan). ` : "") +
        ENCARGO[kind],
      // El origin guardado al programar (aquí no hay request).
      origin,
      dueAt: Math.floor(Date.now() / 1000),
    });
  }
  armWakeups(ns);
}
