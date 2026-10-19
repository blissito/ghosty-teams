import { describe, it, expect, vi, beforeEach } from "vitest";

// La tarjeta viva del pedido nace DENTRO del hilo y «también en el room» (8-oct): antes salía
// suelta en el room y parecía que el trabajo se mudaba a otro hilo (MailMask #18).
const posts: { channelId: number; parentId: number | null; body: string; opts?: { alsoInChannel?: boolean } }[] = [];
let cardMsgId: number | null = null;
const bodies = new Map<number, string>();
const updates: { sql: string; args: unknown[] }[] = [];

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT card_msg_id")) return [{ card_msg_id: cardMsgId }];
    updates.push({ sql, args });
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  postAgent: async (channelId: number, parentId: number | null, body: string, _k: string, _h: string, _n: string, _t: string, _a: string, opts?: { alsoInChannel?: boolean }) => {
    posts.push({ channelId, parentId, body, opts });
    return { id: 500 };
  },
  getMessage: async (id: number) => (bodies.has(id) ? { id, body: bodies.get(id) } : id === 500 ? { id: 500, body: "" } : null),
}));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [{ handle: "plan", name: "Plan", avatar: "" }] }));

import { ensureRunCard, postRunCard, type Run } from "./factory-runs.server";

const run = (over: Partial<Run> = {}): Run => ({
  id: 18, channelId: 14, rootMsgId: 4625, topic: "general", title: "CLI", status: "plan_review", planVersion: 1, loops: 0,
  repo: "o/r", branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "ana", approvedBy: null, ...over,
});

beforeEach(() => {
  posts.length = 0;
  cardMsgId = null;
  bodies.clear();
  updates.length = 0;
});

describe("tarjeta viva del pedido", () => {
  it("se publica en el hilo del pedido y también en el room", async () => {
    await ensureRunCard(run());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channelId: 14, parentId: 4625, opts: { alsoInChannel: true } });
    expect(posts[0].body).toContain("gt-run");
  });
  it("un pedido sin hilo la deja en el room", async () => {
    await ensureRunCard(run({ rootMsgId: 0 }));
    expect(posts[0].parentId).toBeNull();
    expect(posts[0].opts).toBeUndefined();
  });
  it("si ya existe no la vuelve a publicar", async () => {
    cardMsgId = 77;
    bodies.set(77, "```gt-run\n{\"runId\":18}\n```");
    await ensureRunCard(run());
    expect(posts).toHaveLength(0);
  });
  it("si su mensaje se borró, la vuelve a publicar", async () => {
    cardMsgId = 77;
    await ensureRunCard(run());
    expect(posts).toHaveLength(1);
  });
  it("al bajarla, la anterior queda como huella que apunta a la nueva", async () => {
    cardMsgId = 77;
    bodies.set(77, "Decide aquí:\n\n```gt-run\n{\"runId\":18}\n```");
    await postRunCard(run());
    expect(posts).toHaveLength(1);
    const fossil = updates.find((u) => u.sql.startsWith("UPDATE gc_messages"));
    expect(fossil?.args[1]).toBe(77);
    const body = String(fossil?.args[0]);
    expect(body).toContain("Decide aquí:");
    expect(body).toContain("gt-run-fossil");
    expect(body).toContain('"liveMsgId":500');
    expect(body).not.toMatch(/```gt-run\n/);
  });
});
