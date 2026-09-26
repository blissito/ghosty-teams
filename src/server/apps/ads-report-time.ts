// Cuándo toca el siguiente reporte de Ghosty Ads. Puro (sin DB) para probarlo; usa el
// reloj de pared de los recordatorios, igual que los horarios de la Fábrica.
import { wallOf, wallToEpoch } from "../reminders.server";

/** Default: 9:00 y 21:00, hora de la Ciudad de México. */
export const REPORT_DEFAULT = { hours: [9, 21], tz: "America/Mexico_City" };

/** Horas válidas (0–23), sin repetir y en orden. Vacío = el default. */
export function normalizeHours(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  const out = [...new Set(list.map((h) => Math.floor(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  return out.length ? out.slice(0, 6) : [...REPORT_DEFAULT.hours];
}

/** Siguiente reporte estrictamente después de `nowSec`, a la primera de `hours` que toque en `tz`. */
export function nextReportAt(hours: number[], tz: string, nowSec: number): number {
  const w = wallOf(nowSec * 1000, tz);
  let best = Infinity;
  for (let add = 0; add < 2; add++) {
    for (const h of normalizeHours(hours)) {
      const at = wallToEpoch({ y: w.y, mo: w.mo, d: w.d + add, h, mi: 0 }, tz);
      if (at > nowSec && at < best) best = at;
    }
  }
  return Number.isFinite(best) ? best : nowSec + 43_200;
}
