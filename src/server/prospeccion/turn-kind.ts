/**
 * ¿Este turno es de Prospección (el panel de una lista o una columna de agente)?
 *
 * Esos turnos no tienen canal ni DM: si el agente lanza un subagente, su resultado no tiene a
 * dónde volver (`agent-wake` truena con «destino sin dm ni canal») y la persona se queda
 * esperando un número que nunca llega (lista #38, 10-nov). Por eso ahí no hay subagentes.
 */
export function isProspTurn(groupId: string): boolean {
  return groupId.startsWith("prosp:");
}
