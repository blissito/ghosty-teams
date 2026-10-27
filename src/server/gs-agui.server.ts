// ── Cliente AG-UI del runtime nativo (Teams → Ghosty Studio) ──────────────────
//
// Contrato: gs-agui 1 (`~/ghosty-studio/docs/claude/agui-adopcion.md` §0 y §0.7c), endpoint
// `POST /api/v2/fleet-agents/:id/agui` con la firma de workspace de siempre. Reemplaza
// `turns` + `turns/:id/events` + `turns/:id/cancel` + `message-stream` contra gs. Ver
// `docs/agui-migracion.md`.
//
// Este módulo NO conoce burbujas ni base de datos: lee eventos AG-UI y los entrega a los
// mismos callbacks que ya usa `runAgentTurn` (`onChunk`, `onTool`, …). Así el resto de Teams
// no se entera del cambio de protocolo.
//
// ⚠️ Un mismo run se puede leer varias veces (reconexión tras un corte, o adopción tras un
// reinicio de Teams). gs re-emite lo abierto ACUMULADO (§0.7b.4) y repite estado, así que
// el lector guarda lo que ya entregó y sólo pasa lo nuevo. Por eso se crea UN lector por
// turno y se le dan todos los streams de ese turno, no uno por stream.
import type { MediaPart, SubEvent, ToolEvent, TruncatedEvent } from "../agents.server";
import type { TodoItem } from "../lib/ebdoc";
import { cleanStepResult, type StepResult } from "@ghostystudio/computer";
import { denialText } from "./ghosty-runtime.server";

/** El `content` de un TOOL_CALL_RESULT: gs manda ahí el `result` del worker en JSON (vacío si no hay). */
function resultOf(content: unknown): StepResult | undefined {
  if (typeof content !== "string" || !content.startsWith("{")) return undefined;
  try {
    return cleanStepResult(JSON.parse(content));
  } catch {
    return undefined;
  }
}

/** Lo que el turno cuenta mientras corre. Todos opcionales menos el texto. */
export type AguiHandlers = {
  onChunk: (text: string) => void | Promise<void>;
  onTool?: (ev: ToolEvent) => void | Promise<void>;
  onTruncated?: (ev: TruncatedEvent) => void;
  onModel?: (model: string) => void;
  /** gs aceptó el run: a partir de aquí sobrevive aunque esta conexión se caiga. */
  onRunStarted?: (runId: string) => void;
  onReplyTo?: (messageIds: number[], folded: boolean) => void | Promise<void>;
  onAttachmentsFailed?: (failed: { name: string; reason: string }[]) => void;
  /** Vigilante de atascos de gs (`ghosty.stalled`, mismo payload que el frame viejo). */
  onStalled?: (frame: Record<string, unknown>) => void;
};

export type AguiOutcome =
  /** El mensaje entró al run vivo: la respuesta sale por la burbuja de aquel turno. */
  | { kind: "injected" }
  | { kind: "finished"; text: string; cancelled: boolean };

/** El run terminó en `RUN_ERROR` (o pidió permiso, que Teams no sabe contestar). */
export class AguiRunError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AguiRunError";
    this.code = code;
  }
}

