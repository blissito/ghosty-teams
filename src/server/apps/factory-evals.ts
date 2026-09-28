// Evals de la fábrica: volver a correr un pedido YA mezclado con otro agente o modelo en un rol,
// desde el mismo commit base y con el mismo plan firmado, y que un juez con la rúbrica de @check
// lo califique contra el PR real. Sirve para elegir el modelo de cada rol con datos.
// Puro (rúbrica, validación y resumen), para probarlo.

export const EVAL_BRANCH_PREFIX = "ghosty-eval/";

export const evalBranch = (evalRunId: number) => `${EVAL_BRANCH_PREFIX}${evalRunId}`;

export type EvalRole = "plan" | "build" | "check";

// Lo que califica el juez, de 1 a 5, POR ROL. `short` es el nombre de la fila en la tabla del hilo.
// build: el mismo criterio que @check en un pedido real. plan: que se firme en un minuto.
// check: contra la revisión humana y el @check original (encontrar lo que importa, sin ruido).
export const EVAL_RUBRIC: Record<EvalRole, Record<string, { desc: string; short: string }>> = {
  plan: {
    coverage: { desc: "Cubre lo pedido, con criterios de aceptación verificables", short: "Cubre lo pedido" },
    concrete: { desc: "Brief técnico concreto: archivos, piezas y pruebas que lo demuestran", short: "Concreto" },
    risks: { desc: "Riesgos y lo que NO se hará, explícitos", short: "Riesgos" },
    signable: { desc: "Una persona lo firma en un minuto: corto, claro, sin relleno", short: "Se firma rápido" },
  },
  build: {
    plan: { desc: "Cumple los criterios de aceptación del plan", short: "Cumple el plan" },
    tests: { desc: "Pruebas que de verdad demuestran lo pedido", short: "Pruebas" },
    maintainability: { desc: "Fácil de cambiar mañana: sin duplicar, sin valores fijos, patrón del código vecino", short: "Mantenible" },
    scope: { desc: "Sólo lo pedido: nada fuera de alcance", short: "Alcance" },
  },
  check: {
    catches: { desc: "Encuentra lo que importa (lo que vio la persona y el @check original)", short: "Encuentra lo importante" },
    precision: { desc: "Sin falsos positivos ni hallazgos de relleno", short: "Sin ruido" },
    actionable: { desc: "Hallazgos accionables: archivo:línea y qué falta", short: "Accionable" },
    verdict: { desc: "Veredicto correcto (pasa / no pasa) frente a lo que pasó de verdad", short: "Veredicto" },
  },
};

export const EVAL_ROLES = Object.keys(EVAL_RUBRIC) as EvalRole[];
export type EvalVerdict = "worse" | "same" | "better";

export type EvalConfig = { role: EvalRole; agent?: string | null; model?: string | null };

export type EvalResult = {
  scores: Record<string, number>;
  /** Contra lo que se hizo de verdad (el PR mezclado, el plan firmado o la revisión original). */
  vsOriginal: EvalVerdict;
  notes: string;
};

/** Rúbrica en texto para el encargo del juez. */
export const rubricText = (role: EvalRole) =>
  Object.entries(EVAL_RUBRIC[role])
    .map(([k, v]) => `- ${k}: ${v.desc}`)
    .join("\n");

/** Valida lo que manda el juez: las 4 notas del rol, enteras de 1 a 5, y la comparación. */
export function parseEvalScore(role: EvalRole, a: Record<string, unknown>): EvalResult | { error: string } {
  const raw = (a.scores ?? {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const k of Object.keys(EVAL_RUBRIC[role])) {
    const n = Number(raw[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: `scores.${k} tiene que ser un entero de 1 a 5 (rúbrica de ${role}: ${Object.keys(EVAL_RUBRIC[role]).join(", ")})` };
    scores[k] = n;
  }
  const vs = String(a.vs_original ?? "");
  if (!["worse", "same", "better"].includes(vs)) return { error: "vs_original tiene que ser worse, same o better" };
  return { scores, vsOriginal: vs as EvalVerdict, notes: String(a.notes ?? "").trim().slice(0, 3000) };
}

export const evalAverage = (s: Record<string, number>) =>
  Math.round((Object.values(s).reduce((n, x) => n + x, 0) / Object.keys(s).length) * 10) / 10;

/** Nombre de una configuración: «build con Grey · terra». Sin «@»: en el chat sería una mención. */
export function configLabel(c: EvalConfig): string {
  const who = [c.agent, c.model].filter(Boolean).join(" · ");
  return who ? `${c.role} con ${who}` : c.role;
}

const VS: Record<EvalRole, string> = { plan: "el plan firmado", build: "el PR original", check: "la revisión original" };

/** El resultado del juez como lo lee una persona en el hilo: veredicto arriba, tabla, porqué. */
export function evalResultMarkdown(c: EvalConfig, r: EvalResult, costUsd?: number | null, models?: string[]): string {
  const vs = { worse: "⬇️ peor que", same: "↔️ igual que", better: "⬆️ mejor que" }[r.vsOriginal] + ` ${VS[c.role]}`;
  const rows = Object.entries(EVAL_RUBRIC[c.role])
    .map(([k, v]) => `| ${v.short} | ${r.scores[k]}/5 |`)
    .join("\n");
  return (
    `🧪 **Eval: ${configLabel(c)} — ${evalAverage(r.scores)}/5** · ${vs}` +
    (models?.length ? ` · ${models.join(", ")}` : "") +
    (costUsd != null ? ` · ${formatUsd(costUsd)}` : "") +
    `\n\n| Criterio | Nota |\n|---|---|\n${rows}\n` +
    (r.notes ? `\n**Por qué:** ${r.notes}\n` : "") +
    `\n_El resumen por rol y modelo está en la página de la Fábrica._`
  );
}

export const formatUsd = (n: number) => (n < 0.01 ? "< $0.01 USD" : `$${n.toFixed(2)} USD`);

export type EvalRow = {
  config: EvalConfig;
  result: EvalResult | null;
  /** Segundos del arranque a que el rol evaluado cerró su paso. */
  seconds: number | null;
  /** Costo del rol evaluado (tokens en gs × precio). null si todavía no se sabe. */
  costUsd: number | null;
};

export type EvalSummary = {
  role: EvalRole;
  label: string;
  runs: number;
  scored: number;
  avg: number | null;
  better: number;
  same: number;
  worse: number;
  medianSeconds: number | null;
  medianCostUsd: number | null;
};

function median(xs: (number | null)[]): number | null {
  const s = xs.filter((x): x is number => x != null && x >= 0).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : null;
}

/** Una fila por configuración: agrupadas por rol y, dentro, la mejor calificada arriba. */
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
    const secs = median(list.map((r) => r.seconds));
    out.push({
      role: list[0].config.role,
      label,
      runs: list.length,
      scored: scored.length,
      avg: avgs.length ? Math.round((avgs.reduce((n, x) => n + x, 0) / avgs.length) * 10) / 10 : null,
      better: scored.filter((r) => r.result!.vsOriginal === "better").length,
      same: scored.filter((r) => r.result!.vsOriginal === "same").length,
      worse: scored.filter((r) => r.result!.vsOriginal === "worse").length,
      medianSeconds: secs == null ? null : Math.round(secs),
      medianCostUsd: median(list.map((r) => r.costUsd)),
    });
  }
  return out.sort((a, b) => EVAL_ROLES.indexOf(a.role) - EVAL_ROLES.indexOf(b.role) || (b.avg ?? -1) - (a.avg ?? -1));
}
