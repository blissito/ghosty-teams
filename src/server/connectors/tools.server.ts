// Discovery + dispatch GENÉRICO de tools de conectores (modelo claude.ai/Cowork). El runtime
// nativo pide las tools de un usuario (listUserTools) para presentárselas al modelo, y cuando
// el agente invoca una, ejecuta runTool con las creds per-user (token en gc_user_connectors).
//
// Seguridad: SOLO se listan/ejecutan tools de conectores que el usuario TIENE conectados
// (listConnectorProviders) → un user no puede invocar la tool de una integración ajena/no
// conectada. El handler resuelve el token del `sub` internamente (getValidToken).

import { loaderFor } from "./impl";

// Declaración expuesta al modelo (sin el handler).
export type ToolDecl = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Tools disponibles para el usuario = unión de las de sus conectores CONECTADOS. */
export async function listUserTools(sub: string): Promise<ToolDecl[]> {
  const { listConnectorProviders } = await import("./store.server");
  const connected = await listConnectorProviders(sub);
  const out: ToolDecl[] = [];
  for (const id of connected) {
    const load = loaderFor(id);
    if (!load) continue;
    try {
      const mod = await load();
      for (const t of mod.tools ?? []) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    } catch {
      // un conector roto no rompe el listado de los demás
    }
  }
  return out;
}

export type RunResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Ejecuta una tool por nombre, SOLO si pertenece a un conector conectado del usuario. */
export async function runTool(sub: string, toolName: string, args: Record<string, unknown>): Promise<RunResult> {
  const { listConnectorProviders } = await import("./store.server");
  const connected = await listConnectorProviders(sub);
  for (const id of connected) {
    const load = loaderFor(id);
    if (!load) continue;
    let mod;
    try {
      mod = await load();
    } catch {
      continue;
    }
    const tool = (mod.tools ?? []).find((t) => t.name === toolName);
    if (!tool) continue;
    try {
      const result = await tool.handler(sub, args ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `tool no disponible o conector no conectado: ${toolName}` };
}
