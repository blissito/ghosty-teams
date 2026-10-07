import { describe, it, expect, vi, beforeEach } from "vitest";

// Caja por pedido (7-oct): gs la crea al construir; sin lugar en el tier el pedido espera (aviso
// UNA vez) y sin repo sigue el camino viejo.
const sqls: { sql: string; args: unknown[] }[] = [];
const posts: string[] = [];
let boxState: string | null = null;
let gs: { status: number; json: unknown } = { status: 200, json: { ok: true, boxId: "sb_1" } };

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.startsWith("SELECT box_state")) return [{ box_state: boxState }];
    if (sql.includes("SET box_state = 'waiting'")) boxState = "waiting";
    if (sql.includes("SET box_id = ?, box_state = 'ready'")) boxState = "ready";
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [
    { handle: "build", name: "Build", avatar: "", backend: { kind: "fleet", id: "cmbuild00000000000000000" } },
    { handle: "check", name: "Check", avatar: "", backend: { kind: "fleet", id: "cmcheck00000000000000000" } },
  ],
  agentGroupId: async () => "g",
}));
vi.mock("./factory-team.server", () => ({ factoryTurnFor: async () => null }));

process.env.GHOSTY_PARTNER_SECRET = "x";
const fetchMock = vi.fn(async () => ({ status: gs.status, json: async () => gs.json }));
vi.stubGlobal("fetch", fetchMock);

import { ensureRunBox, type Run } from "./factory-runs.server";

const run = (repo: string | null = "blissito/mailmask"): Run => ({
  id: 16, channelId: 5, rootMsgId: 4553, topic: "general", title: "Prueba", status: "building", planVersion: 1, loops: 0,
  repo, branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "bliss", approvedBy: "bliss",
});

beforeEach(() => {
  sqls.length = 0;
  posts.length = 0;
  boxState = null;
  fetchMock.mockClear();
});

describe("ensureRunBox", () => {
  it("lista: guarda el id y pide la caja para @build y @check", async () => {
    gs = { status: 200, json: { ok: true, boxId: "sb_1" } };
    expect(await ensureRunBox(run())).toBe("ready");
    expect(boxState).toBe("ready");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(body).toMatchObject({ op: "up", runId: 16, repo: "blissito/mailmask", agents: ["cmbuild00000000000000000", "cmcheck00000000000000000"] });
  });

  it("sin lugar: queda en espera y avisa en el hilo UNA vez", async () => {
    gs = { status: 409, json: { error: "no_slot", tier: "F1", max: 2, busy: [15, 14] } };
    expect(await ensureRunBox(run())).toBe("waiting");
    expect(await ensureRunBox(run())).toBe("waiting");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/F1 tiene 2 lugar\(es\) y están ocupados por pedidos en curso \(#15, #14\)/);
  });

  it("sin repo o con gs caído sigue el camino viejo", async () => {
    expect(await ensureRunBox(run(null))).toBe("off");
    gs = { status: 502, json: { error: "boom" } };
    expect(await ensureRunBox(run())).toBe("off");
  });
});
