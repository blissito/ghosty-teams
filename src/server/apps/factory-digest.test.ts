import { describe, it, expect, vi } from "vitest";

// La foto del pedido sale de la DB y NO consume notas (eso sólo lo hace el encargo a @build).
const sqls: string[] = [];
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("verdict_json, sprint_item_id")) return [{ verdict_json: JSON.stringify({ ci: "success", risk: "low", ready: true, findings: "falta un test" }), sprint_item_id: 36 }];
    if (sql.includes("FROM gt_factory_sprint_items i JOIN")) return [{ key: "A", title: "Auth + domains", sprint_id: 4, sprint_title: "CLI", sprint_status: "active" }];
    if (sql.includes("FROM gt_factory_notes")) return [{ by: "@plan", text: "agrega un test de whoami sin sesión" }];
    if (sql.includes("FROM gt_factory_events")) return [{ type: "rework", actor: "@plan", at: Math.floor(Date.now() / 1000) - 120, data_json: JSON.stringify({ from: "pr_review", to: "building" }) }];
    if (sql.includes("FROM gt_factory_runs") && sql.includes("ORDER BY id DESC LIMIT")) return [{ id: 10, title: "CLI", status: "building", pr_url: "https://github.com/o/r/pull/8", updated_at: Math.floor(Date.now() / 1000) }];
    if (sql.includes("FROM gt_factory_sprints s")) return [{ id: 4, title: "CLI 3 tickets", status: "draft", replaces: 3, total: 3, merged: 0 }];
    return [];
  },
}));
vi.mock("./factory-runs.server", () => ({
  getPlan: async () => ({ planMd: "# Plan\n" + "x".repeat(2000), decision: "approve" }),
  runPreview: async () => ({ state: "ready", url: "https://p", error: null }),
}));

import { runDigest, roomIndex } from "./factory-digest.server";

const run = { id: 10, title: "CLI", status: "building", planVersion: 1, loops: 0, repo: "o/r", branch: "b", prUrl: "https://github.com/o/r/pull/8" } as never;

describe("runDigest", () => {
  it("compacto: etapa, ticket, plan recortado, notas, veredicto y eventos", async () => {
    const d = await runDigest(run);
    expect(d).toContain("Pedido #10");
    expect(d).toContain("ticket A");
    expect(d).toContain("agrega un test de whoami");
    expect(d).toContain("CI success");
    expect(d).toContain("rework (@plan)");
    expect(d.length).toBeLessThan(2000);
    expect(sqls.some((s) => s.startsWith("UPDATE gt_factory_notes"))).toBe(false);
  });
  it("con detail trae el plan completo y la preview", async () => {
    const d = await runDigest(run, { detail: true });
    expect(d).toContain("x".repeat(2000));
    expect(d).toContain("Preview: ready");
  });
});

describe("roomIndex", () => {
  it("pedidos abiertos y sprints con su avance", async () => {
    const r = await roomIndex(14);
    expect(r).toContain("Pedido #10");
    expect(r).toContain("PR o/r/pull/8");
    expect(r).toContain("Sprint #4");
    expect(r).toContain("borrador (falta firma)");
    expect(r).toContain("reemplaza al #3");
  });
});
