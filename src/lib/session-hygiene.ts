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
 * La burbuja de «Seguir con memoria fresca»: también reinicia la sesión del agente, pero su
 * siguiente turno arranca con la cola de lo hablado (`continuacionTrasFresca`). Cuenta como
 * ancla igual que `MARCA_CLEAR`.
 */
export const MARCA_FRESCA = "🧹 Seguimos con memoria fresca; me quedé con lo último que hablamos.";

/** ¿Este cuerpo es una de las dos burbujas que reinician la memoria? */
export function esMarcaDeMemoria(body: string | null | undefined): boolean {
  const b = body ?? "";
  return b.includes(MARCA_CLEAR) || b.includes(MARCA_FRESCA);
}

/** Lo que se le lleva al agente tras la memoria fresca. Misma cifra que «seguir en un chat nuevo» de gs. */
const CONTINUACION_MAX = 16_000;

/** La etiqueta con la que el stream pinta una compactación (`tool-label.ts`, `gs_compact`). */
const COMPACTO = "Compacté la memoria";

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
  flow: { agent_handle: string | null; sender_sub?: string | null; body: string | null }[] | null | undefined
): number {
  if (!flow?.length) return 0;
  // El ÚLTIMO clear manda: en una conversación con dos, se cuenta desde el segundo.
  let desde = 0;
  for (let i = flow.length - 1; i >= 0; i--) {
    if (flow[i].agent_handle && esMarcaDeMemoria(flow[i].body)) {
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
    // ⚠️ En un DM el mensaje de la PERSONA también lleva `agent_handle` (a quién va dirigido):
    // lo que distingue al agente es `sender_sub` vacío. Sin esto se contaba doble y el aviso
    // salía a los ~15 turnos en vez de 30 (visto 15-oct).
    if (m.agent_handle && !m.sender_sub && (m.body ?? "").trim() && !esMarcaDeMemoria(m.body)) n++;
  }
  return n;
}

/**
 * Cuántas veces compactó el agente su memoria desde el último borrado. Una sola ya dice que
 * la conversación se volvió larga: cada compactación es un turno más lento y caro (descti,
 * oct-2026: 1 de cada 3 turnos de los DMs largos). Derivado igual que `turnosDesdeElClear`.
 */
export function compactacionesDesdeElClear(
  flow: { agent_handle: string | null; body: string | null }[] | null | undefined
): number {
  if (!flow?.length) return 0;
  let n = 0;
  for (let i = flow.length - 1; i >= 0; i--) {
    const m = flow[i];
    if (m.agent_handle && esMarcaDeMemoria(m.body)) break;
    if (m.agent_handle && (m.body ?? "").includes(COMPACTO)) n++;
  }
  return n;
}

type FlowMsg = { agent_handle: string | null; sender_sub?: string | null; body: string | null };

/**
 * El contexto para el PRIMER turno después de «Seguir con memoria fresca»: la cola de lo hablado
 * entre el ancla anterior y la burbuja de memoria fresca. Es la cola (16k caracteres), no un
 * resumen hecho por modelo: no cuesta un turno y no inventa nada (igual que gs).
 *
 * "" si la última respuesta del agente no es la burbuja de memoria fresca: en cuanto contesta,
 * deja de inyectarse solo. `flow` va en orden cronológico; el mensaje actual de la persona puede
 * venir al final y se ignora (ya va en el turno).
 */
export function continuacionTrasFresca(flow: FlowMsg[] | null | undefined): string {
  if (!flow?.length) return "";
  const esAgente = (m: FlowMsg) => !!m.agent_handle && m.sender_sub == null;
  let fresca = -1;
  for (let i = flow.length - 1; i >= 0; i--) {
    const m = flow[i];
    if (!esAgente(m) || !(m.body ?? "").trim()) continue;
    if ((m.body ?? "").includes(MARCA_FRESCA)) fresca = i;
    break;
  }
  if (fresca < 0) return "";
  let desde = 0;
  for (let i = fresca - 1; i >= 0; i--) {
    if (esAgente(flow[i]) && esMarcaDeMemoria(flow[i].body)) { desde = i + 1; break; }
  }
  const lineas: string[] = [];
  for (const m of flow.slice(desde, fresca)) {
    // Los bloques (tools, pasos, artefactos) no son la plática y se comerían el tope.
    const t = (m.body ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (t) lineas.push(`${esAgente(m) ? "Tú" : "Persona"}: ${t}`);
  }
  if (!lineas.some((l) => l.startsWith("Tú:"))) return "";
  let cola = lineas.join("\n\n");
  if (cola.length > CONTINUACION_MAX) cola = "…" + cola.slice(-CONTINUACION_MAX);
  return (
    "[TU MEMORIA DE ESTA CONVERSACIÓN SE REINICIÓ PORQUE SE HIZO LARGA. Ésta es la parte final de lo que " +
    "hablaron: úsala como contexto, sigue desde ahí sin presentarte de nuevo ni repetir lo que ya entregaste, " +
    "y no la cites. Si te hace falta un archivo de antes, pídeselo a la persona.]\n" +
    cola +
    "\n[FIN DE LO ANTERIOR. LA PERSONA ESCRIBE AHORA.]\n\n"
  );
}
