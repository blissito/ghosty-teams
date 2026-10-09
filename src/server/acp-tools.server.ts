// ── Las tools del ESPACIO para un agente ACP ─────────────────────────────────
//
// Un agente ACP no recibe tools escritas para él: recibe las MISMAS que ya usan los agentes
// nativos, por el mismo dispatch (`/api/connectors/tools`) y con el mismo token-capacidad.
// Por eso una tool nueva en Teams la ve cualquier agente sin tocar su imagen.
//
// Esta función es sólo la DECISIÓN: si este turno merece credencial y con qué alcance. Vive
// aparte de `agents.server.ts` porque una regla de seguridad que no se puede probar sin
// levantar medio sistema acaba sin probarse.

import type { ToolDest, ToolScope } from "./connectors/tool-token.server";

/**
 * Lo que dura la credencial: lo que puede durar el TURNO, igual que en el camino nativo. Con 5
 * minutos un turno de la fábrica que esperaba al CI se quedaba sin tools a la mitad y no podía
 * cerrar su paso («Tu sesión con el espacio ya no vale», mercadito-verde, 5-oct). El socket
 * sigue siendo por turno; el token sólo vale para su conversación y su espacio.
 */
export const ACP_TOOL_TTL_S = 900;
/** Turno de un rol de la Software Factory: puede ir de horas, como en el nativo. */
export const ACP_FACTORY_TOOL_TTL_S = 2 * 3600;

export type AcpToolArgs = {
  /** Quién escribió el mensaje que disparó el turno. Sin invocador no hay a nombre de quién actuar. */
  invokerSub?: string | null;
  /** Canal público (WhatsApp y compañía): frontera de seguridad, no una preferencia. */
  publicChannel?: boolean;
  ns: string;
  dest?: ToolDest | null;
  /** El origin de ESTE tenant: a dónde tiene que llamar la caja. */
  origin?: string | null;
  scope: ToolScope;
  /** Turno de un rol de la fábrica (@plan, @build, @check…): credencial de 2 h. */
  factory?: boolean;
  /** Uso Limitado del destino (`destLimitedUse`). Obligatorio: autoriza Drive de Studio. */
  lu: boolean;
};

/**
 * El token-capacidad del turno, o `undefined` si este turno no debe tener tools.
 *
 * Las tres condiciones son las del camino nativo, y por las mismas razones:
 *
 * - **Sin invocador**, no hay identidad a nombre de la cual ejercer nada.
 * - **En canal público, nunca.** El texto del turno lo escribe un extraño, y un agente con
 *   tools sería su canal de exfiltración. Vale aunque llegue un `invokerSub`.
 * - **Sin origin**, no se sabe a dónde llamar; y el destino va DENTRO del token para que
 *   nadie pueda sugerir otro desde fuera.
 *
 * Nunca lanza: sin `GHOSTY_PARTNER_SECRET`, `mintToolToken` explota, y un deploy sin ese
 * secreto tumbaría todos los turnos ACP en vez de sólo sus herramientas.
 */
export async function acpToolToken(a: AcpToolArgs): Promise<string | undefined> {
  if (!a.invokerSub || a.publicChannel || !a.origin) return undefined;
  try {
    const { mintToolToken } = await import("./connectors/tool-token.server");
    return mintToolToken(a.invokerSub, a.ns, a.lu, a.dest ?? null, a.factory ? ACP_FACTORY_TOOL_TTL_S : ACP_TOOL_TTL_S, {
      aud: `${a.origin.replace(/\/+$/, "")}/api/connectors/tools`,
      scope: a.scope,
    });
  } catch {
    return undefined; // turno sin tools del espacio, no turno roto
  }
}
