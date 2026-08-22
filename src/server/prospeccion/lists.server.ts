/**
 * Prospección — listas, columnas y filas.
 *
 * El modelo es el de Clay: la COLUMNA es la unidad de trabajo. Una lista nace con sus
 * columnas base (lo que toda fuente entrega) y el usuario le agrega columnas nuevas que
 * se llenan corriendo una receta sobre las N filas.
 *
 * Las columnas base NO viven en `gt_prosp_columns`: son campos fijos de la fila, porque
 * toda fuente los da y porque el envío los necesita (correo, teléfono) sin tener que
 * resolver un JSON. Las dinámicas sí, y su valor vive en `data_json` de cada fila.
 */
import { dbq, dbqMany, num, type Row } from "../../dbq.server";
// El mapeo y las columnas base viven en un módulo ISOMORFO: la pantalla de revisión
// necesita las mismas definiciones antes de que el servidor toque nada.
import { BASE_COLUMNS, columnKey } from "../../lib/prospeccion-mapping";
export { BASE_COLUMNS, columnKey };

/** Una celda dinámica: el valor, de dónde salió, y si se verificó. */
export type Cell = { v: string | null; src?: string; verified?: boolean };

export type ProspRow = {
  id: number;
  listId: number;
  position: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
  data: Record<string, Cell>;
  status: string;
};

/**
 * La receta de una columna: qué la llena.
 *
 * Es un tipo CERRADO a propósito y no un `Record<string, unknown>`: viaja por la frontera
 * de server-fn (que exige serializable) y, más importante, es lo que decide qué código se
 * ejecuta — un campo libre ahí es una superficie que nadie revisa.
 */
export type Recipe = {
  /** `enrich`: qué tool corre, en orden de waterfall_. La primera que resuelva gana. */
  waterfall?: string[];
  /** `ai`: qué se le pide al modelo por fila. */
  prompt?: string;
  /** Sugerencia de tipo para pintar la celda: text, sí/no, número, url. */
  format?: "text" | "bool" | "number" | "url";
};

export type ProspColumn = {
  id: number;
  listId: number;
  key: string;
  label: string;
  kind: "base" | "enrich" | "ai" | "manual";
  recipe: Recipe | null;
  width: number | null;
  position: number;
};

export type ProspList = {
  id: number;
  name: string;
  criteria: string | null;
  source: string;
  createdBy: string;
  status: string;
  createdAt: number;
  /** Archivada: sigue existiendo y se puede recuperar hasta `purgeAt`. */
  archivedAt: number | null;
  purgeAt: number | null;
  rows: number;
  /** Contadores del embudo, para la tarjeta y el panel. */
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
};


function parseData(raw: string | null): Record<string, Cell> {
  try {
    const o = JSON.parse(String(raw ?? "{}"));
    return o && typeof o === "object" ? (o as Record<string, Cell>) : {};
  } catch {
    return {};
  }
}

function toRow(r: Row): ProspRow {
  return {
    id: num(r.id),
    listId: num(r.list_id),
    position: num(r.position),
    name: r.name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    website: r.website ?? null,
    address: r.address ?? null,
    category: r.category ?? null,
    data: parseData(r.data_json),
    status: r.status ?? "new",
  };
}

/**
 * Las listas del workspace CON sus contadores del embudo.
 *
 * Los contadores salen de `gt_prosp_touches` en UNA consulta agregada, no de un campo en
 * la lista: un contador guardado se desincroniza en cuanto un envío falla a la mitad, y
 * aquí el número es la razón por la que alguien abre la pantalla.
 */
/** Días que una lista archivada sigue siendo recuperable antes de purgarse. */
export const PURGE_DAYS = 30;

/**
 * Las listas del workspace CON sus contadores del embudo.
 *
 * ⚠️ TRES consultas en UN viaje (`dbqMany`). Sueltas eran ~470 ms para dos listas: sqld
 * está detrás de la red y cada ida y vuelta cuesta ~230 ms, así que lo caro no es la
 * consulta, es el viaje.
 *
 * Los contadores salen de `gt_prosp_touches` agregando, no de un campo guardado en la
 * lista: un contador guardado se desincroniza en cuanto un envío falla a la mitad, y aquí
 * el número es la razón por la que alguien abre la pantalla.
 */
