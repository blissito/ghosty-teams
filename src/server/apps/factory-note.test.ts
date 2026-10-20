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
const handoffs: { to: string; cause: string; text: string; opts?: Run }[] = [];
const relays: Run[] = [];
let roleMsgCount = 0;
const absorbCalls: { runId: number; keys: string[] }[] = [];
let steerOk = false;
const steers: string[] = [];
const consumed: number[] = [];
let activeSprint: { id: number; title: string } | null = null;
const sqlLog: { sql: string; args: unknown[] }[] = [];
const logged: { type: string; data: Run }[] = [];
let gate: { reason: string; waits: boolean } | null = null;
let livePreview: { state: string; url: string | null; sha: string | null; error: string | null } = { state: "none", url: null, sha: null, error: null };
let smokeResult: import("./factory-smoke.server").SmokeResult[] | null = null;
const whyCalls: { runId: number; opts: Run }[] = [];
let whyReply: Run | null = null;

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
  postRelay: (_r: Run, d: Run) => void relays.push(d),
  handoff: async (_r: Run, to: string, _s: string, cause: string, text: string, _o?: string, _g?: string, opts?: Run) => (handoffs.push({ to, cause, text, opts }), true),
  takeNotes: async () => "",
  reopenWithNotes: async (run: Run, _by: string, extra: string, _o: string, data: Run) => {
    applied.push({ event: "rework", patch: { merge_asked: null, loops: 0 }, data });
    handoffs.push({ to: "build", cause: "ampliar el PR", text: `MISMA rama${extra}` });
    return { ...run, status: "building" };
  },
  prConflicted: async () => null,
  prTouchesGithubDir: async () => false,
  ensurePrClosesIssue: async () => {},
  getPlan: async () => ({ planMd: "1. permiso de Marketer" }),
  MERGE_FROM_HINT: "",
  addNote: async (runId: number, by: string, text: string) => (notes.push({ runId, by, text }), 77),
  consumeNote: async (id: number) => void consumed.push(id),
  steerRole: async (_r: Run, _role: string, text: string) => (steers.push(text), steerOk),
  logEvent: async (_id: number, type: string, _a: string, data: Run) => void logged.push({ type, data }),
  prCi: async () => ({ state: "success", failed: [] }),
  markPrReady: async () => true,
  previewGate: async () => gate,
  previewRequired: async () => !!gate,
  runPreview: async () => livePreview,
  prFiles: async () => [],
  parsePrUrl: () => ({ repo: "o/r", number: 8 }),
  runCardFence: () => "",
  postRunCard: async () => 1,
  fetchRunWhy: async (runId: number, opts: Run) => (whyCalls.push({ runId, opts }), whyReply),
}));
vi.mock("./factory-smoke.server", async (orig) => ({
  ...(await orig<typeof import("./factory-smoke.server")>()),
  runActionSmoke: async () => smokeResult,
}));
vi.mock("./factory-shots.server", () => ({ captureVerdictShots: async () => {} }));
vi.mock("../connectors/github.server", () => ({ githubApi: async () => ({}) }));

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => (
    sqlLog.push({ sql, args }),
    sql.includes("type = 'role_msg'") ? [{ n: roleMsgCount }] : sql.includes("status = 'active'") && activeSprint ? [activeSprint] : []
  ),
}));
vi.mock("./sprint.server", () => ({
  validateSprintItems: (raw: any[]) => raw.map((i) => ({ key: i.key, title: i.title, size: i.size, dependsOn: [], bodyMd: i.title })),
  withPrepFirst: async (_s: string, _r: string, items: unknown[]) => items,
  getSprint: async (id: number) => (activeSprint && activeSprint.id === id ? { ...activeSprint, channelId: 3, status: "active" } : null),
  submitSprint: async () => ({ id: 9 }),
  absorbItems: async (runId: number, keys: string[]) => (
    absorbCalls.push({ runId, keys }), keys.filter((k) => k !== "Z").map((k) => ({ key: k, title: `Ticket ${k}`, bodyMd: `cuerpo ${k}` }))
  ),
}));

import { factoryTools, prMentions } from "./factory-tools.server";

