// Mantenimiento programado por repo (tipo `maintenance`): a la hora que el room eligió, la
// plataforma despierta a @build o @plan con una RECETA fija — dependencias, docs, TODOs,
// huecos de tests. Inspirado en las Scheduled Tasks de Jules, los workflows de gh-aw con
// «safe-outputs», la receta «scheduled maintenance» de claude-code-action y las «Finishing
// Touches» de CodeRabbit.
//
// No corre por evento (`on: []`): un barrido cada 15 min mira `gt_repo_automations` con
// `kind = 'maintenance'` y decide con `isDue` (reloj de CDMX). El turno lleva
// `dest.automation = "maintenance"`, y con eso `runTool` aplica los safe-outputs
// (`safe-outputs.ts`): sólo issues `[ghosty]` con etiqueta `ghosty-maintenance` o PR en
// BORRADOR desde `ghosty/maint-<receta>-<fecha>`. Nunca mergea ni cierra nada.
//
// El turno lo abre `automationCtx().wake` (el mismo de las demás automatizaciones y de la
// estafeta de la fábrica), en un hilo fijo por receta (`maint-<receta>`): cada semana cae en el
// mismo. Si no hay nada que hacer el agente contesta «OK» y `fire()` borra esa burbuja.
import type { Automation } from "./types";
import { wallOf } from "../reminders.server";
import { MAINT_BRANCH_PREFIX, MAINT_ISSUE_PREFIX, MAINT_LABEL } from "./safe-outputs";

export const MAINTENANCE_RECIPES = ["deps", "docs", "todos", "tests"] as const;
export type MaintenanceRecipe = (typeof MAINTENANCE_RECIPES)[number];

export type MaintenanceSettings = {
  recipes?: string[];
  /** 0 = domingo … 6 = sábado. Default lunes. Se ignora si hay `cron`. */
  weekday?: number;
  /** Hora de CDMX (0–23). Default 9. */
  hour?: number;
  minute?: number;
  /** Cron de 5 campos (`m h dom mes dow`) leído en hora de CDMX. Gana sobre weekday/hour. */
  cron?: string;
};

const TICK_MS = 15 * 60_000;
/** Ventana de gracia: un tick perdido (deploy, reinicio) no se come la semana. */
const DUE_WINDOW_MIN = 60;
const CDMX_TZ = "America/Mexico_City";

// ── Reloj ────────────────────────────────────────────────────────────────────

type WallClock = { minute: number; hour: number; dom: number; month: number; dow: number; date: string };

/** La hora de pared de CDMX de un instante (ms epoch). El reloj es el de los recordatorios y
 *  las tareas de la fábrica (`wallOf`), no uno propio. */