/** Respuesta HTTP no-SSE de gs (`{error, message}`). `retryAfterMs` sale de `Retry-After`. */
export class AguiHttpError extends Error {
  status: number;
  code: string;
  retryAfterMs?: number;
  /** El `message` de gs tal cual (en un 402 es el aviso de saldo para la persona). */
  detail: string;
  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(`gs-agui ${status} ${code}: ${message}`);
    this.name = "AguiHttpError";
    this.status = status;
    this.code = code;
    this.detail = message;
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Request ─────────────────────────────────────────────────────────────────

/** Id del mensaje de usuario. Numérico (id de Teams) cuando lo hay: vuelve en `reply_to`/`injected`. */
export function userMessageId(runId: string, messageRef?: number | null): string {
  return messageRef != null && Number.isFinite(messageRef) ? String(messageRef) : `${runId}:u`;
}

/** FileParts A2A (lo que arma `buildMediaParts`) → content parts de AG-UI. */
export function contentParts(text: string, parts: MediaPart[]): unknown[] {
  const out: unknown[] = [{ type: "text", text }];
  for (const p of parts) {
    const f = p?.file;
    if (!f || (!f.uri && !f.bytes)) continue;
    const type = f.mimeType?.startsWith("image/") ? "image" : "document";
    out.push({
      type,
      source: f.uri ? { type: "url", value: f.uri } : { type: "data", value: f.bytes, mimeType: f.mimeType },
      mimeType: f.mimeType,
      ...(f.name ? { filename: f.name } : {}),
    });
  }
  return out;
}

/**
 * `RunAgentInput`. `message` ausente = reconectar/adoptar (`messages: []`). Lo que no es
 * estándar va en `forwardedProps` (contrato: §0.7c + lo acordado para Teams).
 */
export function buildRunInput(opts: {
  threadId: string;
  runId: string;
  message?: { id: string; text: string; parts?: MediaPart[] } | null;
  forwardedProps?: Record<string, unknown>;
}): Record<string, unknown> {
  const m = opts.message;
  return {
    threadId: opts.threadId,
    runId: opts.runId,
    messages: m ? [{ id: m.id, role: "user", content: m.parts?.length ? contentParts(m.text, m.parts) : m.text }] : [],
    state: {},
    tools: [],
    context: [],
    forwardedProps: { permissions: "auto", ...(opts.forwardedProps ?? {}) },
  };
}

/** Lee una respuesta que no es SSE como el error que es. 2xx sin SSE también es error. */
export async function httpErrorOf(res: Response): Promise<AguiHttpError> {
  const raw = await res.text().catch(() => "");
  let code = "http";
  let message = raw.slice(0, 300);
  try {
    const j = JSON.parse(raw) as { error?: string; message?: string; setupUrl?: string; payUrl?: string };
    code = j.error || code;
    message = j.message || j.error || message;
    // 402: es lo que el agente dice en el chat (guía con saltos y su liga).
    if (res.status === 402 && j.message) message = denialText(j);
  } catch { /* cuerpo no-JSON */ }
  const ra = Number(res.headers.get("retry-after"));
  return new AguiHttpError(res.status, code, message, ra > 0 ? ra * 1000 : undefined);
}

// ── JSON Patch mínimo (STATE_DELTA) ─────────────────────────────────────────

function unescape(seg: string) {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** RFC 6902 lo justo para `state`: add/replace/remove (move/copy/test no los usa gs). */
export function applyPatch(doc: unknown, ops: { op: string; path: string; value?: unknown }[]): unknown {
  let root: any = structuredClone(doc ?? {});
  for (const op of ops ?? []) {
    if (!op || typeof op.path !== "string") continue;
    const segs = op.path.split("/").slice(1).map(unescape);
    if (!segs.length) {
      if (op.op === "add" || op.op === "replace") root = structuredClone(op.value);
      continue;
    }
    let cur: any = root;
    for (const s of segs.slice(0, -1)) {
      if (cur == null || typeof cur !== "object") break;
      cur = cur[s];
    }
    if (cur == null || typeof cur !== "object") continue;
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
      const i = last === "-" ? cur.length : Number(last);
      if (!Number.isInteger(i)) continue;
      if (op.op === "add") cur.splice(i, 0, structuredClone(op.value));
      else if (op.op === "replace") cur[i] = structuredClone(op.value);
      else if (op.op === "remove") cur.splice(i, 1);
    } else if (op.op === "add" || op.op === "replace") cur[last] = structuredClone(op.value);
    else if (op.op === "remove") delete cur[last];
  }
  return root;
}

// ── Lector ──────────────────────────────────────────────────────────────────

type TaskRow = {
  id?: string;
  title?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: { tokens?: number; toolUses?: number };
  lastTool?: string;
  summary?: string;
};

const PULSE_MS = 20_000;

const SUB_END: Record<string, NonNullable<SubEvent["status"]>> = { completed: "done", failed: "failed", stopped: "canceled" };

/**
 * Un lector por TURNO. `read()` consume un stream SSE de ese run y devuelve el desenlace, o
 * `null` si el stream se acabó sin `RUN_FINISHED` (corte de red: el llamador reconecta con
 * el mismo `runId` y le pasa el stream nuevo a este mismo lector).
 */
export class AguiTurnReader {
  /** runId del run VIVO (el de `RUN_STARTED`; en un steer es el del otro turno). */
  runId: string | null = null;
  /** Texto por mensaje, en orden de llegada. Concatenado = lo que lleva la burbuja. */
  private texts = new Map<string, string>();
  /** Mensaje que gs está re-emitiendo tras reconectar: lo ya entregado no se repite. */
  private replay = new Map<string, string>();
  private toolNames = new Map<string, string>();
  private toolArgs = new Map<string, string>();
  /** Inicio retenido hasta saber su `ghosty.tool` (el rótulo llega justo después). */
  private pendingStart: string | null = null;
  private toolDetail = new Map<string, string>();
  private toolCommand = new Map<string, string>();
  private started = new Set<string>();
  /** Cuándo arrancó cada tool: el reloj de la fila lo lleva Teams (gs ya no manda `progress`). */
  private startAt = new Map<string, number>();
  private ended = new Set<string>();
  /** Cerradas por `TOOL_CALL_END` esperando su `TOOL_CALL_RESULT` (que trae si falló). */
  private awaitingResult = new Set<string>();
  private once = new Set<string>();
  private state: any = {};
  private subs = new Map<string, { lastTool?: string; ended: boolean }>();
  private replaced: string | null = null;
  private notifiedStart = false;

