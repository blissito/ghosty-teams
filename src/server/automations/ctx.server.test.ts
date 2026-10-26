import { beforeEach, describe, expect, it, vi } from "vitest";

// `wake`: hilo propio del room (reusado por threadKey) y despertador `auto:` a nombre de quien
// prendió la automatización.
const threads = new Map<string, number>();
const overrides = new Map<string, string>();
const posted: { channelId: number; parentId: number | null; body: string }[] = [];
const enqueueWakeup = vi.fn(async (_w: unknown) => true);
const mintWakeRef = vi.fn((_r: unknown) => "ref");
let owner: string | null = "u_quien_prendio";
let ownerOrigin: string | null = null;

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT root_msg_id")) {
      const id = threads.get(`${args[0]}:${args[1]}`);
      return id ? [{ root_msg_id: id }] : [];
    }
    if (sql.startsWith("INSERT OR REPLACE INTO gt_automation_threads")) threads.set(`${args[0]}:${args[1]}`, Number(args[2]));
    if (sql.includes("FROM gc_users")) return [{ sub: "u_owner" }];
    if (sql.startsWith("SELECT overrides FROM gt_factory_thread_overrides")) {
      const o = overrides.get(`${args[0]}:${args[1]}`);
      return o ? [{ overrides: o }] : [];
    }
    if (sql.includes("INSERT INTO gt_factory_thread_overrides")) overrides.set(`${args[0]}:${args[1]}`, String(args[2]));
    return [];
  },
}));
vi.mock("./store.server", () => ({
  automationRunAs: async () => ({ sub: owner, origin: ownerOrigin }),
  automationSettings: async () => ({}),
  claimKey: async () => true,
  spendBudget: async () => true,
}));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "build", name: "Build", avatar: "" }],
  agentGroupId: async (_a: unknown, s: string) => `ghosty-chat-build-${s}`,
}));
vi.mock("../../db.server", () => ({
  getChannelById: async (id: number) => ({ id, slug: "tech", archived: 0 }),
  postAgent: async (channelId: number, parentId: number | null, body: string) => {
    posted.push({ channelId, parentId, body });
    return { id: 100 + posted.length };
  },
  getMessage: async (id: number) => ({ id, body: "" }),
}));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "room" } }));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: (w: unknown) => enqueueWakeup(w),
  mintWakeRef: (r: unknown) => mintWakeRef(r),
  kickWakeups: () => {},
  armWakeups: () => {},
}));

const { automationCtx } = await import("./ctx.server");

beforeEach(() => {
  threads.clear();
  overrides.clear();
  posted.length = 0;
  vi.clearAllMocks();
  owner = "u_quien_prendio";
  ownerOrigin = null;
});