export function cdmxClock(ms: number): WallClock {
  const w = wallOf(ms, CDMX_TZ);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    minute: w.mi,
    hour: w.h,
    dom: w.d,
    month: w.mo,
    dow: new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay(),
    date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`,
  };
}

/** Un campo de cron: `*`, `5`, `1,3`, `1-5`, `*\/15`, `0-30/10`. null = campo inválido. */
function cronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.trim().match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let lo = min, hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export type CronSpec = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean };

export function parseCron(expr: string): CronSpec | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = cronField(f[0], 0, 59), hour = cronField(f[1], 0, 23), dom = cronField(f[2], 1, 31);
  const month = cronField(f[3], 1, 12), dowRaw = cronField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  // 7 también es domingo.
  const dow = new Set([...dowRaw].map((d) => d % 7));
  return { minute, hour, dom, month, dow, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

function cronMatches(c: CronSpec, w: WallClock): boolean {
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  // Regla clásica de cron: con día del mes Y de la semana restringidos, basta cualquiera.
  if (!c.domStar && !c.dowStar) return c.dom.has(w.dom) || c.dow.has(w.dow);
  return c.dom.has(w.dom) && c.dow.has(w.dow);
}

/** El horario efectivo como cron (weekday/hour/minute se traducen). null = ajustes inválidos. */
export function scheduleOf(s: MaintenanceSettings): CronSpec | null {
  if (s.cron) return parseCron(s.cron);
  const weekday = s.weekday ?? 1, hour = s.hour ?? 9, minute = s.minute ?? 0;
  if (![weekday, hour, minute].every(Number.isInteger)) return null;
  return parseCron(`${minute} ${hour} * * ${weekday}`);
}

/**
 * El instante programado que cae en los últimos `DUE_WINDOW_MIN` minutos, o null. Devuelve la
 * fecha de CDMX de ese instante: con ella se arma la llave del claim
 * (`<repo>:<receta>:<fecha>`), así que dos ticks dentro de la ventana disparan una sola vez.
 */
export function dueSlot(s: MaintenanceSettings, now: number, windowMin = DUE_WINDOW_MIN): string | null {
  return dueSlotAt(s, now, windowMin)?.date ?? null;
}

/** Como `dueSlot`, con la hora del instante (`HH:MM` de CDMX): para un cron que corre varias veces al día. */
export function dueSlotAt(s: MaintenanceSettings, now: number, windowMin = DUE_WINDOW_MIN): { date: string; time: string } | null {
  const c = scheduleOf(s);
  if (!c) return null;
  const base = Math.floor(now / 60_000) * 60_000;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < windowMin; i++) {
    const w = cdmxClock(base - i * 60_000);
    if (cronMatches(c, w)) return { date: w.date, time: `${pad(w.hour)}:${pad(w.minute)}` };
  }
  return null;
}

export function isDue(s: MaintenanceSettings, now: number): boolean {
  return dueSlot(s, now) !== null;
}

/** Las recetas elegidas, sólo las conocidas y sin repetir. */
export function recipesOf(s: MaintenanceSettings): MaintenanceRecipe[] {
  const known = new Set<string>(MAINTENANCE_RECIPES);
  return [...new Set((s.recipes ?? []).map(String))].filter((r): r is MaintenanceRecipe => known.has(r));
}

// ── Recetas ──────────────────────────────────────────────────────────────────

/** Qué rol corre cada receta: @build si el entregable es un PR borrador, @plan si son issues. */
export const RECIPE_HANDLE: Record<MaintenanceRecipe, "build" | "plan"> = {
  deps: "build",
  docs: "build",
  todos: "plan",
  tests: "build",
};

const RECIPE_TITLE: Record<MaintenanceRecipe, string> = {
  deps: "dependencias",
  docs: "documentación",
  todos: "TODOs",
  tests: "tests",
};

const RECIPE_TASK: Record<MaintenanceRecipe, string> = {
  deps:
    "Actualiza las dependencias MENORES y de PARCHE del repo (nunca mayores: ésas sólo las mencionas en la descripción del PR). " +
    "Si ya hay un PR abierto de Dependabot o Renovate para un paquete, ése no lo repitas (la fábrica ya los adopta). " +
    "Respeta el gestor y el lockfile que ya usa el repo. Corre la instalación, el build y los tests; si algo truena por una " +
    "actualización, quítala del lote y dilo. Abre UN PR borrador con el lote y espera a que el CI pase (github_pr_checks).",
  docs:
    "Compara el README y la carpeta de docs con el código actual: comandos, variables de entorno, rutas, scripts de package.json " +
    "o equivalentes, ejemplos que ya no corren. Corrige SÓLO lo que el código contradice (no reescribas el estilo) en UN PR borrador, " +
    "con una lista de qué estaba desfasado y dónde lo viste en el código.",
  todos:
    "Busca los TODO, FIXME y HACK del código (github_search_code). Quédate con los que señalan un bug, un riesgo o trabajo " +
    "concreto y vigente; ignora los vagos o los de código muerto. Para los relevantes, abre issues (máximo 5, agrupa los del " +
    "mismo tema) con archivo y línea, por qué importa y una propuesta concreta. Antes, revisa github_list_issues con la " +
    `etiqueta ${MAINT_LABEL} para no repetir uno que ya exista.`,
  tests:
    "Mira lo que cambió en la rama principal en los últimos 7 días (github_list_commits / github_get_commit). Encuentra la " +
    "lógica nueva o cambiada sin pruebas y escribe tests para lo más riesgoso, con el framework de pruebas que ya usa el repo. " +
    "Córrelos; un test que falla por un bug real NO se arregla aquí: se reporta en la descripción del PR. Abre UN PR borrador.",
};

/** El texto del turno: el encargo + los safe-outputs dichos en claro (el candado vive en runTool). */
export function recipeText(recipe: MaintenanceRecipe, repo: string, date: string): string {
  const branch = `${MAINT_BRANCH_PREFIX}${recipe}-${date}`;
  const output =
    RECIPE_HANDLE[recipe] === "plan"
      ? `Entregas SÓLO issues nuevos: título con el prefijo «${MAINT_ISSUE_PREFIX}» y la etiqueta «${MAINT_LABEL}».`
      : `Entregas SÓLO un PR en BORRADOR desde la rama ${branch} (créala desde la principal), o un issue con el prefijo ` +
        `«${MAINT_ISSUE_PREFIX}» y la etiqueta «${MAINT_LABEL}» si el cambio no cabe en un PR.`;
  return (
    `[maintenance:${recipe}] Mantenimiento semanal de ${RECIPE_TITLE[recipe]} del repo ${repo}. Trabaja SÓLO sobre ese repo. ` +
    RECIPE_TASK[recipe] +
    `\n\nReglas de este turno (la plataforma las hace cumplir): ${output} Nunca mergeas, nunca cierras ni editas issues o PRs ` +
    `existentes, nunca empujas a la rama principal ni a ramas de personas. Al terminar, deja en este hilo la liga de lo que abriste.`
  );
}

// ── Barrido ──────────────────────────────────────────────────────────────────

/** Una fila prendida de `gt_repo_automations` (kind = maintenance). */
export type MaintenanceRow = { roomId: number; repo: string; settings: MaintenanceSettings };

export type MaintenanceJob = {
  roomId: number; repo: string; recipe: MaintenanceRecipe; date: string; handle: "build" | "plan";
  /** Clave del claim: una vez por room, repo, receta y fecha de CDMX. */
  key: string;
  /** El hilo propio de la receta en el room: la semana siguiente cae en el mismo. */
  threadKey: string;
};

/** Puro: qué recetas tocan AHORA. */
export function dueJobs(rows: MaintenanceRow[], now: number): MaintenanceJob[] {
  const out: MaintenanceJob[] = [];
  for (const r of rows) {
    const date = dueSlot(r.settings, now);
    if (!date) continue;
    for (const recipe of recipesOf(r.settings))
      out.push({
        roomId: r.roomId, repo: r.repo, recipe, date, handle: RECIPE_HANDLE[recipe],
        key: `${r.roomId}:${r.repo}:${recipe}:${date}`,
        threadKey: `maint-${recipe}`,
      });
  }
  return out;
}

function parseSettings(raw: unknown): MaintenanceSettings {
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function loadRows(): Promise<MaintenanceRow[]> {
  const { dbq } = await import("../../dbq.server");
  const rows = await dbq(`SELECT room_id, repo, settings_json FROM gt_repo_automations WHERE kind = 'maintenance' AND enabled = 1`, []).catch(() => []);
  return rows.map((r) => ({ roomId: Number(r.room_id), repo: String(r.repo), settings: parseSettings(r.settings_json) }));
}

/** Claim de 8 días: cubre la ventana de gracia y nunca choca con la semana siguiente. */
const CLAIM_TTL_MS = 8 * 24 * 3600_000;

export async function sweepMaintenance(ns: string, now = Date.now()): Promise<number> {
  const jobs = dueJobs(await loadRows(), now);
  if (!jobs.length) return 0;
  const db = await import("../../db.server");
  const { resolvedAgents } = await import("../../agents.server");
  const { automationCtx } = await import("./ctx.server");
  const handles = new Set((await resolvedAgents()).map((a) => a.handle));
  // UNA sola vía de dependencias: con la fábrica instalada y su revisión de dependencias
  // prendida para ese room+repo (`factory-schedules.server.ts`, @plan propone y alguien firma),
  // la receta `deps` no corre. Sin fábrica, o con su revisión apagada, la receta sí.
  const factoryDeps = await import("../apps/factory-schedules.server")
    .then((m) => m.factoryDepsCoverage())
    .catch(() => () => false);
  let fired = 0;
  for (const job of jobs) {
    if (job.recipe === "deps" && factoryDeps(job.roomId, job.repo)) continue;
    // El room tiene que seguir teniendo ese repo: desconectarlo apaga el mantenimiento de hecho.
    const repos = await db.listRoomRepos(job.roomId).catch(() => []);
    if (!repos.some((x) => x.repo.toLowerCase() === job.repo.toLowerCase())) continue;
    // @plan si no hay @build (y al revés): un room sin fábrica completa igual recibe su receta.
    const handle = handles.has(job.handle) ? job.handle : job.handle === "build" ? "plan" : "build";
    if (!handles.has(handle)) continue;
    const ctx = automationCtx({ ns, roomId: job.roomId, repo: job.repo, kind: "maintenance" });
    if (!(await ctx.claim("maintenance", job.key, CLAIM_TTL_MS))) continue;
    if (!(await ctx.budget("maintenance"))) continue;
    await ctx.wake({
      handle,
      threadKey: job.threadKey,
      title: `🧹 Mantenimiento de ${RECIPE_TITLE[job.recipe]} · \`${job.repo}\``,
      text: recipeText(job.recipe, job.repo, job.date),
    });
    fired++;
  }
  return fired;
}

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Llamado desde ensureSchema, como `armFactorySchedules`: este tenant existe. */
export function armMaintenance(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => void sweepAll(), TICK_MS);
  timer.unref?.();
  void sweepAll();
}

async function sweepAll(): Promise<void> {
  const { withNamespace } = await import("../tenant.server");
  for (const ns of Array.from(tenants)) {
    await withNamespace(ns, () => sweepMaintenance(ns)).catch((e) => console.error(`[maintenance] ${ns}`, e));
  }
}

/** Corre por horario, no por evento: el registro lo lista para la UI y los ajustes. */
export const automations: Automation[] = [
  {
    kind: "maintenance",
    on: [],
    handle: async () => {},
  },
];
