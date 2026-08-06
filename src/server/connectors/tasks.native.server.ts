import type { ConnectorTool } from "./impl";
import type { ToolDest } from "./tool-token.server";
import {
  boardSchemas,
  callTasks,
  isWorkspaceAction,
  teamsToolNames,
  toBoardAction,
} from "../tasks-bridge.server";
import { boardUrl, listBoards, rememberRoomBoard, resolveBoard } from "../tasks-boards.server";
import { currentSlug } from "../tenant.server";

// Las tools `task_*` que el agente ve DESDE el chat. Van aparte de `nativeTools()` porque
// ésa es síncrona y aquí hay que pedirle los schemas a Tasks — volverla async arrastraría
// todo su árbol de llamadas por una sola familia de tools.
//
// El reparto: este archivo decide QUÉ tablero y arma el catálogo; `tasks-bridge.server.ts`
// transporta; y las reglas (validación, permisos) viven sólo en Tasks.

/** Descripciones en español para el catálogo. Las de Tasks vienen bien, pero el nombre que
 *  el modelo ve aquí es el prefijado, así que la frase tiene que hablar de ESE nombre. */
const EXTRA: Record<string, string> = {
  task_board_read: "Lee el tablero completo: columnas y tarjetas.",
  task_find: "Busca tareas por texto, responsable, columna, prioridad o estado.",
  task_create: "Crea una tarea en el tablero.",
  task_move: "Mueve una tarea a otra columna (p. ej. a 'Done' para cerrarla).",
  task_update: "Cambia título, descripción, prioridad, estado, responsable o fecha.",
  task_labels: "Añade o quita etiquetas de una tarea.",
  task_comment: "Comenta en una tarea.",
  task_checklist_add: "Añade un punto a la lista de verificación de una tarea.",
  task_member_add: "Da de alta a alguien en el tablero.",
  task_delete: "Archiva una tarea (reversible). Pide confirm:true.",
};

const str = (description: string) => ({ type: "string", description });

/** El argumento que TODAS llevan de más respecto a Tasks. */
const BOARD_HINT = {
  board: str(
    'Nombre del tablero, sólo si la persona dijo uno. Si no, se usa el de este room.'
  ),
};

/**
 * Catálogo completo de `task_*`. **Ninguna se implementa aquí**: todas son la acción de
 * Tasks, con otro nombre.
 *
 * Los schemas se PIDEN (`{action:"list"}`) y se cachean: copiarlos a mano garantiza que se
 * desincronicen y que el modelo mande un argumento que ya no existe. Si Tasks no responde no
 * se ofrece ninguna, que es preferible a anunciar acciones cuyos argumentos no conocemos.
 */
export async function taskTools(sub: string, dest: ToolDest | null): Promise<ConnectorTool[]> {
  const slug = await currentSlug().catch(() => null);
  if (!slug) return [];

  const pick = await resolveBoard(dest?.channelId ?? null);
  // Para PEDIR el catálogo basta cualquier tablero —las acciones no dependen de cuál—, y con
  // ninguno se usa el token de espacio (`projectId: 0`), que es justo el que deja crear el
  // primero.
  const anyBoard = pick.kind === "board" ? pick.board.id : pick.kind === "ask" ? pick.candidates[0].id : 0;
  const schemas = await boardSchemas(slug, sub, anyBoard);

  const out: ConnectorTool[] = [];
  for (const teamsName of teamsToolNames()) {
    const inner = toBoardAction(teamsName)!;
    const s = schemas[inner];
    if (!s) continue;
    // Sin ningún tablero sólo tienen sentido las de espacio: ofrecer `task_create` llevaría
    // al agente a intentarlo y fallar, que es peor que no tenerla.
    if (pick.kind === "none" && !isWorkspaceAction(teamsName)) continue;
    const props = ((s.inputSchema as any)?.properties ?? {}) as Record<string, unknown>;
    out.push({
      name: teamsName,
      description: EXTRA[teamsName] ?? s.description,
      inputSchema: isWorkspaceAction(teamsName)
        ? (s.inputSchema as Record<string, unknown>)
        : { ...(s.inputSchema as object), properties: { ...props, ...BOARD_HINT } },
      handler: (handlerSub, args) => runProxied(handlerSub, dest, teamsName, args),
    });
  }
  return out;
}

