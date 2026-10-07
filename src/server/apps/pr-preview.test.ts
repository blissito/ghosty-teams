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
  gsPreview: async (op: string, body: Record<string, unknown>) => (calls.push({ op, body }), reply[op]),
}));

import { prPreviewStatus, prPreviewUp } from "./pr-preview.server";

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
