// ── Cliente A2A v1.0 (Agent2Agent, Linux Foundation) ──────────────────────────
//
// QUÉ CAMBIA ESTO. Hasta ahora un "agente externo" en Teams sólo podía ser un webhook con
// NUESTRO formato: alguien tenía que programar contra un contrato que sólo existe aquí, y
// además sin streaming (el turno se juntaba entero y aterrizaba de golpe). Con A2A basta
// pegar la URL de un AgentCard: Teams lo descubre, lee qué sabe hacer, y habla el mismo
// protocolo que ya hablan Studio y las cajas.
//
// Y sobre todo: `RuntimeSupports` deja de ser un switch escrito a mano por runtime y pasa a
// DERIVARSE de lo que el agente declara en su card. De lista cerrada a registro.
//
// OJO CON LA VERSIÓN. A2A v1.0 rompió con v0.3 y casi todo el material que circula enseña
// 0.3: los métodos son PascalCase (`SendStreamingMessage`, no `message/stream`), el card no
// tiene `url` en la raíz sino `supportedInterfaces[]`, desapareció el discriminador `kind`,
// los Part se aplanaron a un oneof y los TaskState van en SCREAMING_SNAKE. Se habla v1.0.

import crypto from "node:crypto";

export type A2AInterface = {
  url: string;
  protocolBinding?: string;
  protocolVersion?: string;
  /** Routing OPACO del proveedor: si viene, hay que reenviarlo en cada request. */
  tenant?: string;
};

export interface AgentCard {
  name?: string;
  description?: string;
  version?: string;
  supportedInterfaces?: A2AInterface[];
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extensions?: Array<{ uri: string; required?: boolean }>;
  };
  defaultOutputModes?: string[];
  skills?: Array<{ id: string; name?: string; description?: string; tags?: string[] }>;
  signatures?: Array<{ protected: string; signature: string }>;
}

/** URIs de extensión que traducimos a capacidades nuestras. */
export const EXT = {
  steer: "https://ghosty.studio/a2a/ext/steer/v1",
  sessionReset: "https://ghosty.studio/a2a/ext/session-reset/v1",
  connectorTools: "https://ghosty.studio/a2a/ext/connector-tools/v1",
  ownsPersona: "https://ghosty.studio/a2a/ext/owns-persona/v1",
  modelEscalation: "https://ghosty.studio/a2a/ext/model-escalation/v1",
} as const;

// ── Card: fetch + caché ───────────────────────────────────────────────────────
//
// La caché NO es una optimización opcional: sin ella cada turno haría un GET extra al
// origen del card antes de poder mandar nada, sumando un RTT al p50 de cada mensaje.

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { card: AgentCard; at: number }>();

export async function fetchCard(cardUrl: string, opts: { force?: boolean } = {}): Promise<AgentCard> {
  const hit = cache.get(cardUrl);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.card;
  const res = await fetch(cardUrl, { headers: { accept: "application/json" } });
  if (!res.ok) {
    // Un card ilegible NO invalida el que ya teníamos: el agente sigue trabajando con lo
    // último conocido en vez de caerse porque su origen tuvo un mal minuto.
    if (hit) return hit.card;
    throw new Error(`no pude leer el AgentCard (${res.status}) en ${cardUrl}`);
  }
  const card = (await res.json()) as AgentCard;
  if (!interfaceOf(card)) throw new Error("el AgentCard no declara supportedInterfaces con url");
  cache.set(cardUrl, { card, at: Date.now() });
  return card;
}

/** La interfaz preferida: la spec dice que el primer elemento es la preferida. */
export function interfaceOf(card: AgentCard): A2AInterface | null {
  // Sólo sabemos hablar JSON-RPC; gRPC y HTTP+JSON son bindings válidos del protocolo que
  // no implementamos, así que una interfaz que sólo ofrezca esos NO nos sirve.
  return (card.supportedInterfaces ?? []).find((i) => !i.protocolBinding || i.protocolBinding === "JSONRPC") ?? null;
}

function hasExt(card: AgentCard, uri: string): boolean {
  return (card.capabilities?.extensions ?? []).some((e) => e.uri === uri);
}

/**
 * `RuntimeSupports` derivado del card. Un card que no declara nada da todo `false`, que es
 * la degradación correcta: el prompt no promete notas de voz que el agente no puede dar
 * —que es el motivo entero por el que RuntimeSupports existe—.
 */
export function supportsFromCard(card: AgentCard) {
  const voice =
    (card.skills ?? []).some((s) => s.id === "voice-note") ||
    (card.defaultOutputModes ?? []).some((m) => m.startsWith("audio/"));
  return {
    voiceNote: voice,
    sessionReset: hasExt(card, EXT.sessionReset),
    connectorTools: hasExt(card, EXT.connectorTools),
    ownsPersona: hasExt(card, EXT.ownsPersona),
    modelEscalation: hasExt(card, EXT.modelEscalation),
  };
}

