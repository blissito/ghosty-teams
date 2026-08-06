import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Los repos que un room declara suyos. Es la frontera del conector de GitHub — el porqué
// vive junto a la tabla, en server/schema.server.ts (gt_room_repos).
//
// Todo lo de aquí corre con el token de QUIEN HACE CLIC: la lista de repos sale de SU
// instalación de la App, así que dos personas del mismo room ven conjuntos distintos. Es
// deliberado: una conexión única de workspace perdería la atribución y le daría a cualquier
// miembro el techo de permisos del que la conectó.

/** El room, comprobando que esta persona pueda verlo. Un privado ajeno no existe. */
async function visibleChannel(channelId: number) {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const db = await import("../db.server");
  const ch = (await db.listChannels(me.sub, me.isOwner)).find((c) => c.id === channelId);
  if (!ch) throw new Error("room no encontrado");
  return { me, db, ch };
}

/** Repos atados a este room. Lo pide el encabezado al pintar. */
export const roomReposFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number }) => d)
  .handler(async ({ data }) => {
    const { db } = await visibleChannel(Number(data.channelId));
    return await db.listRoomRepos(Number(data.channelId));
  });

/**
 * Los repos que alcanza la instalación de QUIEN pregunta — lo que se puede conectar.
 *
 * Reusa la tool `github_list_repos` en vez de volver a hablar con GitHub: ahí ya está
 * resuelto el caso de varias instalaciones (personal + organizaciones) y el mensaje de
 * "conectado pero sin instalar", que es el que hay que enseñar cuando la lista sale vacía.
 *
 * Se pide al ABRIR el panel, no con la página: es una llamada a GitHub por persona.
 */
export const githubInstallationReposFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const { allTools } = await import("./connectors/github.server");
  const tool = allTools().find((t) => t.name === "github_list_repos");
  if (!tool) return { repos: [], installUrl: null as string | null };
  const r = (await tool.handler(me.sub, {})) as {
    repos?: { repo: string; private?: boolean; description?: string | null; pushedAt?: string | null }[];
    installed?: boolean;
    installUrl?: string;
    addMoreUrl?: string;
    error?: string;
  };
  return {
    repos: (r?.repos ?? []).filter((x) => typeof x?.repo === "string"),
    // Sin repos la salida correcta NO es un buscador mudo: es la liga para elegirlos en
    // GitHub. Es el mismo caso de "revisa la integración en Ajustes".
    installUrl: r?.addMoreUrl ?? r?.installUrl ?? null,
    connected: !r?.error || r?.installed !== false,
  };
});

/** PRs abiertos de un repo — preview de confirmación en el picker, y lista una vez atado. */
export const githubOpenPrsFn = createServerFn({ method: "POST" })
  .validator((d: { repo: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { allTools, normalizeRepo } = await import("./connectors/github.server");
    const repo = normalizeRepo(data.repo);
    if (!repo) return [];
    const tool = allTools().find((t) => t.name === "github_list_prs");
    if (!tool) return [];
    const r = (await tool.handler(me.sub, { repo, state: "open" })) as
      | { prs?: { number: number; title: string; url?: string; draft?: boolean }[]; error?: string }
      | any;
    // Un repo que la persona no alcanza da error, y aquí eso NO es una excepción: es el
    // caso normal de un repo que conectó alguien más. Lista vacía y la UI lo explica.
    if (!r || r.error) return [];
    const list: any[] = Array.isArray(r) ? r : (r.prs ?? r.pullRequests ?? []);
    return list
      .slice(0, Math.min(Number(data.limit) || 6, 20))
      .map((p) => ({ number: p?.number, title: p?.title ?? "", url: p?.url ?? null, draft: !!p?.draft }))
      .filter((p) => typeof p.number === "number");
  });

/**
 * Ata un repo al room. Cualquiera que pueda VER el room puede conectar: es un equipo, y
 * pedir permisos de administración para algo reversible sólo lo vuelve inservible. Lo que
 * sí queda registrado es quién lo hizo (`connected_by`).
 */
export const addRoomRepoFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; repo: string }) => d)
  .handler(async ({ data }) => {
    const { me, db } = await visibleChannel(Number(data.channelId));
    const { normalizeRepo } = await import("./connectors/github.server");
    const repo = normalizeRepo(data.repo);
    if (!repo) throw new Error('el repositorio va como "dueño/repo"');
    await db.addRoomRepo(Number(data.channelId), repo, me.sub);
    return await db.listRoomRepos(Number(data.channelId));
  });

/** Lo quita quien lo conectó, o el owner del workspace. */
export const removeRoomRepoFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; repo: string }) => d)
  .handler(async ({ data }) => {
    const { me, db } = await visibleChannel(Number(data.channelId));
    const actual = await db.listRoomRepos(Number(data.channelId));
    const fila = actual.find((r) => r.repo.toLowerCase() === String(data.repo).toLowerCase());
    if (!fila) return actual;
    if (!me.isOwner && fila.connectedBy !== me.sub)
      throw new Error("lo conectó otra persona: que lo quite ella o el dueño del espacio");
    await db.removeRoomRepo(Number(data.channelId), fila.repo);
    return await db.listRoomRepos(Number(data.channelId));
  });

/** Para la card del home: cada repo con los rooms donde está conectado. */
export const workspaceRoomReposFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return [];
  const db = await import("../db.server");
  return await db.listWorkspaceRoomRepos(me.sub, me.isOwner);
});
