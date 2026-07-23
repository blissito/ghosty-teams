// Contrato UNIFORME de implementación de un conector (modelo claude.ai/Cowork): además de
// su metadata (registry.ts), cada integración puede exportar `ambientContext` (contexto
// barato por turno) y `tools` (acciones que el agente invoca on-demand). El runtime nativo
// DESCUBRE las tools de los conectores CONECTADOS del usuario y las presenta al modelo;
// cuando el agente llama una, el runtime pega al dispatch (/api/connectors/tools) → runTool.
//
// Escala a miles: carga PEREZOSA por id (solo se importa el módulo de un conector si el
// usuario lo conectó). Agregar integración = módulo + 1 línea en LOADERS.

export type ToolHandler = (sub: string, args: Record<string, unknown>) => Promise<unknown>;

// Declaración estilo function-calling (name global-único → prefijado por conector).
export type ConnectorTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema del argumento
  handler: ToolHandler;
};

export type ConnectorModule = {
  ambientContext?: (sub: string, sender: string) => Promise<string | null>;
  tools?: ConnectorTool[];
};

// Una línea por integración. Lazy → no arrastra miles de módulos por request.
const LOADERS: Record<string, () => Promise<ConnectorModule>> = {
  calendly: () => import("./calendly.server"),
};

export function loaderFor(id: string): (() => Promise<ConnectorModule>) | undefined {
  return LOADERS[id];
}