export async function listLists(opts?: { archived?: boolean }): Promise<ProspList[]> {
  const where = opts?.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const [rows, agg, sizes] = await dbqMany([
    { sql: `SELECT * FROM gt_prosp_lists WHERE ${where} ORDER BY created_at DESC LIMIT 200` },
    {
      sql: `SELECT list_id,
              SUM(CASE WHEN sent_at    IS NOT NULL THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
            FROM gt_prosp_touches GROUP BY list_id`,
    },
    { sql: `SELECT list_id, COUNT(*) AS n FROM gt_prosp_rows GROUP BY list_id` },
  ]);
  if (!rows.length) return [];

  const counts = new Map<number, Record<string, number>>();
  for (const a of agg) {
    counts.set(num(a.list_id), {
      sent: num(a.sent),
      opened: num(a.opened),
      clicked: num(a.clicked),
      replied: num(a.replied),
    });
  }
  const size = new Map<number, number>();
  for (const x of sizes) size.set(num(x.list_id), num(x.n));

  return rows.map((l) => {
    const id = num(l.id);
    const c = counts.get(id) ?? {};
    return {
      id,
      name: l.name ?? "",
      criteria: l.criteria ?? null,
      source: l.source ?? "denue",
      createdBy: l.created_by ?? "",
      status: l.status ?? "draft",
      createdAt: num(l.created_at),
      archivedAt: l.archived_at == null ? null : num(l.archived_at),
      purgeAt: l.purge_at == null ? null : num(l.purge_at),
      rows: size.get(id) ?? 0,
      sent: c.sent ?? 0,
      opened: c.opened ?? 0,
      clicked: c.clicked ?? 0,
      replied: c.replied ?? 0,
    };
  });
}

/**
 * Lee, y sólo si las tablas no existen todavía monta el esquema y reintenta.
 *
 * ⚠️ `ensureSchema()` tarda **7.9 segundos** la primera vez de cada proceso (35 viajes a
 * sqld) — medido. Esperarlo antes de CADA lectura era el motivo de que la pantalla se
 * quedara en esqueleto: en producción se paga una vez por despliegue, pero en desarrollo el
 * servidor se recarga con cada cambio y se vuelve a pagar entero.
 *
 * Así, el caso normal no lo paga nunca, y el caso «tenant nuevo» sigue funcionando solo.
 */
export async function listListsSafe(opts?: { archived?: boolean }): Promise<ProspList[]> {
  try {
    return await listLists(opts);
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
    const { ensureSchema } = await import("../schema.server");
    await ensureSchema();
    return listLists(opts);
  }
}

export async function createList(args: {
  name: string;
  criteria?: string | null;
  source?: string;
  createdBy: string;
}): Promise<number> {
  await dbq(
    `INSERT INTO gt_prosp_lists (name, criteria, source, created_by) VALUES (?, ?, ?, ?)`,
    [args.name.slice(0, 200), args.criteria ?? null, args.source ?? "denue", args.createdBy]
  );
  const r = await dbq(`SELECT id FROM gt_prosp_lists ORDER BY id DESC LIMIT 1`);
  return num(r[0]?.id);
}

export async function getList(id: number): Promise<ProspList | null> {
  // Mira las dos, activas y archivadas: se puede abrir una archivada para decidir si se
  // recupera. Lo que cambia es que la pantalla avisa y no deja trabajarla.
  const [live, archived] = await Promise.all([listLists(), listLists({ archived: true })]);
  return [...live, ...archived].find((l) => l.id === id) ?? null;
}

export async function renameList(id: number, name: string): Promise<void> {
  await dbq(`UPDATE gt_prosp_lists SET name = ? WHERE id = ?`, [name.slice(0, 200), id]);
}

/**
 * Archiva la lista y programa su purga.
 *
 * No borra nada: las filas y las columnas se quedan intactas, y hasta `purge_at` la lista
 * vuelve entera con `restoreList`. Es la misma decisión que con los miembros de un
 * workspace —se banea, no se borra— y por la misma razón: casi siempre es temporal.
 */
