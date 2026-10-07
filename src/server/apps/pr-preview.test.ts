import { describe, it, expect, vi, beforeEach } from "vitest";

// «Levantar preview» para PRs sin pedido: sólo quien ve el room, sólo repos del room, nunca un
// PR de un pedido (su preview es automática) y respetando el apagado del repo.
let rooms = [5];
let roomRepos = ["acme/app"];
let runs: unknown[] = [];
let off = false;
let head: { sha: string; draft: boolean } | null = { sha: "abc123", draft: false };
const calls: { op: string; body: Record<string, unknown> }[] = [];
let reply: Record<string, unknown> = {};
// Respuesta de error de gs por op (status + body): simula el 409 `no_slot`.
let fail: Record<string, { status: number; body: any } | undefined> = {};
// gt_pr_preview_state en memoria (sólo las sentencias que usa pr-preview.server).
type Row = { repo: string; pr: number; state: string; requested_by: string | null; busy: string; at: number };
let table: Row[] = [];
let clock = 0;
let gh: Record<string, any> = {};

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: any[] = []) => {
    const same = (r: Row) => r.repo.toLowerCase() === String(args[0]).toLowerCase() && r.pr === args[1];
    if (sql.startsWith("SELECT * FROM gt_pr_preview_state WHERE state = 'waiting'"))
      return table.filter((r) => r.state === "waiting").sort((a, b) => a.at - b.at);
    if (sql.startsWith("SELECT")) return table.filter(same);
    if (sql.startsWith("DELETE")) return ((table = table.filter((r) => !same(r))), []);
    if (sql.startsWith("INSERT")) {
      const [repo, pr, state, requested_by, busy] = args;
      table.push({ repo, pr, state, requested_by, busy, at: ++clock });
      return [];
    }
    throw new Error(`sql no esperado: ${sql}`);
  },
}));
vi.mock("../connectors/github.server", () => ({
  allTools: () => [{ name: "github_get_pr", handler: async (_sub: string, a: any) => gh[`${a.repo}#${a.number}`] ?? { error: "404" } }],
}));

vi.mock("../../db.server", () => ({
  listChannels: async () => rooms.map((id) => ({ id })),
  listRoomRepos: async () => roomRepos.map((repo) => ({ repo, connectedBy: "x", createdAt: 0 })),
}));
vi.mock("./factory-runs.server", () => ({
  runsByPr: async () => runs,
  repoPreviewOff: async () => off,
  prHead: async () => head,
}));
vi.mock("./preview.server", () => ({
  gsPreview: async (op: string, body: Record<string, unknown>) => {
    calls.push({ op, body });
    const f = typeof fail[op] === "function" ? (fail[op] as any)(body) : fail[op];
    if (f) throw Object.assign(new Error(String(f.body?.error ?? "gs")), f);
    return reply[op];
  },
}));

import { prPreviewStatus, prPreviewUp, recordEvictedPreviews, retryWaitingPrPreviews } from "./pr-preview.server";

const me = { sub: "u1", isOwner: false };
const input = { channelId: 5, repo: "Acme/App", number: 7 };

beforeEach(() => {
  rooms = [5];
  roomRepos = ["acme/app"];
  runs = [];
  off = false;
  head = { sha: "abc123", draft: false };
  calls.length = 0;
  reply = {};
  fail = {};
  table = [];
  gh = {};
});

describe("prPreviewStatus", () => {
  it("sin caja: elegible y sin fase", async () => {
    reply.status = { status: null };
    expect(await prPreviewStatus(me, input)).toEqual({ eligible: true, phase: "none", url: null, error: null, sha: null });
    expect(calls).toEqual([{ op: "status", body: { repo: "Acme/App", pr: 7 } }]);
  });

  it("lista: devuelve la liga con llave", async () => {
    reply.status = { status: { phase: "ready", sha: "abc123", url: "https://p.example/?key=k", error: null } };
    const v = await prPreviewStatus(me, input);
    expect(v).toMatchObject({ eligible: true, phase: "ready", url: "https://p.example/?key=k" });
  });

  it("PR de un pedido: no elegible y no le pregunta a gs", async () => {
    runs = [{ id: 1 }];
    expect(await prPreviewStatus(me, input)).toEqual({ eligible: false, reason: "run" });
    expect(calls).toHaveLength(0);
  });

  it("repo fuera del room o preview apagada: no elegible", async () => {
    roomRepos = ["otro/repo"];
    expect(await prPreviewStatus(me, input)).toEqual({ eligible: false, reason: "repo" });
    roomRepos = ["acme/app"];
    off = true;
    expect(await prPreviewStatus(me, input)).toEqual({ eligible: false, reason: "off" });
  });

  it("no ve el room: lanza", async () => {
    rooms = [9];
    await expect(prPreviewStatus(me, input)).rejects.toThrow("no ves ese room");
  });
});

