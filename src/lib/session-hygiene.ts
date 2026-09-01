// ── Higiene de sesión: cuánto lleva esta conversación sin borrar memoria ────────────
//
// Una conversación de agente no se abarata sola: cada turno relee todo lo anterior. El
// 2026-08-31, en descti, un DM llevaba 44 respuestas sin un solo /clear y él solo era el
// 58% del gasto del tenant (3.8M de tokens facturables). Nadie lo sabía, porque en la
// pantalla no hay ninguna señal de que una conversación se volvió cara.
//
// ⚠️ Esto NO decide nada ni bloquea nada: cuenta, y la UI lo sugiere junto al botón que ya
// existe. Cortarle la conversación a alguien a media junta sería peor que el gasto.

/**
 * La burbuja que postea `clearDmAgentFn` al borrar la memoria. Es el ancla desde la que se
 * cuenta.
 *
 * ⚠️ Exportada y usada TAMBIÉN por `dm.ts` a propósito: con el texto escrito a mano en los
 * dos sitios, retocar el copy dejaría el contador sin reiniciarse nunca y nada fallaría.
 */
export const MARCA_CLEAR = "🧹 Listo, borré la memoria de esta conversación. Empezamos de cero.";

/**
 * Umbral a partir del cual se sugiere borrar la memoria.
 *
 * Es una decisión de PRODUCTO, no un número derivado: un expediente legítimo corre 10-15
 * turnos, así que avisar antes entrenaría a ignorar el aviso; la sesión que motivó esto iba
 * en 44. 30 deja margen para trabajo normal y aun así caza el caso caro con holgura.
 */
export const TURNOS_LARGA = 30;

/**
 * Cuántas respuestas lleva el agente desde el último borrado de memoria.
 *
 * DERIVADO del flujo que la UI ya tiene cargado: ni columna, ni contador, ni server fn — un
 * /clear lo pone a cero solo, sin que nadie tenga que acordarse de resetear nada. Mismo
 * criterio que las imágenes rotas de `artifactDocHint`.
 */
export function turnosDesdeElClear(
  flow: { agent_handle: string | null; body: string | null }[] | null | undefined
): number {
  if (!flow?.length) return 0;
  // El ÚLTIMO clear manda: en una conversación con dos, se cuenta desde el segundo.
  let desde = 0;
  for (let i = flow.length - 1; i >= 0; i--) {
    if (flow[i].agent_handle && (flow[i].body ?? "").includes(MARCA_CLEAR)) {
      desde = i + 1;
      break;
    }
  }
  let n = 0;
  for (let i = desde; i < flow.length; i++) {
    const m = flow[i];
    // ⚠️ Cuerpo NO vacío: la cáscara del turno se crea vacía y eager (`postDmMessageFn`),
    // así que contarla adelantaría el umbral un turno entero. Y la propia burbuja del
    // /clear no es una respuesta: es la confirmación de haberla borrado.
    if (m.agent_handle && (m.body ?? "").trim() && !(m.body ?? "").includes(MARCA_CLEAR)) n++;
  }
  return n;
}
