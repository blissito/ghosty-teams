import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

// Lo que la app de iOS ve de un pedido a @plan (bliss, 19-oct: «se manda el pedido pero nada
// regresa»): el hilo con la pregunta `ask-user` armada, el sprint propuesto en él y el run que
// nació ahí. Y sólo si la persona ve el room.
const channels = [
  { id: 1, slug: "studio", name: "studio", is_private: 0 },
  { id: 2, slug: "secreto", name: "secreto", is_private: 1 },
];
const msgs = [
  { id: 10, channel_id: 1, parent_id: null, sender: "blissmo", sender_sub: "u1", avatar: "", body: "@plan arma lo del colaborador", kind: "msg", agent_handle: null, created_at: 1 },
  { id: 11, channel_id: 1, parent_id: 10, sender: "Arqui", sender_sub: null, avatar: "", body: "```gt-sprint\n{\"sprintId\":12}\n```", kind: "msg", agent_handle: "plan", created_at: 2 },
  { id: 12, channel_id: 1, parent_id: 10, sender: "Arqui", sender_sub: null, avatar: "", body: "¿Para todos los rooms?", kind: "msg", agent_handle: "plan", created_at: 3,
    artifact: { id: 1, messageId: 12, kind: "ask-user", url: "", title: "¿Para todos los rooms?", md: JSON.stringify(["Sí", "Sólo #studio"]) } },
  { id: 13, channel_id: 1, parent_id: 10, sender: "Arqui", sender_sub: null, avatar: "", body: "pensando", kind: "status", agent_handle: "plan", created_at: 4 },
];
let sprintSeenBy: unknown = null;

vi.mock("../db.server", () => ({
  getChannel: async (slug: string) => channels.find((c) => c.slug === slug) ?? null,
  getChannelById: async (id: number) => channels.find((c) => c.id === id) ?? null,
  canSeeChannel: async (ch: { is_private: number }) => !ch.is_private,
  getMessage: async (id: number) => msgs.find((m) => m.id === id) ?? null,
  listThread: async (id: number) => msgs.filter((m) => m.parent_id === id),
  attachArtifacts: async (m: unknown[]) => m,
}));
vi.mock("../users.server", () => ({
  listAllMembers: async () => [{ sub: "u1", email: "b@x.com", name: "blissmo", avatar: "", isOwner: false, banned: false }],
  resolvePermissions: async (_e: string, o: boolean) => ({ isOwner: o, isStaff: false }),
}));
vi.mock("../server/tenant.server", () => ({ currentNamespace: async () => "business" }));
vi.mock("../server/turns.server", () => ({ turnState: (_ns: string, id: number) => (id === 12 ? { phase: "running" } : null) }));
vi.mock("../server/apps/factory-runs.server", () => ({ runOfThread: async () => null }));
vi.mock("../dbq.server", () => ({ dbq: async (sql: string) => (/gt_factory_sprints/.test(sql) ? [{ id: 12 }] : []) }));
vi.mock("../server/apps/factory", () => ({
  readSprint: async (id: number, me: unknown) => ((sprintSeenBy = me), { id, title: "Colaborador, fase 2", status: "draft", items: [] }),
}));

process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
const { Route } = await import("./api.internal.factory-thread");
const post = (Route.options as any).server.handlers.POST as (c: { request: Request }) => Promise<Response>;

async function call(body: object) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${raw}`).digest("hex");
  const res = await post({ request: new Request("http://x/api/internal/factory-thread", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sig }, body: raw }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

describe("api/internal/factory-thread", () => {
  it("trae el hilo, la pregunta con opciones y el sprint propuesto, como quien pregunta", async () => {
    const r = await call({ channel: "studio", threadId: 10, sub: "u1" });
    expect(r.status).toBe(200);
    expect(r.json.root.body).toContain("@plan");
    expect(r.json.messages.map((m: any) => m.id)).toEqual([11, 12]); // sin el «status»
    expect(r.json.messages[1].ask).toEqual({ question: "¿Para todos los rooms?", options: ["Sí", "Sólo #studio"], answered: null });
    expect(r.json.messages[1].live).toBe(true);
    expect(r.json.working).toBe(true);
    expect(r.json.sprint.id).toBe(12);
    expect((sprintSeenBy as any).sub).toBe("u1");
    expect(r.json.run).toBeNull();
  });

  it("after: sólo lo nuevo", async () => {
    const r = await call({ channel: "studio", threadId: 10, after: 11, sub: "u1" });
    expect(r.json.messages.map((m: any) => m.id)).toEqual([12]);
  });

  it("un room que no ve, un hilo ajeno o una respuesta no son un pedido", async () => {
    expect((await call({ channel: "secreto", threadId: 10, sub: "u1" })).status).toBe(403);
    expect((await call({ channel: "studio", threadId: 11, sub: "u1" })).status).toBe(404);
    expect((await call({ channel: "studio", threadId: 10, sub: "nadie" })).status).toBe(403);
  });
});
