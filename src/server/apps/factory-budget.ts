// Tope de gasto por pedido de la fábrica (31-oct). Partes puras; el resto en factory-budget.server.ts.
// Nació de la auditoría del 17–31 oct: $202 de $331 se fueron a 16 pedidos que nunca se mezclaron,
// sin que nada los detuviera (#133: $47.7 en 210 h). Devin hace lo mismo con su límite por sesión:
// al llegar se duerme hasta que alguien lo despierta.

/** Tope del espacio cuando nadie lo ha cambiado. */
export const DEFAULT_BUDGET_USD = 5;
/** Lo mínimo y lo máximo que se acepta como tope (USD). */
export const MIN_BUDGET_USD = 1;
export const MAX_BUDGET_USD = 500;

/** Las conversaciones del pedido en gs (`agentGroupId` termina así): los roles, el crítico del plan y el refuerzo. */
export function budgetSuffixes(runId: number): string[] {
  return [`-factory-${runId}`, `-factory-${runId}-critic`, `-factory-${runId}-advisor`];
}

/** ¿Ya llegó? Sin dato de gasto (gs no contestó) nunca detiene. */
export function overBudget(spentUsd: number | null, budgetUsd: number): boolean {
  return spentUsd != null && budgetUsd > 0 && spentUsd >= budgetUsd;
}

/** El siguiente escalón que se ofrece al llegar: +$5 hasta $20, luego el doble. */
export function nextBudget(budgetUsd: number): number {
  const next = budgetUsd < 20 ? budgetUsd + 5 : budgetUsd * 2;
  return Math.min(MAX_BUDGET_USD, Math.round(next * 100) / 100);
}

/** Un tope válido (redondeado a centavos) o null. */
export function parseBudget(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  if (!Number.isFinite(n) || n < MIN_BUDGET_USD || n > MAX_BUDGET_USD) return null;
  return Math.round(n * 100) / 100;
}

export const formatBudget = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
