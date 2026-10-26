// Severidad mínima de una revisión (P0/P1/P2): un solo texto para la automatización pr_review y
// la revisión suelta de @check en la fábrica. Puro, sin imports: lo usan factory-roles y
// pr-review.server sin ciclo.

export type Severity = "P0" | "P1" | "P2";

export function normalizeSeverity(v: unknown): Severity {
  return v === "P0" || v === "P2" ? v : "P1";
}

/** Valor explícito o null (para saber si alguien lo fijó). */
export function parseSeverity(v: unknown): Severity | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "P0" || s === "P1" || s === "P2" ? s : null;
}

/** Qué entra a la review según la severidad mínima. */
export function severityScope(min: Severity): string {
  if (min === "P0") return "sólo P0 (rompe producción, hueco de seguridad, pérdida o fuga de datos)";
  if (min === "P2") return "P0, P1 y P2 (P2 = mantenibilidad o pruebas que faltan con riesgo real; nunca estilo ni gustos)";
  return "sólo P0 y P1 (bugs, seguridad, pérdida de datos, condiciones de carrera, regresiones claras)";
}

/** La regla de severidad tal cual la lee @check: qué publicar, cómo marcarlo y la review vacía. */
export function severityRule(min: Severity): string {
  return `Severidad: de lo que encuentres, publica ${severityScope(min)}; lo demás no se comenta. Antes de señalar algo, confirma en el código que pasa de verdad; si dudas, no lo señales. Un comentario en línea por hallazgo, con la severidad al inicio («P1: …»), qué falla y cómo arreglarlo. Si no hay nada grave, la review es una línea: «Sin hallazgos graves».`;
}