  constructor(private h: AguiHandlers) {}

  get text(): string {
    return [...this.texts.values()].join("");
  }

  /** Para el reintento ciego: ¿ya hubo trabajo visible? */
  get hadOutput(): boolean {
    return this.texts.size > 0 || this.started.size > 0;
  }

  async read(body: ReadableStream<Uint8Array>, opts: { idleMs: number }): Promise<AguiOutcome | null> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // Latido de las tools abiertas cada 20 s: una tool larga (build, tests) no emite nada por
    // minutos y sin reloj la burbuja parece colgada (3-oct).
    const pulse = setInterval(() => {
      const now = Date.now();
      for (const [id, at] of this.startAt) {
        if (!this.ended.has(id)) void this.h.onTool?.({ id, phase: "progress", elapsedMs: now - at });
      }
    }, PULSE_MS);
    pulse.unref?.();
    try {
      for (;;) {
        let idle: ReturnType<typeof setTimeout> | undefined;
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idle = setTimeout(() => reject(new Error(`terminated (sin datos en ${opts.idleMs / 1000} s)`)), opts.idleMs);
          }),
        ]).finally(() => clearTimeout(idle));
        if (done) return null;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          // SSE: varias líneas `data:` de un evento se unen con \n. `: ping` y `id:` se ignoran.
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const out = await this.handle(ev);
          if (out) return out;
        }
      }
    } finally {
      clearInterval(pulse);
      await reader.cancel().catch(() => {});
    }
  }

  private async flushStart(): Promise<void> {
    const id = this.pendingStart;
    if (!id) return;
    this.pendingStart = null;
    if (this.started.has(id)) return;
    this.started.add(id);
    this.startAt.set(id, Date.now());
    const command = this.toolCommand.get(id);
    await this.h.onTool?.({ name: this.toolNames.get(id), id, phase: "start", detail: this.toolDetail.get(id), ...(command ? { command } : {}) });
  }

  private async endTool(id: string, ok: boolean, result?: StepResult): Promise<void> {
    this.awaitingResult.delete(id);
    if (this.ended.has(id)) return;
    this.ended.add(id);
    await this.h.onTool?.({ id, phase: "end", ok, ...(result ? { result } : {}) });
  }

  private async closeAwaiting(): Promise<void> {
    for (const id of [...this.awaitingResult]) await this.endTool(id, true);
  }

  /** Lo nuevo de un delta, descontando lo que ya se entregó de ese mensaje antes de reconectar. */
  private async text_(messageId: string, delta: string): Promise<void> {
    if (!delta) return;
    const known = this.texts.get(messageId) ?? "";
    const rep = this.replay.get(messageId);
    if (rep !== undefined) {
      const acc = rep + delta;
      if (acc.length <= known.length) {
        this.replay.set(messageId, acc);
        return;
      }
      this.replay.delete(messageId);
      const fresh = acc.slice(known.length);
      this.texts.set(messageId, acc);
      await this.h.onChunk(fresh);
      return;
    }
    this.texts.set(messageId, known + delta);
    await this.h.onChunk(delta);
  }

  /** Repite un aviso sólo una vez aunque gs lo re-emita al reconectar. */
  private first(key: string): boolean {
    if (this.once.has(key)) return false;
    this.once.add(key);
    return true;
  }

  private async subagents(): Promise<void> {
    const tasks = (this.state?.subagents?.tasks ?? []) as TaskRow[];
    for (const t of tasks) {
      if (!t?.id) continue;
      const usage = { toolUses: t.usage?.toolUses ?? 0, tokens: t.usage?.tokens ?? 0 };
      let st = this.subs.get(t.id);
      if (!st) {
        st = { ended: false };
        this.subs.set(t.id, st);
        await this.h.onTool?.({ name: "gs_subagent_child", id: t.id, phase: "start", sub: { kind: "start", name: t.title, task: t.title, startedAt: t.startedAt, ...usage } });
      }
      if (t.lastTool && t.lastTool !== st.lastTool) {
        st.lastTool = t.lastTool;
        const [tool, ...rest] = t.lastTool.split(" · ");
        await this.h.onTool?.({ name: "gs_subagent_child", id: t.id, phase: "start", sub: { kind: "step", tool, detail: rest.join(" · "), ...usage } });
      }
      const end = t.status ? SUB_END[t.status] : undefined;
      if (!st.ended && end) {
        st.ended = true;
        await this.h.onTool?.({
          name: "gs_subagent_child", id: t.id, phase: "start",
          sub: { kind: "end", status: end, ms: t.endedAt && t.startedAt ? t.endedAt - t.startedAt : undefined, preview: t.summary ?? undefined, ...usage },
        });
        await this.h.onTool?.({ id: t.id, phase: "end", ok: end === "done" });
      }
    }
  }

  private async handle(ev: any): Promise<AguiOutcome | null> {
    const type = String(ev?.type ?? "");
    // El rótulo (`ghosty.tool`) llega justo tras el START; cualquier otro evento suelta el inicio.
    if (this.pendingStart && !(type === "CUSTOM" && ev.name === "ghosty.tool")) await this.flushStart();
    switch (type) {
      case "RUN_STARTED":
        this.runId = typeof ev.runId === "string" ? ev.runId : this.runId;
        if (!this.notifiedStart && this.runId) {
          this.notifiedStart = true;
          this.h.onRunStarted?.(this.runId);
        }
        return null;
      case "MESSAGES_SNAPSHOT": {
        // Teams guarda su propio hilo; del snapshot sólo sirve lo que ESTE run ya cerró
        // (ids `<runId>:…`): su texto y sus herramientas, para que una adopción rehaga la burbuja.
        const prefix = this.runId ? `${this.runId}:` : null;
        if (!prefix) return null;
        const mine = (Array.isArray(ev.messages) ? ev.messages : []).filter((m: any) => typeof m?.id === "string" && m.id.startsWith(prefix));
        for (const m of mine) {
          if (m.role === "assistant") {
            const content = typeof m.content === "string" ? m.content : "";
            const known = this.texts.get(m.id) ?? "";
            // Nuevo, o uno que se cerró mientras estábamos desconectados: sólo falta la cola.
            if (content.length > known.length && content.startsWith(known)) {
              this.texts.set(m.id, content);
              await this.h.onChunk(content.slice(known.length));
            }
            const rotulos = new Map<string, string>();
            for (const c of Array.isArray(m.metadata?.custom) ? m.metadata.custom : []) {
              if (c?.name === "ghosty.tool" && c.value?.toolCallId) rotulos.set(String(c.value.toolCallId), String(c.value.detail ?? c.value.path ?? ""));
            }
            for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
              const id = String(tc?.id ?? "");
              if (!id || this.started.has(id)) continue;
              this.toolNames.set(id, String(tc.function?.name ?? ""));
              if (rotulos.get(id)) this.toolDetail.set(id, rotulos.get(id)!);
              this.pendingStart = id;
              await this.flushStart();
              // El plan de un TodoWrite ya cerrado viaja en sus argumentos (igual que en vivo).
              if (tc.function?.name === "TodoWrite") {
                try {
                  const todos = (JSON.parse(String(tc.function.arguments || "{}")) as { todos?: TodoItem[] }).todos;
                  if (Array.isArray(todos) && todos.length) await this.h.onTool?.({ name: "TodoWrite", id, phase: "start", todos });
                } catch { /* args no JSON */ }
              }
            }
          } else if (m.role === "tool" && typeof m.toolCallId === "string" && this.started.has(m.toolCallId)) {
            await this.endTool(m.toolCallId, !m.error, resultOf(m.content));
          }
        }
        return null;
      }
      case "TEXT_MESSAGE_START":
        // Ya conocido = gs lo está re-emitiendo acumulado tras reconectar.
        if (typeof ev.messageId === "string" && this.texts.has(ev.messageId)) this.replay.set(ev.messageId, "");
        return null;
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_CHUNK":
        if (typeof ev.delta === "string") await this.text_(String(ev.messageId ?? "_"), ev.delta);
        return null;
      case "TEXT_MESSAGE_END":
        this.replay.delete(String(ev.messageId ?? ""));
        return null;
      case "TOOL_CALL_START": {
        const id = String(ev.toolCallId ?? "");
        if (!id) return null;
        await this.closeAwaiting();
        if (typeof ev.toolCallName === "string") this.toolNames.set(id, ev.toolCallName);
        if (!this.started.has(id)) this.pendingStart = id;
        return null;
      }
      case "TOOL_CALL_ARGS": {
        const id = String(ev.toolCallId ?? "");
        if (id && typeof ev.delta === "string") this.toolArgs.set(id, (this.toolArgs.get(id) ?? "") + ev.delta);
        return null;
      }
      case "TOOL_CALL_END": {
        const id = String(ev.toolCallId ?? "");
        if (!id) return null;
        // El plan (TodoWrite) viaja en los args: se entrega como un inicio más con `todos`,
        // que es como lo pinta `runAgentTurn` (el `started` es un Set, repetir no duplica).
        if (this.toolNames.get(id) === "TodoWrite") {
          try {
            const todos = (JSON.parse(this.toolArgs.get(id) || "{}") as { todos?: TodoItem[] }).todos;
            if (Array.isArray(todos) && todos.length) await this.h.onTool?.({ name: "TodoWrite", id, phase: "start", todos });
          } catch { /* args incompletos */ }
        }
        this.toolArgs.delete(id);
        if (!this.ended.has(id)) this.awaitingResult.add(id);
        return null;
      }
      case "TOOL_CALL_RESULT": {
        const id = String(ev.toolCallId ?? "");
        if (id) await this.endTool(id, !(ev.metadata?.error === true || (typeof ev.error === "string" && ev.error)), resultOf(ev.content));
        return null;
      }
      case "STATE_SNAPSHOT":
        this.state = ev.snapshot ?? {};
        await this.subagents();
        return null;
      case "STATE_DELTA":
        this.state = applyPatch(this.state, Array.isArray(ev.delta) ? ev.delta : []);
        await this.subagents();
        return null;
      case "CUSTOM":
        return this.custom(String(ev.name ?? ""), ev.value ?? {});
      case "RUN_ERROR":
        throw new AguiRunError(String(ev.message || "error del agente"), typeof ev.code === "string" ? ev.code : undefined);
      case "RUN_FINISHED":
        return this.finish(ev);
      default:
        // REASONING_*, STEP_* (despertando la caja…): Teams no los pinta.
        return null;
    }
  }

  private async custom(name: string, v: any): Promise<AguiOutcome | null> {
    switch (name) {
      case "ghosty.tool": {
        const id = String(v.toolCallId ?? "");
        if (!id) return null;
        const detail = typeof v.detail === "string" ? v.detail : typeof v.path === "string" ? v.path : undefined;
        if (detail) this.toolDetail.set(id, detail);
        if (typeof v.command === "string" && v.command) this.toolCommand.set(id, v.command);
        if (this.pendingStart === id) await this.flushStart();
        return null;
      }
      case "ghosty.todos": {
        // El plan que cambió al CERRAR una tool (TaskCreate/TaskUpdate): se entrega como el de
        // TodoWrite, con id propio para no pisar la fila de la tool que lo cambió.
        const todos = Array.isArray(v.todos) ? (v.todos as TodoItem[]) : [];
        if (todos.length && this.first(`todos:${JSON.stringify(todos)}`)) await this.h.onTool?.({ name: "TodoWrite", id: `${String(v.toolCallId ?? "plan")}:plan`, phase: "start", todos });
        return null;
      }
      case "ghosty.browser": {
        // Captura del navegador de la caja (`cloud_browser_*`) para la computadora del agente.
        if (typeof v.data !== "string" || !v.data || !v.frame || typeof v.frame !== "object") return null;
        await this.h.onTool?.({ ...(v.toolCallId ? { id: String(v.toolCallId) } : {}), phase: "frame", frame: v.frame, data: v.data, mimeType: typeof v.mimeType === "string" ? v.mimeType : "image/jpeg" });
        return null;
      }
      case "ghosty.injected":
        return { kind: "injected" };
      case "ghosty.reply_to": {
        const ids = (Array.isArray(v.messageIds) ? v.messageIds : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
        if (ids.length && this.first(`reply_to:${ids.join(",")}`)) await this.h.onReplyTo?.(ids, v.folded === true);
        return null;
      }
      case "ghosty.attachments_failed": {
        // Acordado: `failed:[{name,reason}]`. `names` + `message` es la forma general del contrato.
        const failed: { name: string; reason: string }[] = Array.isArray(v.failed)
          ? v.failed.map((f: any) => ({ name: String(f?.name ?? "archivo"), reason: String(f?.reason ?? "") }))
          : (Array.isArray(v.names) ? v.names : []).map((n: unknown) => ({ name: String(n), reason: String(v.message ?? "") }));
        if (failed.length && this.first(`attachments:${JSON.stringify(failed)}`)) this.h.onAttachmentsFailed?.(failed);
        return null;
      }
      case "ghosty.stalled":
        if (this.first(`stalled:${v.rule}|${v.tool}|${v.since}`)) this.h.onStalled?.(v);
        return null;
      case "ghosty.replace":
        if (typeof v.content === "string") this.replaced = v.content;
        return null;
      default:
        return null;
    }
  }

  private async finish(ev: any): Promise<AguiOutcome> {
    await this.closeAwaiting();
    const outcome = String(ev.outcome?.type ?? "success");
    if (outcome === "interrupt") {
      // Teams pide `permissions:"auto"`: un interrupt aquí es un contrato roto, no una pregunta.
      throw new AguiRunError("el agente pidió permiso y este canal no sabe contestarlo", "interrupt");
    }
    const meta = ev.metadata ?? {};
    const tr = meta.truncated;
    if (tr && typeof tr === "object") {
      this.h.onTruncated?.({ subtype: String(tr.subtype ?? "unknown"), classification: tr.classification, numTurns: tr.numTurns, stopReason: tr.stopReason, notice: tr.notice });
    } else if (meta.interrupted && typeof meta.interrupted === "object") {
      // gs perdió el turno (deploy, caja caída): lo dicho se conserva y se ofrece reintentar.
      this.h.onTruncated?.({ subtype: "interrupted", classification: "retryable", notice: "event" });
    }
    const model = Array.isArray(ev.usage) ? ev.usage.find((u: any) => typeof u?.model === "string" && u.model)?.model : undefined;
    if (model) this.h.onModel?.(model);
    const result = typeof ev.result === "string" && ev.result ? ev.result : null;
    return { kind: "finished", text: this.replaced ?? result ?? this.text, cancelled: outcome === "cancelled" };
  }
}
