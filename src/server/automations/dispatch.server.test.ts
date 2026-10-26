import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationKind, RepoEvent } from "./types";

// El despachador: rooms con el repo × automatizaciones prendidas × `on`, sin pisar a la fábrica
// y con los errores de cada una atrapados.
const calls: string[] = [];
let enabled = new Map<number, { kinds: Set<AutomationKind>; by: Map<AutomationKind, string | null> }>();
let rooms: number[] = [];
let factoryPrs: number[] = [];
let registry: Automation[] = [];

vi.mock("./store.server", () => ({ enabledByRoom: async () => enabled }));
vi.mock("./registry.server", () => ({ get AUTOMATIONS() { return registry; } }));
vi.mock("../../db.server", () => ({ roomsOfRepo: async () => rooms }));
vi.mock("../apps/factory-runs.server", () => ({ runsByPr: async (_r: string, n: number) => (factoryPrs.includes(n) ? [{ id: 1 }] : []) }));
vi.mock("./ctx.server", () => ({ automationCtx: (p: { roomId: number; kind: string }) => ({ roomId: String(p.roomId), kind: p.kind }) }));

const { dispatchRepoEvent } = await import("./dispatch.server");

const on = (kind: AutomationKind, ...kinds: AutomationKind[]) => ({ kinds: new Set<AutomationKind>([kind, ...kinds]), by: new Map() });
const auto = (kind: AutomationKind, events: string[], fail = false): Automation => ({
  kind,
  on: events,
  handle: async (_ev, ctx) => {
    calls.push(`${kind}@${ctx.roomId}`);
    if (fail) throw new Error("boom");
  },
});
const ev = (over: Partial<RepoEvent> = {}): RepoEvent => ({ deliveryId: "d", event: "workflow_run", action: "completed", repo: "acme/app", run: { id: 1, prNumbers: [5] }, ...over });

beforeEach(() => {
  calls.length = 0;
  rooms = [1, 2];
  factoryPrs = [];
  registry = [auto("ci_fix", ["workflow_run.completed"]), auto("ci_doctor", ["workflow_run"]), auto("issue_triage", ["issues.opened"])];
  enabled = new Map([[1, on("ci_fix", "issue_triage")], [2, on("ci_doctor")], [3, on("ci_fix")]]);
});

describe("dispatchRepoEvent", () => {
  it("cada room recibe sólo lo que prendió y escucha el evento; un room sin el repo, nada", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchRepoEvent(ev(), { ns: "ns", origin: "https://x" })).toEqual({ ran: 2 });
    expect(calls.sort()).toEqual(["ci_doctor@2", "ci_fix@1"]);
  });

  it("un PR de un pedido de la fábrica no se toca", async () => {
    factoryPrs = [5];
    expect(await dispatchRepoEvent(ev(), { ns: "ns", origin: "" })).toEqual({ ran: 0 });
    expect(calls).toEqual([]);
  });

  it("una automatización que truena no frena a las demás", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registry = [auto("ci_fix", ["workflow_run"], true), auto("ci_doctor", ["workflow_run"])];
    enabled = new Map([[1, on("ci_fix", "ci_doctor")]]);
    expect(await dispatchRepoEvent(ev(), { ns: "ns", origin: "" })).toEqual({ ran: 2 });
    expect(calls.sort()).toEqual(["ci_doctor@1", "ci_fix@1"]);
    expect(err).toHaveBeenCalledOnce();
  });

  it("lo que causó nuestro bot no despierta nada", async () => {
    expect(await dispatchRepoEvent(ev({ sender: { login: "ghosty-studio[bot]", type: "Bot" } }), { ns: "ns", origin: "" })).toEqual({ ran: 0 });
  });

  it("sin nada prendido para el repo ni siquiera busca rooms", async () => {
    enabled = new Map();
    expect(await dispatchRepoEvent(ev(), { ns: "ns", origin: "" })).toEqual({ ran: 0 });
  });
});
