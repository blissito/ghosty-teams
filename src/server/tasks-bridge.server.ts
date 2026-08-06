import crypto from "node:crypto";

// Puente Teams → Ghosty Tasks. Deja que el agente mueva el tablero SIN salir del chat, que
// es donde se rompía el flujo de un equipo: la idea se discute aquí y para volverla trabajo
// con dueño había que abrir otra app y volver a teclearla.
//
// No es un conector OAuth: no hay nada que autorizar. Los dos productos comparten
// `GHOSTY_PARTNER_SECRET` y el MISMO namespace de sqld, así que Teams puede minar un
// tool-token de Tasks y hablarle directo.
//
// Las reglas viven de UN solo lado. Aquí no se valida un título ni se decide quién puede
// tocar un tablero: eso lo hace `board.actions.ts` + `requireProjectMember` en Tasks, con el
// `sub` de quien invocó. Este archivo sólo transporta.

const TTL_S = 15 * 60;

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("falta GHOSTY_PARTNER_SECRET");
  return s;
}

/**
 * Token-capacidad de Tasks: `base64url({sub,projectId,exp}).HMAC`.
 *
 * ⚠️ El formato NO es libre — tiene que casar byte a byte con `verifyToolToken` de
 * `ghosty-tasks/src/server/tool-token.server.ts`, que es el otro extremo.
 *
 * ⚠️ **El tablero va DENTRO del token, no en los argumentos.** Un token = un tablero. Es lo
 * que impide que el modelo escriba en un tablero distinto del que se resolvió: aunque
 * inventara un id de tarea ajeno, `taskOf()` filtra por `project_id` del token y para él
 * simplemente no existe.
 */
function mintTasksToolToken(sub: string, projectId: number): string {
  const payload = { sub, projectId, exp: Math.floor(Date.now() / 1000) + TTL_S };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Las ÚNICAS acciones que este puente puede mandar. Es una lista cerrada, y no por higiene:
 *
 * ⚠️ **`api.agent.tools.ts` de Tasks REENVÍA a los conectores de Teams cualquier nombre que
 * no reconozca** (su `connectors-bridge.server.ts`). Si aquí se reenviara a su vez lo
 * desconocido, dos servidores se pasarían la pelota hasta agotar el timeout — con una
 * petición HTTP por rebote. Un nombre que no esté en esta lista muere AQUÍ, sin salir.
 *
 * Copiadas de `ghosty-tasks/src/server/actions/board.actions.ts`.
 */
const BOARD_ACTIONS = new Set([
  "list_board",
  "find_tasks",
  "create_task",
  "move_task",
  "update_task",
  "set_labels",
  "comment_task",
  "add_checklist_item",
  "add_member",
  "delete_task",
]);

/** ¿Este nombre lo atiende Tasks? Público para que el test del bucle lo compruebe. */
export function isBoardAction(name: string): boolean {
  return BOARD_ACTIONS.has(name);
}

/** Prefijo en Teams: los nombres de tool son globales en el turno y `create_task` a secas
 *  colisiona con demasiadas cosas. `task_create` ↔ `create_task` del otro lado. */
export const TASK_TOOL_PREFIX = "task_";

/**
 * `task_create` → `create_task`. El mapeo es por tabla y no por regla, porque los nombres de
 * Tasks no siguen un patrón único (`list_board`, `add_checklist_item`) y adivinarlo con un
 * split acabaría mandando nombres que no existen.
 */
const NAME_MAP: Record<string, string> = {
  task_board_read: "list_board",
  task_find: "find_tasks",
  task_create: "create_task",
  task_move: "move_task",
  task_update: "update_task",
  task_labels: "set_labels",
  task_comment: "comment_task",
  task_checklist_add: "add_checklist_item",
  task_member_add: "add_member",
  task_delete: "delete_task",
};

export function toBoardAction(teamsName: string): string | null {
  const inner = NAME_MAP[teamsName];
  return inner && BOARD_ACTIONS.has(inner) ? inner : null;
}

export function teamsToolNames(): string[] {
  return Object.keys(NAME_MAP);
}

/** Base pública del Tasks de ESTE workspace. */
function tasksOrigin(slug: string): string {
  const root = process.env.TASKS_ROOT_DOMAIN ?? "tasks.ghosty.studio";
  return `https://${slug}.${root}`;
}

export type TasksCall = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Ejecuta una acción de tablero en Tasks.
 *
 * ⚠️ **El tenant de Tasks sale del HOST, no de un header de namespace** (su
 * `tenant.server.ts`). Se manda `x-ghosty-origin`, que es el punto de inyección que ya honra
 * — y el slug se resuelve del enrutamiento de Teams, **jamás de un argumento del modelo**:
 * si viniera del turno, el agente de un workspace podría apuntar al tablero de otro.
 */
export async function callTasks(
  slug: string,
  sub: string,
  projectId: number,
  name: string,
  args: Record<string, unknown>
): Promise<TasksCall> {
  const action = toBoardAction(name);
  // La puerta del bucle. Antes de cualquier fetch.
  if (!action) return { ok: false, error: `acción de tablero no permitida: ${name}` };

  const origin = tasksOrigin(slug);
  let res: Response;
  try {
    res = await fetch(`${origin}/api/agent/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintTasksToolToken(sub, projectId)}`,
        "x-ghosty-origin": origin,
      },
      body: JSON.stringify({ action: "run", name: action, args: args ?? {} }),
      // La caja de Tasks DUERME por inactividad y el proxy la despierta al primer request:
      // el arranque en frío se come varios segundos. Un timeout corto convertiría eso en un
      // error espurio justo la primera vez del día, que es la peor primera impresión.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, error: `no pude hablar con Tasks: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.status === 401) return { ok: false, error: "Tasks rechazó la credencial del puente." };
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `Tasks respondió ${res.status} sin JSON.` };
  }
  // Tasks devuelve 200 con `{ok:false,error}` para errores de validación a propósito: el
  // modelo lee el motivo y reintenta. Se propaga tal cual en vez de convertirlo en una
  // excepción, que le quitaría justo esa información.
  if (body?.ok === false) return { ok: false, error: String(body.error ?? "error de Tasks") };
  if (!res.ok) return { ok: false, error: `Tasks respondió ${res.status}` };
  return { ok: true, result: body?.result ?? body };
}