export function supportsSteer(card: AgentCard): boolean {
  return hasExt(card, EXT.steer);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * 🔴 FRONTERA DE SEGURIDAD. Sólo se firma con GHOSTY_PARTNER_SECRET hacia hosts NUESTROS.
 *
 * Es la misma razón por la que `runtimeFor` ignora `runtimeUrl` en `gs-native`: una firma
 * de partner es válida durante 300s y reusable, así que mandarla a un host ajeno es
 * regalársela a quien la quiera usar contra nosotros. Y aquí el riesgo es peor, porque la
 * URL del card la escribe el usuario al dar de alta el agente: sin allowlist, cualquiera
 * podría cosechar firmas poniendo su propio dominio.
 *
 * Fuera del allowlist se usa Bearer con el token del agente, que es lo que corresponde a un
 * tercero.
 */
function isOurHost(u: URL): boolean {
  const extra = (process.env.A2A_TRUSTED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const h = u.hostname.toLowerCase();
  return (
    h === "www.ghosty.studio" ||
    h === "ghosty.studio" ||
    h.endsWith(".sandboxes.easybits.cloud") ||
    extra.includes(h)
  );
}

function authHeaders(endpoint: string, rawBody: string, workspaceNs: string, agentToken: string): Record<string, string> {
  const url = new URL(endpoint);
  if (isOurHost(url) && process.env.GHOSTY_PARTNER_SECRET) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto
      .createHmac("sha256", process.env.GHOSTY_PARTNER_SECRET)
      .update(`${ts}.${workspaceNs}.${rawBody}`)
      .digest("hex");
    return { "x-ghosty-ts": ts, "x-ghosty-ws": workspaceNs, "x-ghosty-sig": sig };
  }
  return agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
}

// ── Turno ─────────────────────────────────────────────────────────────────────

export type MediaPart = { kind: "file"; file: { name?: string; mimeType: string; uri?: string; bytes?: string } };
export type ToolEvent = { name?: string; id?: string; phase?: "start" | "end"; ok?: boolean; detail?: string };

/** Nuestros MediaPart → Part de A2A v1.0, que aplanó `file:{bytes|uri}` a `raw`/`url`. */
function toA2AParts(text: string, parts: MediaPart[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ text }];
  for (const p of parts ?? []) {
    const f = p.file ?? ({} as MediaPart["file"]);
    if (f.bytes) out.push({ raw: f.bytes, filename: f.name, mediaType: f.mimeType });
    else if (f.uri) out.push({ url: f.uri, filename: f.name, mediaType: f.mimeType });
  }
  return out;
}

export interface A2ATurn {
  cardUrl: string;
  /** La conversación. Va como `contextId`, que es lo que el agente usa para su memoria. */
  contextId: string;
  text: string;
  parts?: MediaPart[];
  workspaceNs: string;
  agentToken?: string;
  onChunk: (chunk: string) => void | Promise<void>;
  onTool?: (ev: ToolEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Un turno por `SendStreamingMessage`. Devuelve el texto completo.
 *
 * El stream son frames SSE `data: {sobre JSON-RPC}`; cada `result` es un StreamResponse,
 * que es un oneof de cuatro (`task` | `message` | `statusUpdate` | `artifactUpdate`). No hay
 * evento centinela de cierre en v1.0: el stream termina cuando el Task llega a un estado
 * terminal, y por eso el final se detecta por ESTADO y no por un flag.
 */
export async function runA2ATurn(t: A2ATurn): Promise<string> {
  const card = await fetchCard(t.cardUrl);
  const iface = interfaceOf(card);
  if (!iface) throw new Error("el AgentCard no declara una interfaz JSONRPC que sepamos hablar");
  const endpoint = iface.url;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "SendStreamingMessage",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        contextId: t.contextId,
        parts: toA2AParts(t.text, t.parts ?? []),
      },
      // El tenant del card es opaco y el cliente DEBE reenviarlo.
      ...(iface.tenant ? { tenant: iface.tenant } : {}),
    },
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Sin este header el servidor asume 0.3 —lo dice la spec— y contestaría otro dialecto.
      "A2A-Version": "1.0",
      accept: "text/event-stream",
      ...authHeaders(endpoint, body, t.workspaceNs, t.agentToken ?? ""),
    },
    body,
    signal: t.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`el agente A2A respondió ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  let full = "";
  let failure: string | null = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Los frames van separados por línea en blanco. Se procesa lo completo y se guarda el resto.
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue; // `: hb` (heartbeat) y otros comentarios
        let result: any;
        try {
          const env = JSON.parse(line.slice(5).trim());
          if (env.error) throw new Error(env.error.message ?? "error A2A");
          result = env.result;
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected end of JSON input") failure = e.message;
          continue;
        }
        if (!result) continue;

        if (result.artifactUpdate) {
          for (const p of result.artifactUpdate.artifact?.parts ?? []) {
            if (typeof p.text === "string" && p.text) {
              full += p.text;
              await t.onChunk(p.text);
            }
          }
        } else if (result.statusUpdate) {
          const st = result.statusUpdate.status ?? {};
          // A2A no tiene evento de tool: viaja como Part `data` dentro de status.message.
          for (const p of st.message?.parts ?? []) {
            if (p.data && typeof p.data === "object" && t.onTool) {
              const d = p.data as Record<string, unknown>;
              if (d.tool || d.toolId) {
                await t.onTool({
                  name: typeof d.tool === "string" ? d.tool : undefined,
                  id: typeof d.toolId === "string" ? d.toolId : undefined,
                  phase: d.phase === "end" ? "end" : "start",
                  ok: typeof d.ok === "boolean" ? d.ok : undefined,
                  detail: typeof d.detail === "string" ? d.detail : undefined,
                });
              }
            }
          }
          if (st.state === "TASK_STATE_FAILED" || st.state === "TASK_STATE_REJECTED") {
            failure =
              st.message?.parts?.find((p: any) => typeof p.text === "string")?.text ??
              (st.state === "TASK_STATE_REJECTED" ? "el agente está a tope" : "el agente falló");
          }
        } else if (result.message) {
          // El agente contestó con un Message suelto en vez de abrir una tarea: la spec dice
          // que entonces el stream lleva exactamente uno y cierra.
          for (const p of result.message.parts ?? []) {
            if (typeof p.text === "string" && p.text) {
              full += p.text;
              await t.onChunk(p.text);
            }
          }
        }
      }
    }
  }

  if (failure) throw new Error(failure);
  return full;
}
