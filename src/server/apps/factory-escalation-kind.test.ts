import { describe, it, expect, vi, beforeEach } from "vitest";

// El escalado con tipo (easybits, 20-oct): «Te toca 8» y ocho tarjetas sin decir qué decidir. 5 eran
// la misma falla de la plataforma (la preview nunca salió de `pending`) y 3 decisiones reales:
// cerrar e ignorar un major (#129), un arreglo de una línea (#128) y subir los hermanos del grupo
// (#132). Cada escalado lleva tipo, motivo y botones; `needsYou` es la regla que gs replica.
type Row = Record<string, any>;
let runRow: Row = {};
let events: { type: string; data_json: string | null; at: number }[] = [];
const gh: { path: string; init?: { method?: string; body?: string } }[] = [];
let ghReply: (path: string, init?: any) => any = () => ({});
let roomRepos: { repo: string; connectedBy: string }[] = [];
let liveDependabot = 0;
const adoptedInserts: unknown[][] = [];
const posts: string[] = [];

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: any[] = []) => {
    if (sql.startsWith("SELECT data_json, at FROM gt_factory_events")) {
      const ev = events.filter((e) => e.type === "check_blocked" || e.type === "check_fail").at(-1);
      return ev ? [ev] : [];
    }
    if (sql.startsWith("UPDATE gt_factory_runs SET status = ?")) {
      if (runRow.status !== args.at(-2)) return [];
      runRow.status = args[0];
      return [{ ...runRow }];
    }
    if (sql.startsWith("INSERT INTO gt_factory_events")) {
      events.push({ type: String(args[2]), data_json: args[3] ?? null, at: 1 });
      return [];
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM gt_factory_runs WHERE kind = 'dependabot'")) return [{ n: liveDependabot }];
    if (sql.startsWith("INSERT INTO gt_factory_runs")) {
      adoptedInserts.push(args);
      return [{ id: 200 }];
    }
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "fabrica" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async (_c: number, _r: number | null, body: string) => (posts.push(body), { id: posts.length }),
  getMessage: async () => null,
  listRoomRepos: async () => roomRepos,
  notifyRoomsOfRepo: async () => [5],
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [], agentGroupId: async () => "g" }));
vi.mock("./installed.server", () => ({ isInstalled: async () => true }));
vi.mock("../connectors/github.server", () => ({
  githubApi: async (_sub: string, path: string, init?: any) => (gh.push({ path, init }), ghReply(path, init)),
  allTools: () => [],
}));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sin red"); }));

import { deduceEscalationKind, isGithubRateLimit, needsYou, rateLimitReason, viewState } from "./factory-flow";
import { closeRunPr, dependabotIgnoreComment, escalateRateLimit, escalationFromEvent, escalationOf, rateLimitRetryAt, turnNoticeBody, type Run } from "./factory-runs.server";
import { adoptDependabotPr, DEPENDABOT_LIVE_CAP } from "./dependabot.server";

const run = (over: Partial<Run> = {}): Run => ({
  id: 129, channelId: 5, rootMsgId: 900, topic: "general", title: "Bump vite from 6 to 7", status: "escalated", planVersion: 0, loops: 0,
  repo: "blissito/easybits", branch: "dependabot/npm/vite-7", prUrl: "https://github.com/blissito/easybits/pull/129", headSha: null, taskRef: "dependabot:major",
  requestedBy: "bliss", approvedBy: "bliss", kind: "dependabot", ...over,
});

beforeEach(() => {
  events = [];
  gh.length = 0;
  ghReply = () => ({});
  roomRepos = [{ repo: "blissito/easybits", connectedBy: "quien-conecto" }];
  liveDependabot = 0;
  adoptedInserts.length = 0;
  posts.length = 0;
  runRow = { id: 129, channel_id: 5, root_msg_id: 900, topic: "general", title: "Bump vite", status: "escalated", plan_version: 0, loops: 0, requested_by: "bliss" };
});

