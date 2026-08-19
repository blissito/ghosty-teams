// ── Cliente ACP (Agent Client Protocol) ───────────────────────────────────────
//
// Teams como CLIENTE de un agente que corre aislado en su propia microVM.
//
// ACP y A2A no compiten: A2A conecta agentes de organizaciones distintas, ACP conecta a una
// PERSONA con un agente. Lo que ACP trae y A2A no es `session/request_permission` — el agente
// se detiene a pedir autorización antes de actuar— y resulta que un hilo es mejor superficie
// de aprobación que un modal en un IDE: es asíncrono, lo ve el equipo, y queda como bitácora.
//
// EL TRANSPORTE. ACP asume que el cliente LANZA al agente como proceso hijo y le habla por
// stdin/stdout. Cruzando la red no hay relación padre-hijo, así que en la caja hay un relé que
// es el padre y retransmite por WebSocket. La spec dice que el protocolo es transport-agnostic
// y permite transportes propios; hay un RFD de WebSocket en borrador, y el día que aterrice
// esto se conecta igual.
//
// NO declaramos `clientCapabilities.fs` ni `.terminal`: omitidas significan NO SOPORTADAS, y
// entonces el agente usa su propio disco y su propia terminal — que es justo lo que queremos
// con una microVM, y hacia donde va ACP v2 (su RFD las elimina del cliente).

import crypto from "node:crypto";
import WebSocket from "ws";

/** Lo que el agente va contando mientras trabaja. */
export type AcpUpdate =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id?: string; title?: string; status?: string }
  | { kind: "plan"; entries: { content: string; status?: string }[] }
  | { kind: "otro"; tipo: string };

/** El agente pide autorización y NO sigue hasta que se le conteste. */
export type AcpPermission = {
  requestId: number | string;
  title: string;
  options: { id: string; label: string; kind?: string }[];
};

export interface AcpTurn {
  wsUrl: string;
  /** Namespace del tenant. Va FIRMADO: el secreto es global y sin él un ticket valdría en cualquier caja. */
  workspaceNs: string;
  /** Quién pregunta, para la bitácora del otro lado. */
  sub: string;
  /** La conversación. Mapea a una sesión de ACP; `session/load` la retoma. */
  sessionId?: string;
  text: string;
  cwd?: string;
  onUpdate: (u: AcpUpdate) => void | Promise<void>;
  /**
   * El agente pide permiso. Devuelve el `id` de la opción elegida, o `null` para rechazar.
   * Mientras esta promesa no resuelva, el agente está DETENIDO — y su caja no hiberna,
   * porque el relé cuenta el socket abierto como trabajo en vuelo.
   */
  onPermission?: (p: AcpPermission) => Promise<string | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AcpResult {
  text: string;
  sessionId: string;
  stopReason?: string;
}

/** Firma el ticket de conexión. El `ns` va dentro: sin él serviría contra la caja de otro. */
export function acpTicketUrl(wsUrl: string, ns: string, sub: string): string {
  const secret = process.env.ACP_TICKET_SECRET;
  if (!secret) return wsUrl; // sin secreto, la URL no adivinable de la caja es la capability
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${ns}.${sub}`).digest("hex");
  const u = new URL(wsUrl);
  u.searchParams.set("ts", ts);
  u.searchParams.set("ns", ns);
  u.searchParams.set("sub", sub);
  u.searchParams.set("sig", sig);
  return u.toString();
}

/** Un turno completo: conecta, negocia, abre o retoma sesión, manda el prompt y espera. */
export async function runAcpTurn(t: AcpTurn): Promise<AcpResult> {
  const ws = new WebSocket(acpTicketUrl(t.wsUrl, t.workspaceNs, t.sub));
  const pendientes = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  let seq = 0;
  let texto = "";

  const enviar = (o: unknown) => ws.send(JSON.stringify(o));
  const llama = (method: string, params: unknown) =>
    new Promise<any>((res, rej) => {
      const id = ++seq;
      pendientes.set(id, { ok: res, err: rej });
      enviar({ jsonrpc: "2.0", id, method, params });
    });

  const cerrar = () => {
    try {
      ws.close();
    } catch {
      /* ya cerrado */
    }
  };

  try {
    await new Promise<void>((res, rej) => {
      // Si el sidecar no responde, se falla rápido en vez de colgar el turno del usuario —
      // misma decisión que tomó el broker de co-edición.
      const to = setTimeout(() => rej(new Error("timeout conectando con el agente")), t.timeoutMs ?? 15_000);
      ws.once("open", () => {
        clearTimeout(to);
        res();
      });
      ws.once("error", (e: Error) => {
        clearTimeout(to);
        rej(e);
      });
    });

    t.signal?.addEventListener("abort", cerrar, { once: true });

    ws.on("message", (d: Buffer | string) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue; // una línea mala se salta; no puede terminar la sesión
        }

        // Respuesta a algo que pedimos.
        if (m.id != null && pendientes.has(m.id)) {
          const p = pendientes.get(m.id)!;
          pendientes.delete(m.id);
          m.error ? p.err(new Error(m.error.message ?? "error del agente")) : p.ok(m.result);
          continue;
        }

        // Notificación de progreso.
        if (m.method === "session/update") {
          void handleUpdate(m.params?.update ?? {}, t, (s) => (texto += s));
          continue;
        }

        // ⚠️ El AGENTE nos llama a NOSOTROS. ACP es full-duplex, y aquí está lo que lo
        // distingue: si esto no se contesta, el agente se queda detenido para siempre.
        if (m.method === "session/request_permission" && m.id != null) {
          void responderPermiso(m, t, enviar);
          continue;
        }
        // Cualquier otra petición del agente se rechaza explícitamente: dejarla sin
        // contestar lo dejaría colgado, y fingir que la soportamos sería peor.
        if (m.method && m.id != null) {
          enviar({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no soportado: ${m.method}` } });
        }
      }
    });

    await llama("initialize", {
      protocolVersion: 1,
      // Sin fs ni terminal: el agente usa los suyos, dentro de su caja.
      clientCapabilities: {},
    });

    // `session/load` retoma la conversación; si el agente no lo soporta, se abre una nueva.
    let sessionId = t.sessionId ?? "";
    if (sessionId) {
      try {
        await llama("session/load", { sessionId, cwd: t.cwd ?? "/data/work", mcpServers: [] });
      } catch {
        sessionId = "";
      }
    }
    if (!sessionId) {
      const s = await llama("session/new", { cwd: t.cwd ?? "/data/work", mcpServers: [] });
      sessionId = s?.sessionId ?? "";
    }

    const fin = await llama("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: t.text }],
    });

    return { text: texto, sessionId, stopReason: fin?.stopReason };
  } finally {
    cerrar();
  }
}

