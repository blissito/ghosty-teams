// Números de la Software Factory de un espacio: cuántos pedidos se concretan y cuánto
// cuestan (vueltas, tiempo). Puro, para probarlo. Hoy se MIDE; más adelante con esto se
// fijan los límites por plan.

export type StatsRow = {
  status: string;
  loops: number;
  createdAt: number;
  prReadyAt: number | null;
};

export type RunStats = {
  total: number;
  merged: number;
  cancelled: number;
  open: number;
  escalated: number;
  /** mezclados / (mezclados + cancelados); null sin pedidos cerrados. */
  successRate: number | null;
  /** Vueltas de @check promedio en los que llegaron a PR (o se mezclaron). */
  avgLoops: number | null;
  /** Mediana del pedido al PR listo, en segundos. */
  medianToPrSeconds: number | null;
};

export function runStats(rows: StatsRow[]): RunStats {
  const merged = rows.filter((r) => r.status === "done").length;
  const cancelled = rows.filter((r) => r.status === "cancelled").length;
  const escalated = rows.filter((r) => r.status === "escalated").length;
  const reached = rows.filter((r) => r.prReadyAt != null);
  // Vueltas: todo pedido que llegó a PR o se mezcló (las vueltas se guardan desde siempre;
  // `prReadyAt` sólo desde el 2026-09-24).
  const passed = rows.filter((r) => r.prReadyAt != null || r.status === "done" || r.status === "pr_review");
  const times = reached.map((r) => r.prReadyAt! - r.createdAt).filter((s) => s >= 0).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  return {
    total: rows.length,
    merged,
    cancelled,
    escalated,
    open: rows.length - merged - cancelled,
    successRate: merged + cancelled ? merged / (merged + cancelled) : null,
    avgLoops: passed.length ? passed.reduce((n, r) => n + r.loops, 0) / passed.length : null,
    medianToPrSeconds: times.length ? (times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2)) : null,
  };
}
