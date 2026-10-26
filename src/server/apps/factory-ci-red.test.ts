import { describe, it, expect, vi, beforeEach } from "vitest";

// Lo que regresa solo a @build sin que nadie pique nada: el CI en rojo del PR (`onPrCiRed`) y lo
// que piden en GitHub con @ghosty (`noteFromGithub`). MailMask #8, 4-oct.
const sqls: { sql: string; args: unknown[] }[] = [];
const posts: string[] = [];
const wakeups: { key: string; text: string }[] = [];
let ciRedPrev: { sha: string | null }[] = [];
let origin = "https://business.teams.ghosty.studio";
let notes: { id: number; by: string; text: string }[] = [];
let current = "building";
// `claimKey` de las automatizaciones: la ventana de 90 s que junta una review en una sola nota.
const claims = new Set<string>();
let flakyKnown = false;
let behindPrev: { sha?: string; auto?: boolean }[] = [];
let updateBranch: { ok?: boolean; error?: string; conflict?: boolean } = { ok: true };
const updateCalls: unknown[] = [];

const row = (status: string) => ({ id: 10, channel_id: 14, root_msg_id: 3970, topic: "general", title: "CLI", status, plan_version: 1, loops: 0, requested_by: "ana", approved_by: "beto", pr_url: "https://github.com/o/r/pull/8" });

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql === "SELECT * FROM gt_factory_runs WHERE id = ?") return [row(current)];
    if (sql.startsWith("INSERT INTO gt_automation_claims")) {
      const k = `${args[0]}|${args[1]}`;
      if (claims.has(k)) return [];
      claims.add(k);
      return [{ kind: args[0] }];
    }
    if (sql.includes("type = 'ci_red' ORDER BY")) return ciRedPrev.map((p) => ({ data_json: JSON.stringify(p) }));
    if (sql.includes("FROM gt_agent_wakeups")) return origin ? [{ origin }] : [];
    // Historial del «CI doctor»: el run 77 es de «Tests», marcado flaky 3 veces con issue #12.
    if (sql.includes("FROM gt_ci_runs") && sql.includes("run_id IN")) return flakyKnown ? [{ run_id: 77, workflow: "Tests" }] : [];
    if (sql.includes("COUNT(*) AS n FROM gt_ci_runs")) return [{ n: flakyKnown ? 3 : 0 }];
    if (sql.includes("FROM gt_ci_flaky_issues")) return flakyKnown ? [{ number: 12 }] : [];
    if (sql.includes("type = 'behind_main'")) return behindPrev.map((p) => ({ data_json: JSON.stringify(p) }));
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) return [row(String(args[0]))];
    if (sql.startsWith("INSERT INTO gt_factory_notes")) {
      notes.push({ id: notes.length + 1, text: String(args[1]), by: String(args[2]) });
      return [{ id: notes.length }];
    }
    // `takeNotes`: las pendientes viajan en el encargo.
    if (sql.startsWith("UPDATE gt_factory_notes")) return notes.splice(0);
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 14, slug: "mailmask" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _p: number, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
}));
const pushes: { recipients: string[]; body: string }[] = [];
vi.mock("../notify.server", () => ({ notify: async (ev: { recipients: string[]; body: string }) => void pushes.push(ev) }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));
vi.mock("../../agents.server", () => ({
  resolvedAgents: async () => [{ handle: "build", name: "Build", avatar: "", backend: { kind: "other" } }, { handle: "plan", name: "Plan", avatar: "" }],
  agentGroupId: async () => "g",
}));
vi.mock("../wakeups.server", () => ({
  enqueueWakeup: async (w: { key: string; text: string }) => (wakeups.push(w), true),
  mintWakeRef: () => "ref",
  kickWakeups: () => {},
  armWakeups: () => {},
}));
vi.mock("../connectors/github.server", () => ({
  ackGithubComment: async () => true,
  githubApi: async () => ({ error: "sin red en la prueba" }),
  allTools: () => [{ name: "github_update_branch", handler: async (_s: string, a: unknown) => (updateCalls.push(a), updateBranch) }],
}));

import { onPrCiRed, onPrBehind, noteFromGithub, asksPerson, afterFactoryTurn, type Run } from "./factory-runs.server";