/** Traduce un `session/update` al vocabulario que el chat ya sabe pintar. */
async function handleUpdate(u: any, t: AcpTurn, acumula: (s: string) => void): Promise<void> {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const s = u.content?.text ?? "";
      if (!s) return;
      acumula(s);
      await t.onUpdate({ kind: "text", text: s });
      return;
    }
    case "agent_thought_chunk":
      // El razonamiento NO entra en el texto de la respuesta: es contexto, no contenido.
      await t.onUpdate({ kind: "thought", text: u.content?.text ?? "" });
      return;
    case "tool_call":
    case "tool_call_update":
      await t.onUpdate({ kind: "tool", id: u.toolCallId, title: u.title, status: u.status });
      return;
    case "plan":
      await t.onUpdate({
        kind: "plan",
        entries: Array.isArray(u.entries)
          ? u.entries.map((e: any) => ({ content: String(e?.content ?? ""), status: e?.status }))
          : [],
      });
      return;
    default:
      // Un update que no conocemos NO se tira en silencio: ACP sigue creciendo (v2 está en
      // RFD) y saber que llegó algo nuevo vale más que fingir que no existe.
      await t.onUpdate({ kind: "otro", tipo: String(u.sessionUpdate ?? "desconocido") });
  }
}

async function responderPermiso(m: any, t: AcpTurn, enviar: (o: unknown) => void): Promise<void> {
  const opciones = Array.isArray(m.params?.options)
    ? m.params.options.map((o: any) => ({ id: String(o?.optionId ?? o?.id ?? ""), label: String(o?.name ?? o?.label ?? ""), kind: o?.kind }))
    : [];
  const titulo = String(m.params?.toolCall?.title ?? m.params?.title ?? "¿Continúo?");

  // Sin manejador se RECHAZA, no se aprueba. Un permiso que se concede solo porque nadie
  // estaba mirando no es un permiso.
  let elegido: string | null = null;
  if (t.onPermission) {
    try {
      elegido = await t.onPermission({ requestId: m.id, title: titulo, options: opciones });
    } catch {
      elegido = null;
    }
  }

  enviar({
    jsonrpc: "2.0",
    id: m.id,
    result: elegido
      ? { outcome: { outcome: "selected", optionId: elegido } }
      : { outcome: { outcome: "cancelled" } },
  });
}
