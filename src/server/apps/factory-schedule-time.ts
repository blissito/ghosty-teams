// Cuándo toca la siguiente tarea programada de la Software Factory. Puro (sin DB) para
// probarlo; usa el reloj de pared de los recordatorios (`reminders.server.ts`).
import { wallOf, wallToEpoch } from "../reminders.server";

export type ScheduleKind = "nightly" | "deps";

/** Default de cada tarea: revisión nocturna L–V 02:00; dependencias los lunes 09:00. */
export const SCHEDULE_DEFAULTS: Record<ScheduleKind, { hour: number; weekdaysOnly: boolean }> = {
  nightly: { hour: 2, weekdaysOnly: true },
  deps: { hour: 9, weekdaysOnly: false },
};

/** ¿Este día (en hora de pared) sirve para la tarea? nightly: L–V si weekdaysOnly; deps: lunes. */
function dayOk(kind: ScheduleKind, dow: number, weekdaysOnly: boolean): boolean {
  if (kind === "deps") return dow === 1;
  return weekdaysOnly ? dow >= 1 && dow <= 5 : true;
}

/** Siguiente ejecución estrictamente después de `nowSec`, a las `hour`:00 de `tz`. */
export function nextRunAt(kind: ScheduleKind, hour: number, weekdaysOnly: boolean, tz: string, nowSec: number): number {
  const w = wallOf(nowSec * 1000, tz);
  for (let add = 0; add < 9; add++) {
    // Date.UTC normaliza días desbordados (31 → 1 del siguiente) igual que `wallToEpoch`.
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + add));
    const at = wallToEpoch({ y: w.y, mo: w.mo, d: w.d + add, h: hour, mi: 0 }, tz);
    if (at > nowSec && dayOk(kind, day.getUTCDay(), weekdaysOnly)) return at;
  }
  return nowSec + 86_400;
}
