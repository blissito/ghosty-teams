import { describe, it, expect, vi, beforeEach } from "vitest";

// Vigilante de la preview (easybits, 20-oct): cinco PRs de Dependabot se quedaron 24 h con la
// preview en `pending` porque gs nunca recibió el `up`. Ninguna preview se queda muda: lo que no
// avanza en 15 min falla con motivo y el pedido escala como `platform` (sin «Te toca»), lo que no
// cabe espera con motivo, y el hosting que no dice nada cede a la caja de gs.
type Row = Record<string, any>;
let rows: Row[] = [];
let events: { run_id: number; type: string; data_json: string | null; at: number }[] = [];
let notices = 0;
let noticeClaimed = new Set<string>();
const posts: { root: number | null; body: string }[] = [];
const gsCalls: { op: string; body: any }[] = [];
let gsImpl: (op: string, body: any) => Promise<any> = async () => null;
let hosting = false;
let commit: { state: string; url: string | null; provider: string | null } = { state: "none", url: null, provider: null };
const silenced: string[] = [];

const nowS = () => Math.floor(Date.now() / 1000);
const baseRow = (over: Row = {}): Row => ({
  id: 127, channel_id: 5, root_msg_id: 900, topic: "general", title: "Bump react-router from 7 to 8", status: "checking",
  plan_version: 0, loops: 0, repo: "blissito/easybits", branch: "dependabot/npm/rr-8", pr_url: "https://github.com/blissito/easybits/pull/127",
  requested_by: "bliss", approved_by: "bliss", kind: "dependabot", task_ref: "dependabot:major", box_id: null,
  preview_state: "pending", preview_sha: "abc1234", preview_since: nowS() - 16 * 60, preview_phase: "installing", ...over,
});

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: any[] = []) => {
    const byId = (id: unknown) => rows.find((r) => r.id === Number(id));
    if (sql.startsWith("SELECT * FROM gt_factory_runs WHERE status IN")) return rows.map((r) => ({ ...r }));
    if (sql.startsWith("SELECT * FROM gt_factory_runs WHERE id = ?")) return byId(args[0]) ? [{ ...byId(args[0]) }] : [];
    if (sql.startsWith("SELECT preview_off")) return [];
    if (sql.startsWith("INSERT INTO gt_factory_events")) {
      events.push({ run_id: Number(args[0]), type: String(args[2]), data_json: args[3] ?? null, at: nowS() });
      return [];
    }
    if (sql.startsWith("SELECT data_json, at FROM gt_factory_events")) {
      const ev = events.filter((e) => e.run_id === Number(args[0]) && (e.type === "check_blocked" || e.type === "check_fail")).at(-1);
      return ev ? [ev] : [];
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM gt_factory_events")) return [{ n: events.filter((e) => e.run_id === Number(args[0]) && e.type === "preview_retry").length }];
    if (sql.startsWith("INSERT INTO gt_factory_repo_prefs")) {
      if (noticeClaimed.has(String(args[0]))) return [];
      noticeClaimed.add(String(args[0]));
      return [{ repo: args[0] }];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_since = ? WHERE id = ? AND preview_since IS NULL")) {
      const r = byId(args[1]);
      if (r && r.preview_since == null) r.preview_since = args[0];
      return [];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_phase = ?, preview_since = unixepoch()")) {
      const r = byId(args[1]);
      if (r) Object.assign(r, { preview_phase: args[0], preview_since: nowS() });
      return [];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_state = ?, preview_url = ?, preview_sha = ?, preview_error = ?, preview_since")) {
      const [state, url, sha, error, phase, id, st2, sha2] = args;
      const r = byId(id);
      if (!r || ((r.preview_state ?? "") === st2 && (r.preview_sha ?? "") === sha2)) return [];
      Object.assign(r, { preview_state: state, preview_url: url, preview_sha: sha, preview_error: error, preview_phase: phase, preview_since: nowS() });
      return [{ id }];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_error = ?")) {
      const r = byId(args[1]);
      if (r) r.preview_error = args[0];
      return [];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET preview_state = 'pending', preview_sha = NULL")) {
      const r = byId(args[0]);
      if (!r) return [];
      Object.assign(r, { preview_state: "pending", preview_sha: null, preview_error: null, preview_since: nowS(), preview_phase: null });
      return [{ ...r }];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET status = ?")) {
      const r = byId(args.at(-3));
      if (!r || r.status !== args.at(-2)) return [];
      r.status = args[0];
      return [{ ...r }];
    }
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_ch: number, root: number | null, body: string) => {
    posts.push({ root, body });
    if (root === null) notices++;
    return { id: posts.length };
  },
  getMessage: async () => null,
  listRoomRepos: async () => [],
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [], agentGroupId: async () => "g" }));
vi.mock("./factory-team.server", () => ({ factoryTurnFor: async () => null }));
vi.mock("./readiness.server", () => ({ repoReadiness: async () => null, invalidateReadiness: () => {} }));
vi.mock("./factory-preview-check.server", () => ({ syncPrCheck: async () => {} }));
vi.mock("./pr-preview.server", () => ({ recordEvictedPreviews: async () => {} }));
vi.mock("./factory-smoke.server", () => ({ runActionSmoke: async () => null, smokeFailures: () => null }));
vi.mock("./factory-shots.server", () => ({ captureVerdictShots: async () => {} }));
vi.mock("../connectors/github.server", () => ({
  allTools: () => [{ name: "github_get_pr", handler: async () => ({ headSha: "abc1234", draft: false, head: "dependabot/npm/rr-8" }) }],
  publishPreviewDeployment: async () => ({ ok: true }),
  githubApi: async () => ({}),
}));
vi.mock("./preview.server", () => ({
  hostingHasPreviews: async () => hosting,
  commitPreview: async () => ({ ...commit, sha: "abc1234" }),
  markHostingSilent: (repo: string) => {
    silenced.push(repo);
    hosting = false;
  },
  gsPreview: async (op: string, body: any) => {
    gsCalls.push({ op, body });
    return gsImpl(op, body);
  },
}));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sin red"); }));

