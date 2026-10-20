import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

// Los sprints desde la app de iOS: mismas funciones que la tarjeta, a nombre de quien llega
// por gs (nunca de la sesión), y los terminados viejos no salen en la lista.
const calls: { fn: string; data: unknown; me: any }[] = [];
let lsSql = "";

vi.mock("../db.server", () => ({
  listChannels: async () => [{ id: 1, slug: "studio" }],
}));
vi.mock("../users.server", () => ({
  listAllMembers: async () => [{ sub: "u1", email: "b@x.com", name: "blissmo", avatar: "", isOwner: true, banned: false }],
  resolvePermissions: async (_e: string, o: boolean) => ({ isOwner: o, isStaff: false }),
}));
vi.mock("../dbq.server", () => ({
  dbq: async (sql: string) => {
    lsSql = sql;
    return [{ id: 12, channel_id: 1, root_msg_id: 6950, card_msg_id: 6951, title: "Colaborador", status: "draft", repo: "blissito/ghosty-studio", created_at: 1, updated_at: 2, total: 5, merged: 0 }];
  },
}));
const spy = (fn: string) => async (data: unknown, me: unknown) => (calls.push({ fn, data, me }), { id: 12, status: fn === "sprintApprove" ? "active" : "draft" });
vi.mock("../server/apps/factory", () => ({
  readSprint: async (id: number, me: unknown) => (calls.push({ fn: "readSprint", data: id, me }), { id }),
  sprintApprove: spy("sprintApprove"),
  sprintEdit: spy("sprintEdit"),
  sprintChanges: spy("sprintChanges"),
  sprintItem: spy("sprintItem"),
  sprintIssue: spy("sprintIssue"),
}));

process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
const { Route } = await import("./api.internal.factory-sprint");
const post = (Route.options as any).server.handlers.POST as (c: { request: Request }) => Promise<Response>;

async function call(body: object) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${raw}`).digest("hex");
  const res = await post({ request: new Request("http://x/api/internal/factory-sprint", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sig }, body: raw }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

describe("api/internal/factory-sprint", () => {
  it("ls: con su room, su hilo y su avance; los terminados sólo de 14 días", async () => {
    const r = await call({ action: "ls", sub: "u1" });
    expect(r.json.sprints[0]).toMatchObject({ id: 12, room: "studio", threadId: 6950, total: 5, merged: 0 });
    expect(lsSql).toContain("14 * 86400");
  });

  it("aprobar y editar van a las funciones de la tarjeta como el miembro", async () => {
    expect((await call({ action: "approve", sprintId: 12, sub: "u1" })).json.status).toBe("active");
    await call({ action: "edit", sprintId: 12, itemId: 3, included: false, sub: "u1" });
    const edit = calls.find((c) => c.fn === "sprintEdit")!;
    expect(edit.data).toMatchObject({ sprintId: 12, itemId: 3, included: false });
    expect(edit.me).toMatchObject({ sub: "u1", isOwner: true });
  });

  it("rechaza lo incompleto y a quien no es miembro", async () => {
    expect((await call({ action: "item", sprintId: 12, itemId: 3, op: "borrar", sub: "u1" })).status).toBe(400);
    expect((await call({ action: "edit", sprintId: 12, sub: "u1" })).status).toBe(400);
    expect((await call({ action: "get", sprintId: 12, sub: "nadie" })).status).toBe(403);
  });
});
