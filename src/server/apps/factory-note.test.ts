import { describe, it, expect, vi, beforeEach } from "vitest";

// Vueltas justas y notas que llegan a su pedido (pedido #10, 01-oct): el veredicto de @check
// sólo gasta vuelta si el PR cambió, y una nota desde el hilo del PR llega al pedido.
type Run = Record<string, any>;
const baseRun = (over: Run = {}): Run => ({
  id: 10, channelId: 3, rootMsgId: 99, topic: "general", title: "Docs", status: "checking", planVersion: 1, loops: 1,
  repo: "o/r", branch: "b", prUrl: "https://github.com/o/r/pull/8", headSha: "aaa", taskRef: null,
  requestedBy: "ana", approvedBy: "beto", checkedSha: "aaa", ...over,
});
let current: Run | null = null;
let head = "aaa";
let byPr: Run[] = [];
const applied: { event: string; patch: Run; data: Run }[] = [];
const notes: { runId: number; by: string; text: string }[] = [];
const posted: string[] = [];
const messages: Record<number, { body: string }> = {};
const threads: Record<number, { body: string }[]> = {};
const handoffs: { to: string; cause: string; text: string }[] = [];
const absorbCalls: { runId: number; keys: string[] }[] = [];

vi.mock("./installed.server", () => ({ isInstalled: async () => true }));
vi.mock("../hooks/generic-alert.server", () => ({ alertWebhookTools: () => [] }));
vi.mock("./uptime.server", () => ({ uptimeTools: () => [] }));
vi.mock("./factory-evals.server", () => ({ evalMeta: async () => null }));
vi.mock("../../origin.server", () => ({ reqOrigin: async () => "https://x.test" }));
vi.mock("../../db.server", () => ({
  getMessage: async (id: number) => messages[id] ?? null,
  listThread: async (id: number) => threads[id] ?? [],
  listRoomRepos: async () => [{ repo: "o/r" }],
  listChannels: async () => [{ id: 3 }, { id: 4 }],
  getChannelById: async (id: number) => ({ id, slug: `room${id}` }),
}));
vi.mock("./factory-runs.server", () => ({
  getRun: async (id: number) => (current && current.id === id ? current : null),
  runOfThread: async (_c: number, root: number) => (current && current.rootMsgId === root ? current : null),
  runsByPr: async (repo: string, n: number) => byPr.filter((r) => r.prUrl.includes(`${repo}/pull/${n}`)),
  prHead: async () => ({ sha: head, draft: true }),
  lastFailUncounted: async () => false,
  applyEvent: async (run: Run, event: string, patch: Run, meta: { data: Run }) => {
    applied.push({ event, patch, data: meta.data });
    return { ...run, ...patch, status: "building" };
  },
  postInThread: async (_r: Run, _h: string, body: string) => (posted.push(body), 1),
  handoff: async (_r: Run, to: string, _s: string, cause: string, text: string) => (handoffs.push({ to, cause, text }), true),
  takeNotes: async () => "",
  prConflicted: async () => null,
  MERGE_FROM_HINT: "",
  addNote: async (runId: number, by: string, text: string) => void notes.push({ runId, by, text }),
}));

vi.mock("./sprint.server", () => ({
  absorbItems: async (runId: number, keys: string[]) => (
    absorbCalls.push({ runId, keys }), keys.filter((k) => k !== "Z").map((k) => ({ key: k, title: `Ticket ${k}`, bodyMd: `cuerpo ${k}` }))
  ),
}));

import { factoryTools, prMentions } from "./factory-tools.server";

const tool = async (name: string, dest: Record<string, unknown>) => (await factoryTools("beto", dest as never)).find((t) => t.name === name)!;

beforeEach(() => {
  current = null;
  head = "aaa";
  byPr = [];
  applied.length = 0;
  notes.length = 0;
  posted.length = 0;
  handoffs.length = 0;
  absorbCalls.length = 0;
  for (const k of Object.keys(messages)) delete messages[Number(k)];
  for (const k of Object.keys(threads)) delete threads[Number(k)];
});

