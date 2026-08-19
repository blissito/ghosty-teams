// Discovery + dispatch GENÉRICO de tools de conectores (modelo claude.ai/Cowork). El runtime
// nativo pide las tools de un usuario (listUserTools) para presentárselas al modelo, y cuando
// el agente invoca una, ejecuta runTool con las creds per-user (token en gc_user_connectors).
//
// Seguridad: SOLO se listan/ejecutan tools de conectores que el usuario TIENE conectados
// (listConnectorProviders) → un user no puede invocar la tool de una integración ajena/no
// conectada. El handler resuelve el token del `sub` internamente (getValidToken).

import { loaderFor, toolsOf } from "./impl";
import { nativeTools, type ToolDest } from "./native.server";
import { taskTools } from "./tasks.native.server";
import type { ToolScope } from "./tool-token.server";

// Declaración expuesta al modelo (sin el handler).
export type ToolDecl = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * Las únicas tools que ve un portador con `scope: "lectura"`.
 *
 * Es una LISTA BLANCA y no una negra a propósito: una tool nueva nace fuera del scope
 * acotado, y hay que meterla aquí a mano. Con una lista negra, cada tool que alguien añadiera
 * quedaría automáticamente al alcance de un agente de terceros — y ese olvido no avisa.
 *
 * Todas leen SÓLO la conversación del turno: ninguna acepta un canal o un documento por
 * argumento, el objetivo sale del `dest` firmado. Ver el comentario de `doc_read`.
 */
const SOLO_LECTURA = new Set(["chat_history", "chat_search", "doc_read"]);

/** ¿Puede este portador ejercer esta tool? El scope acota QUÉ hace; el `dest`, DÓNDE. */
export function toolEnScope(name: string, scope: ToolScope): boolean {
  return scope === "completo" || SOLO_LECTURA.has(name);
}

/**
 * Tools disponibles para el usuario = las NATIVAS (siempre) + las de sus conectores
 * CONECTADOS. Las nativas van incondicionalmente: no dependen de que nadie autorice
 * nada, y sin ellas un usuario sin integraciones veía cero tools.
 */
export async function listUserTools(
  sub: string,
  dest: ToolDest | null = null,
  scope: ToolScope = "completo"
): Promise<ToolDecl[]> {
  // El filtro de verdad está en `runTool`; éste es para no ANUNCIAR lo que no se puede usar.
  // Anunciar de más haría que el modelo lo intentara y fallara, que es peor que no verlo.
  if (scope !== "completo") {
    return nativeTools(dest)
      .filter((t) => toolEnScope(t.name, scope))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }
  // Los suyos + los COMPARTIDOS del workspace. Éste es el cambio que hace funcionar las
  // conexiones de equipo: sin él las tools ni se le anuncian al modelo, y el agente diría
  // "no tengo Sentry" teniendo una compartida delante.
  const { listAvailableProviders } = await import("./store.server");
  const connected = await listAvailableProviders(sub);
  const out: ToolDecl[] = nativeTools(dest).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  // Las de Ghosty Tasks van aparte de `nativeTools` porque ésa es síncrona y éstas piden sus
  // schemas al tablero. Un Tasks caído no puede dejar al usuario sin el resto de sus tools.
  for (const t of await taskTools(sub, dest).catch(() => []))
    out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
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

/**
 * El CANDADO del alcance por room. Filtrar la lista de tools es UX; esto es la seguridad:
 * al modelo se le ofreció `github_read_file`, y nada le impide llamarla con un repo que este
 * room no declaró. Sin esta comprobación, el filtro de `github.server.ts` sería una
 * sugerencia — la misma lección que `CARD_ACTIONS`: la lista cerrada vive en el servidor.
 *
 * Devuelve el motivo cuando hay que abortar, o `null` para dejar pasar.
 */
async function repoScopeDenial(
  toolName: string,
  args: Record<string, unknown>,
  dest: ToolDest | null
): Promise<string | null> {
  if (!toolName.startsWith("github_")) return null;
  if (!dest?.channelId) return null; // DM 1:1 → sin restricción de room
  const { allowedRepos, normalizeRepo, REPOLESS_TOOLS } = await import("./github.server");
  const allowed = await allowedRepos(dest);
  if (!allowed) return null;
  if (!allowed.length)
    return "Este room no tiene ningún repositorio conectado, así que aquí no puedes consultar GitHub. Pídele a la persona que conecte uno con el botón de GitHub del encabezado del room.";
  if (REPOLESS_TOOLS.has(toolName)) return null;
  const asked = normalizeRepo(args?.repo);
  if (!asked)
    return `Falta el repositorio. En este room trabajas sobre ${allowed.join(", ")}.`;
  const ok = allowed.some((r) => r.toLowerCase() === asked.toLowerCase());
  // El error DICE cuáles sí, porque el modelo lo lee: un "no permitido" a secas lo lleva a
  // reintentar con otro nombre inventado en vez de usar el que tiene delante.
  return ok
    ? null
    : `El repositorio ${asked} no está conectado a este room. Aquí sólo puedes trabajar sobre ${allowed.join(", ")}. No lo intentes por otra vía: dile a la persona que lo conecte con el botón de GitHub del encabezado si de verdad lo quiere aquí.`;
}

/** Ejecuta una tool por nombre, SOLO si pertenece a un conector conectado del usuario. */
export async function runTool(
  sub: string,
  toolName: string,
  args: Record<string, unknown>,
  dest: ToolDest | null = null,
  scope: ToolScope = "completo"
): Promise<RunResult> {
  // ⚠️ El scope se aplica AQUÍ, en la ejecución, y no sólo en el listado. Filtrar únicamente
  // lo que se anuncia sería cosmético: nada impide que un modelo llame por nombre a una tool
  // que nunca se le enseñó, y los nombres de las nuestras están en el código, en los tests y
  // en cualquier transcripción.
  if (!toolEnScope(toolName, scope)) {
    return { ok: false, error: `${toolName} no está disponible para este agente (sólo lectura de la conversación).` };
  }
  const denial = await repoScopeDenial(toolName, args ?? {}, dest);
  if (denial) return { ok: false, error: denial };
  // Las de Tasks antes que nada: su nombre está reservado y no dependen de ningún conector.
  if (toolName.startsWith("task_")) {
    const tt = (await taskTools(sub, dest)).find((t) => t.name === toolName);
    if (!tt) return { ok: false, error: `tool de tablero no disponible: ${toolName}` };
    try {
      return { ok: true, result: await tt.handler(sub, args ?? {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
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