describe("prPreviewUp", () => {
  it("pide up con la cabeza del PR", async () => {
    reply.up = { phase: "installing", sha: "abc123", url: "https://p.example/?key=k", error: null };
    const v = await prPreviewUp(me, input);
    expect(calls).toEqual([{ op: "up", body: { repo: "Acme/App", pr: 7, sha: "abc123" } }]);
    // La liga sólo se enseña lista.
    expect(v).toMatchObject({ eligible: true, phase: "installing", url: null });
  });

  it("falla: una línea de error", async () => {
    reply.up = { phase: "failed", sha: "abc123", url: null, error: "falló el build (npm run build)\nlog…" };
    expect(await prPreviewUp(me, input)).toMatchObject({ phase: "failed", error: "falló el build (npm run build)" });
  });

  it("PR de un pedido o sin GitHub: no levanta nada", async () => {
    runs = [{ id: 1 }];
    await expect(prPreviewUp(me, input)).rejects.toThrow(/pedido/);
    runs = [];
    head = null;
    await expect(prPreviewUp(me, input)).rejects.toThrow(/GitHub/);
    expect(calls).toHaveLength(0);
  });
});

const NO_SLOT = { status: 409, body: { error: "no_slot", tier: "F1", max: 2, busy: [12, 15] } };

describe("lugares: sin lugar y soltadas", () => {
  it("409 no_slot: queda esperando con los pedidos que ocupan", async () => {
    fail.up = NO_SLOT;
    const v = await prPreviewUp(me, input);
    expect(v).toMatchObject({ eligible: true, phase: "waiting", busy: [12, 15], note: "Sin lugar: 2 pedidos en curso (#12, #15) · se levanta sola" });
    expect(table).toMatchObject([{ repo: "Acme/App", pr: 7, state: "waiting", requested_by: "u1", busy: "[12,15]" }]);
    // gs sin caja + fila waiting → el estado dice esperando
    reply.status = { status: null };
    expect(await prPreviewStatus(me, input)).toMatchObject({ phase: "waiting", busy: [12, 15] });
  });

  it("otro error de gs: lanza y no anota nada", async () => {
    fail.up = { status: 500, body: { error: "boom" } };
    await expect(prPreviewUp(me, input)).rejects.toThrow("boom");
    expect(table).toHaveLength(0);
  });

  it("éxito: borra la fila y anota las previews soltadas", async () => {
    table.push({ repo: "acme/app", pr: 7, state: "waiting", requested_by: "u1", busy: "[1]", at: 0 });
    reply.up = { phase: "creating", sha: "abc123", evicted: [{ repo: "acme/app", pr: 3 }] };
    expect(await prPreviewUp(me, input)).toMatchObject({ phase: "creating" });
    expect(table).toMatchObject([{ repo: "acme/app", pr: 3, state: "evicted" }]);
  });

  it("soltada: el estado lo dice con la nota (si gs ya no tiene caja)", async () => {
    await recordEvictedPreviews([{ repo: "Acme/App", pr: 7 }, { repo: "", pr: 0 } as any]);
    expect(table).toHaveLength(1);
    reply.status = { status: null };
    expect(await prPreviewStatus(me, input)).toEqual({
      eligible: true,
      phase: "evicted",
      url: null,
      error: null,
      sha: null,
      note: "Se soltó para dar lugar a un pedido u otra preview",
    });
    // Si gs sí tiene caja, manda gs.
    reply.status = { status: { phase: "ready", url: "https://p/?key=k" } };
    expect(await prPreviewStatus(me, input)).toMatchObject({ phase: "ready" });
  });
});

describe("retryWaitingPrPreviews", () => {
  const wait = (repo: string, pr: number, at: number, by: string | null = "u1") =>
    table.push({ repo, pr, state: "waiting", requested_by: by, busy: "[]", at });

  it("la más vieja primero; se detiene en la primera que sigue sin lugar", async () => {
    wait("acme/app", 2, 1);
    wait("acme/app", 3, 2);
    gh = { "acme/app#2": { state: "open", headSha: "s2" }, "acme/app#3": { state: "open", headSha: "s3" } };
    fail.up = NO_SLOT;
    await retryWaitingPrPreviews();
    expect(calls).toEqual([{ op: "up", body: { repo: "acme/app", pr: 2, sha: "s2" } }]);
    expect(table.map((r) => r.state)).toEqual(["waiting", "waiting"]);
  });

  it("con lugar: levanta y limpia; sigue con la siguiente", async () => {
    wait("acme/app", 2, 1);
    wait("acme/app", 3, 2);
    gh = { "acme/app#2": { state: "open", headSha: "s2" }, "acme/app#3": { state: "open", headSha: "s3" } };
    reply.up = { phase: "creating" };
    await retryWaitingPrPreviews();
    expect(calls.map((c) => c.body.pr)).toEqual([2, 3]);
    expect(table).toHaveLength(0);
  });

  it("PR cerrado o mezclado: se olvida sin pedir nada a gs", async () => {
    wait("acme/app", 2, 1);
    wait("acme/app", 3, 2);
    gh = { "acme/app#2": { state: "closed", headSha: "s2" }, "acme/app#3": { state: "open", merged: true, headSha: "s3" } };
    await retryWaitingPrPreviews();
    expect(calls).toHaveLength(0);
    expect(table).toHaveLength(0);
  });

  it("GitHub no contesta: la deja para el siguiente tick", async () => {
    wait("acme/app", 2, 1);
    await retryWaitingPrPreviews();
    expect(calls).toHaveLength(0);
    expect(table).toHaveLength(1);
  });
});
