// ── Dónde corre un agente ─────────────────────────────────────────────────────
//
// Un agente de Teams no corre en Teams: corre en un RUNTIME. Hoy hay dos, y los
// dos son válidos — no es una migración a medias:
//
//   gs-native  → el runtime nativo de Ghosty Studio, co-locado en el mismo host.
//   easybits   → la flota de EasyBits, donde nacieron los agentes más viejos.
//
// Antes esto se elegía por TENANT (`gc_config.agent_runtime_url`), o sea que
// todos los agentes de un workspace iban al mismo lado. Un workspace puede tener
// legítimamente los dos, así que la elección es DEL AGENTE (columna
// `gc_agents.runtime`); la config del tenant queda como default para las filas
// que todavía no la tienen.
//
// ── Por qué "transporte" y no sólo "base URL" ────────────────────────────────
//
// Porque el siguiente runtime es LOCAL: Claude o Codex corriendo en la computadora
// del usuario. Esa máquina no es alcanzable desde el host — no hay URL a la que
// pegarle. Su identidad es una CONEXIÓN QUE ÉL ABRE, y el turno viaja por ahí.
//
// Si este módulo devolviera `{base, headers}`, ese runtime tendría que pelearse
// con la abstracción el día que llegue. Devuelve un TRANSPORTE: hoy sólo existe
// `http` (los dos runtimes actuales hablan el mismo SSE y difieren nada más en
// base + auth), y mañana `local` se suma como otro transporte sin tocar a los
// llamadores, que ya preguntan acá en vez de ramificar sobre un booleano.

export type RuntimeKind = "gs-native" | "easybits";

/**
 * Qué sabe hacer cada runtime. Existe para que la UI y el prompt no prometan lo
 * que el runtime no puede cumplir: hoy el prompt le ordena al agente mandar notas
 * de voz "proactivamente y seguido" sin preguntar dónde corre, y en EasyBits eso
 * falla en CADA turno (su worker no recibe GS_TTS_URL ni creds de storage, y su
 * plataforma además le prohíbe las tools de voz). Un agente local tendrá su
 * propia combinación otra vez distinta.
 */
export interface RuntimeSupports {
  /** El box sintetiza la nota de voz (voice.mjs + GS_TTS_URL + storage). */
  voiceNote: boolean;
  /** Hay endpoint para borrar la memoria de una conversación (el /clear). */
  sessionReset: boolean;
  /** Acepta tools de conectores per-invocador (toolToken + toolsUrl). */
  connectorTools: boolean;
  /** La persona la aplica el runtime; si no, se la mandamos por appendSystemPrompt. */
  ownsPersona: boolean;
}

const SUPPORTS: Record<RuntimeKind, RuntimeSupports> = {
  "gs-native": { voiceNote: true, sessionReset: true, connectorTools: true, ownsPersona: true },
  easybits: { voiceNote: false, sessionReset: false, connectorTools: false, ownsPersona: false },
};

/** Transporte HTTP: los dos runtimes de hoy. `local` se sumará como otro kind. */
export interface HttpRuntime {
  transport: "http";
  kind: RuntimeKind;
  base: string;
  supports: RuntimeSupports;
  /** Headers de auth para este runtime, sobre el body crudo que se va a mandar. */
  headers(rawBody: string, agentToken: string): Record<string, string>;
  /** El Bearer de EasyBits caduca y se auto-sana con un 401; el HMAC no. */
  refreshesOn401: boolean;
}

export type AgentRuntime = HttpRuntime;

/** Lo mínimo que necesitamos saber de un agente para ubicar su runtime. */
export interface RuntimeBinding {
  /** Texto crudo de la DB; se valida acá, no en el llamador. */
  runtime?: string | null;
  runtimeUrl?: string | null;
}

/**
 * Valida el kind que viene de la DB. Un valor DESCONOCIDO no se ignora: si esta
 * build de Teams no sabe hablar ese runtime, mandar el turno a cualquier otro
 * sería entregarle la conversación a quien no es. Mejor romper con un mensaje que
 * diga qué pasa — el llamador ya pinta "no pude contactar a @handle".
 */
function parseKind(v: string | null | undefined): RuntimeKind | null {
  if (!v) return null;
  if (v === "gs-native" || v === "easybits") return v;
  throw new Error(`runtime desconocido para este agente: "${v}"`);
}

/**
 * Runtime de un agente concreto.
 *
 * Orden: lo que dice el AGENTE → el default del tenant (`nativeRuntimeBase()`) →
 * EasyBits, que es donde vivía todo antes de que esto existiera.
 *
 * ⚠️ `runtimeUrl` se IGNORA en `gs-native`, a propósito. Ahí firmamos con
 * GHOSTY_PARTNER_SECRET, y mandarle peticiones firmadas a un host ajeno sería
 * regalar firmas válidas (canonical `ts.rawBody`, ventana ±300s) a quien las
 * quiera reusar. La URL sólo manda donde ella misma ES la identidad del runtime.
 */
export async function runtimeFor(agent: RuntimeBinding): Promise<AgentRuntime> {
  const { nativeRuntimeBase, partnerHeaders } = await import("./ghosty-runtime.server");

  const declared = parseKind(agent.runtime);
  const nativeBase = declared === "easybits" ? null : await nativeRuntimeBase();
  const kind: RuntimeKind = declared ?? (nativeBase ? "gs-native" : "easybits");

  if (kind === "gs-native") {
    const base = nativeBase ?? (await nativeRuntimeBase());
    // El namespace se resuelve UNA vez acá (lectura async del tenant) y queda
    // capturado en `headers()`, para no volver async toda la cadena de llamada.
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    if (!base) {
      // Un agente marcado como nativo en un tenant sin runtime configurado. Es un
      // error de configuración y se dice; caer a EasyBits en silencio lo mandaría
      // a un sistema donde su id no existe, con un mensaje que no ayuda a nadie.
      throw new Error(
        "el agente corre en el native gs runtime pero este workspace no lo tiene configurado " +
          "(gc_config.agent_runtime_url o GHOSTY_RUNTIME_URL)",
      );
    }
    return {
      transport: "http",
      kind,
      base,
      supports: SUPPORTS[kind],
      headers: (rawBody) => partnerHeaders(rawBody, ns),
      refreshesOn401: false,
    };
  }

  return {
    transport: "http",
    kind,
    base: (agent.runtimeUrl || process.env.EASYBITS_BASE_URL || "https://www.easybits.cloud").replace(/\/+$/, ""),
    supports: SUPPORTS[kind],
    headers: (_rawBody, agentToken) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentToken}`,
    }),
    refreshesOn401: true,
  };
}

/** Kind con el que se estampa un agente recién creado en cada camino de alta. */
export function kindForNewAgent(nativeBase: string | null): RuntimeKind {
  return nativeBase ? "gs-native" : "easybits";
}
