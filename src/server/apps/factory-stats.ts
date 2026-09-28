// Números de la Software Factory de un espacio: cuántos pedidos se concretan y cuánto
// cuestan (vueltas, tiempo). Puro, para probarlo. Hoy se MIDE; más adelante con esto se
// fijan los límites por plan.

export type StatsRow = {
  status: string;
  loops: number;
  createdAt: number;
  prReadyAt: number | null;
  firstReviewAt?: number | null;
  firstReviewState?: string | null;
  mergedAt?: number | null;
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
  /** De los PRs que ya vio una persona, cuántos pasaron a la primera: la métrica norte. */
  firstPassRate: number | null;
  /** Mediana de PR listo → primera revisión humana (o merge, si nadie dejó review). */
  medianReviewSeconds: number | null;
};

// Pasó a la primera: aprobado en la primera review, o mezclado sin que nadie pidiera cambios.
// `changes_requested` reprueba; un `commented` sólo decide cuando hay merge. null = todavía no se sabe.
export function firstPass(r: StatsRow): boolean | null {
  if (r.prReadyAt == null) return null;
  const state = r.firstReviewState ?? null;
  if (state === "approved") return true;
  if (state === "changes_requested") return false;
  if (r.status === "done") return true;
  return null;
}

function median(xs: number[]): number | null {
  const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)) : null;
}

export function runStats(rows: StatsRow[]): RunStats {
  const merged = rows.filter((r) => r.status === "done").length;
  const cancelled = rows.filter((r) => r.status === "cancelled").length;
  const escalated = rows.filter((r) => r.status === "escalated").length;
  const reached = rows.filter((r) => r.prReadyAt != null);
  // Vueltas: todo pedido que llegó a PR o se mezcló (las vueltas se guardan desde siempre;
  // `prReadyAt` sólo desde el 2026-09-24).
  const passed = rows.filter((r) => r.prReadyAt != null || r.status === "done" || r.status === "pr_review");
  const judged = reached.map(firstPass).filter((x): x is boolean => x != null);
  const reviewTimes = reached
    .map((r) => (r.firstReviewAt ?? r.mergedAt ?? null) != null ? (r.firstReviewAt ?? r.mergedAt)! - r.prReadyAt! : null)
    .filter((x): x is number => x != null);
  return {
    total: rows.length,
    merged,
    cancelled,
    escalated,
    open: rows.length - merged - cancelled,
    successRate: merged + cancelled ? merged / (merged + cancelled) : null,
    avgLoops: passed.length ? passed.reduce((n, r) => n + r.loops, 0) / passed.length : null,
    medianToPrSeconds: median(reached.map((r) => r.prReadyAt! - r.createdAt)),
    firstPassRate: judged.length ? judged.filter(Boolean).length / judged.length : null,
    medianReviewSeconds: median(reviewTimes),
  };
}
