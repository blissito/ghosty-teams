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

/** Por dónde ejerce sus tools quien recibe el contexto. Ver `ambientContext`. */
export type ToolChannel = "gs-sdk" | "mcp";

/**
 * Aviso que acompaña a CUALQUIER lista de nombres de tools cuando quien la lee las recibe
 * por MCP.
 *
 * ⚠️ Un cliente MCP NAMESPACEA las tools con el nombre del servidor: en goose, `task_create`
 * aparece como `ghosty__task_create` (comprobado en su sesión real el 2026-08-20 —
 * `grep -ao "ghosty__[a-z_]*" sessions.db-wal`). Nuestros bloques de contexto las nombraban
 * en crudo, así que el agente buscaba un nombre que en su lista NO EXISTE, y de ahí concluía
 * —y le decía al usuario— que no tenía acceso al tablero mientras lo tenía delante.
 *
 * Se enseña la REGLA en vez de escribir el prefijo en cada sitio: el prefijo lo decide el
 * cliente, no nosotros, y hoy es `ghosty__` porque así se llama nuestro servidor en el relé
 * de goose-acp. Un cliente ACP nuevo puede usar otro separador, otro nombre o ninguno; con
 * la regla, ese agente sigue funcionando sin tocar este archivo.
 */
export const NOTA_PREFIJO_MCP =
  "OJO con los nombres: tu cliente puede mostrarlas con el prefijo de su servidor " +
  "(p. ej. `ghosty__task_create` en vez de `task_create`). Es la MISMA herramienta: " +
  "llámala con el nombre exacto que veas en TU lista y nunca concluyas que no la tienes " +
  "porque el nombre no coincida letra por letra con el de este texto. ";

/** El aviso, sólo cuando aplica. Vacío para el SDK, donde los nombres son literales. */
export function notaNombres(toolChannel: ToolChannel = "gs-sdk"): string {
  return toolChannel === "mcp" ? NOTA_PREFIJO_MCP : "";
}

/**
 * Resultado del "ping" de un conector por CREDENCIALES: prueba lo que tecleó la persona
 * ANTES de que se guarde nada. El `error` lo lee un HUMANO en el formulario (a diferencia
 * del `{error}` de un handler de tool, que lo lee el modelo), así que dice qué corregir.
 */
export type VerifyResult =
  | { ok: true; externalId?: string | null; probe?: unknown }
  | { ok: false; error: string };

export type ConnectorModule = {
  // `message` = texto del turno del usuario → el conector decide si enriquece (p.ej. Calendly
  // sólo pega a la API en intención de agenda). La lógica per-conector vive AQUÍ, no en dm.ts.
  // El `dest` es por el mismo motivo que en `tools`: hay conectores cuyo set de tools
  // depende de DÓNDE ocurre el turno (las alertas de Sentry sólo existen dentro de un
  // canal), y sin él el bloque le anunciaba al modelo tools que en un DM no existen.
  // `opts.toolChannel` dice CÓMO llegan las tools a este agente, y sólo importa para el texto:
  // un worker nativo las llama por el SDK de su caja (`/opt/gs-sdk/connectors.mjs`), y un
  // agente ACP las recibe como herramientas del protocolo y las invoca por su nombre. Decirle
  // a un ACP que importe un SDK que no existe es peor que no decirle nada: intenta el import,
  // falla, y concluye que no tiene la integración. Opcional ⇒ ningún conector se rompe por
  // ignorarlo, y el default es el de siempre.
  ambientContext?: (
    sub: string,
    sender: string,
    message: string,
    dest: ToolDest | null,
    opts?: { toolChannel?: ToolChannel }
  ) => Promise<string | null>;
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
  // Sólo conectores con `credentials` en el registry. Recibe los campos YA pasados por el
  // guard de red (net-guard.server.ts) y NO recibe `sub`: no puede persistir nada ni
  // saltarse el guard — de eso se encarga credentials.server.ts. Vive aquí y no en el
  // registry porque el registry se importa SIEMPRE (lo lee el panel) y esto hace red: con
  // 40 conectores serían 40 clientes HTTP cargados para pintar una lista.
  verifyCredentials?: (fields: Record<string, string>) => Promise<VerifyResult>;
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
  odoo: () => import("./odoo.server"),
};

export function loaderFor(id: string): (() => Promise<ConnectorModule>) | undefined {
  return LOADERS[id];
}