export async function archiveList(id: number): Promise<{ purgeAt: number }> {
  const purgeAt = Math.floor(Date.now() / 1000) + PURGE_DAYS * 86400;
  await dbq(
    `UPDATE gt_prosp_lists SET archived_at = unixepoch(), purge_at = ? WHERE id = ? AND archived_at IS NULL`,
    [purgeAt, id]
  );
  return { purgeAt };
}

export async function restoreList(id: number): Promise<void> {
  await dbq(`UPDATE gt_prosp_lists SET archived_at = NULL, purge_at = NULL WHERE id = ?`, [id]);
}

/**
 * Borra de verdad. Sólo lo llama el barrido de purga y el botón de "borrar ahora".
 *
 * Las TOCADAS no se borran: son la bitácora de a quién se contactó, y siguen valiendo
 * aunque la lista desaparezca — es lo que impide volver a tocar a alguien dentro de un mes.
 */
export async function purgeList(id: number): Promise<void> {
  await dbq(`DELETE FROM gt_prosp_rows WHERE list_id = ?`, [id]);
  await dbq(`DELETE FROM gt_prosp_columns WHERE list_id = ?`, [id]);
  await dbq(`DELETE FROM gt_prosp_lists WHERE id = ?`, [id]);
}

/** Barrido: purga lo que ya cumplió su plazo. Devuelve cuántas se fueron. */
export async function purgeExpired(): Promise<number> {
  const due = await dbq(
    `SELECT id FROM gt_prosp_lists WHERE purge_at IS NOT NULL AND purge_at <= unixepoch() LIMIT 50`
  );
  for (const r of due) await purgeList(num(r.id));
  return due.length;
}

export async function listColumns(listId: number): Promise<ProspColumn[]> {
  const rows = await dbq(
    `SELECT * FROM gt_prosp_columns WHERE list_id = ? ORDER BY position, id`,
    [listId]
  );
  return rows.map((c) => ({
    id: num(c.id),
    listId: num(c.list_id),
    key: (c.key as string) ?? "",
    label: (c.label as string) ?? "",
    kind: ((c.kind as string) ?? "manual") as ProspColumn["kind"],
    recipe: c.recipe ? (JSON.parse(String(c.recipe)) as Recipe) : null,
    width: c.width == null ? null : num(c.width),
    position: num(c.position),
  }));
}


export async function addColumn(args: {
  listId: number;
  label: string;
  kind: ProspColumn["kind"];
  recipe?: Recipe | null;
}): Promise<ProspColumn> {
  const existing = await listColumns(args.listId);
  let key = columnKey(args.label);
  // Colisión de slug: "¿Tiene sitio?" y "¿tiene sitio!" dan la misma llave.
  if (existing.some((c) => c.key === key)) key = `${key}_${existing.length + 1}`;
  const position = existing.length ? Math.max(...existing.map((c) => c.position)) + 1 : 0;
  await dbq(
    `INSERT INTO gt_prosp_columns (list_id, key, label, kind, recipe, position) VALUES (?,?,?,?,?,?)`,
    [
      args.listId,
      key,
      args.label.slice(0, 80),
      args.kind,
      args.recipe ? JSON.stringify(args.recipe) : null,
      position,
    ]
  );
  const cols = await listColumns(args.listId);
  return cols.find((c) => c.key === key)!;
}

export async function deleteColumn(listId: number, key: string): Promise<void> {
  await dbq(`DELETE FROM gt_prosp_columns WHERE list_id = ? AND key = ?`, [listId, key]);
  // El valor se queda en `data_json` a propósito: borrar la columna es quitarla de la
  // vista, no perder el dato que ya se pagó por conseguir. Si se vuelve a crear con la
  // misma llave, reaparece.
}

export async function listRows(listId: number, limit = 2000): Promise<ProspRow[]> {
  const rows = await dbq(
    `SELECT * FROM gt_prosp_rows WHERE list_id = ? ORDER BY position, id LIMIT ?`,
    [listId, limit]
  );
  return rows.map(toRow);
}

