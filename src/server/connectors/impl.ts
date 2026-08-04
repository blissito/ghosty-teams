// Contrato UNIFORME de implementación de un conector (modelo claude.ai/Cowork): además de
// su metadata (registry.ts), cada integración puede exportar `ambientContext` (contexto
// barato por turno) y `tools` (acciones que el agente invoca on-demand). El runtime nativo
// DESCUBRE las tools de los conectores CONECTADOS del usuario y las presenta al modelo;
// cuando el agente llama una, el runtime pega al dispatch (/api/connectors/tools) → runTool.
//
// Escala a miles: carga PEREZOSA por id (solo se importa el módulo de un conector si el
// usuario lo conectó). Agregar integración = módulo + 1 línea en LOADERS.

import type { ToolDest } from "./tool-token.server";

export type ToolHandler = (sub: string, args: Record<string, unknown>) => Promise<unknown>;

// Declaración estilo function-calling (name global-único → prefijado por conector).
export type ConnectorTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema del argumento
  handler: ToolHandler;
};

export type ConnectorModule = {
  // `message` = texto del turno del usuario → el conector decide si enriquece (p.ej. Calendly
  // sólo pega a la API en intención de agenda). La lógica per-conector vive AQUÍ, no en dm.ts.
  ambientContext?: (sub: string, sender: string, message: string) => Promise<string | null>;
  // Lista fija, o función cuando el set depende de QUIÉN es el usuario o de DÓNDE ocurre el
  // turno. Denik usa el `sub`: sus tools de administración de plataforma sólo existen para
  // el equipo de Denik, y ofrecérselas a los demás llenaría el prompt de acciones que
  // siempre fallarían con 403.
  //
  // El `dest` es para las tools que dejan algo APUNTANDO a esta conversación —hoy, las
  // alertas entrantes de Sentry. El canal tiene que venir FIRMADO en el tool-token y jamás
  // de los argumentos: si el agente pudiera elegir destino, podría dirigir las alertas de
  // un proyecto al canal privado de otro equipo. Es el mismo criterio que ya protege a las
  // tools nativas (ver tool-token.server.ts).
  tools?: ConnectorTool[] | ((sub: string, dest: ToolDest | null) => Promise<ConnectorTool[]>);
};

/** Resuelve `tools` sea lista o función. */
export async function toolsOf(
  mod: ConnectorModule,
  sub: string,
  dest: ToolDest | null = null
): Promise<ConnectorTool[]> {
  const t = mod.tools;
  if (!t) return [];
  return typeof t === "function" ? await t(sub, dest) : t;
}

// Una línea por integración. Lazy → no arrastra miles de módulos por request.
const LOADERS: Record<string, () => Promise<ConnectorModule>> = {
  calendly: () => import("./calendly.server"),
  denik: () => import("./denik.server"),
  sentry: () => import("./sentry.server"),
  github: () => import("./github.server"),
};

export function loaderFor(id: string): (() => Promise<ConnectorModule>) | undefined {
  return LOADERS[id];
}
