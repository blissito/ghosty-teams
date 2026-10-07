import { describe, it, expect, vi, beforeEach } from "vitest";

// Atascos en vivo: gs manda `stalled` y Teams avisa en el hilo, empuja al rol (steer) y, desde el
// segundo atasco del pedido, manda push a quien lo pidió (una vez). Nació del #13 de
// mercadito-verde (6-oct): cinco esperas de ~10 min sin que nadie se enterara.
const posts: string[] = [];
const pushes: { recipients: string[]; body: string }[] = [];
let stuckRows: { at: number; data_json: string }[] = [];
let notified = false;
let status = "building";
const inserted: { type: string; data: string | null }[] = [];

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql === "SELECT * FROM gt_factory_runs WHERE id = ?") return [{ id: 13, channel_id: 5, root_msg_id: 345, topic: "general", title: "Redondeo", status, plan_version: 1, loops: 0, requested_by: "oswaldo", approved_by: "oswaldo" }];
    if (sql.includes("type = 'stuck' ORDER BY")) return stuckRows;
    if (sql.includes("type = 'stuck_notified'")) return notified ? [{ 1: 1 }] : [];
    if (sql.startsWith("INSERT INTO gt_factory_events")) {
      inserted.push({ type: String(args[2]), data: args[3] as string | null });
      if (args[2] === "stuck") stuckRows.push({ at: Math.floor(Date.now() / 1000), data_json: String(args[3]) });
      if (args[2] === "stuck_notified") notified = true;
    }
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async (ev: { recipients: string[]; body: string }) => void pushes.push(ev) }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
// Sin backend de flota: el steer no sale (devuelve false) y el aviso no promete revisarlo.
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "build", name: "Constructor", avatar: "", backend: { kind: "other" } }],
  agentGroupId: async () => "g",
}));

import { onRoleStalled } from "./factory-runs.server";

const G = "ws-a857-ghosty-chat-build-factory-13";
const frame = (detail: string) => ({ rule: "long_command", detail, count: 1, secs: 540, human: `lleva 9 min en \`${detail}\` sin terminar.`, steer: "revisa si está colgado" });

beforeEach(() => {
  posts.length = 0;
  pushes.length = 0;
  inserted.length = 0;
  stuckRows = [];
  notified = false;
  status = "building";
});

describe("onRoleStalled", () => {
  it("primer atasco: bitácora y aviso en el hilo, sin push", async () => {
    await onRoleStalled(G, frame("npm run test:actions:db"));
    expect(inserted.map((i) => i.type)).toEqual(["stuck"]);
    expect(posts[0]).toMatch(/^⏳ @build lleva 9 min en `npm run test:actions:db`/);
    expect(pushes).toHaveLength(0);
  });

  it("el mismo atasco no se avisa dos veces; uno distinto sí, y ése manda push una sola vez", async () => {
    await onRoleStalled(G, frame("npm run test:actions:db"));
    await onRoleStalled(G, frame("npm run test:actions:db"));
    expect(posts).toHaveLength(1);
    await onRoleStalled(G, frame("node t4.mjs"));
    await onRoleStalled(G, frame("node t5.mjs"));
    expect(posts).toHaveLength(3);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].recipients).toEqual(["oswaldo"]);
  });

  it("ignora turnos que no son de un rol de la fábrica, el crítico y pedidos cerrados", async () => {
    await onRoleStalled("ws-a857-ghosty-chat-general", frame("x"));
    await onRoleStalled("ws-a857-ghosty-chat-check-factory-13-critic", frame("x"));
    await onRoleStalled("ws-a857-ghosty-chat-plan-factory-thread-345", frame("x"));
    status = "done";
    await onRoleStalled(G, frame("x"));
    expect(posts).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });
});
