// Layout Boris: un turno con TodoWrite deja la burbuja del turno como plan vivo (se repinta
// con cada TodoWrite) y la respuesta sale como mensaje aparte. Sin plan, todo igual que antes.
// El stream es falso (fetch mockeado) y sqld contesta vacío: se prueba runAgentTurn entero.
import { test, expect } from "vitest";
import { runAgentTurn } from "./agents.server";
import { extractTodos, extractToolState, extractSteps } from "./lib/ebdoc";

const T = (todos: any) => ({ type: "tool", name: "TodoWrite", id: "t" + Math.random(), phase: "start", todos });
let frames: any[] = [
  T([{ content: "Modelar", status: "in_progress", activeForm: "Modelando" }, { content: "Probar", status: "pending" }]),
  { type: "chunk", value: "Voy con el modelo." },
  { type: "tool", name: "Bash", id: "b1", phase: "start", detail: "lake build" },
  { type: "tool", id: "b1", phase: "end", ok: true },
  T([{ content: "Modelar", status: "completed" }, { content: "Probar", status: "in_progress", activeForm: "Probando" }]),
  { type: "chunk", value: "Modelo listo." },
  { type: "tool", name: "Bash", id: "b2", phase: "start" },
  { type: "tool", id: "b2", phase: "end", ok: true },
  T([{ content: "Modelar", status: "completed" }, { content: "Probar", status: "completed" }]),
  { type: "chunk", value: "Todo verificado: 6 modelos, 0 sorry." },
  { type: "done", value: "Voy con el modelo.Modelo listo.Todo verificado: 6 modelos, 0 sorry." },
];

test("layout Boris: plan vivo + respuesta aparte", { timeout: 30000 }, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/v2/pipeline")) {
      const reqs = JSON.parse(init.body).requests as any[];
      const results = reqs.map((r) => r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
      return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  const bodies: Record<number, string[]> = {};
  let next = 100;
  const r = await runAgentTurn({
    agent: { handle: "lens", name: "Lens", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: "x", token: "tok", runtime: "easybits", runtimeUrl: "http://fake.local" } } as any,
    handle: "lens", groupId: "g", sender: "boris", text: "Use lean",
    createShell: async () => 1,
    createFollowUp: async () => next++,
    emitDelta: () => {},
    emitBody: (id, b) => { (bodies[id] ??= []).push(b); },
    originOverride: "http://localhost",
  });
  globalThis.fetch = realFetch;
  const shell = bodies[1];
  // el plan se edita en su lugar: estados distintos a lo largo del turno
  const estados = shell.map((b) => extractTodos(b)?.todos.map((t) => t.status).join(",")).filter(Boolean);
  expect(new Set(estados).size).toBeGreaterThanOrEqual(3);
  expect(r.id).toBe(100);
  expect(r.plan?.id).toBe(1);
  expect(r.reply).toBe("Todo verificado: 6 modelos, 0 sorry.");
  expect(extractTodos(r.plan!.body)!.todos.every((t) => t.status === "completed")).toBe(true);
  expect(extractToolState(r.plan!.body)).toBeTruthy();
  expect(extractSteps(r.plan!.body)).toEqual(["Voy con el modelo.", "Modelo listo."]);
});

test("sin plan: una sola burbuja como siempre", { timeout: 30000 }, async () => {
  frames = frames.filter((f) => f.name !== "TodoWrite");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/v2/pipeline")) {
      const reqs = JSON.parse(init.body).requests as any[];
      const results = reqs.map((r) => r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
      return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200 });
    }
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200 });
  }) as any;
  let follow = 0;
  const r = await runAgentTurn({
    agent: { handle: "lens", name: "Lens", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: "x", token: "tok", runtime: "easybits", runtimeUrl: "http://fake.local" } } as any,
    handle: "lens", groupId: "g", sender: "boris", text: "hola",
    createShell: async () => 1, createFollowUp: async () => { follow++; return 999; },
    emitDelta: () => {}, emitBody: () => {}, originOverride: "http://localhost",
  });
  globalThis.fetch = realFetch;
  expect(follow).toBe(0);
  expect(r.id).toBe(1);
  expect(r.plan).toBeUndefined();
  expect(r.reply).toContain("Todo verificado");
  expect(extractTodos(r.reply)).toBeNull();
});

test("retomar: el plan de la burbuja muerta sigue vivo y sin fences duplicados", { timeout: 30000 }, async () => {
  const { renderTodosBlock } = await import("./lib/ebdoc");
  const prefijo =
    renderTodosBlock({ todos: [{ content: "Modelar", status: "completed" }, { content: "Probar", status: "in_progress" }], asOf: 5 }) +
    '```gt-tools\n{"tools":[{"label":"Ejecuté un comando","status":"done"}]}\n```\n\nIba a medias.';
  frames = [{ type: "chunk", value: " Sigo." }, { type: "done", value: " Sigo." }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/v2/pipeline")) {
      const reqs = JSON.parse(init.body).requests as any[];
      const results = reqs.map((r) => r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
      return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200 });
    }
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200 });
  }) as any;
  const pintados: string[] = [];
  const r = await runAgentTurn({
    agent: { handle: "lens", name: "Lens", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: "x", token: "tok", runtime: "easybits", runtimeUrl: "http://fake.local" } } as any,
    handle: "lens", groupId: "g", sender: "boris", text: "sigue", prefijo,
    createShell: async () => 1, createFollowUp: async () => 2,
    emitDelta: () => {}, emitBody: (_id, b) => pintados.push(b), originOverride: "http://localhost",
  });
  globalThis.fetch = realFetch;
  for (const b of pintados) {
    expect(b.split("```gt-todos").length - 1).toBeLessThanOrEqual(1);
    expect(b.split("```gt-tools").length - 1).toBeLessThanOrEqual(1);
  }
  expect(extractTodos(pintados[0])?.todos[1].status).toBe("in_progress");
  // Hubo plan → la continuación sale aparte y la burbuja conserva el plan.
  expect(r.plan && extractTodos(r.plan.body)?.todos.length).toBe(2);
  expect(r.reply).toContain("Sigo.");
});
