import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// `ghosty teams post`: gs firma, Teams publica como la persona y arranca a quien mencione.
// Lo que no puede pasar: publicar a nombre de alguien que no es miembro, en un hilo de otro room,
// o con una firma vencida.
const posted: { me: { sub: string; name: string }; data: { slug: string; parentId: number | null; body: string } }[] = [];
const asked: { handle: string; invokerMessageId?: number }[] = [];
const members = [
  { sub: "u1", email: "bliss@x.com", name: "blissmo", avatar: "", isOwner: true, banned: false },
  { sub: "u2", email: "fuera@x.com", name: "Baneado", avatar: "", isOwner: false, banned: true },
];
const messages: Record<number, { id: number; channel_id: number; parent_id: number | null; dm_id: number | null }> = {
  50: { id: 50, channel_id: 7, parent_id: null, dm_id: null },
  51: { id: 51, channel_id: 7, parent_id: 50, dm_id: null },
  60: { id: 60, channel_id: 8, parent_id: null, dm_id: null },
};

vi.mock("../server/schema.server", () => ({ ensureSchema: async () => {} }));
vi.mock("../db.server", () => ({
  getChannel: async (slug: string) => (slug === "mailmask" ? { id: 7, slug: "mailmask" } : null),
  getChannelById: async (id: number) => (id === 7 ? { id: 7, slug: "mailmask" } : null),
  getMessage: async (id: number) => messages[id] ?? null,
  canSeeChannel: async () => true,
  listThread: async () => [],
}));
vi.mock("../users.server", () => ({
  listAllMembers: async () => members,
  resolvePermissions: async (_e: string, o: boolean) => ({ isOwner: o, isStaff: false }),
}));
vi.mock("../server/chat", () => ({
  postMessageAs: async (me: { sub: string; name: string }, data: { slug: string; parentId: number | null; body: string }) => {
    posted.push({ me, data });
    return { ok: true, id: 99, respondents: [{ handle: "plan", parent: data.parentId ?? 99, fleetThread: "flow", shellId: 100 }], unresolved: [] };
  },
  askAgentAs: async (_me: unknown, d: { handle: string; invokerMessageId?: number }) => {
    asked.push({ handle: d.handle, invokerMessageId: d.invokerMessageId });
    return { ok: true };
  },
}));

process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
const { Route } = await import("./api.internal.post-message");
const post = (Route.options as any).server.handlers.POST as (c: { request: Request }) => Promise<Response>;

async function call(body: object, ts = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${raw}`).digest("hex");
  const res = await post({ request: new Request("http://x/api/internal/post-message", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sig }, body: raw }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("api/internal/post-message", () => {
  beforeEach(() => {
    posted.length = 0;
    asked.length = 0;
  });

  it("publica como la persona y arranca a quien mencionó, con el mensaje como invocador", async () => {
    const r = await call({ action: "post", channel: "mailmask", text: "@plan que el deploy espere al ci", sub: "u1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 99, threadId: 99, channel: "mailmask" });
    expect(posted[0]).toMatchObject({ me: { sub: "u1", name: "blissmo" }, data: { slug: "mailmask", parentId: null } });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(asked).toEqual([{ handle: "plan", invokerMessageId: 99 }]);
  });

  it("dentro de un hilo responde en su raíz", async () => {
    const r = await call({ action: "post", channel: "mailmask", parentId: 50, text: "¿en qué va?", sub: "u1" });
    expect(r.json.threadId).toBe(50);
  });

  it("no publica a nombre de quien no es miembro (ni baneado), ni con firma vencida", async () => {
    expect((await call({ action: "post", channel: "mailmask", text: "hola", sub: "nadie" })).status).toBe(403);
    expect((await call({ action: "post", channel: "mailmask", text: "hola", sub: "u2" })).status).toBe(403);
    expect((await call({ action: "post", channel: "mailmask", text: "hola", sub: "u1" }, String(Math.floor(Date.now() / 1000) - 600))).status).toBe(403);
    expect(posted).toHaveLength(0);
  });

  it("el hilo tiene que ser raíz y del mismo room", async () => {
    expect((await call({ action: "post", channel: "mailmask", parentId: 51, text: "x", sub: "u1" })).json.error).toMatch(/inicio del hilo \(50\)/);
    expect((await call({ action: "post", channel: "mailmask", parentId: 60, text: "x", sub: "u1" })).status).toBe(404);
    expect(posted).toHaveLength(0);
  });
});