const run = (status: Run["status"]): Run => ({
  id: 10, channelId: 14, rootMsgId: 3970, topic: "general", title: "CLI", status, planVersion: 1, loops: 0,
  repo: "o/r", branch: null, prUrl: "https://github.com/o/r/pull/8", headSha: null, taskRef: null, requestedBy: "ana", approvedBy: "beto",
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const events = () => sqls.filter((s) => s.sql.startsWith("INSERT INTO gt_factory_events")).map((s) => s.args[2]);

beforeEach(() => {
  sqls.length = 0;
  posts.length = 0;
  wakeups.length = 0;
  ciRedPrev = [];
  notes = [];
  claims.clear();
  current = "building";
  origin = "https://business.teams.ghosty.studio";
  flakyKnown = false;
  behindPrev = [];
  updateBranch = { ok: true };
  updateCalls.length = 0;
});

describe("CI en rojo en la etapa PR", () => {
  it("primera vez con esa cabeza: se lo regresa a @build con qué falló", async () => {
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    await flush();
    expect(events()).toEqual(expect.arrayContaining(["ci_red", "note", "rework"]));
    expect(posts.some((p) => p.includes("🔧") && p.includes("verify"))).toBe(true);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].text).toContain("github_workflow_run_logs");
  });

  it("misma cabeza otra vez: no repite", async () => {
    ciRedPrev = [{ sha: "abc" }];
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    expect(events()).toEqual([]);
    expect(wakeups).toHaveLength(0);
  });

  it("tercera vuelta: lo ve una persona y no se reabre", async () => {
    ciRedPrev = [{ sha: "b" }, { sha: "a" }];
    await onPrCiRed(run("pr_review"), "c", ["verify"]);
    await flush();
    expect(events()).toEqual(["ci_red_help"]);
    expect(posts.some((p) => p.startsWith("⚠️"))).toBe(true);
    expect(wakeups).toHaveLength(0);
  });

  it("sin origen para el encargo: avisa en vez de quedarse callado", async () => {
    origin = "";
    await onPrCiRed(run("pr_review"), "abc", ["verify"]);
    expect(events()).toEqual(["ci_red_help"]);
  });
});

describe("CI rojo con un workflow flaky conocido", () => {
  const checks = [{ name: "unit", state: "failure" as const, seconds: 30, url: "https://github.com/o/r/actions/runs/77/job/9" }];

  it("la nota a @build pide reintentar antes de tocar código, con la liga al issue agrupado", async () => {
    flakyKnown = true;
    await onPrCiRed(run("pr_review"), "abc", ["unit"], { checks });
    await flush();
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].text).toContain("ya está marcado flaky");
    expect(wakeups[0].text).toContain("github_rerun_workflow");
    expect(wakeups[0].text).toContain("https://github.com/o/r/issues/12");
    expect(posts.some((p) => p.includes("🔧") && p.includes("«Tests»") && p.includes("reintentarlo"))).toBe(true);
  });

  it("sin historial flaky: el encargo queda como siempre", async () => {
    await onPrCiRed(run("pr_review"), "abc", ["unit"], { checks });
    await flush();
    expect(wakeups[0].text).not.toContain("flaky");
    expect(posts.find((p) => p.includes("🔧"))).toBe("🔧 El CI del PR falló (unit): se lo regresé a @build.");
  });
});

describe("PR de un fork", () => {
  it("CI rojo: no se le regresa a @build (no puede empujar); lo ve una persona una vez", async () => {
    await onPrCiRed(run("pr_review"), "abc", ["unit"], { fork: "ana/r" });
    expect(events()).toEqual(["ci_red_help"]);
    expect(wakeups).toHaveLength(0);
    expect(posts.some((p) => p.includes("fork") && p.includes("ana/r"))).toBe(true);
  });
});

describe("PR atrás de su base («behind»)", () => {
  it("se pone al día solo, una vez por cabeza, y se vuelve a ofrecer el merge", async () => {
    await onPrBehind(run("pr_review"), "abc");
    expect(updateCalls).toEqual([{ repo: "o/r", number: 8 }]);
    expect(events()).toEqual(["behind_main"]);
    expect(sqls.some((q) => q.sql.includes("merge_asked = NULL"))).toBe(true);
    expect(posts.some((p) => p.startsWith("🔄"))).toBe(true);
    behindPrev = [{ sha: "abc", auto: true }];
    updateCalls.length = 0;
    await onPrBehind(run("pr_review"), "abc");
    expect(updateCalls).toHaveLength(0);
  });

  it("tope de 5 puestas al día automáticas por pedido", async () => {
    behindPrev = [1, 2, 3, 4, 5].map((i) => ({ sha: `s${i}`, auto: true }));
    await onPrBehind(run("pr_review"), "nuevo");
    expect(updateCalls).toHaveLength(0);
  });

  it("si choca, es un conflicto: va a @build con el merge de la principal", async () => {
    updateBranch = { error: "Conflicto: …", conflict: true };
    await onPrBehind(run("pr_review"), "abc");
    await flush();
    expect(events()).toEqual(expect.arrayContaining(["behind_main"]));
    expect(wakeups.some((w) => w.text.includes("mergeFrom"))).toBe(true);
  });
});