describe("escalationOf con tipo (easybits, 20-oct)", () => {
  it("un escalado nuevo trae kind, reason, puntos y acciones", async () => {
    events.push({
      type: "check_blocked",
      data_json: JSON.stringify({ kind: "skip", reason: "Vite 7 exige Node 20 y el deploy usa Node 18", findings: "- Vite 7 quita Node 18\n- el Dockerfile usa node:18" }),
      at: 1700,
    });
    expect(await escalationOf(run())).toEqual({
      kind: "skip",
      reason: "Vite 7 exige Node 20 y el deploy usa Node 18",
      points: ["Vite 7 quita Node 18", "el Dockerfile usa node:18"],
      findings: "- Vite 7 quita Node 18\n- el Dockerfile usa node:18",
      at: 1700,
      actions: ["close", "close_ignore", "fix"],
    });
  });

  it("sin escalar no hay escalado", async () => {
    expect(await escalationOf(run({ status: "checking" }))).toBeNull();
  });

  it("escalados viejos sin kind: se deduce (variables → env, preview pendiente → platform, si no decision)", () => {
    // Los hallazgos reales de los runs #127–#134, recortados.
    expect(deduceEscalationKind("La preview sigue en pending después de 20 min; factory_preview no da URL.")).toBe("platform");
    expect(deduceEscalationKind("Faltan las variables DATABASE_URL y SESSION_SECRET para levantar la preview.")).toBe("env");
    expect(deduceEscalationKind("- `STRIPE_SECRET_KEY` no está definida")).toBe("env");
    expect(deduceEscalationKind("@aws-sdk/client-s3 3.9 exige subir @aws-sdk/s3-request-presigner a la misma versión.")).toBe("decision");
    const legacy = escalationFromEvent({ findings: "- La preview está pending y nunca llegó\n- no pude probar el formulario" }, 10)!;
    expect(legacy.kind).toBe("platform");
    expect(legacy.actions).toEqual(["retry_preview", "recheck"]);
    expect(legacy.reason).toBe("La preview está pending y nunca llegó");
  });

  it("el motivo se recorta a un renglón de 140", () => {
    const e = escalationFromEvent({ kind: "decision", findings: "x", reason: "a".repeat(300) }, 1)!;
    expect(e.reason.length).toBeLessThanOrEqual(140);
  });
});

describe("needsYou: la regla que gs replica", () => {
  it("firmar un plan te toca; un escalado sí salvo platform; un PR listo sí salvo que entre solo", () => {
    expect(needsYou({ status: "plan_review" }, null)).toBe(true);
    expect(needsYou({ status: "escalated" }, { kind: "decision" })).toBe(true);
    expect(needsYou({ status: "escalated" }, { kind: "env" })).toBe(true);
    expect(needsYou({ status: "escalated" }, { kind: "platform" })).toBe(false);
    expect(needsYou({ status: "escalated" }, null)).toBe(true);
    expect(needsYou({ status: "pr_review" }, null)).toBe(true);
    expect(needsYou({ status: "pr_review" }, null, { merge: "auto" })).toBe(false);
    expect(needsYou({ status: "pr_review" }, null, { merge: "queued" })).toBe(false);
    for (const status of ["planning", "building", "checking", "done", "cancelled"] as const) expect(needsYou({ status }, null)).toBe(false);
  });

  it("el tablero tampoco pone un escalado de la plataforma en «Necesita tu decisión»", () => {
    const v = viewState({ status: "escalated", requestedBy: "bliss" }, { lastActivityAt: 0, now: 0, busy: false, escalationKind: "platform" });
    expect(v.whoseTurn).toBeNull();
    expect(v.label).toBe("Esperando preview");
  });
});

