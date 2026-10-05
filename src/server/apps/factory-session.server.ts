// Clave de conversación (sufijo del groupId) de un turno en un room.
//
// Los roles de la fábrica (@plan/@build/@check) NO usan la conversación única del room
// (`<slug>-flow`): su estado vive en la DB (pedidos, notas, sprints) y les llega como foto en
// cada turno. Una sesión por room creció a ~200k tokens y compactaba un minuto para contestar
// una línea (MailMask, 4-oct). Ahora: la del pedido del hilo (`factory-<runId>`, la misma que
// usan los relevos) o una por hilo. El resto de los agentes sigue igual.
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
  return `${channel.slug}-${fleetThread}`;
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
