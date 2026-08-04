// Builder GENÉRICO de contexto de conectores para un turno del agente. Escala a miles de
// integraciones sin tocar dm.ts: itera SOLO los conectores que el usuario tiene conectados
// y le pide a cada uno su `ambientContext` (contrato uniforme). Agregar una integración =
// implementar `ambientContext` en su módulo + una línea en IMPL_LOADERS. Cero acoplamiento.
//
// Nota de escala: `ambientContext` es el bloque BARATO inyectable en cada turno. Las
// capacidades ricas (leer disponibilidad real, agendar, tools de MCP como EasyBits) NO van
// aquí — son TOOLS/SKILLS que el runtime nativo descubre y el agente invoca on-demand (así
// no se inyectan miles de conectores en cada mensaje). Ese surface es el siguiente paso.

import { loaderFor } from "./impl";

/** Contexto ambiente de TODOS los conectores conectados del usuario, listo para el prompt. */
export async function buildConnectorContext(sub: string, sender: string, message: string): Promise<string> {
  try {
    const { listConnectorProviders } = await import("./store.server");
    const connected = await listConnectorProviders(sub);
    if (!connected.size) return "";
    const { refreshConnectorMetaIfStale } = await import("./meta.server");
    const parts = await Promise.all(
      [...connected].map(async (id) => {
        const load = loaderFor(id);
        if (!load) return null;
        try {
          // ANTES de pedir el bloque: el `meta` que lo alimenta se capturaba al
          // conectar y no se refrescaba nunca, así que el agente hablaba de una
          // realidad vieja (negocios, roles, cuenta activa). Esto es no-op
          // mientras esté fresco, y sólo espera la PRIMERA vez de cada conexión.
          await refreshConnectorMetaIfStale(sub, id);
          const mod = await load();
          return (await mod.ambientContext?.(sub, sender, message)) ?? null;
        } catch {
          return null; // un conector roto nunca tumba el turno ni a los demás
        }
      })
    );
    const blocks = parts.filter((p): p is string => !!p);
    const ajenos = await contextoDeConectoresDelEquipo(sub);
    if (ajenos) blocks.push(ajenos);
    if (!blocks.length) return "";
    // ⚠️ La sesión del worker es PERSISTENTE, así que el agente arrastra lo que concluyó
    // en turnos anteriores. El 2026-08-04 uno dijo "no tengo Sentry conectado" a las 11:07
    // —cierto en ese momento—, el usuario lo conectó a las 11:08, y a las 11:28 repitió lo
    // mismo SIN LLAMAR A NINGUNA TOOL: se creyó a sí mismo en vez de mirar. Este
    // encabezado existe para que la lista de ahora le gane a su propia memoria.
    return (
      `[ESTADO ACTUAL de las integraciones, recalculado en ESTE turno. Es la verdad de ahora ` +
      `y PISA cualquier cosa que hayas dicho o concluido antes en esta conversación: si en un ` +
      `turno anterior dijiste que no tenías una integración y aquí aparece, es que ya la ` +
      `conectaron. Compruébalo usando la tool, no tu memoria.]\n\n` +
      blocks.join("\n\n") +
      "\n\n"
    );
  } catch {
    return "";
  }
}

/**
 * Los conectores que tiene ALGUIEN MÁS del workspace y el invocador no.
 *
 * ⚠️ Esto NO puede vivir en el `ambientContext` de cada conector: ese camino sólo se
 * recorre para los que el usuario YA tiene conectados (`listConnectorProviders(sub)`), o
 * sea justo el caso contrario al que hace falta. El módulo de Sentry ni se carga para
 * quien no lo tiene.
 *
 * Por qué existe: el 2026-08-04, en el workspace "Soporte", el agente respondió "no tengo
 * integración con Sentry conectada" y se inventó dos caminos alternativos. David SÍ la
 * tenía. El agente no podía saberlo y la conversación murió ahí. Decirle a quién pedírselo
 * es la diferencia entre un callejón y un siguiente paso.
 *
 * Sólo nombres — ni correos, ni tokens, ni nada de la cuenta remota. Es la misma
 * información que el panel de Integraciones ya enseña a cualquier miembro.
 */
async function contextoDeConectoresDelEquipo(sub: string): Promise<string | null> {
  try {
    const { listConnectorHolders, listConnectorProviders } = await import("./store.server");
    const [holders, mios] = await Promise.all([listConnectorHolders(), listConnectorProviders(sub)]);
    const ajenos = [...holders.entries()].filter(([id, subs]) => !mios.has(id) && subs.some((s) => s !== sub));
    if (!ajenos.length) return null;

    const { CONNECTORS } = await import("./registry");
    const { listWorkspaceUsers } = await import("../../users.server");
    const gente = new Map((await listWorkspaceUsers()).map((u) => [u.sub, u.name]));

    const lineas = ajenos
      .map(([id, subs]) => {
        const nombre = CONNECTORS.find((c) => c.id === id)?.name ?? id;
        // Los baneados y quien nunca entró a Teams no tienen fila: se descartan en vez de
        // pintarse como un hueco.
        const quienes = subs.filter((s) => s !== sub).map((s) => gente.get(s)).filter(Boolean);
        return quienes.length ? `${nombre} (${quienes.join(", ")})` : null;
      })
      .filter(Boolean);
    if (!lineas.length) return null;

    return (
      `[INTEGRACIONES DEL EQUIPO que TÚ NO tienes con quien te escribe: ${lineas.join("; ")}. ` +
      `Las integraciones son POR PERSONA: sólo puedes usar las de quien te está hablando. ` +
      `Si te piden algo que necesita una de éstas, NO inventes alternativas ni digas que no ` +
      `se puede: dile que la conecte él en Ajustes → Integraciones, o que se lo pida a la ` +
      `persona de la lista, que ya la tiene.]`
    );
  } catch {
    return null;
  }
}
