// Tope de gasto por pedido de la fábrica (31-oct): la puerta antes de despertar a un rol y las
// acciones de subirlo. El gasto sale de gs (`/api/v2/usage/groups`, las conversaciones del pedido);
// si gs no contesta, no se detiene nada. Al llegar, el encargo se guarda (`budget_handoff`), la
// tarjeta dice «Llegó al tope» y se avisa una vez a quien lo pidió; subirlo reanuda ese encargo.
import { getConfig, setConfig } from "../../config.server";
import { dbq } from "../../dbq.server";
import { budgetFor, budgetSuffixes, DEFAULT_BUDGET_USD, formatBudget, nextBudget, overBudget, parseBudget } from "./factory-budget";
import type { Run } from "./factory-runs.server";

type PendingHandoff = {
  to: "plan" | "build" | "check" | "eval";
  sub: string;
  cause: string;
  text: string;
  origin: string;
  groupSuffix: string;
  opts: Record<string, unknown>;
};

/** El tope del espacio (`gc_config.factory_budget_usd`) o el de casa. */
export async function spaceBudgetUsd(): Promise<number> {
  return parseBudget(await getConfig("factory_budget_usd").catch(() => null)) ?? DEFAULT_BUDGET_USD;
}

/** El tope de este pedido: el suyo si alguien lo subió; si no, el del espacio o el de Dependabot (`budgetFor`). */
export async function runBudgetUsd(runId: number): Promise<number> {
  const [r] = await dbq("SELECT budget_usd, kind FROM gt_factory_runs WHERE id = ?", [runId]).catch(() => []);
  return budgetFor(r?.kind ?? null, r?.budget_usd, await spaceBudgetUsd());
}

/** Lo que lleva gastado el pedido en gs (USD), o null si gs no contesta. */
export async function runSpentUsd(runId: number): Promise<number | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) return null;
    const { currentNamespace } = await import("../tenant.server");
    const body = JSON.stringify({ suffixes: budgetSuffixes(runId) });
    const res = await fetch(`${base}/api/v2/usage/groups`, { method: "POST", headers: partnerHeaders(body, await currentNamespace()), body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { groups?: Record<string, { costUsd?: number }> };
    return Object.values(j.groups ?? {}).reduce((n, g) => n + Number(g?.costUsd ?? 0), 0);
  } catch {
    return null;
  }
}

/**
 * La puerta de `handoff`: "ok" si el rol puede trabajar; "paused" si el pedido ya llegó a su tope
 * (el encargo queda guardado y se avisa sólo la primera vez).
 */
export async function budgetGate(run: Run, pending: PendingHandoff): Promise<"ok" | "paused"> {
  const [row] = await dbq("SELECT budget_paused_at FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
  const alreadyPaused = row?.budget_paused_at != null;
  if (!alreadyPaused) {
    const [spent, budget] = await Promise.all([runSpentUsd(run.id), runBudgetUsd(run.id)]);
    if (!overBudget(spent, budget)) return "ok";
    await dbq("UPDATE gt_factory_runs SET budget_paused_at = unixepoch(), budget_handoff = ? WHERE id = ?", [JSON.stringify(pending), run.id]);
    const R = await import("./factory-runs.server");
    await R.logEvent(run.id, "budget_hit", null, { spent: Math.round(spent! * 100) / 100, budget, to: pending.to });
    const text =
      `⏸️ **Llegó al tope de ${formatBudget(budget)}** (lleva ${formatBudget(spent!)}). Nadie trabaja en este pedido ` +
      `hasta que lo subas a ${formatBudget(nextBudget(budget))} o lo canceles.`;
    await R.postInThread(run, "plan", text).catch(() => null);
    await R.notifyRun(run, [run.requestedBy], `Llegó al tope de ${formatBudget(budget)}. Súbelo o cancélalo.`, `factory:${run.id}:budget`);
    void R.refreshRoom(run.channelId);
    return "paused";
  }
  // Ya detenido: se guarda el encargo más reciente (el que importa al reanudar).
  await dbq("UPDATE gt_factory_runs SET budget_handoff = ? WHERE id = ?", [JSON.stringify(pending), run.id]).catch(() => {});
  return "paused";
}

/**
 * Sube el tope del pedido y, si estaba detenido, reanuda el encargo guardado. `usd` null = el
 * siguiente escalón. Devuelve el tope nuevo, lo gastado y si se reanudó algo.
 */
export async function raiseRunBudget(run: Run, usd: number | null, who: string): Promise<{ budgetUsd: number; spentUsd: number | null; resumed: boolean }> {
  const current = await runBudgetUsd(run.id);
  const budget = usd ?? nextBudget(current);
  const [row] = await dbq("SELECT budget_paused_at, budget_handoff FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
  const wasPaused = row?.budget_paused_at != null;
  const stash = row?.budget_handoff ? String(row.budget_handoff) : null;
  const spent = await runSpentUsd(run.id);
  // Si el tope nuevo ya está gastado, se queda detenido (no se despierta a nadie para volver a parar).
  const stillOver = overBudget(spent, budget);
  await dbq(`UPDATE gt_factory_runs SET budget_usd = ?${stillOver ? "" : ", budget_paused_at = NULL, budget_handoff = NULL"} WHERE id = ?`, [budget, run.id]);
  const R = await import("./factory-runs.server");
  await R.logEvent(run.id, "budget_raised", who, { from: current, to: budget });
  let resumed = false;
  if (wasPaused && !stillOver) {
    await R.postInThread(run, "plan", `▶️ ${who} subió el tope a ${formatBudget(budget)}. Sigo con el pedido.`).catch(() => null);
    let pending: PendingHandoff | null = null;
    try {
      pending = stash ? (JSON.parse(stash) as PendingHandoff) : null;
    } catch {
      pending = null;
    }
    const fresh = (await R.getRun(run.id)) ?? run;
    if (pending && !["done", "cancelled"].includes(fresh.status))
      resumed = await R.handoff(fresh, pending.to, pending.sub, pending.cause, pending.text, pending.origin, pending.groupSuffix, pending.opts as never).catch(() => false);
  }
  void R.refreshRoom(run.channelId);
  return { budgetUsd: budget, spentUsd: spent, resumed };
}

/** El tope por pedido de todo el espacio. Sólo afecta a los pedidos que no tienen uno propio. */
export async function setSpaceBudget(usd: number): Promise<number> {
  await setConfig("factory_budget_usd", String(usd));
  return usd;
}
