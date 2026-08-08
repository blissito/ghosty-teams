import { dbq } from "../dbq.server";

// Qué TABLERO usa el agente cuando le hablas desde un room.
//
// Teams y Tasks comparten el MISMO namespace de sqld —un workspace, una DB—, así que los
// tableros se leen con un SELECT y no con una llamada HTTP. Ligar una tarea a un hilo es un
// JOIN, no una integración.
//
// ⚠️ Esto NO es una frontera, al revés que los repos por room. Es un DEFAULT recordado: el
// room propone, no encierra, y a propósito — se quiere que varios rooms puedan mirar otros
// tableros. Lo que impide un abuso real es que Tasks aplica `requireProjectMember` con el
// `sub` de quien invocó, así que nadie ve un tablero del que no sea miembro aunque el room lo
// nombre. Las dos features se parecen y sus garantías no son iguales: no las confundas.

export type Board = { id: number; slug: string; name: string };

/**
 * Tableros vivos del workspace.
 *
 * Es un SELECT y no una llamada a Tasks a propósito: hay que saber a QUÉ tablero apunta el
 * turno antes de poder minar el token, así que pedirlo por HTTP sería un viaje de ida y
 * vuelta en cada turno para decidir. Leer la base compartida vale; lo que no valía era
 * duplicar la lógica de ESCRITURA, que ya vive sólo en `ops/projects.ops.ts` de Tasks.
 */
export async function listBoards(): Promise<Board[]> {
  let rows: Awaited<ReturnType<typeof dbq>>;
  try {
    rows = await dbq(
      "SELECT id, slug, name FROM task_projects WHERE COALESCE(archived,0) = 0 ORDER BY id"
    );
  } catch (e) {
    // El schema de Tasks lo crea TASKS (`ensureSchema` en su `/api/agent/tools`), no Teams:
    // en un tenant que nunca ha abierto tasks.ghosty.studio la tabla no existe todavía.
    // Eso es "cero tableros", no un error — tronar aquí dejaba a `taskTools` sin llegar a
    // `boardSchemas` (que es justo la llamada que crea el schema del otro lado) y el agente
    // de un workspace nuevo nacía sin ni siquiera `task_board_create`. Cualquier otro error
    // (sqld caído) sí sube: convertirlo en "no hay tableros" mentiría.
    if (/no such table/i.test(String((e as Error)?.message))) return [];
    throw e;
  }
  return rows.map((r) => ({ id: Number(r.id), slug: String(r.slug), name: String(r.name) }));
}

/** El tablero que este room viene usando, si alguno. */
export async function roomBoard(channelId: number): Promise<Board | null> {
  const rows = await dbq(
    `SELECT p.id AS id, p.slug AS slug, p.name AS name
       FROM gt_room_board b JOIN task_projects p ON p.id = b.project_id
      WHERE b.channel_id = ? AND COALESCE(p.archived,0) = 0`,
    [channelId]
  );
  const r = rows[0];
  return r ? { id: Number(r.id), slug: String(r.slug), name: String(r.name) } : null;
}

/**
 * Recuerda el tablero de un room. Se llama SOLA la primera vez que una petición resuelve uno
 * ahí — que es lo que hace que no haya nada que configurar antes de que sirva.
 */
export async function rememberRoomBoard(channelId: number, projectId: number, sub: string): Promise<void> {
  await dbq(
    `INSERT INTO gt_room_board (channel_id, project_id, set_by, at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(channel_id) DO UPDATE SET project_id = excluded.project_id,
                                           set_by = excluded.set_by,
                                           at = excluded.at`,
    [channelId, projectId, sub]
  );
}

/** Por nombre: exacto primero, luego por slug, luego "contiene". */
function matchByName(boards: Board[], hint: string): Board | null {
  const q = hint.trim().toLowerCase();
  if (!q) return null;
  return (
    boards.find((b) => b.name.toLowerCase() === q) ??
    boards.find((b) => b.slug.toLowerCase() === q) ??
    boards.find((b) => b.name.toLowerCase().includes(q)) ??
    null
  );
}

export type BoardPick =
  | { kind: "board"; board: Board; remembered: boolean }
  /** Ni pista ni default: el agente PREGUNTA en vez de elegir por su cuenta. */
  | { kind: "ask"; candidates: Board[] }
  | { kind: "none" };

/**
 * Resuelve el tablero de una petición, en este orden:
 *
 *   1. la pista explícita del turno ("…en el tablero de Marketing")
 *   2. el que este room viene usando
 *   3. si el workspace tiene UNO solo, ése
 *   4. si hay varios y ninguno encaja → preguntar
 *
 * ⚠️ El paso 4 no es cortesía: elegir a ciegas escribe una tarea real en el tablero
 * equivocado, y nadie se entera hasta que alguien la busca donde debería estar. `board.
 * actions.ts` de Tasks ya usa este mismo `{needs:"disambiguation"}` y el agente lo entiende.
 */
export async function resolveBoard(channelId: number | null, hint?: string): Promise<BoardPick> {
  const boards = await listBoards();
  if (!boards.length) return { kind: "none" };

  if (hint) {
    const m = matchByName(boards, hint);
    // Una pista que no casa NO cae al default: si pidieron "Marketing" y se escribe en
    // "Producto", el error es invisible. Se ofrecen los que hay.
    return m ? { kind: "board", board: m, remembered: false } : { kind: "ask", candidates: boards };
  }

  if (channelId != null) {
    const rb = await roomBoard(channelId);
    if (rb) return { kind: "board", board: rb, remembered: true };
  }

  if (boards.length === 1) return { kind: "board", board: boards[0], remembered: false };
  return { kind: "ask", candidates: boards };
}

/** URL del tablero, y de UNA tarea si se pasa. La liga profunda es `?task=<id>`. */
export function boardUrl(slug: string, boardSlug: string, taskId?: number): string {
  const root = process.env.TASKS_ROOT_DOMAIN ?? "tasks.ghosty.studio";
  const base = `https://${slug}.${root}/p/${boardSlug}/board`;
  return taskId ? `${base}?task=${taskId}` : base;
}
