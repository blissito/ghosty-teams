// Cliente AG-UI de gs (gs-agui 1) contra streams GRABADOS: lo que gs emite por
// `POST /api/v2/fleet-agents/:id/agui` y lo que Teams tiene que hacer con eso. Ver
// docs/agui-migracion.md.
import { describe, test, expect, afterEach } from "vitest";
import { AguiTurnReader, AguiRunError, applyPatch, buildRunInput, contentParts } from "./gs-agui.server";
import type { ToolEvent, TruncatedEvent } from "../agents.server";

const sse = (events: unknown[], { cut = false } = {}) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(": ping\n\n") + (cut ? 'data: {"type":"TEXT_MES' : ""), {
    headers: { "content-type": "text/event-stream" },
  }).body!;

function harness() {
  const chunks: string[] = [];
  const tools: ToolEvent[] = [];
  const log: Record<string, unknown[]> = { truncated: [], model: [], started: [], replyTo: [], attachments: [], stalled: [] };
  const reader = new AguiTurnReader({
    onChunk: (c) => void chunks.push(c),
    onTool: (ev) => void tools.push(ev),
    onTruncated: (t: TruncatedEvent) => void log.truncated.push(t),
    onModel: (m) => void log.model.push(m),
    onRunStarted: (r) => void log.started.push(r),
    onReplyTo: (ids, folded) => void log.replyTo.push({ ids, folded }),
    onAttachmentsFailed: (f) => void log.attachments.push(f),
    onStalled: (s) => void log.stalled.push(s),
  });
  return { reader, chunks, tools, log };
}

const R = "teams:run-1";
const started = { type: "RUN_STARTED", threadId: "g", runId: R, timestamp: 1 };

