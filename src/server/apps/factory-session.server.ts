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
