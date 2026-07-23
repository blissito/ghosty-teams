// Builder GENÉRICO de contexto de conectores para un turno del agente. Escala a miles de
// integraciones sin tocar dm.ts: itera SOLO los conectores que el usuario tiene conectados
// y le pide a cada uno su `ambientContext` (contrato uniforme). Agregar una integración =
// implementar `ambientContext` en su módulo + una línea en IMPL_LOADERS. Cero acoplamiento.
//
// Nota de escala: `ambientContext` es el bloque BARATO inyectable en cada turno. Las
// capacidades ricas (leer disponibilidad real, agendar, tools de MCP como EasyBits) NO van
// aquí — son TOOLS/SKILLS que el runtime nativo descubre y el agente invoca on-demand (así
// no se inyectan miles de conectores en cada mensaje). Ese surface es el siguiente paso.

type AmbientModule = { ambientContext?: (sub: string, sender: string) => Promise<string | null> };

// Carga PEREZOSA por id → solo se importa el módulo de un conector si el usuario lo conectó
// (no arrastramos miles de integraciones en cada request). Una línea por integración.
const IMPL_LOADERS: Record<string, () => Promise<AmbientModule>> = {
  calendly: () => import("./calendly.server"),
};

/** Contexto ambiente de TODOS los conectores conectados del usuario, listo para el prompt. */
export async function buildConnectorContext(sub: string, sender: string): Promise<string> {
  try {
    const { listConnectorProviders } = await import("./store.server");
    const connected = await listConnectorProviders(sub);
    if (!connected.size) return "";
    const parts = await Promise.all(
      [...connected].map(async (id) => {
        const load = IMPL_LOADERS[id];
        if (!load) return null;
        try {
          const mod = await load();
          return (await mod.ambientContext?.(sub, sender)) ?? null;
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