import { announcePreviews, boxNeedsUp, boxPreviewNext, previewDue, stuckPreviewReason, waitingFromGsError } from "./factory-runs.server";

beforeEach(() => {
  rows = [];
  events = [];
  notices = 0;
  noticeClaimed = new Set();
  posts.length = 0;
  gsCalls.length = 0;
  gsImpl = async () => null;
  hosting = false;
  commit = { state: "none", url: null, provider: null };
  silenced.length = 0;
});

let nextId = 1000;
const fresh = (over: Row = {}) => baseRow({ id: nextId++, ...over });

describe("vigilante de la preview (easybits, 20-oct)", () => {
  it("15 min en «installing» sin avanzar: falla con motivo y el pedido escala como platform", async () => {
    const r = fresh();
    rows = [r];
    gsImpl = async (op) => (op === "status" ? { status: { phase: "installing", sha: "abc1234", url: null, error: null } } : null);
    await announcePreviews();
    expect(r.preview_state).toBe("failed");
    expect(r.preview_error).toMatch(/^la preview no arrancó: la caja se quedó en «installing»/);
    expect(r.status).toBe("escalated");
    const blocked = events.find((e) => e.type === "check_blocked")!;
    expect(JSON.parse(blocked.data_json!)).toMatchObject({ kind: "platform" });
    expect(JSON.parse(blocked.data_json!).reason.length).toBeLessThanOrEqual(140);
  });

  it("cinco pedidos del mismo repo atorados: UN solo aviso en el room, no cinco", async () => {
    rows = [fresh(), fresh(), fresh(), fresh(), fresh()];
    gsImpl = async (op) => (op === "status" ? { status: { phase: "installing", sha: "abc1234", url: null, error: null } } : null);
    // De uno en uno: con varios `import()` dinámicos a la vez, vitest le da a alguno el
    // github.server real en vez del simulado (en producción van 4 a la vez; el aviso único lo
    // garantiza el INSERT … ON CONFLICT … RETURNING, no el orden).
    await announcePreviews({ concurrency: 1 });
    expect(rows.every((r) => r.status === "escalated")).toBe(true);
    expect(notices).toBe(1);
    expect(posts.find((p) => p.root === null)!.body).toContain("blissito/easybits");
  });

  it("si cambió de fase, eso es avance: el reloj vuelve a empezar", async () => {
    const r = fresh();
    rows = [r];
    gsImpl = async (op) => (op === "status" ? { status: { phase: "building", sha: "abc1234", url: null, error: null } } : null);
    await announcePreviews();
    expect(r.preview_state).toBe("pending");
    expect(r.preview_phase).toBe("building");
    expect(nowS() - r.preview_since).toBeLessThan(5);
    expect(r.status).toBe("checking");
  });

  it("gs sin lugar (409 no_slot): queda `waiting` con el motivo, no `pending` mudo", async () => {
    const r = fresh({ preview_state: null, preview_sha: null, preview_since: null, preview_phase: null });
    rows = [r];
    gsImpl = async () => {
      throw Object.assign(new Error("no_slot"), { status: 409, body: { error: "no_slot", busy: [120, 121] } });
    };
    await announcePreviews();
    expect(r.preview_state).toBe("waiting");
    expect(r.preview_error).toContain("#120, #121");
    expect(r.status).toBe("checking");
  });

  it("gs reiniciado contesta `sha: null`: se vuelve a pedir `up`", async () => {
    const r = fresh({ preview_since: nowS() - 60 });
    rows = [r];
    gsImpl = async (op) =>
      op === "status" ? { status: { phase: "ready", sha: null, url: null, error: null } } : { phase: "installing", sha: "abc1234", url: null, error: null };
    await announcePreviews();
    expect(gsCalls.map((c) => c.op)).toEqual(["status", "up"]);
    expect(r.preview_state).toBe("pending");
  });

  it("el hosting no dice nada del commit en 5 min: se le pide la caja a gs", async () => {
    const r = fresh({ preview_since: nowS() - 6 * 60, preview_phase: null });
    rows = [r];
    hosting = true;
    gsImpl = async (op) => (op === "up" ? { phase: "installing", sha: "abc1234", url: null, error: null } : { status: null });
    await announcePreviews();
    expect(silenced).toEqual(["blissito/easybits"]);
    expect(gsCalls.some((c) => c.op === "up")).toBe(true);
  });

  it("la preview llega a un pedido escalado por la plataforma: @check revisa otra vez solo", async () => {
    const r = fresh({ status: "escalated", preview_state: "pending", preview_since: nowS() - 60 });
    rows = [r];
    events.push({ run_id: r.id, type: "check_blocked", data_json: JSON.stringify({ kind: "platform", reason: "la preview no arrancó", findings: "- x" }), at: nowS() });
    gsImpl = async (op) => (op === "status" ? { status: { phase: "ready", sha: "abc1234", url: "https://pr-127.preview.test", error: null } } : null);
    await announcePreviews();
    expect(r.preview_state).toBe("ready");
    expect(r.status).toBe("checking");
    expect(events.some((e) => e.type === "recheck")).toBe(true);
  });

  it("un escalado de verdad (decision) NO se re-revisa solo al llegar la preview", async () => {
    const r = fresh({ status: "escalated", preview_state: "pending", preview_since: nowS() - 60 });
    rows = [r];
    events.push({ run_id: r.id, type: "check_blocked", data_json: JSON.stringify({ kind: "skip", reason: "major que no conviene", findings: "- x" }), at: nowS() });
    gsImpl = async (op) => (op === "status" ? { status: { phase: "ready", sha: "abc1234", url: "https://pr-127.preview.test", error: null } } : null);
    await announcePreviews();
    expect(r.status).toBe("escalated");
  });
});