const tool = async (name: string, dest: Record<string, unknown>) => (await factoryTools("beto", dest as never)).find((t) => t.name === name)!;

beforeEach(() => {
  current = null;
  head = "aaa";
  gate = null;
  livePreview = { state: "none", url: null, sha: null, error: null };
  smokeResult = null;
  whyCalls.length = 0;
  whyReply = null;
  byPr = [];
  applied.length = 0;
  sqlLog.length = 0;
  logged.length = 0;
  notes.length = 0;
  posted.length = 0;
  handoffs.length = 0;
  relays.length = 0;
  roleMsgCount = 0;
  absorbCalls.length = 0;
  steerOk = false;
  steers.length = 0;
  consumed.length = 0;
  activeSprint = null;
  for (const k of Object.keys(messages)) delete messages[Number(k)];
  for (const k of Object.keys(threads)) delete threads[Number(k)];
});

describe("factory_check_verdict: una vuelta cuenta sólo si el PR cambió", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  it("con la misma cabeza no suma vuelta", async () => {
    current = baseRun();
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, findings: "falta X", kind: "fix", reason: "falta X" });
    expect(applied[0]).toMatchObject({ event: "check_fail", patch: { loops: 1, checked_sha: "aaa" }, data: { counted: false } });
  });
  it("con una cabeza nueva sí", async () => {
    current = baseRun({ headSha: "bbb" });
    head = "bbb";
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, findings: "falta X", kind: "fix", reason: "falta X" });
    expect(applied[0]).toMatchObject({ patch: { loops: 2, checked_sha: "bbb" }, data: { counted: true } });
  });
});

// Alcance acotado tras un escalado (#115, 19-oct): @check revisa sólo eso y se borra con su veredicto.
describe("alcance de @check", () => {
  it("el encargo de revisar lo trae", async () => {
    current = baseRun({ status: "building", checkScope: "los 4 puntos del escalado" });
    await (await tool("factory_build_done", { channelId: 3, parentId: 99, handle: "build" })).handler("beto", {
      pr_url: "https://github.com/o/r/pull/8",
      tests: "vitest 120/120, typecheck ok",
    });
    const h = handoffs.find((x) => x.to === "check")!;
    expect(h.text).toContain("## Alcance de esta vuelta\nlos 4 puntos del escalado");
  });
  it("sin alcance no aparece", async () => {
    current = baseRun({ status: "building" });
    await (await tool("factory_build_done", { channelId: 3, parentId: 99, handle: "build" })).handler("beto", {
      pr_url: "https://github.com/o/r/pull/8",
      tests: "vitest 120/120, typecheck ok",
    });
    expect(handoffs.find((x) => x.to === "check")!.text).not.toContain("Alcance de esta vuelta");
  });
  it("el veredicto lo borra", async () => {
    current = baseRun({ checkScope: "los 4 puntos" });
    await (await tool("factory_check_verdict", { channelId: 3, parentId: 99, handle: "check" })).handler("beto", { pass: false, findings: "falta X", kind: "fix", reason: "falta X" });
    expect(applied[0].patch).toMatchObject({ check_scope: null });
  });
});

// La cabeza se movió durante la revisión (update-branch de la plataforma, «Correr CI»): antes se
// rechazaba siempre y @check se quedaba sin salida (palmera-legal #4, 3-oct).
describe("factory_check_verdict: la cabeza del PR se movió durante la revisión", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  it("con hallazgos (pass=false) se acepta: siguen valiendo", async () => {
    current = baseRun({ headSha: "aaa" });
    head = "ccc";
    const r: any = await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, findings: "falta X", kind: "fix", reason: "falta X" });
    expect(r.ok).not.toBe(false);
    expect(applied[0]).toMatchObject({ event: "check_fail" });
  });
  it("aprobar: fija la cabeza nueva y pide revisar sólo ese tramo", async () => {
    current = baseRun({ headSha: "aaa1111" });
    head = "ccc2222";
    const r: any = await (await tool("factory_check_verdict", dest)).handler("beto", { pass: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("aaa1111...ccc2222");
    expect(sqlLog.some((q) => q.sql.startsWith("UPDATE gt_factory_runs SET head_sha") && q.args[0] === "ccc2222")).toBe(true);
    expect(logged).toEqual([{ type: "head_moved", data: { from: "aaa1111", to: "ccc2222" } }]);
    expect(applied).toHaveLength(0);
  });
});

