// Horario de una tarea programada de la fábrica para UN repo, como lo enseña la pantalla: un
// día (L–V, diario o un día de la semana) y una hora de CDMX. Se guarda como cron de 5 campos
// (`gt_factory_repo_schedules.cron`). Puro y sin imports de servidor: lo usan la UI y el server.

/** "1-5" = lunes a viernes, "*" = todos los días, "0".."6" = domingo..sábado. */
export type ScheduleDay = "1-5" | "*" | "0" | "1" | "2" | "3" | "4" | "5" | "6";

export const SCHEDULE_DAYS: { value: ScheduleDay; label: string }[] = [
  { value: "1-5", label: "Lunes a viernes" },
  { value: "*", label: "Todos los días" },
  { value: "1", label: "Lunes" },
  { value: "2", label: "Martes" },
  { value: "3", label: "Miércoles" },
  { value: "4", label: "Jueves" },
  { value: "5", label: "Viernes" },
  { value: "6", label: "Sábado" },
  { value: "0", label: "Domingo" },
];

const DAY_SET = new Set<string>(SCHEDULE_DAYS.map((d) => d.value));

/** El día de cada tarea en el horario del espacio: nocturna L–V, dependencias los lunes. */
export const DEFAULT_DAY: Record<"nightly" | "deps", ScheduleDay> = { nightly: "1-5", deps: "1" };

export function scheduleToCron(day: ScheduleDay, hour: number): string {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  return `0 ${h} * * ${DAY_SET.has(day) ? day : "1-5"}`;
}

/** El cron de vuelta a día+hora; null si es uno a la medida (puesto por API) que la pantalla no sabe pintar. */
export function cronToSchedule(cron: string): { day: ScheduleDay; hour: number } | null {
  const m = cron.trim().match(/^0 (\d{1,2}) \* \* (\S+)$/);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour > 23 || !DAY_SET.has(m[2])) return null;
  return { day: m[2] as ScheduleDay, hour };
}