describe("piezas puras del vigilante", () => {
  it("stuckPreviewReason: a tiempo no dice nada; vencida, el motivo en llano", () => {
    const now = 10_000;
    expect(stuckPreviewReason({ since: now - 60, phase: "installing", provider: null, lastError: null }, now)).toBeNull();
    expect(stuckPreviewReason({ since: now - 16 * 60, phase: null, provider: "Vercel", lastError: null }, now)).toBe("la preview no arrancó: Vercel no la publicó en 16 min");
    expect(stuckPreviewReason({ since: now - 16 * 60, phase: null, provider: null, lastError: "fetch failed" }, now)).toContain("gs no respondió");
  });
  it("waitingFromGsError: 409 no_slot y 503 esperan; lo demás no", () => {
    expect(waitingFromGsError({ status: 409, body: { error: "no_slot", busy: [3] } })).toContain("#3");
    expect(waitingFromGsError({ status: 503, body: { error: "no hay capacidad" } })).toBe("no hay capacidad");
    expect(waitingFromGsError({ status: 502, body: { error: "x" } })).toBeNull();
    expect(waitingFromGsError(new Error("timeout"))).toBeNull();
  });
  it("boxNeedsUp / boxPreviewNext: «creating» sin sha no es olvido; ready con sha null sí", () => {
    expect(boxNeedsUp(null, "a")).toBe(true);
    expect(boxNeedsUp({ phase: "creating", sha: null }, "a")).toBe(false);
    expect(boxNeedsUp({ phase: "ready", sha: null }, "a")).toBe(true);
    expect(boxNeedsUp({ phase: "building", sha: "a" }, "a")).toBe(false);
    expect(boxPreviewNext({ phase: "ready", sha: "a", url: "https://x" }, "a")).toMatchObject({ state: "ready", url: "https://x" });
    expect(boxPreviewNext({ phase: "failed", sha: "a", error: "build" }, "a")).toMatchObject({ state: "failed", error: "build" });
    expect(boxPreviewNext({ phase: "ready", sha: "b" }, "a").state).toBe("pending");
  });
  it("previewDue: sin LIMIT por updated_at; el que lleva más sin mirarse va primero", () => {
    const last = new Map<number, number>([[1, 1000], [2, 0], [3, 50_000]]);
    const due = previewDue([{ id: 1, preview_state: "ready" }, { id: 2, preview_state: "ready" }, { id: 3, preview_state: "pending" }], last, 130_000, 10);
    expect(due.map((r) => r.id)).toEqual([2, 1, 3]);
    expect(previewDue([{ id: 3, preview_state: "ready" }], last, 130_000, 10)).toEqual([]);
  });
});
