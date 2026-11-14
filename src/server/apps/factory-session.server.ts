// Clave de conversación (sufijo del groupId) de un turno en un room. ÚNICO sitio que la decide.
//
// Regla (14-nov-2026): **una conversación por HILO**, keyada por la raíz del intercambio (como
// Slack con `thread_ts ?? ts`). Antes era una por room y todos los hilos compartían memoria: el
// agente contestaba en un hilo cosas de otro (Brendi) y la sesión del room llegó a 255 MB.
// La sesión por hilo ya existió y se quitó el 3-ago porque un archivo soltado en el room no
// llegaba al hilo; hoy la respuesta nace SIEMPRE en el hilo del mensaje que la pidió y el turno
// re-entrega los adjuntos y el texto de la raíz, así que el hilo se basta solo. Lo que debe
// valer en todo el room vive en las notas del agente (`gt_agent_notes`, por room).
//
// Los roles de la fábrica (@plan/@build/@check) van por pedido (`factory-<runId>`, la misma de
// los relevos) o por hilo: su estado vive en la DB y les llega como foto en cada turno.
//
// Sin raíz (caminos que no tienen hilo) queda la del room, `<slug>-flow`. Ese literal no se
// toca: el runtime keya por `(fleetAgentId, groupId)` y cambiarlo dejaría esas sesiones sin dueño.
// `TEAMS_SESSION_PER_THREAD=0` regresa a una por room sin desplegar código.
import { FACTORY_HANDLES } from "./factory-roles";

export async function fleetSuffixFor(
  handle: string,
  channel: { id: number; slug: string },
  rootId: number | null | undefined,
  fleetThread = "flow",
): Promise<string> {
  if (rootId && (FACTORY_HANDLES as readonly string[]).includes(handle)) {
    const { isInstalled } = await import("./installed.server");
    if (await isInstalled("factory").catch(() => false)) {
      const R = await import("./factory-runs.server");
      const run = await R.runOfThread(channel.id, rootId).catch(() => null);
      return run ? `factory-${run.id}` : `factory-thread-${rootId}`;
    }
  }
  if (rootId && sessionPerThread()) return `${channel.slug}-t${rootId}`;
  return `${channel.slug}-${fleetThread}`;
}

/** ¿La conversación de un agente normal es por hilo? (default sí). */
export function sessionPerThread(): boolean {
  return process.env.TEAMS_SESSION_PER_THREAD !== "0";
}

/**
 * Quién contesta en el hilo de un pedido un mensaje SIN mención. null = no es hilo de pedido
 * (sigue la regla general). Los avisos de la plataforma salen con la cara de un rol y la regla
 * general («el último agente que habló») le mandaba a @build lo que era para @plan: «haz otro
 * sprint» → «eso es de @plan» (palmera-legal, 4-oct). Si un rol le preguntó algo a la persona
 * (`waiting_person`), la respuesta es para él; si no, para @plan, que coordina.
 */
export async function factoryFollowHandle(channelId: number, rootId: number): Promise<string | null> {
  const { isInstalled } = await import("./installed.server");
  if (!(await isInstalled("factory").catch(() => false))) return null;
  const R = await import("./factory-runs.server");
  const run = await R.runOfThread(channelId, rootId).catch(() => null);
  if (!run) return null;
  const { dbq } = await import("../../dbq.server");
  const [last] = await dbq("SELECT type, actor FROM gt_factory_events WHERE run_id = ? ORDER BY id DESC LIMIT 1", [run.id]).catch(() => []);
  if (last?.type === "waiting_person" && (FACTORY_HANDLES as readonly string[]).includes(String(last.actor))) return String(last.actor);
  return "plan";
}
