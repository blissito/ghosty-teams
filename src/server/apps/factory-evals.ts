// Evals de la fábrica: volver a correr un pedido YA mezclado con otro agente o modelo en un rol,
// desde el mismo commit base y con el mismo plan firmado, y que un juez con la rúbrica de @check
// lo califique contra el PR real. Sirve para elegir el modelo de cada rol con datos.
// Puro (rúbrica, validación y resumen), para probarlo.

export const EVAL_BRANCH_PREFIX = "ghosty-eval/";

export const evalBranch = (evalRunId: number) => `${EVAL_BRANCH_PREFIX}${evalRunId}`;

// Lo que califica el juez, de 1 a 5. Mismo criterio que @check en un pedido real.
export const EVAL_CRITERIA = {
  plan: "Cumple los criterios de aceptación del plan",
  tests: "Pruebas que de verdad demuestran lo pedido",
  maintainability: "Fácil de cambiar mañana: sin duplicar, sin valores fijos, patrón del código vecino",
  scope: "Sólo lo pedido: nada fuera de alcance",
} as const;
export type EvalCriterion = keyof typeof EVAL_CRITERIA;
export type EvalVerdict = "worse" | "same" | "better";

export type EvalConfig = { role: "build"; agent?: string | null; model?: string | null };

export type EvalResult = {
  scores: Record<EvalCriterion, number>;
  /** Contra el PR que se mezcló de verdad. */
  vsOriginal: EvalVerdict;
  notes: string;
};

/** Valida lo que manda el juez: 4 notas enteras de 1 a 5 y la comparación. */
export function parseEvalScore(a: Record<string, unknown>): EvalResult | { error: string } {
  const raw = (a.scores ?? {}) as Record<string, unknown>;
  const scores = {} as Record<EvalCriterion, number>;
  for (const k of Object.keys(EVAL_CRITERIA) as EvalCriterion[]) {
    const n = Number(raw[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: `scores.${k} tiene que ser un entero de 1 a 5` };
    scores[k] = n;
  }
  const vs = String(a.vs_original ?? "");
  if (!["worse", "same", "better"].includes(vs)) return { error: "vs_original tiene que ser worse, same o better" };
  return { scores, vsOriginal: vs as EvalVerdict, notes: String(a.notes ?? "").trim().slice(0, 3000) };
}

export const evalAverage = (s: Record<EvalCriterion, number>) =>
  Math.round((Object.values(s).reduce((n, x) => n + x, 0) / Object.keys(s).length) * 10) / 10;

/** Nombre corto de una configuración para la tabla: «@build · deepseek · flash». */
export function configLabel(c: EvalConfig): string {
  return [`@${c.role}`, c.agent, c.model].filter(Boolean).join(" · ");
}

export type EvalRow = {
  config: EvalConfig;
  result: EvalResult | null;
  /** Segundos del arranque al build terminado. */
  buildSeconds: number | null;
};

export type EvalSummary = {
  label: string;
  runs: number;
  scored: number;
  avg: number | null;
  better: number;
  same: number;
  worse: number;
  medianBuildSeconds: number | null;
};

/** Una fila por configuración, la mejor calificada arriba. */
export function summarizeEvals(rows: EvalRow[]): EvalSummary[] {
  const by = new Map<string, EvalRow[]>();
  for (const r of rows) {
    const k = configLabel(r.config);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out: EvalSummary[] = [];
  for (const [label, list] of by) {
    const scored = list.filter((r) => r.result);
    const avgs = scored.map((r) => evalAverage(r.result!.scores));
    const times = list.map((r) => r.buildSeconds).filter((x): x is number => x != null && x >= 0).sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    out.push({
      label,
      runs: list.length,
      scored: scored.length,
      avg: avgs.length ? Math.round((avgs.reduce((n, x) => n + x, 0) / avgs.length) * 10) / 10 : null,
      better: scored.filter((r) => r.result!.vsOriginal === "better").length,
      same: scored.filter((r) => r.result!.vsOriginal === "same").length,
      worse: scored.filter((r) => r.result!.vsOriginal === "worse").length,
      medianBuildSeconds: times.length ? (times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2)) : null,
    });
  }
  return out.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
}
