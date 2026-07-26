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
    return blocks.length ? blocks.join("\n\n") + "\n\n" : "";
  } catch {
    return "";
  }
}