async function runProxied(
  sub: string,
  dest: ToolDest | null,
  teamsName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const slug = await currentSlug().catch(() => null);
  if (!slug) return { error: "no pude resolver el espacio de trabajo" };

  // `board` es NUESTRO argumento, no de Tasks: se saca antes de reenviar o su validador lo
  // rechazaría por desconocido.
  const { board: hint, ...rest } = (args ?? {}) as { board?: unknown };

  // Las de ESPACIO no van dentro de ningún tablero: token con `projectId: 0`. Resolver uno
  // antes las haría imposibles justo cuando hacen falta —crear el primero—.
  if (isWorkspaceAction(teamsName)) {
    const r = await callTasks(slug, sub, 0, teamsName, rest as Record<string, unknown>);
    if (!r.ok) return { error: r.error };
    const res = r.result as Record<string, unknown> | null;
    // Un tablero recién creado queda como el del room: quien acaba de pedirlo va a trabajar
    // en él, y obligarle a repetir el nombre en el mensaje siguiente sería absurdo.
    const nuevo = Number((res as any)?.id);
    if (dest?.channelId && Number.isFinite(nuevo) && nuevo > 0)
      await rememberRoomBoard(dest.channelId, nuevo, sub);
    return res ?? { ok: true };
  }

  const pick = await resolveBoard(dest?.channelId ?? null, hint ? String(hint) : undefined);

  if (pick.kind === "none")
    return { error: "Este espacio todavía no tiene ningún tablero. Créalo con task_board_create." };
  if (pick.kind === "ask")
    // El mismo shape que usan las acciones de Tasks para lo mismo: el agente ya lo entiende
    // y pregunta en vez de elegir. Elegir a ciegas escribe en el tablero equivocado y nadie
    // se entera hasta que alguien busca la tarea donde debería estar.
    return {
      needs: "disambiguation",
      pregunta: "¿En qué tablero?",
      candidates: pick.candidates.map((b) => b.name),
    };

  const r = await callTasks(slug, sub, pick.board.id, teamsName, rest as Record<string, unknown>);
  if (!r.ok) return { error: r.error };

  // Recordar el tablero DESPUÉS de que la llamada salga bien: si falló por permisos, este
  // room no debería quedarse apuntando ahí.
  if (dest?.channelId) await rememberRoomBoard(dest.channelId, pick.board.id, sub);

  const result = r.result as Record<string, unknown> | null;
  const id = Number((result as any)?.id ?? (result as any)?.task?.id);
  return {
    ...(typeof result === "object" && result ? result : { result }),
    tablero: pick.board.name,
    url: Number.isFinite(id) && id > 0 ? boardUrl(slug, pick.board.slug, id) : boardUrl(slug, pick.board.slug),
  };
}

/**
 * El bloque de contexto de Tasks. Va aquí y no en una skill:
 * `gotcha_skill_autodescubrible_no_es_leida` — lo que tiene que pasar siempre no puede
 * depender de que el modelo abra un archivo.
 */
export async function tasksContext(dest: ToolDest | null): Promise<string | null> {
  const slug = await currentSlug().catch(() => null);
  if (!slug) return null;
  const boards = await listBoards().catch(() => []);
  if (!boards.length) return null;
  const pick = await resolveBoard(dest?.channelId ?? null);
  const donde =
    pick.kind === "board"
      ? `En este room el tablero es "${pick.board.name}"; si no dicen otro, usa ése.`
      : `Hay varios tableros (${boards.map((b) => b.name).join(", ")}): si no dicen cuál, PREGUNTA.`;

  return (
    `[GHOSTY TASKS conectado. ${donde} ` +
    `Tienes tools task_* para el tablero: task_boards, task_board_read, task_find, task_create, ` +
    `task_move, task_update, task_labels, task_comment, task_checklist_add, task_member_add, ` +
    `task_delete y task_board_create. ` +
    `Cuando alguien acuerde algo que hay que HACER —con dueño o con fecha— ofrécete a crear la ` +
    `tarea; no lo hagas a sus espaldas. Trabajas con la cuenta de quien te habló, así que la ` +
    `tarea aparece a su nombre. ` +
    // Sin esto el agente contesta con un párrafo y la tarea queda invisible en el chat.
    `OBLIGATORIO: después de crear o mover una tarea, cierra tu respuesta con un bloque ` +
    "```gt-task" +
    ` con este JSON en una línea: {"id":N,"title":"…","board":"…","column":"…",` +
    `"assignee":"…","priority":"…","due":"AAAA-MM-DD","url":"…"}. Pon SÓLO lo que sepas de ` +
    `verdad por la respuesta de la tool; omite lo que no, nunca lo inventes. La plataforma le ` +
    `pinta los botones a la persona, así que NO preguntes "¿la marco como hecha?" ni menciones ` +
    `el nombre de ninguna tool: eso es fontanería nuestra.]`
  );
}
