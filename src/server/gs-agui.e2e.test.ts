// Extremo a extremo contra un gs DE VERDAD con el agente simulado (GS_AGUI_FAKE=1): sin cajas,
// sin modelo, sin cobro. Sólo corre si se le da dónde:
//
//   GS_AGUI_E2E_URL=http://127.0.0.1:5182 GS_AGUI_E2E_AGENT=<fleetAgentId> GS_AGUI_E2E_WS=<ns> \
//   GHOSTY_PARTNER_SECRET=<el de ese gs> npx vitest run src/server/gs-agui.e2e.test.ts
//
// Palabras del agente simulado: «lento», «ayudante», «plan», «falla», «adjunto», «atorado»,
// «truncado», «error» (ver docs/claude/agui-adopcion.md de gs).
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { ToolEvent, TruncatedEvent } from "../agents.server";

const URL_GS = process.env.GS_AGUI_E2E_URL ?? "";
const AGENT = process.env.GS_AGUI_E2E_AGENT ?? "";
const WS = process.env.GS_AGUI_E2E_WS ?? "";

describe.skipIf(!URL_GS || !AGENT || !WS)("gs-agui extremo a extremo (agente simulado)", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    process.env.GHOSTY_RUNTIME_URL = URL_GS;
    // La base de Teams no existe aquí: las lecturas de contexto contestan vacío.
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes("/v2/pipeline")) {
        const reqs = JSON.parse(init.body).requests as any[];
        const results = reqs.map((r) => (r.type === "close" ? { type: "ok", response: { type: "close" } } : { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } }));
        return new Response(JSON.stringify({ baton: null, base_url: null, results }), { headers: { "content-type": "application/json" } });
      }
      return realFetch(url, init);
    }) as any;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const thread = () => `e2e-teams-${crypto.randomUUID().slice(0, 8)}`;

  async function turn(text: string, o: { groupId?: string; inject?: boolean; messageRef?: number; resume?: string; signal?: AbortSignal; onDurable?: (t: string) => void; onReplyTo?: (ids: number[]) => void } = {}) {
    const { callAgentBackendStream } = await import("../agents.server");
    const { withNamespace } = await import("./tenant.server");
    const chunks: string[] = [];
    const tools: ToolEvent[] = [];
    const truncated: TruncatedEvent[] = [];
    const failures: string[] = [];
    const attachments: unknown[] = [];
    const models: string[] = [];
    const reply = await withNamespace(WS, () =>
      callAgentBackendStream(
        { handle: "build", name: "Build", avatar: "", systemPrompt: null, backend: { kind: "fleet", id: AGENT, token: "", runtime: "gs-native" } } as any,
        o.groupId ?? thread(), "e2e", text, (c) => void chunks.push(c), [], (ev) => void tools.push(ev), null, undefined, o.signal, null,
        o.inject, "http://localhost", false, (t) => void truncated.push(t), (f) => void failures.push(f.message), false, (m) => void models.push(m),
        { resumeTurnId: o.resume, onDurable: o.onDurable, messageRef: o.messageRef, onReplyTo: (ids) => void o.onReplyTo?.(ids), onAttachmentsFailed: (f) => void attachments.push(f) },
      ),
    );
    return { reply, chunks, tools, truncated, failures, attachments, models };
  }

  // Seguro en PRODUCCIÓN (turno real y corto, sin herramientas): `-t "prod-seguro"`.
  test("prod-seguro: turno corto y reenganche al run ya terminado", async () => {
    const groupId = thread();
    let runId = "";
    const r = await turn("Responde únicamente OK. No uses herramientas.", { groupId, onDurable: (t) => (runId = t) });
    expect(r.failures).toEqual([]);
    expect(r.reply.trim()).toMatch(/OK/);
    expect(r.chunks.join("").trim()).toBe(r.reply.trim());
    expect(runId).toMatch(/^teams:/);
    expect(r.models.length).toBe(1);
    // Adopción de un run terminado: no abre otro turno, repite su cierre con el mismo texto.
    const again = await turn("", { groupId, resume: runId });
    expect(again.failures).toEqual([]);
    expect(again.reply.trim()).toBe(r.reply.trim());
  }, 120_000);

  test("turno simple: el texto en vivo y el autoritativo coinciden", async () => {
    const r = await turn("hola");
    expect(r.failures).toEqual([]);
    expect(r.reply.length).toBeGreaterThan(0);
    // El `result` de gs viene recortado (trim); lo demás tiene que coincidir letra por letra.
    expect(r.chunks.join("").trim()).toBe(r.reply.trim());
  }, 60_000);

  test("plan + ayudante + falla + adjunto + truncado", async () => {
    const r = await turn("plan ayudante falla adjunto truncado");
    expect(r.failures).toEqual([]);
    expect(r.tools.some((t) => t.todos?.length)).toBe(true);
    expect(r.tools.some((t) => t.name === "gs_subagent_child" && t.sub?.kind === "start")).toBe(true);
    expect(r.tools.some((t) => t.phase === "end" && t.ok === false)).toBe(true);
    expect(r.attachments.length).toBe(1);
    expect(r.truncated.length).toBe(1);
    // Cada tool que arrancó, cerró.
    const started = new Set(r.tools.filter((t) => t.phase === "start" && t.name !== "gs_subagent_child").map((t) => t.id));
    const ended = new Set(r.tools.filter((t) => t.phase === "end").map((t) => t.id));
    for (const id of started) expect(ended.has(id)).toBe(true);
  }, 90_000);

  test("RUN_ERROR = aviso de falla, sin reintento", async () => {
    const r = await turn("error");
    expect(r.failures.length).toBe(1);
    expect(r.reply).toMatch(/No pude contactar a @build/);
  }, 60_000);

  test("steer a un run vivo: INJECTED y el vivo avisa reply_to con mi id", async () => {
    const groupId = thread();
    const replyTo: number[][] = [];
    const vivo = turn("lento", { groupId, onReplyTo: (ids) => replyTo.push(ids) });
    await new Promise((r) => setTimeout(r, 4_000));
    const { INJECTED } = await import("../agents.server");
    const s = await turn("y también esto", { groupId, inject: true, messageRef: 777 });
    expect(s.reply).toBe(INJECTED);
    const v = await vivo;
    expect(v.failures).toEqual([]);
    expect(replyTo).toContainEqual([777]);
  }, 90_000);

  test("Detener corta el run en gs (forwardedProps.cancel)", async () => {
    const groupId = thread();
    const ac = new AbortController();
    let runId = "";
    const p = turn("lento", { groupId, signal: ac.signal, onDurable: (t) => (runId = t) });
    await new Promise((r) => setTimeout(r, 3_000));
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(runId).toMatch(/^teams:/);
    await new Promise((r) => setTimeout(r, 1_500));
    // Reenganchar al mismo run: ya terminó (cancelado), y repite su cierre.
    const again = await turn("", { groupId, resume: runId });
    expect(again.failures).toEqual([]);
  }, 90_000);

  test("adopción tras «reinicio»: mismo runId con messages:[] rehace la burbuja", async () => {
    const groupId = thread();
    const ac = new AbortController();
    let runId = "";
    const original = turn("lento plan", { groupId, signal: ac.signal, onDurable: (t) => (runId = t) });
    await new Promise((r) => setTimeout(r, 4_000));
    // Otro lector (como el Teams que arranca tras un deploy) se engancha al mismo run.
    expect(runId).toMatch(/^teams:/);
    const adoptada = await turn("", { groupId, resume: runId });
    expect(adoptada.failures).toEqual([]);
    expect(adoptada.chunks.join("").trim()).toBe(adoptada.reply.trim());
    expect(adoptada.tools.some((t) => t.todos?.length)).toBe(true);
    ac.abort(); // ya terminó: el cancel llega a un run cerrado y no hace nada
    await original.catch(() => {});
  }, 120_000);

  test("runId desconocido = 404 → aviso de falla (Continuar)", async () => {
    const r = await turn("", { resume: `teams:no-existe-${Date.now()}` });
    expect(r.failures[0]).toMatch(/404 run_not_found/);
  }, 60_000);

  test("steerRole: injectOnly sin run vivo = 409 run_not_live", async () => {
    const { buildRunInput, httpErrorOf } = await import("./gs-agui.server");
    const { partnerHeaders } = await import("./ghosty-runtime.server");
    const body = JSON.stringify(buildRunInput({ threadId: thread(), runId: `teams:${crypto.randomUUID()}`, message: { id: "9001", text: "nota" }, forwardedProps: { configGroupId: "teams", sender: "plataforma", steer: true, injectOnly: true } }));
    const res = await realFetch(`${URL_GS}/api/v2/fleet-agents/${AGENT}/agui`, { method: "POST", headers: { ...partnerHeaders(body, WS), Accept: "text/event-stream" }, body, signal: AbortSignal.timeout(10_000) });
    const e = await httpErrorOf(res);
    expect([e.status, e.code]).toEqual([409, "run_not_live"]);
  }, 30_000);
});
