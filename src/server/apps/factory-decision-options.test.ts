import { describe, it, expect, vi, beforeEach } from "vitest";

// Escalados `decision` con opciones (1-nov). Caso real: mailmask #153/#154 pasaron días en bucle
// porque «Que @build lo arregle» y «Retomar» despertaban a @build sin decir qué camino se eligió, y
// @build contestaba «espero a que elijas a o b» 4 veces al día.
const sqls: { sql: string; args: unknown[] }[] = [];
let notes: { id: number; by: string; text: string }[] = [];
let escalEvent: { type: string; data_json: string; at: number } | null = null;
let sharedFix: number | null = null;

const row = (over: Record<string, unknown> = {}) => ({
  id: 153, channel_id: 5, root_msg_id: 900, topic: "general", title: "Bump actions", status: "escalated", plan_version: 0,
  loops: 0, repo: "o/r", requested_by: "ana", approved_by: "beto", ...over,
});

vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string, args: unknown[] = []) => {
    sqls.push({ sql, args });
    if (sql.startsWith("UPDATE gt_factory_runs SET status")) {
      const r: Record<string, unknown> = row({ status: args[0], ...(args.includes(200) ? { id: 200, kind: "repo_fix" } : {}) });
      const cols = [...sql.matchAll(/, (\w+) = \?/g)].map((m) => m[1]);
      cols.forEach((c, i) => (r[c] = args[1 + i]));
      return [r];
    }
    if (sql.includes("FROM gt_factory_events") && sql.includes("'check_blocked', 'check_fail'")) return escalEvent ? [escalEvent] : [];
    if (sql.startsWith("INSERT INTO gt_factory_notes")) {
      notes.push({ id: notes.length + 1, text: String(args[1]), by: String(args[2]) });
      return [{ id: notes.length }];
    }
    if (sql.startsWith("UPDATE gt_factory_notes")) return notes.splice(0);
    if (sql.startsWith("SELECT * FROM gt_factory_plans")) return [{ plan_md: "" }];
    if (sql.startsWith("SELECT box_state")) return [{ box_state: "waiting" }];
    if (sql.startsWith("INSERT INTO gt_factory_runs")) return [{ id: 200 }];
    if (sql.startsWith("SELECT * FROM gt_factory_runs WHERE id = ?") && args[0] === 200) return [row({ id: 200, status: "planning", kind: "repo_fix", title: "Arreglar en main" })];
    if (sql.includes("kind = 'repo_fix'")) return sharedFix ? [{ id: sharedFix }] : [];
    return [];
  },
}));
vi.mock("../../db.server", () => ({
  getChannelById: async () => ({ id: 5, slug: "mailmask" }),
  filterMutedOut: async (s: string[]) => s,
  postAgent: async () => ({ id: 1 }),
  getMessage: async () => null,
}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns", currentSlug: async () => "business" }));
vi.mock("../../agents.server", () => ({ resolvedAgents: async () => [], agentGroupId: async () => "g" }));
vi.mock("./factory-team.server", () => ({ factoryTurnFor: async () => null }));

process.env.GHOSTY_PARTNER_SECRET = "x";
vi.stubGlobal("fetch", vi.fn(async () => ({ status: 409, json: async () => ({ error: "no_slot", tier: "free", max: 1, busy: [] }) })));

import { asksPerson, chooseOption, ciNotStarted, decide, escalationFromEvent, type Run } from "./factory-runs.server";
import { normalizeEscalationOptions, optionNote, parseOptionChoice } from "./factory-flow";

const run = (over: Partial<Run> = {}): Run => ({
  id: 153, channelId: 5, rootMsgId: 900, topic: "general", title: "Bump actions", status: "escalated", planVersion: 0, loops: 0,
  repo: "o/r", branch: "dependabot/x", prUrl: "https://github.com/o/r/pull/123", headSha: null, taskRef: "dependabot:minor",
  requestedBy: "ana", approvedBy: "beto", kind: "dependabot",
  ...over,
});
const handoffText = () => {
  const u = sqls.find((s) => s.sql.includes("SET box_handoff"))!;
  return JSON.parse(String(u.args[0])).text as string;
};
const OPTIONS = [
  { label: "Arreglar el permiso en main", action: "recheck", brief: "Agrega pull-requests: read al job security en main y re-corre el CI." },
  { label: "Arreglarlo en esta rama", action: "build", brief: "Agrega pull-requests: read al job security en esta rama." },
  { label: "Hacer merge así", action: "merge_as_is", brief: "Lo rojo es el permiso de gitleaks, no el bump." },
];
const blocked = (data: Record<string, unknown>) => ({ type: "check_blocked", data_json: JSON.stringify(data), at: 1 });

beforeEach(() => {
  sqls.length = 0;
  notes = [];
  escalEvent = null;
  sharedFix = null;
});

describe("opciones del escalado (puras)", () => {
  it("se normalizan: letras en orden, tope 3, merge_as_is sólo con PR, menos de 2 = sin opciones", () => {
    const o = normalizeEscalationOptions([...OPTIONS, { label: "cuarta", action: "close", brief: "x" }], { hasPr: true })!;
    expect(o.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(o[2].action).toBe("merge_as_is");
    expect(normalizeEscalationOptions(OPTIONS, { hasPr: false })!.map((x) => x.action)).toEqual(["recheck", "build"]);
    expect(normalizeEscalationOptions([OPTIONS[0], { label: "x", action: "borrar_todo", brief: "" }], { hasPr: true })).toBeNull();
    expect(normalizeEscalationOptions("a o b", { hasPr: true })).toBeNull();
  });

  it("una letra o un número en el hilo elige; lo demás no", () => {
    const o = normalizeEscalationOptions(OPTIONS, { hasPr: true })!;
    expect(parseOptionChoice("b", o)?.action).toBe("build");
    expect(parseOptionChoice("la a.", o)?.id).toBe("a");
    expect(parseOptionChoice("opción 3", o)?.action).toBe("merge_as_is");
    expect(parseOptionChoice("b", null)).toBeNull();
    expect(parseOptionChoice("bueno, hazlo", o)).toBeNull();
    expect(parseOptionChoice("d", o)).toBeNull();
  });

  it("el escalado guardado devuelve sus opciones y por dónde llegó", () => {
    const e = escalationFromEvent({ findings: "- gitleaks 403", kind: "decision", reason: "Falta un permiso", options: normalizeEscalationOptions(OPTIONS, { hasPr: true }) }, 1);
    expect(e?.options?.map((o) => o.label)).toEqual(OPTIONS.map((o) => o.label));
    expect(e?.via).toBe("blocked");
    expect(escalationFromEvent({ findings: "- x", kind: "env", reason: "r", options: OPTIONS }, 1)?.options).toBeNull();
    expect(escalationFromEvent({ findings: "- x", kind: "decision", reason: "r" }, 1, "loops")?.via).toBe("loops");
  });
});

describe("decidir un escalado decision", () => {
  it("«otra vuelta» sin nota y con opciones se rechaza: hay que elegir", async () => {
    escalEvent = blocked({ findings: "- x", kind: "decision", reason: "r", options: normalizeEscalationOptions(OPTIONS, { hasPr: true }) });
    await expect(decide({ run: run(), version: 0, decision: "approve", sub: "beto", who: "Beto", origin: "" })).rejects.toThrow(/elige/);
  });

  it("sin opciones pero frenado por @check (caso #153 viejo): sin nota también se rechaza", async () => {
    escalEvent = blocked({ findings: "- (a) en la rama o (b) en main", kind: "decision", reason: "r" });
    await expect(decide({ run: run(), version: 0, decision: "approve", sub: "beto", who: "Beto", origin: "" })).rejects.toThrow(/camino/);
  });

  it("vueltas agotadas (check_fail) sin nota sigue funcionando: los hallazgos dicen qué arreglar", async () => {
    escalEvent = { type: "check_fail", data_json: JSON.stringify({ findings: "- falta un test", kind: "decision" }), at: 1 };
    await decide({ run: run({ loops: 3 }), version: 0, decision: "approve", sub: "beto", who: "Beto", origin: "" });
    expect(handoffText()).toContain("pidió otra vuelta");
  });

  it("elegir una opción build le lleva la elección literal a @build", async () => {
    escalEvent = blocked({ findings: "- x", kind: "decision", reason: "r", options: normalizeEscalationOptions(OPTIONS, { hasPr: true }) });
    const r = await chooseOption({ run: run(), optionId: "b", sub: "beto", who: "Beto", origin: "" });
    expect(r.option.action).toBe("build");
    expect(handoffText()).toContain("Beto: Elegí la opción b: Arreglarlo en esta rama. Agrega pull-requests: read");
    expect(sqls.some((s) => s.sql.includes("INSERT INTO gt_factory_events") && s.args.includes("option_chosen"))).toBe(true);
  });

  it("fix_main abre un pedido repo_fix que nace esperando firma y deja al original esperándolo", async () => {
    const fixOpts = normalizeEscalationOptions([{ label: "Dar permiso a gitleaks en main", action: "fix_main", brief: "pull-requests: read en el job security" }, OPTIONS[2]], { hasPr: true });
    escalEvent = blocked({ findings: "- gitleaks 403 en main", kind: "decision", reason: "Falta un permiso en main", options: fixOpts });
    const r = await chooseOption({ run: run(), optionId: "a", sub: "beto", who: "Beto", origin: "" });
    expect(r.fixRun).toBe(200);
    const ins = sqls.find((x) => x.sql.startsWith("INSERT INTO gt_factory_runs"))!;
    expect(ins.args).toContain("repo_fix");
    const plan = sqls.find((x) => x.sql.startsWith("INSERT INTO gt_factory_plans"))!;
    expect(String(plan.args[1])).toContain("pull-requests: read en el job security");
    expect(sqls.some((x) => x.sql.includes("INSERT INTO gt_factory_events") && x.args.includes("waiting_fix"))).toBe(true);
  });

  it("fix_main reutiliza el arreglo abierto del mismo repo (no abre uno por PR)", async () => {
    sharedFix = 77;
    escalEvent = blocked({ findings: "- x", kind: "decision", reason: "r", options: normalizeEscalationOptions([{ label: "main", action: "fix_main", brief: "b" }, OPTIONS[2]], { hasPr: true }) });
    const r = await chooseOption({ run: run(), optionId: "a", sub: "beto", who: "Beto", origin: "" });
    expect(r.fixRun).toBe(77);
    expect(sqls.some((x) => x.sql.startsWith("INSERT INTO gt_factory_runs"))).toBe(false);
  });

  it("merge_as_is exige confirmación explícita", async () => {
    escalEvent = blocked({ findings: "- x", kind: "decision", reason: "r", options: normalizeEscalationOptions(OPTIONS, { hasPr: true }) });
    await expect(chooseOption({ run: run(), optionId: "c", sub: "beto", who: "Beto", origin: "" })).rejects.toThrow(/confirma/);
  });

  it("una opción que no existe o un pedido que ya avanzó no se ejecutan", async () => {
    escalEvent = blocked({ findings: "- x", kind: "decision", reason: "r", options: normalizeEscalationOptions(OPTIONS, { hasPr: true }) });
    await expect(chooseOption({ run: run(), optionId: "z", sub: "beto", who: "Beto", origin: "" })).rejects.toThrow(/ya no existe/);
    await expect(chooseOption({ run: run({ status: "building" }), optionId: "a", sub: "beto", who: "Beto", origin: "" })).rejects.toThrow(/ya no espera/);
  });

  it("la nota de una opción dice letra, etiqueta y qué hacer", () => {
    expect(optionNote({ id: "a", label: "Re-correr el CI", action: "recheck", brief: "Lo arreglé en main." })).toBe("Elegí la opción a: Re-correr el CI. Lo arreglé en main.");
  });
});

describe("el rol que espera a una persona no se retoma solo", () => {
  // Los mensajes reales de @build en #153 y #154 (1-nov): ninguno termina en «?».
  it.each([
    "Sigue sin decisión de blissmo entre (a) arreglar `security` en esta rama o (b) PR aparte sobre `main`, así que el paso #153 sigue abierto. En cuanto elija, lo ejecuto y cierro con `factory_build_done`.",
    "Retomé el pedido y el CI del PR #124 sigue en rojo (10 de 15 checks fallidos, ninguno pendiente), así que no cierro el paso con `factory_build_done`. Lo que falta es que @fixtergeek revise Actions y vuelva a correr el CI, o decida el merge con la evidencia de la caja.",
    "Blissmo pidió retomar el pedido, pero en el hilo no hay todavía su decisión. Si me dices a o b, lo hago en este mismo turno.",
  ])("detecta la espera: %s", (t) => expect(asksPerson(t)).toBe(true));

  it("un cierre normal no cuenta como espera", () => {
    expect(asksPerson("Listo: subí los hermanos del grupo y el CI pasó. Cierro con factory_build_done.")).toBe(false);
    expect(asksPerson("Cuando termine el CI cierro el paso.")).toBe(false);
  });
});

describe("CI que GitHub nunca arrancó", () => {
  it("todos los rojos en ≤ 5 s = no arrancó (cobro o límite de gasto)", () => {
    expect(ciNotStarted([{ state: "failure", seconds: 3 }, { state: "failure", seconds: 4 }, { state: "success", seconds: 120 }])).toBe(true);
  });
  it("un rojo que sí corrió no es «no arrancó»; sin rojos tampoco", () => {
    expect(ciNotStarted([{ state: "failure", seconds: 3 }, { state: "failure", seconds: 95 }])).toBe(false);
    expect(ciNotStarted([{ state: "failure", seconds: null }])).toBe(false);
    expect(ciNotStarted([{ state: "success", seconds: 2 }])).toBe(false);
  });
});