describe("pedido desde GitHub (@ghosty)", () => {
  const ask = { text: "@ghosty quita el código prellenado", url: "https://github.com/o/r/pull/8#issuecomment-1" };

  it("PR listo: se reabre, se cuenta en el hilo con la liga y @build sabe dónde contestar", async () => {
    expect(await noteFromGithub(run("pr_review"), "bliss", ask)).toBe("reopened");
    await flush();
    expect(posts.some((p) => p.includes("💬 @bliss en GitHub") && p.includes(ask.url))).toBe(true);
    expect(wakeups[0].text).toContain("github_comment");
  });

  it("comentario en línea: @build contesta en ese hilo", async () => {
    await noteFromGithub(run("pr_review"), "bliss", { ...ask, path: "cli/a.ts", line: 3 });
    expect(wakeups[0].text).toContain("github_reply_review_comment");
    expect(wakeups[0].text).toContain("cli/a.ts:3");
  });

  it("comentario en línea: pide resolver el hilo sólo si quedó arreglado", async () => {
    await noteFromGithub(run("pr_review"), "bliss", { ...ask, path: "cli/a.ts", line: 3 });
    expect(wakeups[0].text).toContain("github_resolve_review_thread SÓLO si lo arreglaste");
    expect(wakeups[0].text).toContain("github_pr_review_threads");
  });

  it("comentario de la conversación del PR: sin hilos que resolver", async () => {
    await noteFromGithub(run("pr_review"), "bliss", ask);
    expect(wakeups[0].text).not.toContain("github_resolve_review_thread");
  });

  it("una review con 3 comentarios en línea es UNA nota a @build; los demás sólo se cuentan en el hilo", async () => {
    const r = run("pr_review");
    const got = [
      await noteFromGithub(r, "bliss", { ...ask, path: "a.ts", line: 1, kind: "review_comment" }),
      await noteFromGithub(r, "bliss", { ...ask, path: "b.ts", line: 2, kind: "review_comment" }),
      await noteFromGithub(r, "bliss", { ...ask, text: "Pidió cambios", kind: "review" }),
    ];
    expect(got).toEqual(["reopened", "batched", "batched"]);
    expect(wakeups).toHaveLength(1);
    expect(notes).toHaveLength(0);
    expect(sqls.filter((x) => x.sql.startsWith("INSERT INTO gt_factory_notes"))).toHaveLength(1);
    expect(events()).toContain("note_batched");
    expect(posts.filter((p) => p.startsWith("💬"))).toHaveLength(3);
  });

  it("otro pedido no comparte la ventana", async () => {
    await noteFromGithub(run("pr_review"), "bliss", { ...ask, path: "a.ts", kind: "review_comment" });
    const other = { ...run("pr_review"), id: 11 };
    expect(await noteFromGithub(other, "bliss", { ...ask, path: "a.ts", kind: "review_comment" })).not.toBe("batched");
  });

  it("en revisión: queda para su siguiente encargo, sin despertar a nadie", async () => {
    expect(await noteFromGithub(run("checking"), "bliss", ask)).toBe("queued");
    expect(wakeups).toHaveLength(0);
    expect(events()).toContain("note");
  });

  it("pedido terminado: no hace nada", async () => {
    expect(await noteFromGithub(run("done"), "bliss", ask)).toBe("closed");
    expect(sqls).toHaveLength(0);
  });
});

// @build pidió los datos del equipo y salió «terminó dos veces sin cerrar su paso» (palmera-legal, 4-oct).
describe("el rol le pregunta algo a la persona", () => {
  it("asksPerson: pregunta al final o gt-ask sí; un ? en código o una afirmación no", () => {
    expect(asksPerson("Armé el esqueleto.\n\n¿Me pasas los nombres del equipo?")).toBe(true);
    expect(asksPerson("Necesito un dato:\n```gt-ask\n{}\n```")).toBe(true);
    expect(asksPerson("Listo, PR abierto.\n\n```ts\nconst x = a ? b : c?\n```")).toBe(false);
    expect(asksPerson("¿Quedó? Sí: PR abierto y pruebas en verde.")).toBe(false);
  });

  it("afterFactoryTurn con pregunta: espera, sin empujón ni alarma", async () => {
    const w = { key: "factory:10:build:1", ref: "r", origin: "o" };
    await afterFactoryTurn(w, { sub: "ana" }, "Me faltan datos.\n\n¿Quiénes son los socios del despacho?");
    await flush();
    expect(events()).toEqual(["waiting_person"]);
    expect(wakeups).toHaveLength(0);
    expect(posts).toHaveLength(0);
    // …y le llega push a quien pidió.
    expect(pushes.at(-1)).toMatchObject({ recipients: ["ana"], body: expect.stringContaining("@build te hizo una pregunta") });
  });

  it("sin pregunta: el empujón de siempre", async () => {
    await afterFactoryTurn({ key: "factory:10:build:1", ref: "r", origin: "o" }, { sub: "ana" }, "Listo, ya quedó.");
    expect(events()).not.toContain("waiting_person");
    expect(wakeups.some((x) => x.key.endsWith(":nudge"))).toBe(true);
  });
});
