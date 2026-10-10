// Esfuerzo de revisión del PR, del 1 (trivial) al 5 (muy complejo), como el de CodeRabbit,
// pero calculado sin modelo: tamaño + lo que toca (las mismas razones de `factory-risk.ts`).
// Los minutos son una guía para planear la revisión, no una promesa.

export type EffortInput = { additions: number; deletions: number; files: number; riskReasons?: string[]; risk?: string };
export type Effort = { score: 1 | 2 | 3 | 4 | 5; label: string; minutes: number; reasons: string[] };

export const EFFORT_LABELS = ["Trivial", "Simple", "Moderado", "Delicado", "Muy complejo"] as const;

const REASON_TEXT: Record<string, string> = {
  github: "toca CI/.github",
  migration: "trae migración",
  auth: "toca autenticación",
  deps: "cambia dependencias",
  api: "toca la API pública",
};

// Lo que pesa más que el tamaño: un error aquí sale caro aunque sean pocas líneas.
const HEAVY = new Set(["migration", "auth", "api"]);

export function reviewEffort(v: EffortInput): Effort {
  const lines = Math.max(0, Number(v.additions) || 0) + Math.max(0, Number(v.deletions) || 0);
  const files = Math.max(0, Number(v.files) || 0);
  const why = (v.riskReasons ?? []).filter((r) => r !== "size");
  let score = lines <= 30 ? 1 : lines <= 150 ? 2 : lines <= 400 ? 3 : lines <= 1000 ? 4 : 5;
  if (files > 20) score = Math.max(score, 4);
  if (why.some((r) => HEAVY.has(r))) score += 1;
  // @check lo subió por lógica delicada que las rutas no delatan.
  if (v.risk === "high" && score < 3) score = 3;
  const s = Math.min(5, Math.max(1, score)) as Effort["score"];
  // ~1 min por cada 60 líneas + medio minuto por archivo, redondeado a 5 (mínimo 5).
  const minutes = Math.max(5, Math.round((lines / 60 + files * 0.5) / 5) * 5);
  const reasons = [
    `${lines.toLocaleString("es-MX")} líneas en ${files} ${files === 1 ? "archivo" : "archivos"}`,
    ...why.map((r) => REASON_TEXT[r] ?? r),
  ];
  return { score: s, label: EFFORT_LABELS[s - 1], minutes, reasons };
}
