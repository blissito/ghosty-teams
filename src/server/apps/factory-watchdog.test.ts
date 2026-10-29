import { describe, it, expect, vi, beforeEach } from "vitest";

// Vigía de pedidos colgados (21-oct, business): #136 avisado una vez y luego 13 h sin que nadie lo
// mirara, #137 sin origin para el auto-retomar, pedidos en espera de caja fuera de `building` y
// una caja tirada a mano que el pedido seguía dando por `ready`.
type Row = Record<string, unknown>;
const sqls: { sql: string; args: unknown[] }[] = [];
const wakes: { key: string; origin: string; cause: string; text: string }[] = [];
const posts: string[] = [];
let runs: Row[] = [];
let events: Row[] = [];
let wakeOrigins: Row[] = [];
let tenantOrigins: Row[] = [];
let box: Row | null = null;
let gs: { status: number; json: unknown }[] = [];
const NOW = Math.floor(Date.now() / 1000);

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.includes("FROM gt_factory_runs r")) return runs;
    if (sql.startsWith("SELECT type FROM gt_factory_events")) return events.filter((e) => e.run_id === args[0]).slice(-1);
    if (sql.startsWith("SELECT at FROM gt_factory_events") && sql.includes("auto_resumed"))
      return events.filter((e) => e.run_id === args[0] && e.type === "auto_resumed" && Number(e.at) > Number(args[1])).reverse();
    if (sql.startsWith("SELECT origin FROM gt_agent_wakeups WHERE key LIKE")) return wakeOrigins;
    if (sql.startsWith("SELECT origin FROM gt_agent_wakeups")) return tenantOrigins;
    if (sql.startsWith("SELECT box_id, box_state")) return box ? [box] : [];
    if (sql.startsWith("SELECT box_state")) return box ? [{ box_state: box.box_state }] : [];
    if (sql.startsWith("SELECT box_handoff")) return [{ box_handoff: null }];
    if (sql.startsWith("UPDATE gt_factory_runs SET stale_warned_at = ?")) return [{ id: args[1] }];
    if (sql.includes("SET box_id = ?, box_state = 'ready'")) box = { box_id: args[0], box_state: "ready" };
    if (sql.includes("SET box_id = NULL, box_state = NULL")) box = null;
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) return [{ ...runs[0], status: args[0] }];
    if (sql.startsWith("INSERT INTO gt_factory_events")) events.push({ run_id: args[0], type: args[2], at: NOW });
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 10, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [
    { handle: "plan", name: "Plan", avatar: "", backend: { kind: "fleet", id: "cmplan000000000000000000" } },
    { handle: "build", name: "Build", avatar: "", backend: { kind: "fleet", id: "cmbuild00000000000000000" } },
    { handle: "check", name: "Check", avatar: "", backend: { kind: "fleet", id: "cmcheck00000000000000000" } },
  ],
  agentGroupId: async () => "g",
}));
vi.mock("./factory-team.server", () => ({ factoryTurnFor: async () => null }));
vi.mock("./sprint.server", () => ({ onSprintRunChanged: async () => {} }));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string; origin: string; cause: string; text: string }) => (wakes.push(w), true),
  mintWakeRef: () => "ref",
  kickWakeups: () => {},
}));

process.env.GHOSTY_PARTNER_SECRET = "x";
const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const r = gs.shift() ?? { status: 200, json: { ok: true, boxId: null } };
  return { status: r.status, json: async () => r.json, _body: init.body };
});
vi.stubGlobal("fetch", fetchMock);

import {
  sweepStaleRuns,
  parkStaleDependabotRuns,
  DEPENDABOT_PARK_SECONDS,
  applyEvent,
  retryWaitingRunBoxes,
  verifyRunBox,
  handoff,
  STALE_RETRY_SECONDS,
  MAX_AUTO_RESUMES_PER_DAY,
  type Run,
} from "./factory-runs.server";

const runRow = (o: Row = {}): Row => ({
  id: 136, channel_id: 10, root_msg_id: 7242, topic: "general", title: "TS 7", status: "checking", plan_version: 0, loops: 0,
  repo: "blissito/easybits", requested_by: "bliss", approved_by: "bliss", stale_warned_at: null, box_state: null,
  last_at: NOW - 13 * 3600, ...o,
});
const run = (o: Partial<Run> = {}): Run => ({
  id: 134, channelId: 10, rootMsgId: 7232, topic: "general", title: "Caja", status: "checking", planVersion: 0, loops: 0,
  repo: "blissito/easybits", branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "bliss", approvedBy: "bliss", ...o,
});
const gsBodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