// El #96 (16-oct): @check aprobó «probado en la caja» con la preview exigida en `needs_env`.
describe("factory_check_verdict: puerta de la preview", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  it("preview exigida sin las variables: rechaza el pass y dice cómo escalar", async () => {
    current = baseRun();
    gate = { reason: "espera las variables del repo", waits: false };
    const r: any = await (await tool("factory_check_verdict", dest)).handler("beto", { pass: true, summary: "probado en la caja" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("kind=env");
    expect(r.error).toContain("no la sustituye");
    expect(applied).toHaveLength(0);
  });
  it("construyéndose: pide esperarla", async () => {
    current = baseRun();
    gate = { reason: "se está construyendo", waits: true };
    const r: any = await (await tool("factory_check_verdict", dest)).handler("beto", { pass: true });
    expect(r.error).toContain("espera a que esté lista");
    expect(applied).toHaveLength(0);
  });
  it("pass=false con blocked sigue entrando aunque falte la preview", async () => {
    current = baseRun();
    gate = { reason: "espera las variables del repo", waits: false };
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: false, blocked: true, findings: "faltan MONGO_URL y SESSION_SECRET", kind: "env", reason: "Faltan MONGO_URL y SESSION_SECRET" });
    expect(applied[0]).toMatchObject({ event: "check_blocked" });
  });
  it("preview lista pero el POST del smoke da 400: no hay pass", async () => {
    current = baseRun();
    livePreview = { state: "ready", url: "https://p.test/?k=x", sha: "aaa", error: null };
    smokeResult = [{ path: "/_root.data", method: "POST", status: 400, ok: false, why: "400: la app rechazó el envío (origen/CSRF)" }];
    const r: any = await (await tool("factory_check_verdict", dest)).handler("beto", { pass: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("POST /_root.data → 400");
    expect(applied).toHaveLength(0);
  });
  it("preview lista y smoke verde: aprueba y guarda el smoke en el veredicto", async () => {
    current = baseRun();
    livePreview = { state: "ready", url: "https://p.test/?k=x", sha: "aaa", error: null };
    smokeResult = [{ path: "/_root.data", method: "POST", status: 405, ok: true, why: "405: el envío pasó el chequeo de origen" }];
    await (await tool("factory_check_verdict", dest)).handler("beto", { pass: true, summary: "ok" });
    expect(applied[0]).toMatchObject({ event: "check_pass" });
    const saved = sqlLog.find((q) => q.sql.startsWith("UPDATE gt_factory_runs SET verdict_json"));
    expect(JSON.parse(String(saved?.args[0])).smoke[0].status).toBe(405);
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

describe("factory_note en vivo: @build a media obra recibe la nota en su turno", () => {
  const dest = { channelId: 3, parentId: 99, handle: "plan" };
  it("si el steer entra, la nota queda consumida", async () => {
    current = baseRun({ status: "building" });
    steerOk = true;
    const r: any = await (await tool("factory_note", dest)).handler("beto", { text: "sólo auth+domains+dns" });
    expect(r.ok).toBe(true);
    expect(steers[0]).toContain("sólo auth+domains+dns");
    expect(consumed).toEqual([77]);
  });
  it("sin turno vivo queda para el siguiente encargo", async () => {
    current = baseRun({ status: "building" });
    const r: any = await (await tool("factory_note", dest)).handler("beto", { text: "x y z" });
    expect(r.ok).toBe(true);
    expect(consumed).toHaveLength(0);
  });
  it("en checking no se le inyecta a nadie", async () => {
    current = baseRun({ status: "checking" });
    steerOk = true;
    await (await tool("factory_note", dest)).handler("beto", { text: "x y z" });
    expect(steers).toHaveLength(0);
  });
});

// @build ↔ @check se escriben (POC 8-oct): en vivo si el otro trabaja, si no lo despierta; en el
// hilo sólo queda la línea de relevo, nunca el texto.
describe("factory_message", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  it("en vivo: steer al otro rol + línea de relevo sin el texto", async () => {
    current = baseRun({ status: "checking" });
    steerOk = true;
    const r: any = await (await tool("factory_message", dest)).handler("beto", { to: "build", text: "¿el 404 es a propósito?" });
    expect(r).toMatchObject({ ok: true, delivered: "live" });
    expect(steers[0]).toContain("¿el 404 es a propósito?");
    expect(steers[0]).toContain('factory_message {to: "check"}');
    expect(relays).toEqual([{ from: "check", to: "build", kind: "message" }]);
    expect(logged).toEqual([{ type: "role_msg", data: { to: "build" } }]);
    expect(handoffs).toHaveLength(0);
  });
  it("sin turno vivo: lo despierta con un encargo `:msg` sin skills", async () => {
    current = baseRun({ status: "checking" });
    const r: any = await (await tool("factory_message", dest)).handler("beto", { to: "build", text: "duda" });
    expect(r).toMatchObject({ ok: true, delivered: "woken" });
    expect(handoffs[0]).toMatchObject({ to: "build", opts: { keySuffix: ":msg", skills: false } });
  });
  it("sólo entre @build y @check, y no a sí mismo", async () => {
    current = baseRun({ status: "checking" });
    expect(((await (await tool("factory_message", { ...dest, handle: "plan" })).handler("beto", { to: "build", text: "x" })) as any).ok).toBe(false);
    expect(((await (await tool("factory_message", dest)).handler("beto", { to: "check", text: "x" })) as any).ok).toBe(false);
  });
  it("tope de 6 por pedido y sentido", async () => {
    current = baseRun({ status: "checking" });
    roleMsgCount = 6;
    const r: any = await (await tool("factory_message", dest)).handler("beto", { to: "build", text: "otra" });
    expect(r.ok).toBe(false);
    expect(relays).toHaveLength(0);
  });
});

describe("factory_sprint_submit: no encima de otro activo", () => {
  const dest = { channelId: 3, parentId: 70, handle: "plan" };
  const items = ["A", "B", "C"].map((k) => ({ key: k, title: `Ticket largo ${k}`, size: "M", criteria: "criterios verificables de verdad" }));
  it("sin replaces se rechaza", async () => {
    activeSprint = { id: 3, title: "CLI viejo" };
    const r: any = await (await tool("factory_sprint_submit", dest)).handler("beto", { goal: "El CLI", title: "CLI de MailMask", items });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("replaces: 3");
  });
  it("con replaces pasa", async () => {
    activeSprint = { id: 3, title: "CLI viejo" };
    const r: any = await (await tool("factory_sprint_submit", dest)).handler("beto", { goal: "El CLI", title: "CLI de MailMask", items, replaces: 3 });
    expect(r.ok).toBe(true);
  });
});

describe("factory_run_review: el postmortem de un pedido", () => {
  const why = {
    healthy: false, category: "approved_unmet_criterion", incomplete: null, note: "🩺 …",
    why: {
      reasons: ["criterio «en la preview» sin preview"], category: "approved_unmet_criterion", impact: "high",
      summary: "Se aprobó sin la preview que el plan exigía.", criticalStep: { role: "check", at: null, command: null, evidence: "probado en la caja" },
      actions: [{ type: "role_rules", text: "@check no aprueba sin la preview exigida" }], source: "rules",
      acceptance: [{ criterion: "La reserva funciona en la preview" }],
    },
  };
  it("@plan lee el análisis completo del pedido del hilo", async () => {
    current = baseRun({ status: "done" });
    whyReply = why;
    const r: any = await (await tool("factory_run_review", { channelId: 3, parentId: 99, handle: "plan" })).handler("beto", {});
    expect(whyCalls).toEqual([{ runId: 10, opts: { full: true, refresh: false } }]);
    expect(r).toMatchObject({ ok: true, runId: 10, healthy: false, category: "approved_unmet_criterion", impact: "high", summary: "Se aprobó sin la preview que el plan exigía." });
    expect(r.acceptance).toHaveLength(1);
    expect(r.note).toContain("factory_suggest");
  });
  it("con refresh lo rehace; @check también puede", async () => {
    current = baseRun({ status: "done" });
    whyReply = { ...why, healthy: true, category: "none", note: null };
    const r: any = await (await tool("factory_run_review", { channelId: 3, parentId: 1, handle: "check" })).handler("beto", { runId: 10, refresh: true });
    expect(whyCalls[0].opts).toEqual({ full: true, refresh: true });
    expect(r.healthy).toBe(true);
  });
  it("@build no la usa", async () => {
    current = baseRun({ status: "done" });
    const r: any = await (await tool("factory_run_review", { channelId: 3, parentId: 99, handle: "build" })).handler("beto", {});
    expect(r.ok).toBe(false);
    expect(whyCalls).toHaveLength(0);
  });
  it("un pedido de un room que no ve no se analiza", async () => {
    current = baseRun({ channelId: 5, status: "done" });
    const r: any = await (await tool("factory_run_review", { channelId: 3, parentId: 1, handle: "plan" })).handler("beto", { runId: 10 });
    expect(r.ok).toBe(false);
    expect(whyCalls).toHaveLength(0);
  });
  it("si gs no contesta, lo dice", async () => {
    current = baseRun({ status: "done" });
    const r: any = await (await tool("factory_run_review", { channelId: 3, parentId: 99, handle: "plan" })).handler("beto", {});
    expect(r).toMatchObject({ ok: false });
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

// easybits (20-oct): cinco PRs de Dependabot escalaron «la preview no está lista» y la persona
// decidió sobre nada. Escalar exige tipo y motivo, y no se vale mientras la preview viene en camino.
describe("factory_check_verdict: escalado con tipo (easybits, 20-oct)", () => {
  const dest = { channelId: 3, parentId: 99, handle: "check" };
  const verdict = async (a: Record<string, unknown>) => (await tool("factory_check_verdict", dest)).handler("beto", a) as Promise<any>;

  it("blocked con la preview construyéndose: se rechaza y el pedido sigue en revisión", async () => {
    current = baseRun();
    livePreview = { state: "pending", url: null, sha: null, error: null };
    const r = await verdict({ pass: false, blocked: true, findings: "la preview no está lista", kind: "decision", reason: "La preview no llega" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no es un bloqueo");
    expect(applied).toHaveLength(0);
  });

  it("blocked con la preview esperando lugar: igual, espera", async () => {
    current = baseRun();
    livePreview = { state: "waiting", url: null, sha: null, error: "sin lugar: 2 pedidos en curso (#120, #121)" };
    const r = await verdict({ pass: false, blocked: true, findings: "sin preview", kind: "env", reason: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("#120");
    expect(applied).toHaveLength(0);
  });

  it("sin kind o sin reason no hay veredicto negativo; platform no lo elige @check", async () => {
    current = baseRun();
    expect((await verdict({ pass: false, blocked: true, findings: "falta X" })).error).toContain("falta kind");
    expect((await verdict({ pass: false, blocked: true, findings: "falta X", kind: "fix" })).error).toContain("falta reason");
    expect((await verdict({ pass: false, blocked: true, findings: "falta X", kind: "platform", reason: "x" })).error).toContain("lo pone la plataforma");
    expect(applied).toHaveLength(0);
  });

  it("kind=skip escala directo (sin blocked) y guarda kind y reason en el evento", async () => {
    current = baseRun({ kind: "dependabot", taskRef: "dependabot:major" });
    await verdict({ pass: false, findings: "- Vite 7 exige Node 20", kind: "skip", reason: "Vite 7 exige Node 20 y el deploy usa Node 18" });
    expect(applied[0]).toMatchObject({ event: "check_blocked", data: { kind: "skip", reason: "Vite 7 exige Node 20 y el deploy usa Node 18" } });
    expect(posted.at(-1)).toContain("No conviene este cambio");
  });

  it("kind=fix sin blocked se le regresa a @build (check_fail con kind y reason)", async () => {
    current = baseRun();
    await verdict({ pass: false, findings: "- tipo mal en a.ts:3", kind: "fix", reason: "Un tipo mal en a.ts" });
    expect(applied[0]).toMatchObject({ event: "check_fail", data: { kind: "fix", reason: "Un tipo mal en a.ts" } });
  });
});
