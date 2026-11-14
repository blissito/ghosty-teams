/**
 * Qué filas corre una columna de agente. ISOMORFO: el servidor lo usa para decidir qué
 * turnos paga y la pantalla para encender el pulso sólo en esas filas. Si cada lado tuviera
 * su criterio, el chip diría «5/100» mientras el servidor corre 95.
 */
export type RunScope = {
  /** Sólo las cuyo turno falló la vez pasada (`err` en la celda). */
  onlyFailed?: boolean;
  /** Sólo las que esta columna nunca corrió: «Seguir con el resto» tras «Probar en 5». */
  onlyUntried?: boolean;
  /** Lo que falta: nunca corrió O falló. Es la ÚNICA acción del chip («Completar»). */
  onlyPending?: boolean;
  /** Sólo las que no tienen valor (incluye «no lo encontró»: sí se vuelve a pagar). */
  onlyEmpty?: boolean;
  /** Las primeras N de lo que quede. */
  limit?: number;
};

type RowLike = { data: Record<string, { v: string | null; err?: string } | undefined> };

export function pickRows<R extends RowLike>(rows: R[], key: string, s: RunScope): R[] {
  const out = s.onlyPending
    ? rows.filter((r) => !r.data[key] || !!r.data[key]?.err)
    : s.onlyFailed
    ? rows.filter((r) => !!r.data[key]?.err)
    : s.onlyUntried
      ? rows.filter((r) => !r.data[key])
      : s.onlyEmpty
        ? rows.filter((r) => !r.data[key]?.v)
        : rows;
  return s.limit && s.limit > 0 ? out.slice(0, s.limit) : out;
}