describe("el aviso dice el motivo (easybits, 20-oct)", () => {
  it("escalado: el reason, no el texto fijo; platform no timbra", () => {
    expect(turnNoticeBody("escalated", { kind: "env", reason: "Faltan 5 variables de la preview" })).toBe("Faltan 5 variables de la preview");
    expect(turnNoticeBody("escalated", { kind: "platform", reason: "la preview no arrancó" })).toBeNull();
    expect(turnNoticeBody("escalated", {})).toBe("La fábrica necesita que decidas cómo seguir.");
    expect(turnNoticeBody("pr_review")).toContain("PR está listo");
    expect(turnNoticeBody("checking")).toBeNull();
  });
});

describe("act close (easybits #129, 20-oct)", () => {
  it("con ignore=major: comenta a Dependabot ANTES de cerrar, con la cuenta de quien conectó el repo, y cancela", async () => {
    const subs: string[] = [];
    ghReply = (path) => (subs.push(path), {});
    const next = await closeRunPr(run(), { ignore: "major", who: "Bliss" });
    expect(next.status).toBe("cancelled");
    expect(gh.map((c) => `${c.init?.method} ${c.path}`)).toEqual([
      "POST /repos/blissito/easybits/issues/129/comments",
      "PATCH /repos/blissito/easybits/pulls/129",
    ]);
    expect(JSON.parse(gh[0].init!.body!).body).toBe("@dependabot ignore this major version");
    expect(JSON.parse(gh[1].init!.body!)).toEqual({ state: "closed" });
    const cancel = events.find((e) => e.type === "cancel")!;
    expect(JSON.parse(cancel.data_json!)).toMatchObject({ reason: "closed_by_person", ignore: "major" });
  });

  it("sin ignore sólo cierra; ignore=dependency pide ignorar la dependencia", async () => {
    await closeRunPr(run(), { ignore: null, who: "Bliss" });
    expect(gh.map((c) => c.init?.method)).toEqual(["PATCH"]);
    expect(dependabotIgnoreComment("dependency")).toBe("@dependabot ignore this dependency");
  });

  it("GitHub no lo cierra: lo dice (el pedido ya quedó cancelado)", async () => {
    ghReply = (path) => (path.includes("/pulls/") ? { error: "GitHub respondió 403" } : {});
    await expect(closeRunPr(run(), { ignore: null, who: "Bliss" })).rejects.toThrow(/GitHub no cerró el PR/);
  });

  it("un pedido cerrado no se vuelve a cerrar", async () => {
    await expect(closeRunPr(run({ status: "done" }), { ignore: null, who: "Bliss" })).rejects.toThrow(/terminado/);
  });
});