describe("AguiTurnReader", () => {
  test("texto, herramienta con rótulo y cierre autoritativo", async () => {
    const h = harness();
    const out = await h.reader.read(
      sse([
        started,
        { type: "STEP_STARTED", stepName: "waking" },
        { type: "TEXT_MESSAGE_START", messageId: `${R}:a0`, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "Voy a " },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "buscar." },
        { type: "TEXT_MESSAGE_END", messageId: `${R}:a0` },
        { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "WebSearch", parentMessageId: `${R}:a0` },
        { type: "CUSTOM", name: "ghosty.tool", value: { toolCallId: "t1", title: "Busqué en la web", kind: "search", detail: "nytimes.com" } },
        { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"q":"x"}' },
        { type: "TOOL_CALL_END", toolCallId: "t1" },
        { type: "TOOL_CALL_RESULT", messageId: `${R}:tt1`, toolCallId: "t1", content: "ok" },
        { type: "TEXT_MESSAGE_START", messageId: `${R}:a1`, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a1`, delta: "Listo." },
        { type: "TEXT_MESSAGE_END", messageId: `${R}:a1` },
        { type: "RUN_FINISHED", threadId: "g", runId: R, result: "Voy a buscar.Listo (redactado).", outcome: { type: "success" }, usage: [{ model: "claude-sonnet-5", inputTokens: 1, outputTokens: 2 }] },
      ]),
      { idleMs: 5_000 },
    );
    expect(out).toEqual({ kind: "finished", text: "Voy a buscar.Listo (redactado).", cancelled: false });
    expect(h.chunks.join("")).toBe("Voy a buscar.Listo.");
    expect(h.tools).toEqual([
      { name: "WebSearch", id: "t1", phase: "start", detail: "nytimes.com" },
      { id: "t1", phase: "end", ok: true },
    ]);
    expect(h.log.model).toEqual(["claude-sonnet-5"]);
    expect(h.log.started).toEqual([R]);
  });

  test("herramienta fallida (metadata.error) y START sin rótulo", async () => {
    const h = harness();
    await h.reader.read(
      sse([
        started,
        { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "Bash" },
        { type: "TOOL_CALL_END", toolCallId: "t1" },
        { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "t1", content: "boom", metadata: { error: true } },
        { type: "RUN_FINISHED", threadId: "g", runId: R, outcome: { type: "success" } },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.tools).toEqual([
      { name: "Bash", id: "t1", phase: "start", detail: undefined },
      { id: "t1", phase: "end", ok: false },
    ]);
  });

  test("el plan de TodoWrite sale de sus args", async () => {
    const h = harness();
    const todos = [{ content: "Modelo", status: "in_progress", activeForm: "Modelando" }];
    const args = JSON.stringify({ todos });
    await h.reader.read(
      sse([
        started,
        { type: "TOOL_CALL_START", toolCallId: "td", toolCallName: "TodoWrite" },
        { type: "TOOL_CALL_ARGS", toolCallId: "td", delta: args.slice(0, 10) },
        { type: "TOOL_CALL_ARGS", toolCallId: "td", delta: args.slice(10) },
        { type: "TOOL_CALL_END", toolCallId: "td" },
        { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "td", content: "ok" },
        { type: "RUN_FINISHED", threadId: "g", runId: R },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.tools.find((t) => t.todos)?.todos).toEqual(todos);
    expect(h.tools.at(-1)).toEqual({ id: "td", phase: "end", ok: true });
  });

  test("reconexión: lo re-emitido acumulado no se repite en la burbuja", async () => {
    const h = harness();
    const first = await h.reader.read(
      sse(
        [
          started,
          { type: "TEXT_MESSAGE_START", messageId: `${R}:a0`, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "Hola, " },
          { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "Read" },
          { type: "CUSTOM", name: "ghosty.tool", value: { toolCallId: "t1", title: "Leí", detail: "a.md" } },
        ],
        { cut: true },
      ),
      { idleMs: 5_000 },
    );
    expect(first).toBeNull(); // corte sin RUN_FINISHED: el llamador reconecta
    const second = await h.reader.read(
      sse([
        started,
        { type: "CUSTOM", name: "ghosty.history", value: { hasMoreBefore: false, before: null } },
        { type: "MESSAGES_SNAPSHOT", messages: [{ id: "viejo:a0", role: "assistant", content: "turno anterior" }] },
        { type: "STATE_SNAPSHOT", snapshot: { caps: { steer: true } } },
        { type: "TEXT_MESSAGE_START", messageId: `${R}:a0`, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "Hola, mundo" },
        { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "Read" },
        { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "!" },
        { type: "TOOL_CALL_END", toolCallId: "t1" },
        { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "t1", content: "ok" },
        { type: "RUN_FINISHED", threadId: "g", runId: R, result: "Hola, mundo!" },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.chunks.join("")).toBe("Hola, mundo!");
    expect(h.tools.filter((t) => t.phase === "start")).toHaveLength(1);
    expect(second).toEqual({ kind: "finished", text: "Hola, mundo!", cancelled: false });
    expect(h.log.started).toEqual([R]); // onRunStarted una sola vez
  });

  test("adopción tras reinicio de Teams: el texto ya cerrado de ESTE run sale del snapshot", async () => {
    const h = harness();
    await h.reader.read(
      sse([
        started,
        { type: "MESSAGES_SNAPSHOT", messages: [
          { id: "otro:a0", role: "assistant", content: "no es de este run" },
          { id: `${R}:u`, role: "user", content: "hazlo" },
          { id: `${R}:a0`, role: "assistant", content: "Primera parte. " },
        ] },
        { type: "TEXT_MESSAGE_START", messageId: `${R}:a1`, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a1`, delta: "Segunda." },
        { type: "RUN_FINISHED", threadId: "g", runId: R, outcome: { type: "success" } },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.chunks.join("")).toBe("Primera parte. Segunda.");
  });

  test("steer: ghosty.injected corta aquí y el run vivo es de otro turno", async () => {
    const h = harness();
    const out = await h.reader.read(
      sse([
        { type: "RUN_STARTED", threadId: "g", runId: "teams:vivo" },
        { type: "CUSTOM", name: "ghosty.injected", value: { messageId: "456" } },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "x", delta: "no debe leerse" },
      ]),
      { idleMs: 5_000 },
    );
    expect(out).toEqual({ kind: "injected" });
    expect(h.reader.runId).toBe("teams:vivo");
    expect(h.chunks).toEqual([]);
  });

  test("CUSTOM de Teams: reply_to, adjuntos, atasco (una vez) y corte", async () => {
    const h = harness();
    const stalled = { rule: "same_cmd", tool: "Bash", detail: "npm test", count: 5, secs: 600, since: 1, human: "Se atoró", steer: "Para" };
    const out = await h.reader.read(
      sse([
        started,
        { type: "CUSTOM", name: "ghosty.attachments_failed", value: { failed: [{ name: "a.pdf", reason: "pesa 40 MB" }] } },
        { type: "CUSTOM", name: "ghosty.reply_to", value: { messageIds: ["452", "x"], folded: true } },
        { type: "CUSTOM", name: "ghosty.stalled", value: stalled },
        { type: "CUSTOM", name: "ghosty.stalled", value: stalled },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `${R}:a0`, delta: "Me quedé" },
        { type: "RUN_FINISHED", threadId: "g", runId: R, result: "Me quedé", metadata: { truncated: { subtype: "error_max_turns", classification: "length", numTurns: 80, stopReason: null, notice: "event" } } },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.log.attachments).toEqual([[{ name: "a.pdf", reason: "pesa 40 MB" }]]);
    expect(h.log.replyTo).toEqual([{ ids: [452], folded: true }]);
    expect(h.log.stalled).toEqual([stalled]);
    expect(h.log.truncated).toEqual([{ subtype: "error_max_turns", classification: "length", numTurns: 80, stopReason: null, notice: "event" }]);
    expect(out).toEqual({ kind: "finished", text: "Me quedé", cancelled: false });
  });

  test("forma general de attachments_failed (names + message) también sirve", async () => {
    const h = harness();
    await h.reader.read(
      sse([started, { type: "CUSTOM", name: "ghosty.attachments_failed", value: { names: ["b.png"], message: "no llegó" } }, { type: "RUN_FINISHED", threadId: "g", runId: R }]),
      { idleMs: 5_000 },
    );
    expect(h.log.attachments).toEqual([[{ name: "b.png", reason: "no llegó" }]]);
  });

  test("turno perdido por gs (metadata.interrupted) y Detener (cancelled)", async () => {
    const h = harness();
    const out = await h.reader.read(
      sse([started, { type: "RUN_FINISHED", threadId: "g", runId: R, outcome: { type: "cancelled" }, metadata: { interrupted: { runId: R, reason: "Se reinició el servidor" } } }]),
      { idleMs: 5_000 },
    );
    expect(out).toEqual({ kind: "finished", text: "", cancelled: true });
    expect(h.log.truncated).toEqual([{ subtype: "interrupted", classification: "retryable", notice: "event" }]);
  });

  test("subagentes por STATE_SNAPSHOT/STATE_DELTA → filas de subagente", async () => {
    const h = harness();
    await h.reader.read(
      sse([
        started,
        { type: "STATE_SNAPSHOT", snapshot: { subagents: { tasks: [{ id: "s1", title: "Investigar precios", status: "running", startedAt: 1000, usage: { tokens: 10, toolUses: 1 } }] } } },
        { type: "STATE_DELTA", delta: [{ op: "add", path: "/subagents/tasks/0/lastTool", value: "WebSearch · precios" }] },
        { type: "STATE_DELTA", delta: [{ op: "replace", path: "/subagents/tasks/0/status", value: "completed" }, { op: "add", path: "/subagents/tasks/0/endedAt", value: 4000 }, { op: "add", path: "/subagents/tasks/0/summary", value: "3 precios" }] },
        { type: "RUN_FINISHED", threadId: "g", runId: R },
      ]),
      { idleMs: 5_000 },
    );
    expect(h.tools.map((t) => t.sub?.kind ?? t.phase)).toEqual(["start", "step", "end", "end"]);
    expect(h.tools[1].sub).toMatchObject({ kind: "step", tool: "WebSearch", detail: "precios" });
    expect(h.tools[2].sub).toMatchObject({ kind: "end", status: "done", ms: 3000, preview: "3 precios" });
    expect(h.tools[3]).toEqual({ id: "s1", phase: "end", ok: true });
  });

  test("RUN_ERROR lanza; un interrupt también (Teams pide permisos auto)", async () => {
    await expect(harness().reader.read(sse([started, { type: "RUN_ERROR", message: "caja caída", code: "box" }]), { idleMs: 5_000 })).rejects.toBeInstanceOf(AguiRunError);
    await expect(
      harness().reader.read(sse([started, { type: "RUN_FINISHED", threadId: "g", runId: R, outcome: { type: "interrupt", interrupts: [{ id: "p", reason: "confirmation" }] } }]), { idleMs: 5_000 }),
    ).rejects.toThrow(/permiso/);
  });

  test("silencio de más = terminated (para reintentar)", async () => {
    const stuck = new ReadableStream<Uint8Array>({ start() {} });
    await expect(harness().reader.read(stuck, { idleMs: 50 })).rejects.toThrow(/terminated/);
  });
});

describe("request", () => {
  test("RunAgentInput con adjuntos como content parts y permisos auto", () => {
    const input = buildRunInput({
      threadId: "g",
      runId: R,
      message: { id: "456", text: "mira", parts: [
        { kind: "file", file: { name: "f.png", mimeType: "image/png", uri: "https://cdn/f.png" } },
        { kind: "file", file: { name: "c.pdf", mimeType: "application/pdf", bytes: "QUJD" } },
      ] },
      forwardedProps: { configGroupId: "teams", steer: true },
    });
    expect(input).toEqual({
      threadId: "g",
      runId: R,
      messages: [{ id: "456", role: "user", content: [
        { type: "text", text: "mira" },
        { type: "image", source: { type: "url", value: "https://cdn/f.png" }, mimeType: "image/png", filename: "f.png" },
        { type: "document", source: { type: "data", value: "QUJD", mimeType: "application/pdf" }, mimeType: "application/pdf", filename: "c.pdf" },
      ] }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: { permissions: "auto", configGroupId: "teams", steer: true },
    });
    expect(buildRunInput({ threadId: "g", runId: R }).messages).toEqual([]);
    expect(contentParts("x", [])).toEqual([{ type: "text", text: "x" }]);
  });

  test("applyPatch: add/replace/remove y append con -", () => {
    const doc = { a: { list: [1, 2] }, b: 1 };
    expect(applyPatch(doc, [
      { op: "add", path: "/a/list/-", value: 3 },
      { op: "replace", path: "/b", value: 2 },
      { op: "remove", path: "/a/list/0" },
      { op: "add", path: "/c~1d", value: true },
    ])).toEqual({ a: { list: [2, 3] }, b: 2, "c/d": true });
    expect(doc).toEqual({ a: { list: [1, 2] }, b: 1 }); // no muta el original
  });
});

// ── Extremo a extremo: callAgentBackendStream contra un gs simulado ─────────────

describe("callAgentBackendStream (runtime gs-native)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const emptySqld = (init: any) => {
    const reqs = JSON.parse(init.body).requests as any[];
    const results = reqs.map((r) => (r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } }));
    return new Response(JSON.stringify({ baton: null, base_url: null, results }), { status: 200, headers: { "content-type": "application/json" } });
  };

  async function run(responses: ((body: any) => Response)[], extra: { inject?: boolean; resume?: string } = {}) {
    process.env.GHOSTY_RUNTIME_URL = "http://gs.local";
    process.env.GHOSTY_PARTNER_SECRET = "s3cret";
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/v2/pipeline")) return emptySqld(init);
      if (!u.startsWith("http://gs.local/") || !u.endsWith("/agui")) return new Response("{}", { status: 404 });
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: u, body, headers: init?.headers ?? {} });
      if (body?.forwardedProps?.cancel) return new Response(sse([]), { headers: { "content-type": "text/event-stream" } });
      const next = responses.shift();
      if (!next) throw new Error("sin respuesta grabada");
      return next(body);
    }) as any;
    const { callAgentBackendStream } = await import("../agents.server");
    const { withNamespace } = await import("./tenant.server");
    const chunks: string[] = [];
    const durables: string[] = [];
    const reply = await withNamespace("ws-test", () =>
      callAgentBackendStream(
        { handle: "build", name: "Build", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: "fa1", token: "tok", runtime: "gs-native" } } as any,
        "g1", "iris", "hazlo", (c) => void chunks.push(c), [], undefined, null, undefined, undefined, null,
        extra.inject, "http://localhost", false, undefined, undefined, false, undefined,
        { resumeTurnId: extra.resume, onDurable: (t) => void durables.push(t), messageRef: extra.inject ? 456 : undefined },
      ),
    );
    return { reply, chunks, calls, durables };
  }

  const ok = (events: unknown[]) => () => new Response(sse(events), { headers: { "content-type": "text/event-stream" } });

  test("POST a /agui firmado como workspace; corte y reenganche con messages:[]", { timeout: 30_000 }, async () => {
    let rid = "";
    const { reply, chunks, calls, durables } = await run([
      (b) => {
        rid = b.runId;
        return new Response(sse([{ ...started, runId: rid }, { type: "TEXT_MESSAGE_CONTENT", messageId: `${rid}:a0`, delta: "Hola" }], { cut: true }), { headers: { "content-type": "text/event-stream" } });
      },
      (b) => ok([{ ...started, runId: b.runId }, { type: "TEXT_MESSAGE_START", messageId: `${b.runId}:a0` }, { type: "TEXT_MESSAGE_CONTENT", messageId: `${b.runId}:a0`, delta: "Hola mundo" }, { type: "RUN_FINISHED", threadId: "g1", runId: b.runId, result: "Hola mundo" }])(),
    ]);
    expect(reply).toBe("Hola mundo");
    expect(chunks.join("")).toBe("Hola mundo");
    expect(calls[0].url).toBe("http://gs.local/api/v2/fleet-agents/fa1/agui");
    expect(calls[0].headers["x-ghosty-ws"]).toBe("ws-test");
    expect(calls[0].headers.Accept).toBe("text/event-stream");
    expect(calls[0].body.threadId).toBe("g1");
    expect(calls[0].body.messages[0].role).toBe("user");
    expect(calls[0].body.forwardedProps).toMatchObject({ configGroupId: "teams", sender: "iris", permissions: "auto" });
    expect(calls[0].body.forwardedProps.steer).toBeUndefined();
    expect(calls[1].body.runId).toBe(rid); // mismo run
    expect(calls[1].body.messages).toEqual([]); // reconectar, no repetir el mensaje
    expect(durables).toEqual([rid]);
  });

  test("steer que no entra (409 run_active) se manda como turno normal al terminar el vivo", { timeout: 30_000 }, async () => {
    const { reply, calls } = await run(
      [
        () => Response.json({ error: "run_active", message: "hay un run vivo" }, { status: 409, headers: { "Retry-After": "0" } }),
        (b) => ok([{ ...started, runId: b.runId }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "ok" }, { type: "RUN_FINISHED", threadId: "g1", runId: b.runId }])(),
      ],
      { inject: true },
    );
    expect(reply).toBe("ok");
    expect(calls[0].body.forwardedProps.steer).toBe(true);
    expect(calls[0].body.messages[0].id).toBe("456");
    expect(calls[1].body.forwardedProps.steer).toBeUndefined();
  });

  test("steer que llega tarde (409 run_not_live) se manda en seguida como turno normal", async () => {
    const { reply, calls } = await run(
      [
        () => Response.json({ error: "run_not_live", message: "ya terminó" }, { status: 409 }),
        (b) => ok([{ ...started, runId: b.runId }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "va" }, { type: "RUN_FINISHED", threadId: "g1", runId: b.runId }])(),
      ],
      { inject: true },
    );
    expect(reply).toBe("va");
    expect(calls[1].body.forwardedProps.steer).toBeUndefined();
    expect(calls[1].body.messages).toHaveLength(1);
  });

  test("steer que entra devuelve INJECTED", async () => {
    const { INJECTED } = await import("../agents.server");
    const { reply } = await run([ok([{ type: "RUN_STARTED", threadId: "g1", runId: "teams:vivo" }, { type: "CUSTOM", name: "ghosty.injected", value: { messageId: "456" } }])], { inject: true });
    expect(reply).toBe(INJECTED);
  });

  test("402 sin saldo es la respuesta, no una falla", async () => {
    const { reply, chunks } = await run([() => Response.json({ error: "quota_exceeded", message: "Se acabó la bolsa; se reinicia el 1." }, { status: 402 })]);
    expect(reply).toBe("Se acabó la bolsa; se reinicia el 1.");
    expect(chunks).toEqual([reply]);
  });

  test("adopción: el primer POST ya es reenganche (messages:[]) con el runId guardado", async () => {
    const { reply, calls } = await run([ok([{ ...started, runId: "teams:viejo" }, { type: "RUN_FINISHED", threadId: "g1", runId: "teams:viejo", result: "terminado" }])], { resume: "teams:viejo" });
    expect(reply).toBe("terminado");
    expect(calls[0].body.runId).toBe("teams:viejo");
    expect(calls[0].body.messages).toEqual([]);
  });

  test("RUN_ERROR = aviso «No pude contactar» (no se reintenta)", async () => {
    const { reply, calls } = await run([ok([started, { type: "RUN_ERROR", message: "caja caída" }])]);
    expect(reply).toMatch(/No pude contactar a @build: caja caída/);
    expect(calls).toHaveLength(1);
  });
});
