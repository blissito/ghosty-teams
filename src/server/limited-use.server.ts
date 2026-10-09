// Uso Limitado de los datos de Google en Teams. Regla (docs de gs: docs/claude/uso-limitado-teams.md):
// un dato de Google sólo entra a un turno si TODOS los modelos que van a leer ese destino son de Uso
// Limitado (Anthropic u OpenAI, cuyas API no entrenan con lo que reciben).
//
// Patrón: la sala es el destinatario y su permiso es el de su lector más débil (Purview/Copilot: la
// conversación hereda la etiqueta más restrictiva). Lectores:
//   · una sala  = el agente del turno + TODOS los agentes habilitados del espacio (cualquiera se puede
//     mencionar ahí y su catch-up y `chat_*` le pasan los mensajes de los demás);
//   · un DM     = su agente, nadie más.
//
// Quién es de Uso Limitado lo decide Studio (`limitedUse` de `/api/v2/fleet-agents`, que sale de
// `limitedUseOk` en gs): aquí no se duplica la regla. Falla cerrado: un agente que Studio no conoce
// (EasyBits, A2A, webhook, ACP pegado a mano) o Studio sin contestar = no.
import type { ResolvedAgent } from "../agents.server";
import type { ToolDest } from "./connectors/tool-token.server";

const TTL_MS = 5 * 60_000;
/** Studio no contestó: se reintenta pronto en vez de dejar Drive apagado 5 minutos. */
const FAIL_TTL_MS = 30_000;

// Por espacio: la lista de Studio la firma el workspace (`currentNamespace`).
const cache = new Map<string, { at: number; ttl: number; byId: Map<string, boolean> | null }>();

/** `limitedUse` de cada agente de Studio de este espacio, o `null` si Studio no contestó. */
export async function limitedUseById(): Promise<Map<string, boolean> | null> {
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace();
  const hit = cache.get(ns);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.byId;
  let byId: Map<string, boolean> | null = null;
  try {
    const { nativeRuntimeBase } = await import("./ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (base) {
      const { listNativeFleetAgents } = await import("./fleet-native.server");
      byId = new Map((await listNativeFleetAgents(base, "")).map((p) => [p.id, p.limitedUse === true]));
    }
  } catch (e) {
    console.warn(`[limited-use] Studio no contestó: ${(e as Error).message}`);
  }
  cache.set(ns, { at: Date.now(), ttl: byId ? TTL_MS : FAIL_TTL_MS, byId });
  return byId;
}

/** Para pruebas: olvida lo guardado. */
export function forgetLimitedUse(): void {
  cache.clear();
}

/** ¿Es de Uso Limitado este agente? Sólo los que Studio conoce y aprueba. */
export function agentLimitedUse(a: ResolvedAgent, byId: ReadonlyMap<string, boolean>): boolean {
  const b = a.backend;
  if (b.kind === "fleet" || b.kind === "acp") return !!b.id && byId.get(b.id) === true;
  return false;
}

/**
 * Proveedor de un modelo suelto (el `model` de un turno de la fábrica): espejo de `providerOfModelId`
 * de gs. Desconocido = no.
 */
export function modelLimitedUse(model: string): boolean {
  return /^claude-|^gpt-|^o\d/.test(model);
}

/**
 * ¿Pueden TODOS los lectores de `dest` recibir datos de Google en este turno? Es el claim `lu` del
 * token del turno. `fleetId`/`model`: los de la fábrica cuando pisan los del agente.
 */
export async function destLimitedUse(
  dest: ToolDest | null | undefined,
  turnAgent: ResolvedAgent | null | undefined,
  opts: { fleetId?: string | null; model?: string | null } = {},
): Promise<boolean> {
  if (!turnAgent) return false;
  const byId = await limitedUseById();
  if (!byId) return false;
  const self = opts.fleetId ? byId.get(opts.fleetId) === true : agentLimitedUse(turnAgent, byId);
  if (!self || (opts.model && !modelLimitedUse(opts.model))) return false;
  if (dest?.dmId) return true;
  const { resolvedAgents } = await import("../agents.server");
  return (await resolvedAgents()).every((a) => agentLimitedUse(a, byId));
}

/** Los agentes del espacio que apagan Google en las salas, para enseñarlo en Ajustes. */
export async function agentsBlockingGoogle(): Promise<{ handle: string; name: string }[] | null> {
  const byId = await limitedUseById();
  if (!byId) return null;
  const { resolvedAgents } = await import("../agents.server");
  return (await resolvedAgents()).filter((a) => !agentLimitedUse(a, byId)).map((a) => ({ handle: a.handle, name: a.name }));
}

/** El motivo, para el agente (que se lo dice a la persona). Mismo texto que en gs. */
export const LIMITED_USE_SHARED_DENIED =
  "Drive, Calendar, Gmail y Contactos de Google no se pueden usar aquí: en este espacio hay agentes con modelos que no son de Uso Limitado (DeepSeek, Gemini u otros) que también leen esta conversación, y Google no permite que sus datos les lleguen. Funciona en un DM con un agente Claude u OpenAI, o en un espacio donde todos los agentes lo sean.";

/** La clave de la conversación del destino: el DM, o la sala con su hilo. `null` = sin conversación. */
export function convKeyOf(dest: ToolDest | null | undefined): string | null {
  if (dest?.dmId) return `dm:${dest.dmId}`;
  if (dest?.channelId) return `ch:${dest.channelId}:${dest.parentId ?? 0}`;
  return null;
}

/** Lo que ve un turno sin Uso Limitado en lugar de un mensaje etiquetado: que existe y por qué no. */
export const GOOGLE_REDACTED =
  "[mensaje retenido: trae datos de Google y esta conversación la leen modelos que no son de Uso Limitado]";

/** Redacta los mensajes etiquetados si el destino no es de Uso Limitado. Nada desaparece: se dice. */
export function redactGoogle<T extends { body: string; google_data?: number }>(msgs: T[], lu: boolean): T[] {
  if (lu) return msgs;
  return msgs.map((m) => (m.google_data ? { ...m, body: GOOGLE_REDACTED } : m));
}