describe("tope de Dependabot por repo, también en el webhook (easybits, 20-oct)", () => {
  const ev = { repo: "blissito/easybits", number: 140, title: "Bump zod from 3 to 4", url: "https://github.com/blissito/easybits/pull/140", author: "dependabot[bot]" };
  it(`con ${DEPENDABOT_LIVE_CAP} vivos no adopta: queda en cola para el barrido y el room no recibe el aviso suelto`, async () => {
    liveDependabot = DEPENDABOT_LIVE_CAP;
    expect(await adoptDependabotPr(ev)).toEqual([5]);
    expect(adoptedInserts).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});

// #137 de business (20-oct): «Bump actions/checkout from 5 to 7» escaló como decision porque GitHub
// limitó las peticiones. Es de la plataforma: sin push, y @check revisa otra vez sola.
const FINDINGS_137 =
  "- `.github/workflows:0` — Sin revisar: github_pr_files, github_pr_checks y github_get_pr devolvieron «GitHub está limitando las peticiones» en 3 intentos durante ~5 min; no se leyó el diff, el CI ni las notas de actions/checkout v6/v7.\n" +
  "- `(preview):0` — factory_preview: state=none, required=true. Sin preview lista en el último commit no hay aprobación.";

describe("límite de GitHub = plataforma (#137, 20-oct)", () => {
  it("se reconoce en español, en inglés y con 403/429, pero no un PR que agrega rate limiting", () => {
    expect(isGithubRateLimit(FINDINGS_137)).toBe(true);
    expect(isGithubRateLimit("You have exceeded a secondary rate limit")).toBe(true);
    expect(isGithubRateLimit("API rate limit exceeded for installation")).toBe(true);
    expect(isGithubRateLimit("github_get_pr respondió 429")).toBe(true);
    expect(isGithubRateLimit("GitHub rate limit al leer el diff")).toBe(true);
    expect(isGithubRateLimit("- `app/routes/login.ts:12` — falta rate limit en el login")).toBe(false);
    expect(isGithubRateLimit("el middleware devuelve 429 sin Retry-After")).toBe(false);
    expect(isGithubRateLimit("github_get_pr respondió 403: sin permiso para eso en GitHub")).toBe(false);
  });

  it("el evento viejo de #137 (sin kind) se deduce platform: no te toca y sólo ofrece «Que @check revise»", () => {
    expect(deduceEscalationKind(FINDINGS_137)).toBe("platform");
    const e = escalationFromEvent({ findings: FINDINGS_137 }, 10)!;
    expect(e.kind).toBe("platform");
    expect(e.actions).toEqual(["recheck"]);
    expect(e.reason).toBe("GitHub limitó las peticiones; @check revisa otra vez sola.");
    expect(needsYou({ status: "escalated" }, e)).toBe(false);
  });

  it("@check lo manda como decision: la plataforma lo guarda platform, sin push y con la hora de la nueva revisión", async () => {
    runRow = { ...runRow, status: "checking" };
    const now = Math.floor(Date.now() / 1000);
    const next = await escalateRateLimit(run({ status: "checking" }), { findings: FINDINGS_137, resetAt: now + 600 });
    expect(next?.status).toBe("escalated");
    const ev = events.find((x) => x.type === "check_blocked")!;
    const data = JSON.parse(ev.data_json!);
    expect(data).toMatchObject({ kind: "platform", cause: "github_rate_limit" });
    expect(data.retryAt).toBe(now + 660);
    expect(data.reason).toMatch(/^GitHub limitó las peticiones; @check revisa otra vez sola en 1[01] min\.$/);
    expect(turnNoticeBody("escalated", data)).toBeNull();
    expect(posts.some((p) => p.includes("En pausa por la plataforma"))).toBe(true);
  });

  it("sin reset de GitHub espera 15 min; un reset absurdo se acota a 1 h", async () => {
    runRow = { ...runRow, status: "checking" };
    const now = Math.floor(Date.now() / 1000);
    await escalateRateLimit(run({ status: "checking" }), { findings: FINDINGS_137 });
    expect(JSON.parse(events.at(-1)!.data_json!).retryAt).toBeGreaterThanOrEqual(now + 900);
    runRow = { ...runRow, status: "checking" };
    await escalateRateLimit(run({ status: "checking" }), { findings: FINDINGS_137, resetAt: now + 86400 });
    expect(JSON.parse(events.at(-1)!.data_json!).retryAt).toBeLessThanOrEqual(now + 3601);
  });

  it("rateLimitRetryAt: la hora guardada, 15 min tras el evento viejo, null si no es de GitHub", () => {
    expect(rateLimitRetryAt({ kind: "platform", cause: "github_rate_limit", retryAt: 500 }, 1)).toBe(500);
    expect(rateLimitRetryAt({ findings: FINDINGS_137 }, 1000)).toBe(1000 + 900);
    expect(rateLimitRetryAt({ kind: "platform", findings: "la preview no arrancó" }, 1)).toBeNull();
    expect(rateLimitRetryAt({ kind: "decision", findings: FINDINGS_137 }, 1)).toBeNull();
    expect(rateLimitReason(1000 + 15 * 60, 1000)).toBe("GitHub limitó las peticiones; @check revisa otra vez sola en 15 min.");
  });
});
