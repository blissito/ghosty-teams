// Estado de CI de un commit, sumando las DOS fuentes que GitHub tiene para eso.
//
// Un repo puede reportar por check-runs (GitHub Actions y casi todas las apps nuevas) o por
// el API viejo de statuses (Vercel, Netlify, CircleCI y otros siguen ahí). Mirar sólo una
// dejaba "CI en verde" con el deploy de preview en rojo, o "sin checks" en un repo que sí
// los tiene. Por eso se agregan las dos en un solo veredicto.
//
// La agregación es PURA (sin red) para poder probarla; la parte que pide los datos recibe
// un `get` y así la usan igual la tool del agente (token de quien la invoca) y la tarjeta
// (token de quien la mira).

export type ChecksState = "success" | "failure" | "pending" | "none";

export type ChecksSummary = {
  state: ChecksState;
  total: number;
  failed: { name: string; conclusion: string; url: string | null }[];
  pending: string[];
};

// Conclusiones de un check-run que cuentan como ROJO. `neutral` y `skipped` no: un job
// saltado a propósito (p. ej. deploy sólo en main) no es un fallo del PR.
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/**
 * Junta check-runs (`/commits/{sha}/check-runs`) y statuses (`/commits/{sha}/status`).
 *
 * - Cualquier rojo gana: con uno solo el PR no se puede mergear, aunque otros sigan.
 * - Si no hay rojos pero algo sigue corriendo → `pending`.
 * - Sin ningún check → `none`, que NO es verde: el repo simplemente no tiene CI.
 */
export function aggregateChecks(checkRuns: unknown, combined: unknown): ChecksSummary {
  const failed: ChecksSummary["failed"] = [];
  const pending: string[] = [];
  let total = 0;

  const runs = Array.isArray((checkRuns as any)?.check_runs) ? (checkRuns as any).check_runs : [];
  for (const r of runs) {
    total++;
    const name = String(r?.name ?? "check");
    if (r?.status !== "completed") {
      pending.push(name);
      continue;
    }
    const c = String(r?.conclusion ?? "");
    if (FAILED.has(c)) failed.push({ name, conclusion: c, url: r?.html_url ?? r?.details_url ?? null });
  }

  // El combined status ya trae el ÚLTIMO estado por contexto, no el historial.
  const statuses = Array.isArray((combined as any)?.statuses) ? (combined as any).statuses : [];
  for (const s of statuses) {
    total++;
    const name = String(s?.context ?? "status");
    const st = String(s?.state ?? "");
    if (st === "pending") pending.push(name);
    else if (st === "failure" || st === "error") failed.push({ name, conclusion: st, url: s?.target_url ?? null });
  }

  const state: ChecksState = failed.length ? "failure" : pending.length ? "pending" : total ? "success" : "none";
  return { state, total, failed, pending };
}

/** Pide las dos fuentes de un commit y las agrega. `get` devuelve el JSON o `{error}`/null. */
export async function loadChecks(
  get: (path: string) => Promise<any>,
  repoPath: string,
  sha: string,
): Promise<ChecksSummary | { error: string }> {
  const [runs, combined] = await Promise.all([
    get(`/repos/${repoPath}/commits/${sha}/check-runs?per_page=100`),
    get(`/repos/${repoPath}/commits/${sha}/status`),
  ]);
  // Sin check-runs no hay veredicto honesto: es la fuente principal. El combined status sí
  // puede faltar (un 404 en repos que nunca lo usaron) sin invalidar el resto.
  if (!runs || runs.error) return { error: runs?.error ?? "No pude leer los checks de GitHub." };
  return aggregateChecks(runs, combined && !combined.error ? combined : null);
}

// ── Vigilancia de un PR (github_watch_pr) ────────────────────────────────────

/** Lo que el barrido recuerda de la vuelta anterior. */
export type WatchMemory = { sha: string; checks: ChecksState; greenSince: number | null };

/** Lo que GitHub dice AHORA del PR. */
export type PrSnapshot = {
  merged: boolean;
  state: "open" | "closed";
  sha: string;
  checks: ChecksSummary;
  autoMerge: boolean;
};

/** Cuánto se espera a que el auto-merge actúe con los checks ya en verde antes de avisar. */
export const AUTO_MERGE_GRACE_S = 10 * 60;

/**
 * ¿Hay que despertar al agente? Devuelve el aviso (o null) y lo que hay que recordar.
 *
 * Se avisa por TRANSICIÓN, no por estado: un PR que ya estaba en verde al vigilarlo no debe
 * despertar a nadie en la primera vuelta. Cuenta como transición salir de `pending` o de
 * `none` (justo después de un push GitHub todavía no creó los checks) o que cambie el
 * commit (un push nuevo que corrió entero entre dos vueltas).
 *
 * Con auto-merge encendido y todo en verde lo interesante es el MERGE, que llega solo en
 * segundos: avisar del verde sería un turno para nada. Si pasado un rato sigue sin
 * mergearse, sí se avisa — casi siempre falta una aprobación y eso lo tiene que decir el
 * agente.
 */
export function prWatchVerdict(
  label: string,
  prev: WatchMemory,
  now: PrSnapshot,
  nowS: number,
): { notice: string | null; memory: WatchMemory } {
  const c = now.checks;
  const green = c.state === "success";
  const memory: WatchMemory = {
    sha: now.sha,
    checks: c.state,
    greenSince: green ? (prev.sha === now.sha && prev.greenSince ? prev.greenSince : nowS) : null,
  };
  if (now.merged) return { notice: `${label}: mergeado.`, memory };
  if (now.state === "closed") return { notice: `${label}: se cerró sin mergear.`, memory };

  if (green && now.autoMerge) {
    const since = memory.greenSince ?? nowS;
    return nowS - since >= AUTO_MERGE_GRACE_S
      ? {
          notice:
            `${label}: checks en verde (${c.total}/${c.total}) y el auto-merge está activado, pero ` +
            `sigue sin mergearse (¿falta una aprobación, o la rama está desactualizada?).`,
          memory,
        }
      : { notice: null, memory };
  }

  const terminal = c.state === "success" || c.state === "failure";
  const moved = prev.checks === "pending" || prev.checks === "none" || prev.sha !== now.sha;
  if (!terminal || !moved) return { notice: null, memory };
  if (green) return { notice: `${label}: checks en verde (${c.total}/${c.total}).`, memory };
  const names = c.failed.map((f) => f.name).slice(0, 5).join(", ");
  return {
    notice: `${label}: fallaron ${c.failed.length} de ${c.total} checks (${names}).`,
    memory,
  };
}