describe("factory_check_verdict: una vuelta cuenta sólo si el PR cambió", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  it("con la misma cabeza no suma vuelta", async () => {
    current = baseRun();
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, findings: "falta X" });
    expect(applied[0]).toMatchObject({ event: "check_fail", patch: { loops: 1, checked_sha: "aaa" }, data: { counted: false } });
  });
  it("con una cabeza nueva sí", async () => {
    current = baseRun({ headSha: "bbb" });
    head = "bbb";
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, findings: "falta X" });
    expect(applied[0]).toMatchObject({ patch: { loops: 2, checked_sha: "bbb" }, data: { counted: true } });
  });
});

describe("factory_note", () => {
  it("desde el hilo de la tarjeta del PR llega a su pedido", async () => {
    byPr = [baseRun({ channelId: 4, status: "escalated" })];
    messages[50] = {
      body: '```gt-gh\n{"kind":"pr","repo":"o/r","ref":"8","title":"Docs","url":"https://github.com/o/r/pull/8","state":"open","author":"x"}\n```',
    };
    const r: any = await (await tool("factory_note", { channelId: 3, parentId: 50, handle: "check" })).handler("beto", { text: "faltan los docs del CLI" });
    expect(r.ok).toBe(true);
    expect(notes).toEqual([{ runId: 10, by: "@check", text: "faltan los docs del CLI" }]);
    expect(posted[0]).toContain("📝 Nota de @check desde otro hilo");
    expect(posted[0]).toContain("/c/room3?thread=50");
  });
  it("sin pedido se rechaza", async () => {
    messages[51] = { body: "hola, ¿cómo va todo?" };
    const r: any = await (await tool("factory_note", { channelId: 3, parentId: 51, handle: "check" })).handler("beto", { text: "algo" });
    expect(r.ok).toBe(false);
    expect(notes).toHaveLength(0);
  });
});

describe("factory_note: el PR por número y el PR listo que se reabre (MailMask, 4-oct)", () => {
  const dest = { channelId: 3, parentId: 60, handle: "plan" };
  it("encuentra el pedido por un «PR #8» que sólo dijo un agente en el hilo", async () => {
    byPr = [baseRun({ status: "building" })];
    messages[60] = { body: "¿qué tenemos pendiente para el cli?" };
    threads[60] = [{ body: "PR #8 (ticket A) sigue abierto en vuelta 3" }, { body: "no, quiero que expandas el pr existente" }];
    const r: any = await (await tool("factory_note", dest)).handler("beto", { text: "mete B–H" });
    expect(r.ok).toBe(true);
    expect(notes[0]).toMatchObject({ runId: 10 });
  });
  it("con `pr` va al pedido dueño del PR, no al pedido con ese número", async () => {
    byPr = [baseRun({ id: 10, status: "building" })];
    current = baseRun({ id: 8, status: "done", prUrl: "https://github.com/o/r/pull/3" });
    const r: any = await (await tool("factory_note", dest)).handler("beto", { pr: "#8", text: "mete B–H" });
    expect(r).toMatchObject({ ok: true, runId: 10 });
  });
  it("un PR listo se reabre, se le encarga a @build en la misma rama y absorbe los tickets", async () => {
    byPr = [baseRun({ status: "pr_review", loops: 3 })];
    const r: any = await (await tool("factory_note", dest)).handler("beto", { pr: "https://github.com/o/r/pull/8", text: "mete lo que falta", absorbs: ["B", "C", "Z"] });
    expect(r).toMatchObject({ ok: true, status: "building", absorbed: ["B", "C"] });
    expect(applied[0]).toMatchObject({ event: "rework", patch: { merge_asked: null, loops: 0 } });
    expect(absorbCalls).toEqual([{ runId: 10, keys: ["B", "C", "Z"] }]);
    expect(handoffs[0].to).toBe("build");
    expect(handoffs[0].text).toContain("MISMA rama");
    expect(handoffs[0].text).toContain("## Ticket B: Ticket B");
  });
  it("un PR desconocido falla con ok:false", async () => {
    const r: any = await (await tool("factory_note", dest)).handler("beto", { pr: "99", text: "x" });
    expect(r.ok).toBe(false);
    expect(notes).toHaveLength(0);
  });
});

describe("prMentions", () => {
  it("URL completa y #N suelto", () => {
    expect(prMentions("mira https://github.com/o/r/pull/8 y #12, no a#3")).toEqual([
      { repo: "o/r", number: 8 },
      { repo: null, number: 12 },
    ]);
  });
});