export async function getRow(id: number): Promise<ProspRow | null> {
  const r = await dbq(`SELECT * FROM gt_prosp_rows WHERE id = ? LIMIT 1`, [id]);
  return r[0] ? toRow(r[0]) : null;
}

/**
 * Inserta filas nuevas al final de la lista.
 *
 * ⚠️ POR LOTES, y no es una optimización: sqld está detrás de la red y cada viaje cuesta
 * ~290 ms. La primera versión hacía un INSERT por fila — una hoja de 10,728 filas tardaba
 * CINCUENTA Y DOS MINUTOS con la interfaz bloqueada. Medido, no estimado.
 *
 * Dos niveles de agrupación, y hacen falta los dos:
 *   1. `INSERT ... VALUES (…),(…),(…)` — N filas en UNA sentencia.
 *   2. `dbqMany` — varias de esas sentencias en UN viaje al servidor.
 *
 * El tamaño lo pone el tope de parámetros de SQLite (~32k por sentencia): 9 columnas × 200
 * filas = 1,800, con margen de sobra. Con eso, 10,728 filas son ~7 viajes, no 10,728.
 */
const INSERT_COLS = ["list_id", "position", "name", "phone", "email", "website", "address", "category", "data_json"];
const ROWS_PER_STATEMENT = 200;
const STATEMENTS_PER_TRIP = 8;

export async function insertRows(
  listId: number,
  incoming: Partial<ProspRow>[],
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  if (!incoming.length) return 0;
  const last = await dbq(
    `SELECT COALESCE(MAX(position), -1) AS p FROM gt_prosp_rows WHERE list_id = ?`,
    [listId]
  );
  let pos = num(last[0]?.p) + 1;

  const placeholders = `(${INSERT_COLS.map(() => "?").join(",")})`;
  const stmts: { sql: string; args: unknown[] }[] = [];
  let done = 0;

  const flush = async () => {
    if (!stmts.length) return;
    await dbqMany(stmts.splice(0, stmts.length));
    onProgress?.(done, incoming.length);
  };

  for (let i = 0; i < incoming.length; i += ROWS_PER_STATEMENT) {
    const chunk = incoming.slice(i, i + ROWS_PER_STATEMENT);
    const args: unknown[] = [];
    for (const r of chunk) {
      args.push(
        listId,
        pos++,
        r.name ?? null,
        r.phone ?? null,
        r.email ?? null,
        r.website ?? null,
        r.address ?? null,
        r.category ?? null,
        JSON.stringify(r.data ?? {})
      );
    }
    stmts.push({
      sql: `INSERT INTO gt_prosp_rows (${INSERT_COLS.join(",")}) VALUES ${chunk.map(() => placeholders).join(",")}`,
      args,
    });
    done += chunk.length;
    if (stmts.length >= STATEMENTS_PER_TRIP) await flush();
  }
  await flush();
  return incoming.length;
}

const BASE_KEYS = new Set(BASE_COLUMNS.map((c) => c.key));

/**
 * Escribe UNA celda. Si la llave es de columna base va al campo fijo; si no, a `data_json`.
 *
 * `src` se guarda siempre: una celda escrita a mano queda marcada como tal, y eso es lo
 * que después permite no volver a pisarla al re-enriquecer.
 */
export async function setCell(
  rowId: number,
  key: string,
  value: string | null,
  meta?: { src?: string; verified?: boolean }
): Promise<void> {
  if (BASE_KEYS.has(key)) {
    await dbq(`UPDATE gt_prosp_rows SET ${key} = ? WHERE id = ?`, [value, rowId]);
    return;
  }
  const row = await getRow(rowId);
  if (!row) return;
  const data = { ...row.data, [key]: { v: value, src: meta?.src ?? "manual", verified: meta?.verified ?? false } };
  await dbq(`UPDATE gt_prosp_rows SET data_json = ? WHERE id = ?`, [JSON.stringify(data), rowId]);
}

export async function setRowStatus(rowId: number, status: string): Promise<void> {
  await dbq(`UPDATE gt_prosp_rows SET status = ? WHERE id = ?`, [status, rowId]);
}

export async function deleteRows(listId: number, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await dbq(
    `DELETE FROM gt_prosp_rows WHERE list_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    [listId, ...ids]
  );
}
