import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// `ghosty factory rooms connect`: crear un room y conectarle un repo desde la terminal. Lo que no
// puede pasar: conectar un repo que la GitHub App de quien conecta no ve (un typo en la terminal),
// crear un room sin pedirlo, o quitar un repo que conectó otra persona.
const channels: { id: number; slug: string; name: string; is_private: number; archived?: number }[] = [];
const repos: { channelId: number; repo: string; connectedBy: string }[] = [];
let created: { name: string; isPrivate: boolean; createdBy: string }[] = [];
let ciAsked: string[][] = [];

vi.mock("../server/schema.server", () => ({ ensureSchema: async () => {} }));
vi.mock("../db.server", () => ({
  listChannels: async () => channels,
  listRoomRepos: async (id: number) => repos.filter((r) => r.channelId === id).map((r) => ({ repo: r.repo, connectedBy: r.connectedBy, createdAt: 0, notify: true })),
  addRoomRepo: async (channelId: number, repo: string, sub: string) => void repos.push({ channelId, repo, connectedBy: sub }),
  removeRoomRepo: async (channelId: number, repo: string) => {
    const i = repos.findIndex((r) => r.channelId === channelId && r.repo === repo);
    if (i >= 0) repos.splice(i, 1);
  },
  createChannel: async (d: { name: string; isPrivate: boolean; createdBy: string }) => {
    created.push(d);
    const ch = { id: 100 + channels.length, slug: d.name.toLowerCase(), name: d.name, is_private: d.isPrivate ? 1 : 0 };
    channels.push(ch);
    return ch;
  },
}));
vi.mock("../users.server", () => ({
  listAllMembers: async () => [
    { sub: "u1", email: "bliss@x.com", name: "blissmo", avatar: "", isOwner: false, banned: false },
    { sub: "u2", email: "ana@x.com", name: "Ana", avatar: "", isOwner: false, banned: false },
  ],
  resolvePermissions: async (_e: string, o: boolean) => ({ isOwner: o, isStaff: false }),
}));
vi.mock("../server/apps/installed.server", () => ({ isInstalled: async () => true }));
vi.mock("../server/connectors/github.server", () => ({
  normalizeRepo: (r: string) => (/^[\w.-]+\/[\w.-]+$/.test(r) ? r : null),
  githubApi: async (_s: string, path: string) => (path === "/repos/blissito/ghosty-studio" ? { full_name: "blissito/ghosty-studio" } : { error: "Not Found" }),
  allTools: () => [{ name: "github_install_link", handler: async () => ({ instalarOAgregarRepos: "https://github.com/apps/ghosty/installations/new" }) }],
}));
vi.mock("../server/apps/factory", () => ({ requestCiBox: async (r: string[]) => (ciAsked.push(r), "ws-business") }));
vi.mock("../server/apps/uptime.server", () => ({ autoMonitorRepo: async () => {} }));
vi.mock("../server/apps/readiness.server", () => ({
  repoReadiness: async () => ({ level: 1, passed: 4, total: 9, checks: [{ key: "ci", ok: false }, { key: "readme", ok: true }] }),
}));

process.env.GHOSTY_PARTNER_SECRET = "s3cr3t";
const { Route } = await import("./api.internal.factory-rooms");
const post = (Route.options as any).server.handlers.POST as (c: { request: Request }) => Promise<Response>;

async function call(body: object) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", "s3cr3t").update(`${ts}.${raw}`).digest("hex");
  const res = await post({ request: new Request("http://x/api/internal/factory-rooms", { method: "POST", headers: { "x-ghosty-ts": ts, "x-ghosty-sig": sig }, body: raw }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

describe("api/internal/factory-rooms", () => {
  beforeEach(() => {
    channels.length = 0;
    repos.length = 0;
    created = [];
    ciAsked = [];
    channels.push({ id: 7, slug: "mailmask", name: "MailMask", is_private: 0 });
  });

  it("crea el room con --create, conecta el repo y dice qué le falta", async () => {
    const r = await call({ action: "connect", room: "studio", repo: "blissito/ghosty-studio", create: true, sub: "u1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ room: "studio", created: true, ciLabel: "ws-business", readiness: { level: 1, missing: ["ci"] } });
    expect(created[0]).toMatchObject({ name: "studio", isPrivate: false, createdBy: "u1" });
    expect(repos).toEqual([{ channelId: 101, repo: "blissito/ghosty-studio", connectedBy: "u1" }]);
    expect(ciAsked).toEqual([["blissito/ghosty-studio"]]);
  });

  it("sin --create no inventa el room", async () => {
    const r = await call({ action: "connect", room: "studio", repo: "blissito/ghosty-studio", sub: "u1" });
    expect(r.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it("un room existente se encuentra por su nombre", async () => {
    const r = await call({ action: "connect", room: "MailMask", repo: "blissito/ghosty-studio", sub: "u1" });
    expect(r.json).toMatchObject({ room: "mailmask", created: false });
  });

  it("no conecta un repo que la GitHub App no ve, y da la liga para darle acceso", async () => {
    const r = await call({ action: "connect", room: "studio", repo: "blissito/ghosty-stduio", create: true, sub: "u1" });
    expect(r.status).toBe(409);
    expect(r.json.installUrl).toContain("github.com/apps/ghosty");
    expect(created).toHaveLength(0);
    expect(repos).toHaveLength(0);
  });

  it("quitar un repo lo puede quien lo conectó, no otra persona", async () => {
    repos.push({ channelId: 7, repo: "blissito/ghosty-studio", connectedBy: "u1" });
    expect((await call({ action: "disconnect", room: "mailmask", repo: "blissito/ghosty-studio", sub: "u2" })).status).toBe(403);
    expect((await call({ action: "disconnect", room: "mailmask", repo: "blissito/ghosty-studio", sub: "u1" })).status).toBe(200);
    expect(repos).toHaveLength(0);
  });

  it("ls dice qué rooms trabajan como fábrica", async () => {
    repos.push({ channelId: 7, repo: "blissito/mailmask", connectedBy: "u1" });
    const r = await call({ action: "ls", sub: "u1" });
    expect(r.json.rooms).toEqual([{ slug: "mailmask", name: "MailMask", private: false, repos: ["blissito/mailmask"], factory: true }]);
  });
});