/**
 * Los schemas de las acciones, pedidos a Tasks con `{action:"list"}`.
 *
 * ⚠️ **No se copian a mano.** Un argumento nuevo del lado de Tasks aparece aquí solo;
 * duplicarlos garantiza que se desincronicen y que el modelo mande algo que ya no existe.
 *
 * Se cachea por slug y corto: es una llamada por turno y por workspace, no por tool.
 */
const schemaCache = new Map<string, { at: number; byName: Record<string, unknown> }>();
const SCHEMA_TTL_MS = 5 * 60_000;

export async function boardSchemas(
  slug: string,
  sub: string,
  projectId: number
): Promise<Record<string, { description: string; inputSchema: Record<string, unknown> }>> {
  const hit = schemaCache.get(slug);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.byName as never;
  const origin = tasksOrigin(slug);
  const out: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {};
  try {
    const res = await fetch(`${origin}/api/agent/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintTasksToolToken(sub, projectId)}`,
        "x-ghosty-origin": origin,
      },
      body: JSON.stringify({ action: "list" }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    for (const t of body?.tools ?? []) {
      // ⚠️ Su `list` devuelve TAMBIÉN los conectores de Teams (el puente de vuelta). Ofrecer
      // eso aquí duplicaría cada tool del usuario con otro nombre. Sólo las de tablero.
      if (!BOARD_ACTIONS.has(t.name)) continue;
      out[t.name] = { description: t.description, inputSchema: t.inputSchema };
    }
  } catch {
    // Sin schemas no se ofrece ninguna tool de tablero: es preferible a anunciarle al modelo
    // acciones cuyos argumentos no conocemos.
    return {};
  }
  schemaCache.set(slug, { at: Date.now(), byName: out });
  return out;
}
