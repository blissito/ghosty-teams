/**
 * Acuse de recibo del agente sobre el mensaje que lo invocó: 👀 al aceptar el turno, y al
 * cerrarlo se SUSTITUYE por ✅ / ⏹ / ⚠️ según el desenlace. Es lo que hace el tag de Claude
 * en Slack, y resuelve lo mismo: en un room con tráfico, la cáscara vacía y la barra
 * "Trabajando ahora" no están donde la persona mira, que es su propio mensaje.
 *
 * ⚠️ Lo pone la PLATAFORMA, no el modelo. Por eso funciona igual en claude-worker, codex,
 * deepseek y ACP/goose sin rebake ni tocar una skill — la regla de siempre: lo que tiene
 * que pasar SIEMPRE no se le pide al modelo (ver `gotcha_skill_autodescubrible_no_es_leida`).
 *
 * ⚠️ Todo aquí es BEST-EFFORT: un acuse que falla no puede tumbar el envío de un mensaje ni
 * el cierre de un turno. Mismo criterio que el acuse de lectura de WhatsApp (`markWaRead`).
 */

/**
 * El sub con el que un agente firma sus reacciones. `gc_reactions.user_sub` es TEXT libre
 * (sin FK ni flag de bot), así que la fila entra sin migración.
 *
 * ⚠️ Un agente NO tiene sub propio en ningún lado: `postAgent` deja `sender_sub` en NULL y
 * lo que identifica a su autor es `agent_handle`. El prefijo `agent:` se toma de
 * `doc-users.ts`, pero AHÍ es una identidad única ("Ghosty") que no distingue dos agentes
 * de la misma flota; con el handle dentro, sí.
 */
export function agentSub(handle: string): string {
  return `agent:${handle}`;
}

/** El emoji con el que se acusa el arranque. Se QUITA al cerrar; nunca se acumula. */
export const ACK_WORKING = "👀";

/** Cómo terminó el turno → con qué emoji se cierra el acuse. */
export const ACK_OUTCOME = {
  done: "✅",
  stopped: "⏹",
  error: "⚠️",
} as const;

export type AckOutcome = keyof typeof ACK_OUTCOME;

/** Pone o quita UNA reacción del agente y la anuncia a la audiencia del mensaje. */
async function react(
  ns: string,
  messageId: number,
  handle: string,
  emoji: string,
  on: boolean
): Promise<void> {
  const db = await import("../db.server");
  const msg = await db.getMessage(messageId);
  if (!msg) return;
  const userSub = agentSub(handle);
  const { count } = await db.setReaction(messageId, userSub, emoji, on);
  const { publishToAudience } = await import("./chat");
  await publishToAudience(ns, msg, {
    t: "reaction",
    messageId,
    emoji,
    userSub,
    op: on ? "add" : "remove",
    count,
  });
}

/** 👀 sobre el mensaje que invocó al agente. Se llama al aceptar el turno. */
export async function ackStart(ns: string, messageId: number, handle: string): Promise<void> {
  await react(ns, messageId, handle, ACK_WORKING, true).catch(() => {});
}

/**
 * Cierra el acuse: quita el 👀 y deja la marca del desenlace.
 *
 * ⚠️ Se llama con TODOS los mensajes que invocaron el turno, no sólo el primero: con STEER,
 * un segundo mensaje se mete en el turno en curso y ya lleva su propio 👀. Cerrar sólo el
 * primero dejaría ese 👀 clavado para siempre, porque nadie más va a volver por él.
 */
export async function ackEnd(
  ns: string,
  messageIds: number[],
  handle: string,
  outcome: AckOutcome
): Promise<void> {
  for (const id of messageIds) {
    await react(ns, id, handle, ACK_WORKING, false).catch(() => {});
    await react(ns, id, handle, ACK_OUTCOME[outcome], true).catch(() => {});
  }
}
