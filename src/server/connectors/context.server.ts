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
import type { ToolDest } from "./tool-token.server";

/** Contexto ambiente de TODOS los conectores conectados del usuario, listo para el prompt. */
export async function buildConnectorContext(
  sub: string,
  sender: string,
  message: string,
  dest: ToolDest | null = null
): Promise<string> {
  try {
    // Los suyos + los COMPARTIDOS del workspace: una conexión del equipo tiene que dar el
    // mismo contexto ambiente que una propia, o el agente diría "no tengo Sentry" teniendo
    // una compartida delante.
    //
    // ⚠️ Con CERO conectores NO se corta aquí: Tasks y la lista de conexiones del equipo no
    // son conectores del invocador y van más abajo. Un `return ""` temprano dejó al agente
    // de coregrid sin enterarse de que su tablero existía (2026-08-07) — y le negaba la
    // lista de "pídeselo a David" justo a quien más la necesita: el que no tiene ninguna.
    const { listAvailableProviders } = await import("./store.server");
    const connected = await listAvailableProviders(sub);
    const { refreshConnectorMetaIfStale } = await import("./meta.server");
    const { resolveConnectorOwner } = await import("./store.server");
    const parts = await Promise.all(
      [...connected].map(async (id) => {
        const load = loaderFor(id);
        if (!load) return null;
        try {
          // ⚠️ El `ambientContext` de cada conector lee la fila de ESE sub
          // (`getConnectorRow`), así que con una conexión compartida hay que pasarle la
          // del DUEÑO o devolvería null y el bloque desaparecería justo cuando más falta
          // hace. La resolución es la misma que usa el dispatch: la propia gana.
          const dueño = await resolveConnectorOwner(sub, id);
          if (!dueño) return null;
          // ANTES de pedir el bloque: el `meta` que lo alimenta se capturaba al
          // conectar y no se refrescaba nunca, así que el agente hablaba de una
          // realidad vieja (negocios, roles, cuenta activa). Esto es no-op
          // mientras esté fresco, y sólo espera la PRIMERA vez de cada conexión.
          await refreshConnectorMetaIfStale(dueño.ownerSub, id);
          const mod = await load();
          const bloque = (await mod.ambientContext?.(dueño.ownerSub, sender, message, dest)) ?? null;
          if (!bloque || !dueño.shared) return bloque;
          // Es de otra persona: hay que decirlo, o el agente hablaría de "tus" errores y
          // "tu" organización cuando son de alguien más.
          const quien = (await nombreDe(dueño.ownerSub)) ?? "otra persona del equipo";
          return (
            `${bloque}\n[OJO: esa conexión NO es de ${sender}. Es la de ${quien}, ` +
            `COMPARTIDA con el equipo. Puedes usarla, pero al reportar resultados di de ` +
            `quién es la cuenta y no hables de ellos como si fueran datos de ${sender}.]`
          );
        } catch {
          return null; // un conector roto nunca tumba el turno ni a los demás
        }
      })
    );
    const blocks = parts.filter((p): p is string => !!p);
    // Tasks no es un conector —no hay nada que autorizar, los dos productos comparten
    // secreto y namespace—, así que su bloque no sale del bucle de arriba. Va aquí, y no en
    // una skill: `gotcha_skill_autodescubrible_no_es_leida`.
    const { tasksContext } = await import("./tasks.native.server");
    const tareas = await tasksContext(dest).catch(() => null);
    if (tareas) blocks.push(tareas);
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
    const { listConnectorHolders, listAvailableProviders } = await import("./store.server");
    // `listAvailableProviders` y no `listConnectorProviders`: las compartidas ya se
    // anunciaron arriba con su bloque completo, así que aquí sólo quedan las PERSONALES
    // de otros — las que hay que pedir prestadas, no las que ya se pueden usar.
    const [holders, usables] = await Promise.all([listConnectorHolders(), listAvailableProviders(sub)]);
    const ajenos = [...holders.entries()].filter(([id, subs]) => !usables.has(id) && subs.some((s) => s !== sub));
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
      `[INTEGRACIONES QUE TIENE EL EQUIPO y tú NO puedes usar con quien te escribe: ` +
      `${lineas.join("; ")}. Son conexiones PERSONALES de esas personas y no están ` +
      `compartidas. Si te piden algo que necesita una de éstas, NO inventes alternativas ni ` +
      `digas que no se puede: dile que la conecte él en Ajustes → Integraciones, que se lo ` +
      `pida a la persona de la lista, o que la compartan con el equipo desde ese mismo panel.]`
    );
  } catch {
    return null;
  }
}

/** Nombre visible de un sub. Best-effort: sin fila en el padrón, se omite. */
async function nombreDe(sub: string): Promise<string | null> {
  try {
    const { listWorkspaceUsers } = await import("../../users.server");
    return (await listWorkspaceUsers()).find((u) => u.sub === sub)?.name ?? null;
  } catch {
    return null;
  }
}