beforeEach(() => {
  sqls.length = 0;
  wakes.length = 0;
  posts.length = 0;
  runs = [];
  events = [];
  wakeOrigins = [];
  tenantOrigins = [];
  box = null;
  gs = [];
  fetchMock.mockClear();
});

describe("sweepStaleRuns", () => {
  it("#136: avisado hace horas y otra vez parado → la plataforma lo retoma sola (no se queda estacionado)", async () => {
    runs = [runRow({ stale_warned_at: NOW - 16 * 3600 })];
    events = [{ run_id: 136, type: "recheck", at: NOW - 13 * 3600 }];
    wakeOrigins = [{ origin: "https://business.teams.ghosty.studio" }];
    await sweepStaleRuns(() => false);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].key).toMatch(/^factory:136:check:/);
    expect(wakes[0].cause).toBe("retomar (automático)");
    expect(events.at(-1)?.type).toBe("auto_resumed");
    // Ya se había avisado: no se vuelve a marcar ni a timbrar.
    expect(sqls.some((q) => q.sql.startsWith("UPDATE gt_factory_runs SET stale_warned_at = ?"))).toBe(false);
  });

  it("avisado: espera STALE_RETRY_SECONDS entre intentos", async () => {
    runs = [runRow({ stale_warned_at: NOW - 16 * 3600 })];
    events = [{ run_id: 136, type: "auto_resumed", at: NOW - STALE_RETRY_SECONDS + 600 }];
    wakeOrigins = [{ origin: "https://business.teams.ghosty.studio" }];
    await sweepStaleRuns(() => false);
    expect(wakes).toHaveLength(0);
  });

  it(`avisado: tope de ${MAX_AUTO_RESUMES_PER_DAY} intentos al día`, async () => {
    runs = [runRow({ stale_warned_at: NOW - 20 * 3600 })];
    events = Array.from({ length: MAX_AUTO_RESUMES_PER_DAY }, (_, i) => ({ run_id: 136, type: "auto_resumed", at: NOW - (i + 3) * 3 * 3600 }));
    wakeOrigins = [{ origin: "https://business.teams.ghosty.studio" }];
    await sweepStaleRuns(() => false);
    expect(wakes).toHaveLength(0);
  });

  it("avisado y esperando a la persona: no se contesta solo", async () => {
    runs = [runRow({ stale_warned_at: NOW - 16 * 3600 })];
    events = [{ run_id: 136, type: "waiting_person", at: NOW - 13 * 3600 }];
    wakeOrigins = [{ origin: "https://business.teams.ghosty.studio" }];
    await sweepStaleRuns(() => false);
    expect(wakes).toHaveLength(0);
  });

  it("#137: sin origin en sus encargos (todos de la plataforma) → usa el del espacio y retoma, no salta al aviso", async () => {
    runs = [runRow({ id: 137, channel_id: 15, root_msg_id: 7280 })];
    events = [{ run_id: 137, type: "recheck", at: NOW - 3600 }];
    await sweepStaleRuns(() => false);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].origin).toBe("https://business.teams.ghosty.studio");
    expect(events.some((e) => e.type === "stale")).toBe(false);
  });

  it("sin origin propio, prefiere el de otro encargo del espacio (dominio propio) al subdominio", async () => {
    runs = [runRow({ id: 137 })];
    tenantOrigins = [{ origin: "https://equipo.business.mx" }];
    await sweepStaleRuns(() => false);
    expect(wakes[0].origin).toBe("https://equipo.business.mx");
  });

  it("con alguien trabajando no se toca", async () => {
    runs = [runRow()];
    await sweepStaleRuns(() => true);
    expect(wakes).toHaveLength(0);
  });

  it("entran los que esperan caja fuera de building; los de building en espera los mueve el tick de cajas", async () => {
    await sweepStaleRuns(() => false);
    const q = sqls.find((s) => s.sql.includes("FROM gt_factory_runs r"))!.sql;
    expect(q).not.toMatch(/stale_warned_at IS NULL/);
    expect(q).toMatch(/NOT \(COALESCE\(r\.box_state, ''\) = 'waiting' AND r\.status = 'building'\)/);
  });
});

describe("applyEvent", () => {
  it("toda transición rearma el vigía (borra stale_warned_at)", async () => {
    runs = [runRow({ status: "checking" })];
    await applyEvent(run({ id: 136, status: "escalated" }), "recheck" as never).catch(() => null);
    const q = sqls.find((s) => s.sql.startsWith("UPDATE gt_factory_runs SET status"));
    expect(q?.sql).toContain("stale_warned_at = NULL");
  });
});

