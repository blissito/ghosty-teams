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
import { SCOPE_COMPLETO, type ToolScope } from "./tool-token.server";

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

/**
 * FAMILIAS por prefijo de nombre.
 *
 * Es por prefijo y no por lista de nombres para que añadir `github_create_release` mañana no
 * obligue a tocar este archivo. Y la regla que lo hace seguro está abajo: **un prefijo que no
 * esté aquí sólo lo alcanza `completo`**. O sea, una tool con nombre nuevo nace FUERA de todas
 * las familias acotadas. El olvido falla cerrado, que es la única dirección aceptable.
 *
 * ⚠️ No añadas aquí un prefijo "por si acaso": cada entrada amplía lo que un binario de
 * terceros puede ejecutar con las credenciales de quien le escribe.
 */
const FAMILIAS: Array<[prefijo: string, familia: string]> = [
  ["github_", "codigo"],
  ["task_", "tareas"],
  ["reminder_", "agenda"],
  ["form_", "formularios"],
  ["doc_", "docs"],
  ["memory_", "memoria"],
  ["prospect_", "prospeccion"],
];

function familiaDe(name: string): string | null {
  for (const [prefijo, familia] of FAMILIAS) if (name.startsWith(prefijo)) return familia;
  return null;
}

/**
 * ¿Puede este portador ejercer esta tool? El scope acota QUÉ hace; el `dest`, DÓNDE.
 *
 * Son ejes ORTOGONALES y uno no cierra el otro: el room decide sobre qué repos se trabaja,
 * pero no dice nada de si este agente puede además mandar correo a tu nombre.
 */
export function toolEnScope(name: string, scope: ToolScope): boolean {
  if (scope.has("completo")) return true;
  // Las de lectura de la conversación van por lista blanca y no por prefijo: `doc_read` lee y
  // `doc_share` reparte, y las dos empiezan igual. Aquí la precisión importa más que la regla.
  if (SOLO_LECTURA.has(name)) return scope.has("lectura");
  const f = familiaDe(name);
  return f !== null && scope.has(f);
}

/**
 * Tools disponibles para el usuario = las NATIVAS (siempre) + las de sus conectores
 * CONECTADOS. Las nativas van incondicionalmente: no dependen de que nadie autorice
 * nada, y sin ellas un usuario sin integraciones veía cero tools.
 */
export async function listUserTools(
  sub: string,
  dest: ToolDest | null = null,
  scope: ToolScope = SCOPE_COMPLETO
): Promise<ToolDecl[]> {
  // El filtro de verdad está en `runTool`; esto es para no ANUNCIAR lo que no se puede usar.
  // Anunciar de más haría que el modelo lo intentara y fallara, que es peor que no verlo.
  //
  // ⚠️ Aquí vivía un atajo que costó una tarde: con cualquier scope acotado se devolvían sólo
  // las nativas y NO se consultaban los conectores. O sea que un agente con permiso de
  // `codigo` no veía ni una tool de GitHub, y desde fuera parecía que el permiso no servía —
  // el 19 ago 2026 @goose acabó intentando `gh` por shell y redactando en un artefacto el
  // issue que le pidieron crear. Un scope acotado tiene que ENTRAR igual al bucle de
  // conectores; lo que cambia es lo que sale, y de eso se encarga el filtro del final.
  //
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
  // Un solo filtro al final, sobre TODO lo reunido: nativas, tablero y conectores. Filtrar en
  // cada rama era lo que dejaba huecos.
  return out.filter((t) => toolEnScope(t.name, scope));
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
  // Ya NO se sale por "no hay canal": la excepción del DM la resuelve `allowedRepos`, que
  // distingue el 1:1 (sin restricción, son tus propios repos) del grupo (como un room sin
  // repos). Meter esa decisión aquí duplicaba la regla en dos sitios que podían divergir.
  const { allowedRepos, normalizeRepo, REPOLESS_TOOLS } = await import("./github.server");
  const allowed = await allowedRepos(dest);
  if (!allowed) return null;
  if (!allowed.length)
    // El texto cambia con el sitio: mandar a alguien al "botón del encabezado del room"
    // estando en un chat de grupo es mandarlo a buscar algo que no va a encontrar.
    return dest?.channelId
      ? "Este room no tiene ningún repositorio conectado, así que aquí no puedes consultar GitHub. Pídele a la persona que conecte uno con el botón de GitHub del encabezado del room."
      : "En un chat de grupo no puedes consultar GitHub: no hay forma de decir sobre qué repositorio se trabaja, y lo que leyeras lo verían personas que quizá no tengan ese acceso. Dile que te lo pida en el room del repositorio, o en un mensaje directo.";
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
  scope: ToolScope = SCOPE_COMPLETO
): Promise<RunResult> {
  // ⚠️ El scope se aplica AQUÍ, en la ejecución, y no sólo en el listado. Filtrar únicamente
  // lo que se anuncia sería cosmético: nada impide que un modelo llame por nombre a una tool
  // que nunca se le enseñó, y los nombres de las nuestras están en el código, en los tests y
  // en cualquier transcripción.
  if (!toolEnScope(toolName, scope)) {
    return {
      ok: false,
      error:
        `${toolName} no está disponible para este agente. Su alcance en este espacio es ` +
        `"${[...scope].join(", ")}". Díselo a la persona en vez de buscar otra vía.`,
    };
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
