import { describe, it, expect, vi, beforeEach } from "vitest";

// La tarjeta viva del pedido nace DENTRO del hilo y «también en el room» (8-oct): antes salía
// suelta en el room y parecía que el trabajo se mudaba a otro hilo (MailMask #18).
const posts: { channelId: number; parentId: number | null; body: string; opts?: { alsoInChannel?: boolean } }[] = [];
let cardMsgId: number | null = null;

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string) => (sql.startsWith("SELECT card_msg_id") ? [{ card_msg_id: cardMsgId }] : []),
}));
vi.mock("../../db.server", () => ({
  postAgent: async (channelId: number, parentId: number | null, body: string, _k: string, _h: string, _n: string, _t: string, _a: string, opts?: { alsoInChannel?: boolean }) => {
    posts.push({ channelId, parentId, body, opts });
    return { id: 500 };
  },
  getMessage: async () => ({ id: 500 }),
}));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [{ handle: "plan", name: "Plan", avatar: "" }] }));

import { ensureRunCard, type Run } from "./factory-runs.server";

const run = (over: Partial<Run> = {}): Run => ({
  id: 18, channelId: 14, rootMsgId: 4625, topic: "general", title: "CLI", status: "plan_review", planVersion: 1, loops: 0,
  repo: "o/r", branch: null, prUrl: null, headSha: null, taskRef: null, requestedBy: "ana", approvedBy: null, ...over,
});

beforeEach(() => {
  posts.length = 0;
  cardMsgId = null;
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
    await ensureRunCard(run());
    expect(posts).toHaveLength(0);
  });
});