describe("cajas", () => {
  it("retryWaitingRunBoxes mira planning/building/checking, no sólo building", async () => {
    await retryWaitingRunBoxes();
    expect(sqls[0].sql).toContain("status IN ('planning','building','checking')");
  });

  it("#134: la caja ya no existe en gs → se olvida y se pide otra", async () => {
    box = { box_id: "sb_b3d4422f", box_state: "ready" };
    gs = [
      { status: 200, json: { ok: true, boxId: null } },
      { status: 200, json: { ok: true, boxId: "sb_nueva" } },
    ];
    expect(await verifyRunBox(run())).toBe("ready");
    expect(gsBodies().map((b) => b.op)).toEqual(["status", "up"]);
    expect(box).toEqual({ box_id: "sb_nueva", box_state: "ready" });
    expect(events.some((e) => e.type === "box_lost")).toBe(true);
  });

  it("caja viva: sólo pregunta, no pide otra", async () => {
    box = { box_id: "sb_1", box_state: "ready" };
    gs = [{ status: 200, json: { ok: true, boxId: "sb_1" } }];
    expect(await verifyRunBox(run())).toBe("ready");
    expect(gsBodies().map((b) => b.op)).toEqual(["status"]);
  });

  it("gs no contesta: se deja como está", async () => {
    box = { box_id: "sb_1", box_state: "ready" };
    gs = [{ status: 502, json: { error: "x" } }];
    expect(await verifyRunBox(run())).toBe("ready");
    expect(box).toEqual({ box_id: "sb_1", box_state: "ready" });
  });

  it("el relevo a @check verifica la caja antes de encargar", async () => {
    box = { box_id: "sb_muerta", box_state: "ready" };
    gs = [
      { status: 200, json: { ok: true, boxId: null } },
      { status: 200, json: { ok: true, boxId: "sb_nueva" } },
    ];
    expect(await handoff(run(), "check", "bliss", "recheck", "revisa", "https://business.teams.ghosty.studio")).toBe(true);
    expect(gsBodies().map((b) => b.op)).toEqual(["status", "up"]);
    expect(wakes).toHaveLength(1);
  });

  it("relevo sin origin: toma el de los encargos del pedido", async () => {
    wakeOrigins = [{ origin: "https://business.teams.ghosty.studio" }];
    await handoff(run(), "plan", "bliss", "recheck", "x", "");
    expect(wakes[0].origin).toBe("https://business.teams.ghosty.studio");
  });
});

// business, 29-oct: 11 pedidos de Dependabot abiertos de 2 a 9 días (majors esperando merge,
// escalados sin respuesta, roles colgados) ocupaban los lugares del repo y la fábrica se veía trabada.
describe("parkStaleDependabotRuns", () => {
  const dep = (o: Row = {}) =>
    runRow({ id: 142, kind: "dependabot", status: "pr_review", task_ref: "dependabot:major", pr_url: "https://github.com/blissito/mailmask/pull/119", ...o });

  it("sin una persona en 72 h → se cancela con motivo parked y avisa en el hilo que el PR sigue abierto", async () => {
    runs = [dep({ last_person_at: NOW - DEPENDABOT_PARK_SECONDS - 3600 })];
    await parkStaleDependabotRuns(() => false);
    const ev = sqls.find((q) => q.sql.startsWith("INSERT INTO gt_factory_events"));
    expect(ev?.args[2]).toBe("cancel");
    expect(String(ev?.args[3])).toContain('"reason":"parked"');
    expect(posts.at(-1)).toMatch(/sigue abierto en GitHub/);
    expect(posts.at(-1)).toContain("pull/119");
  });

  it("una persona escribió hace poco → se queda", async () => {
    runs = [dep({ last_person_at: NOW - 3600 })];
    await parkStaleDependabotRuns(() => false);
    expect(events).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("con un rol trabajando → se queda", async () => {
    runs = [dep({ last_person_at: NOW - DEPENDABOT_PARK_SECONDS - 3600 })];
    await parkStaleDependabotRuns(() => true);
    expect(events).toHaveLength(0);
  });

  it("sólo mira pedidos de Dependabot sin merge en cola", async () => {
    await parkStaleDependabotRuns(() => false);
    const q = sqls.find((x) => x.sql.includes("FROM gt_factory_runs r"));
    expect(q?.sql).toContain("r.kind = 'dependabot'");
    expect(q?.sql).toContain("r.merge_queued_by IS NULL");
  });
});
