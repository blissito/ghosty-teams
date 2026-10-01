import { describe, it, expect, vi, beforeEach } from "vitest";

// Bitácora y avisos del pedido: cada transición deja UN renglón inmutable; sin transición
// (candado perdido) no deja ninguno; y sólo se avisa cuando le toca a una persona.
const sqls: { sql: string; args: unknown[] }[] = [];
let updateWins = true;
let pendingNotes: { id: number; by: string; text: string }[] = [];
const notified: { recipients: string[]; body: string; url: string }[] = [];

const row = (status: string) => ({ id: 7, channel_id: 3, root_msg_id: 99, topic: "general", title: "t", status, plan_version: 1, loops: 0, requested_by: "ana", approved_by: "beto" });

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) {
      // Las columnas del patch van después del estado: `loops` se refleja en la fila.
      const r: Record<string, unknown> = row(String(args[0]));
      const cols = [...sql.matchAll(/, (\w+) = \?/g)].map((m) => m[1]);
      cols.forEach((c, i) => (r[c] = args[1 + i]));
      return updateWins ? [r] : [];
    }
    if (sql.startsWith("UPDATE gt_factory_notes")) {
      const out = pendingNotes.splice(0);
      return out;
    }
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 3, slug: "development" }),
  filterMutedOut: async (subs: string[]) => subs,
}));
vi.mock("../notify.server", () => ({
  notify: async (ev: { recipients: string[]; body: string; url: string }) => {
    notified.push(ev);
  },
}));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));

import { applyEvent, takeNotes } from "./factory-runs.server";
import type { Run } from "./factory-runs.server";

const run = (status: Run["status"]): Run => ({
  id: 7, channelId: 3, rootMsgId: 99, topic: "general", title: "t", status, planVersion: 1, loops: 0,
  repo: null, branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const events = () => sqls.filter((s) => s.sql.startsWith("INSERT INTO gt_factory_events"));

beforeEach(() => {
  sqls.length = 0;
  notified.length = 0;
  updateWins = true;
});

describe("bitácora del pedido", () => {
  it("una transición deja un renglón con quién y qué", async () => {
    await applyEvent(run("checking"), "check_fail", { loops: 1 }, { actor: "check", data: { findings: "falta prueba" } });
    await flush();
    expect(events()).toHaveLength(1);
    const [runId, actor, type, data] = events()[0].args as [number, string, string, string];
    expect([runId, actor, type]).toEqual([7, "check", "check_fail"]);
    expect(JSON.parse(data)).toMatchObject({ from: "checking", to: "building", findings: "falta prueba" });
  });

  it("si el candado se pierde no hay renglón", async () => {
    updateWins = false;
    await expect(applyEvent(run("plan_review"), "approve")).rejects.toThrow();
    await flush();
    expect(events()).toHaveLength(0);
  });
});

describe("avisos sólo cuando le toca a una persona", () => {
  it("plan listo → aviso a quien pidió, con liga al pedido", async () => {
    await applyEvent(run("planning"), "plan_submitted");
    await flush();
    await flush();
    expect(notified).toHaveLength(1);
    expect(notified[0].recipients).toEqual(["ana"]);
    expect(notified[0].url).toBe("/c/development?thread=99&run=7");
  });

  it("PR listo → quien pidió y quien firmó", async () => {
    await applyEvent(run("checking"), "check_pass");
    await flush();
    await flush();
    expect(notified[0].recipients.sort()).toEqual(["ana", "beto"]);
  });

  it("construir o revisar no avisan", async () => {
    await applyEvent(run("plan_review"), "approve");
    await applyEvent(run("building"), "build_done");
    await flush();
    await flush();
    expect(notified).toHaveLength(0);
  });
});


describe("vueltas de check", () => {
  it("un check_fail que no contó no suma vuelta ni escala", async () => {
    const r = { ...run("checking"), loops: 2 };
    const next = await applyEvent(r, "check_fail", { loops: 2 }, { actor: "check", data: { counted: false } });
    expect(next.status).toBe("building");
    expect(next.loops).toBe(2);
  });
  it("con la vuelta contada, la tercera escala", async () => {
    const r = { ...run("checking"), loops: 2 };
    const next = await applyEvent(r, "check_fail", { loops: 3 }, { actor: "check", data: { counted: true } });
    expect(next.status).toBe("escalated");
  });
});

describe("notas del pedido", () => {
  it("el encargo de @build las incluye y las marca consumidas", async () => {
    pendingNotes = [
      { id: 2, by: "ana", text: "y el changelog" },
      { id: 1, by: "@check", text: "faltan los docs del CLI" },
    ];
    const block = await takeNotes(7);
    expect(block).toContain("## Notas de la persona y del equipo");
    expect(block.indexOf("faltan los docs del CLI")).toBeLessThan(block.indexOf("y el changelog"));
    const upd = sqls.find((s) => s.sql.startsWith("UPDATE gt_factory_notes"))!;
    expect(upd.sql).toContain("consumed_at = unixepoch()");
    expect(upd.sql).toContain("consumed_at IS NULL");
    // Ya consumidas: el siguiente encargo no las repite.
    expect(await takeNotes(7)).toBe("");
  });
});