describe("ctx.wake", () => {
  it("abre un hilo con el título y despierta al agente ahí, a nombre de quien la prendió", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", origin: "https://x", kind: "ci_fix" });
    await ctx.wake({ handle: "build", text: "arregla el CI", threadKey: "ci_fix:acme/app#3", title: "🔧 CI rojo en #3" });
    expect(posted).toEqual([{ channelId: 7, parentId: null, body: "🔧 CI rojo en #3" }]);
    const ref = mintWakeRef.mock.calls[0][0] as { sub: string; groupId: string; dest: { channelId: number; parentId: number; handle: string } };
    expect(ref.sub).toBe("u_quien_prendio");
    expect(ref.dest).toMatchObject({ channelId: 7, parentId: 101, handle: "build" });
    expect(ref.groupId).toBe("ghosty-chat-build-tech-auto-ci-fix-acme-app-3");
    expect(ref.dest).toMatchObject({ factoryMode: "automation", automation: "ci_fix" });
    const w = enqueueWakeup.mock.calls[0][0] as { key: string; text: string; origin: string };
    expect(w.key).toMatch(/^auto:7:ci_fix:acme\/app#3:/);
    expect(w.text).toBe("arregla el CI");
    expect(w.origin).toBe("https://x");
  });

  it("el mismo threadKey vuelve al mismo hilo", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", origin: "https://x", kind: "ci_fix" });
    await ctx.wake({ handle: "build", text: "1", threadKey: "k" });
    await ctx.wake({ handle: "build", text: "2", threadKey: "k" });
    expect(posted).toHaveLength(1);
    expect((mintWakeRef.mock.calls[1][0] as { dest: { parentId: number } }).dest.parentId).toBe(101);
  });

  it("sin quien la prendió trabaja a nombre del dueño; sin ese @handle no hace nada", async () => {
    owner = null;
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", origin: "https://x", kind: "ci_fix" });
    await ctx.wake({ handle: "build", text: "x", threadKey: "k" });
    expect((mintWakeRef.mock.calls[0][0] as { sub: string }).sub).toBe("u_owner");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await ctx.wake({ handle: "check", text: "x", threadKey: "k2" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("delayS retrasa el turno; sin origin del request usa el guardado al prender", async () => {
    ownerOrigin = "https://acme.teams.ghosty.studio";
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", kind: "security_fix" });
    const before = Math.floor(Date.now() / 1000);
    await ctx.wake({ handle: "build", text: "x", threadKey: "sec", delayS: 600 });
    const w = enqueueWakeup.mock.calls[0][0] as { dueAt: number; origin: string };
    expect(w.dueAt).toBeGreaterThanOrEqual(before + 600);
    expect(w.origin).toBe("https://acme.teams.ghosty.studio");
  });
});

describe("ctx.post", () => {
  it("aviso suelto o en el hilo de la clave, sin turno", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", kind: "security_fix" });
    await ctx.post("⚠️ secreto filtrado");
    await ctx.post("se agotaron los intentos", { threadKey: "k", title: "🔧 #3" });
    expect(posted).toEqual([
      { channelId: 7, parentId: null, body: "⚠️ secreto filtrado" },
      { channelId: 7, parentId: null, body: "🔧 #3" },
      { channelId: 7, parentId: 102, body: "se agotaron los intentos" },
    ]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

describe("ctx.wake con retraso y marca de automatización", () => {
  it("delayS corre el dueAt y el turno lleva automation + repo", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/app", origin: "https://x", kind: "security_fix" });
    const before = Math.floor(Date.now() / 1000);
    await ctx.wake({ handle: "build", text: "lote", threadKey: "sec", delayS: 600 });
    const w = enqueueWakeup.mock.calls[0][0] as { dueAt: number };
    expect(w.dueAt).toBeGreaterThanOrEqual(before + 600);
    expect((mintWakeRef.mock.calls[0][0] as { dest: object }).dest).toMatchObject({ automation: "security_fix", automationRepo: "acme/app" });
  });
});

describe("el hilo de la automatización sabe su repo", () => {
  it("wake deja el repo en los overrides del hilo (room con varios repos)", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/api", origin: "https://x", kind: "ci_fix" });
    await ctx.wake({ handle: "build", text: "x", threadKey: "k" });
    expect(JSON.parse(overrides.get("7:101")!)).toEqual({ repo: "acme/api" });
  });

  it("combina con lo que el hilo ya traía y lo pone al reusar un hilo viejo", async () => {
    threads.set("7:k", 55);
    overrides.set("7:55", JSON.stringify({ models: { build: "opus" } }));
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/api", origin: "https://x", kind: "ci_fix" });
    await ctx.wake({ handle: "build", text: "x", threadKey: "k" });
    expect(JSON.parse(overrides.get("7:55")!)).toEqual({ models: { build: "opus" }, repo: "acme/api" });
  });

  it("un aviso suelto también lo deja (raíz de un hilo posible); uno en hilo, sólo en la raíz", async () => {
    const ctx = automationCtx({ ns: "ns", roomId: 7, repo: "acme/web", kind: "security_fix" });
    await ctx.post("aviso");
    await ctx.post("en hilo", { threadKey: "k2" });
    expect([...overrides.keys()].sort()).toEqual(["7:101", "7:102"]);
    expect(JSON.parse(overrides.get("7:101")!)).toEqual({ repo: "acme/web" });
  });
});
