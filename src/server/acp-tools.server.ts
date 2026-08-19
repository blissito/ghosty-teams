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
 * TTL corto a propósito: el socket ACP es POR TURNO, así que la credencial no tiene por qué
 * sobrevivirlo. Los 15 min del default nativo son para sesiones persistentes de worker.
 */
export const ACP_TOOL_TTL_S = 300;

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
    return mintToolToken(a.invokerSub, a.ns, a.dest ?? null, ACP_TOOL_TTL_S, {
      aud: `${a.origin.replace(/\/+$/, "")}/api/connectors/tools`,
      scope: a.scope,
    });
  } catch {
    return undefined; // turno sin tools del espacio, no turno roto
  }
}
