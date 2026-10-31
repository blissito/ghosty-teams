import { describe, it, expect, vi, beforeEach } from "vitest";
import { budgetFor, budgetSuffixes, nextBudget, overBudget, parseBudget, DEFAULT_BUDGET_USD, DEPENDABOT_BUDGET_USD } from "./factory-budget";

// Tope de gasto por pedido (31-oct): #133 gastó $47.7 en 210 h sin que nada lo detuviera.
type Row = Record<string, unknown>;
let row: Row = {};
let config: string | null = null;
let spent: number | null = 0;
const events: { type: string; data: unknown }[] = [];
const posts: string[] = [];
const handoffs: unknown[][] = [];

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT budget_paused_at, budget_handoff")) return [row];
    if (sql.startsWith("SELECT budget_paused_at")) return [row];
    if (sql.startsWith("SELECT budget_usd")) return [row];
    if (sql.startsWith("UPDATE gt_factory_runs SET budget_paused_at = unixepoch()")) Object.assign(row, { budget_paused_at: 1, budget_handoff: args[0] });
    else if (sql.startsWith("UPDATE gt_factory_runs SET budget_handoff")) row.budget_handoff = args[0];
    else if (sql.startsWith("UPDATE gt_factory_runs SET budget_usd")) {
      row.budget_usd = args[0];
      if (sql.includes("budget_paused_at = NULL")) Object.assign(row, { budget_paused_at: null, budget_handoff: null });
    }
    return [];
  },
}));
vi.mock("../../config.server", () => ({ getConfig: async () => config, setConfig: async (_k: string, v: string) => void (config = v) }));
vi.mock("../ghosty-runtime.server", () => ({ nativeRuntimeBase: async () => (spent == null ? null : "https://gs"), partnerHeaders: () => ({}) }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("./factory-runs.server", () => ({
  logEvent: async (_id: number, type: string, _a: unknown, data: unknown) => void events.push({ type, data }),
  postInThread: async (_r: unknown, _h: string, body: string) => (posts.push(body), 1),
  notifyRun: async () => {},
  refreshRoom: async () => {},
  getRun: async () => run,
  handoff: async (...a: unknown[]) => (handoffs.push(a), true),
}));
vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ groups: { "-factory-133": { costUsd: spent ?? 0 }, "-factory-133-critic": { costUsd: 0 } } }) }));

const { budgetGate, raiseRunBudget, runBudgetUsd } = await import("./factory-budget.server");
const run = { id: 133, channelId: 1, rootMsgId: 2, status: "checking", requestedBy: "bliss" } as never;
const pending = { to: "check" as const, sub: "bliss", cause: "retomar", text: "revisa", origin: "https://x", groupSuffix: "", opts: {} };

beforeEach(() => {
  row = {};
  config = null;
  spent = 0;
  events.length = posts.length = handoffs.length = 0;
});

describe("partes puras", () => {
  it("sufijos: roles, crítico y refuerzo", () => expect(budgetSuffixes(7)).toEqual(["-factory-7", "-factory-7-critic", "-factory-7-advisor"]));
  it("sin dato de gasto no detiene", () => {
    expect(overBudget(null, 5)).toBe(false);
    expect(overBudget(5, 5)).toBe(true);
    expect(overBudget(4.99, 5)).toBe(false);
  });
  it("escalones: +5 hasta 20, luego el doble", () => {
    expect(nextBudget(5)).toBe(10);
    expect(nextBudget(20)).toBe(40);
  });
  it("tope por tipo: Dependabot $5, pedidos el del espacio; el propio gana", () => {
    expect(budgetFor("dependabot", null, DEFAULT_BUDGET_USD)).toBe(DEPENDABOT_BUDGET_USD);
    expect(budgetFor(null, null, DEFAULT_BUDGET_USD)).toBe(15);
    expect(budgetFor("dependabot", null, 3)).toBe(3);
    expect(budgetFor("dependabot", 12, 15)).toBe(12);
  });
  it("parseBudget acepta «$7.5» y rechaza fuera de rango", () => {
    expect(parseBudget("$7.5")).toBe(7.5);
    expect(parseBudget(0)).toBeNull();
    expect(parseBudget(10_000)).toBeNull();
  });
});

describe("budgetGate", () => {
  it("abajo del tope: el rol trabaja", async () => {
    spent = 1.2;
    expect(await budgetGate(run, pending)).toBe("ok");
    expect(events).toHaveLength(0);
  });
  it("llegó al tope del espacio: se detiene, guarda el encargo y avisa una vez", async () => {
    spent = DEFAULT_BUDGET_USD + 0.4;
    expect(await budgetGate(run, pending)).toBe("paused");
    expect(row.budget_paused_at).toBe(1);
    expect(JSON.parse(String(row.budget_handoff)).to).toBe("check");
    expect(events.map((e) => e.type)).toEqual(["budget_hit"]);
    expect(posts[0]).toMatch(/Llegó al tope de \$15/);
    // Otro encargo mientras está detenido: no vuelve a avisar, guarda el más reciente.
    expect(await budgetGate(run, { ...pending, to: "build" })).toBe("paused");
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(row.budget_handoff)).to).toBe("build");
  });
  it("gs no contesta: no se detiene nada", async () => {
    spent = null;
    expect(await budgetGate(run, pending)).toBe("ok");
  });
  it("el tope del pedido gana al del espacio", async () => {
    config = "20";
    row.budget_usd = 30;
    expect(await runBudgetUsd(133)).toBe(30);
  });
});

describe("raiseRunBudget", () => {
  it("subirlo reanuda el encargo guardado", async () => {
    spent = 15.4;
    await budgetGate(run, pending);
    const out = await raiseRunBudget(run, null, "Bliss");
    expect(out).toMatchObject({ budgetUsd: 20, resumed: true });
    expect(row.budget_paused_at).toBeNull();
    expect(handoffs[0]?.[1]).toBe("check");
  });
  it("si el tope nuevo ya está gastado, se queda detenido y no despierta a nadie", async () => {
    spent = 22;
    await budgetGate(run, pending);
    const out = await raiseRunBudget(run, 20, "Bliss");
    expect(out.resumed).toBe(false);
    expect(row.budget_paused_at).toBe(1);
    expect(handoffs).toHaveLength(0);
  });
});
