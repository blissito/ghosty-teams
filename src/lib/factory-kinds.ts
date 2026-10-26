// ── Cómo se nombra un pedido según su tipo (tarjeta, tablero, barra) ──────────────────────────
//
// Los pedidos adoptados no nacen de una persona: un lote de alertas (`security`), el CI rojo de un
// PR (`ci_fix`) o un PR de dependencias que rompió el CI (`dep_fix`). La tarjeta los decía igual
// que un pedido cualquiera. Aquí, una etiqueta corta con su ícono; el texto pasa por `t()` con
// `{n}` como hueco (por eso la clave es el texto en español con el hueco, como en el resto).

export type RunKindTag = { icon: string; text: string; n: number | null };

/** `kind_meta` de la fila (JSON) o null. */
export function parseKindMeta(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const prNumberOf = (url: string | null | undefined) => Number(String(url ?? "").match(/\/pull\/(\d+)/)?.[1] ?? 0) || null;

/** Lo que viaja a la tarjeta y al tablero (serializable): no el JSON entero. */
export type KindSummary = { alerts: number | null; covered: number };

export function kindSummary(meta: Record<string, unknown> | null | undefined): KindSummary | null {
  if (!meta) return null;
  return { alerts: Number(meta.alerts) || null, covered: coveredCount(meta) };
}

export function runKindTag(kind: string | null | undefined, meta: { alerts?: unknown } | null | undefined, prUrl?: string | null): RunKindTag | null {
  switch (kind) {
    case "security": {
      const n = Number(meta?.alerts) || null;
      return { icon: "🛡️", text: n === 1 ? "Seguridad: 1 alerta" : n ? "Seguridad: {n} alertas" : "Seguridad: lote de alertas", n };
    }
    case "ci_fix": {
      const n = prNumberOf(prUrl);
      return { icon: "🔧", text: n ? "Arreglo de CI de #{n}" : "Arreglo de CI", n };
    }
    case "dep_fix": {
      const n = prNumberOf(prUrl);
      return { icon: "📦", text: n ? "Arreglo de dependencia de #{n}" : "Arreglo de dependencia", n };
    }
    default:
      return null;
  }
}

/** Cuántas alertas del lote ya cubre un PR de Dependabot (las cita el plan «la cubre #N»). */
export function coveredCount(meta: Record<string, unknown> | null | undefined): number {
  return Array.isArray(meta?.covered) ? meta.covered.length : 0;
}
