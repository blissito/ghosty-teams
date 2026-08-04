// Discovery + dispatch GENÉRICO de tools de conectores (modelo claude.ai/Cowork). El runtime
// nativo pide las tools de un usuario (listUserTools) para presentárselas al modelo, y cuando
// el agente invoca una, ejecuta runTool con las creds per-user (token en gc_user_connectors).
//
// Seguridad: SOLO se listan/ejecutan tools de conectores que el usuario TIENE conectados
// (listConnectorProviders) → un user no puede invocar la tool de una integración ajena/no
// conectada. El handler resuelve el token del `sub` internamente (getValidToken).

import { loaderFor, toolsOf } from "./impl";
import { nativeTools, type ToolDest } from "./native.server";

// Declaración expuesta al modelo (sin el handler).
export type ToolDecl = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * Tools disponibles para el usuario = las NATIVAS (siempre) + las de sus conectores
 * CONECTADOS. Las nativas van incondicionalmente: no dependen de que nadie autorice
 * nada, y sin ellas un usuario sin integraciones veía cero tools.
 */
export async function listUserTools(sub: string, dest: ToolDest | null = null): Promise<ToolDecl[]> {
  // Los suyos + los COMPARTIDOS del workspace. Éste es el cambio que hace funcionar las
  // conexiones de equipo: sin él las tools ni se le anuncian al modelo, y el agente diría
  // "no tengo Sentry" teniendo una compartida delante.
  const { listAvailableProviders } = await import("./store.server");
  const connected = await listAvailableProviders(sub);
  const out: ToolDecl[] = nativeTools(dest).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  for (const id of connected) {
    const load = loaderFor(id);
    if (!load) continue;
    try {
      const mod = await load();
      for (const t of await toolsOf(mod, sub, dest)) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    } catch {
      // un conector roto no rompe el listado de los demás
    }
  }
  return out;
}

export type RunResult =
  | { ok: true; result: unknown; usedSharedConnection?: string }
  | { ok: false; error: string };

/** Nombre visible de un sub, para decir con qué cuenta se actuó. Best-effort. */
async function nombreDe(sub: string): Promise<string | null> {
  try {
    const { listWorkspaceUsers } = await import("../../users.server");
    return (await listWorkspaceUsers()).find((u) => u.sub === sub)?.name ?? null;
  } catch {
    return null;
  }
}

/** Ejecuta una tool por nombre, SOLO si pertenece a un conector conectado del usuario. */
export async function runTool(sub: string, toolName: string, args: Record<string, unknown>, dest: ToolDest | null = null): Promise<RunResult> {
  // Las nativas primero: no requieren conector y su nombre está reservado.
  const nat = nativeTools(dest).find((t) => t.name === toolName);
  if (nat) {
    try {
      return { ok: true, result: await nat.handler(sub, args ?? {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const { listAvailableProviders, resolveConnectorOwner } = await import("./store.server");
  const connected = await listAvailableProviders(sub);
  for (const id of connected) {
    const load = loaderFor(id);
    if (!load) continue;
    let mod;
    try {
      mod = await load();
    } catch {
      continue;
    }
    const tool = (await toolsOf(mod, sub, dest)).find((t) => t.name === toolName);
    if (!tool) continue;
    // Con QUÉ cuenta se ejecuta. La propia gana; si no hay, la compartida del workspace.
    // Al handler se le pasa el sub DUEÑO del token y por eso ninguno de ellos cambia.
    const dueño = await resolveConnectorOwner(sub, id);
    if (!dueño) continue;
    try {
      const result = await tool.handler(dueño.ownerSub, args ?? {});
      if (!dueño.shared) return { ok: true, result };
      // Con una conexión ajena, el resultado DICE de quién es. Que el equipo vea con qué
      // cuenta se actuó es parte del control, no un adorno — y evita que el agente hable
      // como si los datos fueran del que pregunta.
      const quien = await nombreDe(dueño.ownerSub);
      return {
        ok: true,
        result,
        usedSharedConnection: quien
          ? `Se usó la conexión de ${id} de ${quien}, compartida con el equipo. Dilo al reportar el resultado.`
          : `Se usó una conexión de ${id} compartida con el equipo. Dilo al reportar el resultado.`,
      } as RunResult;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `tool no disponible o conector no conectado: ${toolName}` };
}
