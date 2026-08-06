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

/** Tableros vivos del workspace. */
export async function listBoards(): Promise<Board[]> {
  const rows = await dbq(
    "SELECT id, slug, name FROM task_projects WHERE COALESCE(archived,0) = 0 ORDER BY id"
  );
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

/** slug único, calcado de `uniqueSlug` en ghosty-tasks/src/server/projects.ts. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tablero"
  );
}

/**
 * Crea un tablero.
 *
 * ⚠️ **Duplica `createProjectFn` de `ghosty-tasks/src/server/projects.ts`** — es la única
 * duplicación de este puente y está aquí a conciencia: el tool-token de Tasks lleva el
 * `projectId` DENTRO, así que no hay forma de pedirle "créame un tablero" sin tener ya uno.
 * Es escribir en la misma DB que Teams ya escribe, no una API paralela.
 *
 * ⚠️ Las tres columnas y sus NOMBRES tienen que seguir igual que allá: `move_task` habla de
 * "Done" por nombre, y un tablero nacido aquí con otros nombres no se podría cerrar.
 */
export async function createBoard(name: string, sub: string): Promise<Board> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("el tablero necesita un nombre");
  const base = slugify(clean);
  let slug = base;
  for (let i = 2; (await dbq("SELECT 1 FROM task_projects WHERE slug = ?", [slug])).length; i++)
    slug = `${base}-${i}`;

  const rows = await dbq(
    "INSERT INTO task_projects (slug, name, created_by) VALUES (?, ?, ?) RETURNING id, slug, name",
    [slug, clean, sub]
  );
  const board = { id: Number(rows[0].id), slug: String(rows[0].slug), name: String(rows[0].name) };

  for (const [i, [col, color]] of ([
    ["To Do", "#6b7280"],
    ["In Progress", "#3b82f6"],
    ["Done", "#22c55e"],
  ] as const).entries())
    await dbq("INSERT INTO task_columns (project_id, name, position, color) VALUES (?, ?, ?, ?)", [
      board.id,
      col,
      i,
      color,
    ]);

  // Sin esta fila, quien lo creó no es miembro y `requireProjectMember` le negaría su propio
  // tablero en la siguiente petición.
  await dbq(
    "INSERT OR IGNORE INTO task_project_members (project_id, user_sub, role) VALUES (?, ?, ?)",
    [board.id, sub, "owner"]
  );
  return board;
}

/** URL del tablero, y de UNA tarea si se pasa. La liga profunda es `?task=<id>`. */
export function boardUrl(slug: string, boardSlug: string, taskId?: number): string {
  const root = process.env.TASKS_ROOT_DOMAIN ?? "tasks.ghosty.studio";
  const base = `https://${slug}.${root}/p/${boardSlug}/board`;
  return taskId ? `${base}?task=${taskId}` : base;
}
