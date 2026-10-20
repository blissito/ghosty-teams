import { describe, it, expect, vi, beforeEach } from "vitest";

// «Otra vuelta» que sí avanza (#115, 19-oct): aprobar un escalado deja UNA vuelta real, la nota de
// quien decide le llega a @build y el alcance de @check queda guardado para su siguiente revisión.
const sqls: { sql: string; args: unknown[] }[] = [];
let notes: { id: number; by: string; text: string }[] = [];

const row = (over: Record<string, unknown> = {}) => ({
  id: 115, channel_id: 5, root_msg_id: 900, topic: "general", title: "Colaboradores", status: "escalated", plan_version: 2,
  loops: 3, repo: "o/r", requested_by: "ana", approved_by: "beto", ...over,
});

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) {
      const r: Record<string, unknown> = row({ status: args[0] });
      const cols = [...sql.matchAll(/, (\w+) = \?/g)].map((m) => m[1]);
      cols.forEach((c, i) => (r[c] = args[1 + i]));
      return [r];
    }
    if (sql.startsWith("INSERT INTO gt_factory_notes")) {
      notes.push({ id: notes.length + 1, text: String(args[1]), by: String(args[2]) });
      return [{ id: notes.length }];
    }
    if (sql.startsWith("UPDATE gt_factory_notes")) return notes.splice(0);
    if (sql.startsWith("SELECT * FROM gt_factory_plans")) return [{ plan_md: "1. permiso de Marketer" }];
    // La caja ya estaba esperando lugar: el encargo se guarda en `box_handoff` y se lee de ahí.
    if (sql.startsWith("SELECT box_state")) return [{ box_state: "waiting" }];
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async () => ({ id: 1 }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [], agentGroupId: async () => "g" }));
vi.mock("./factory-team.server", () => ({ factoryTurnFor: async () => null }));

process.env.GHOSTY_PARTNER_SECRET = "x";
vi.stubGlobal("fetch", vi.fn(async () => ({ status: 409, json: async () => ({ error: "no_slot", tier: "free", max: 1, busy: [] }) })));

import { decide, type Run } from "./factory-runs.server";

const run = (over: Partial<Run> = {}): Run => ({
  id: 115, channelId: 5, rootMsgId: 900, topic: "general", title: "Colaboradores", status: "escalated", planVersion: 2, loops: 3,
  repo: "o/r", branch: "b", prUrl: "https://github.com/o/r/pull/9", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
  ...over,
});
const runUpdate = () => sqls.find((s) => s.sql.startsWith("UPDATE gt_factory_runs SET status"))!;
const patchOf = (u: { sql: string; args: unknown[] }) => {
  const cols = [...u.sql.matchAll(/, (\w+) = \?/g)].map((m) => m[1]);
  return Object.fromEntries(cols.map((c, i) => [c, u.args[1 + i]]));
};
const handoffText = () => {
  const u = sqls.find((s) => s.sql.includes("SET box_handoff"))!;
  return JSON.parse(String(u.args[0])).text as string;
};

beforeEach(() => {
  sqls.length = 0;
  notes = [];
});

describe("otra vuelta tras escalar", () => {
  it("deja una vuelta real, guarda el alcance y la nota le llega a @build", async () => {
    await decide({
      run: run(), version: 2, decision: "approve", note: "primero el permiso de Marketer", checkScope: "los 4 puntos del escalado",
      sub: "beto", who: "Beto", origin: "",
    });
    expect(patchOf(runUpdate())).toMatchObject({ approved_by: "beto", loops: 2, check_scope: "los 4 puntos del escalado" });
    expect(handoffText()).toContain("Beto: primero el permiso de Marketer");
  });

  it("un escalado por check_blocked conserva sus vueltas", async () => {
    await decide({ run: run({ loops: 0 }), version: 2, decision: "approve", sub: "beto", who: "Beto", origin: "" });
    const patch = patchOf(runUpdate());
    expect(patch.loops).toBe(0);
    expect(patch).not.toHaveProperty("check_scope");
  });

  it("aprobar un plan nuevo no mete la firma como nota", async () => {
    await decide({ run: run({ status: "plan_review", loops: 0 }), version: 2, decision: "approve", note: "va", sub: "beto", who: "Beto", origin: "" });
    expect(sqls.some((s) => s.sql.startsWith("INSERT INTO gt_factory_notes"))).toBe(false);
  });
});

// easybits #132 (20-oct): «Que @build lo arregle» desde un escalado de Dependabot perdía el encargo
// (subir los paquetes hermanos del grupo y empujar a la rama del PR): @build no sabía qué hacer.
describe("otra vuelta en un PR de Dependabot (easybits, 20-oct)", () => {
  it("el encargo conserva lo de Dependabot: su rama, los hermanos y el grupo", async () => {
    await decide({
      run: run({ kind: "dependabot", prUrl: "https://github.com/blissito/easybits/pull/132", branch: "dependabot/npm/aws-sdk" }),
      version: 2, decision: "approve", sub: "beto", who: "Beto", origin: "",
    });
    const text = handoffText();
    expect(text).toContain("pidió otra vuelta");
    expect(text).toContain("https://github.com/blissito/easybits/pull/132");
    expect(text).toContain("SU rama (dependabot/npm/aws-sdk)");
    expect(text).toContain("súbelos juntos");
    expect(text).toContain(".github/dependabot.yml");
  });

  it("un pedido normal en otra vuelta no lleva el texto de Dependabot", async () => {
    await decide({ run: run(), version: 2, decision: "approve", sub: "beto", who: "Beto", origin: "" });
    expect(handoffText()).not.toContain("Dependabot");
  });
});
