import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

/**
 * Tope de filas por importación.
 *
 * Alto a propósito: existe para que una hoja con formato raro no meta cien mil filas
 * vacías, no para decirle a nadie que su lista es grande. Al superarlo se CORTA y se avisa
 * cuántas quedaron fuera; nunca se rechaza el archivo entero.
 */
const MAX_IMPORT_ROWS = 20_000;

/** Las columnas base, para armar la lista de campos filtrables sin importar el módulo. */
const BASE_FIELD_KEYS = ["name", "phone", "email", "website", "address", "category"];

/** Las listas del workspace, con los contadores del embudo. */
export const listProspListsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return { ok: false as const, lists: [] };
  // ⚠️ SIN `ensureSchema()` por delante. Tarda 7.9 s la primera vez de cada proceso
  // (medido, 35 viajes a sqld) y era el motivo de que la pantalla se quedara en esqueleto.
  // `listListsSafe` monta el esquema sólo si de verdad faltan las tablas.
  const { listListsSafe } = await import("./prospeccion/lists.server");
  return { ok: true as const, lists: await listListsSafe() };
});

/**
 * Crea una lista y la llena con la fuente.
 *
 * Devuelve el error de la fuente TAL CUAL en `error`: si falta el token de DENUE o la
 * zona no se reconoce, quien lo lee es la persona que escribió el criterio y necesita
 * saber qué corregir. Un "no se encontró nada" genérico manda a diagnosticar el lugar
 * equivocado.
 */
export const createListFn = createServerFn({ method: "POST" })
  .validator((d: { criteria: string; name?: string; source?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };

    const criteria = (data.criteria ?? "").trim();
    if (!criteria) return { ok: false as const, error: "Escribe qué negocios buscas" };

    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const { createList, insertRows } = await import("./prospeccion/lists.server");
    const { sourceById } = await import("./prospeccion/sources/index");

    const src = sourceById(data.source ?? "denue");
    let found;
    try {
      found = await src.search(criteria, Math.min(data.limit ?? 100, 500));
    } catch (e) {
      return { ok: false as const, error: String(e instanceof Error ? e.message : e) };
    }

    const listId = await createList({
      name: (data.name ?? criteria).slice(0, 120),
      criteria,
      source: src.id,
      createdBy: me.sub,
    });
    await insertRows(listId, found);
    return { ok: true as const, listId, rows: found.length };
  });

/**
 * ListRow vacía, para empezar pegando from Excel en vez de buscando.
 *
 * No es un case_ secundario: mucha pyme ya tiene su lista en una hoja y lo que quiere es
 * enriquecerla, no descubrir prospectos nuevos.
 */
export const createEmptyListFn = createServerFn({ method: "POST" })
  .validator((d: { name?: string; rows?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const { createList, insertRows } = await import("./prospeccion/lists.server");
    const listId = await createList({
      name: (data.name ?? "ListRow nueva").slice(0, 120),
      criteria: null,
      source: "manual",
      createdBy: me.sub,
    });
    // Nace con filas en blanco: una rejilla de cero filas no deja pegar en ningún lado.
    const n = Math.min(Math.max(data.rows ?? 25, 1), 500);
    await insertRows(listId, Array.from({ length: n }, () => ({})));
    return { ok: true as const, listId, rows: n };
  });

export const getListFn = createServerFn({ method: "GET" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { getList, listRows, listColumns, BASE_COLUMNS } = await import("./prospeccion/lists.server");
    const list = await getList(Number(data.listId));
    if (!list) return { ok: false as const };
    const [rows, columns] = await Promise.all([
      listRows(list.id),
      listColumns(list.id),
    ]);
    return { ok: true as const, list, rows, columns, base: BASE_COLUMNS };
  });

export const setCellFn = createServerFn({ method: "POST" })
  .validator((d: { rowId: number; key: string; value: string | null }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { setCell } = await import("./prospeccion/lists.server");
    await setCell(Number(data.rowId), data.key, data.value, { src: "manual" });
    return { ok: true as const };
  });

export const renameListFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; name: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { renameList } = await import("./prospeccion/lists.server");
    await renameList(Number(data.listId), data.name);
    return { ok: true as const };
  });

/**
 * Archiva una lista. NO la borra.
 *
 * El botón dice "Archivar" y esto archiva: el mismo verbo de punta a punta. Devuelve la
 * fecha de purga para poder decirla en el aviso — "se borra el 21 de septiembre" es una
 * frase con la que se puede decidir; "se borrará pronto" no.
 */
export const archiveListFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, purgeAt: 0 };
    const { archiveList } = await import("./prospeccion/lists.server");
    const { purgeAt } = await archiveList(Number(data.listId));
    return { ok: true as const, purgeAt };
  });

export const restoreListFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { restoreList } = await import("./prospeccion/lists.server");
    await restoreList(Number(data.listId));
    return { ok: true as const };
  });

/** Borrado inmediato y definitivo. Sólo desde la vista de archivadas. */
export const purgeListFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { purgeList } = await import("./prospeccion/lists.server");
    await purgeList(Number(data.listId));
    return { ok: true as const };
  });

/** Las listas archivadas, con su fecha de purga. */
export const listArchivedFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return { ok: false as const, lists: [] };
  const { listListsSafe, purgeExpired } = await import("./prospeccion/lists.server");
  // El barrido va aquí y no en un cron: es barato, corre cuando alguien mira las archivadas,
  // y así no hay un temporizador más que vigilar. Si nadie mira, nada urge.
  await purgeExpired().catch(() => 0);
  return { ok: true as const, lists: await listListsSafe({ archived: true }) };
});

export const listEnrichersFn = createServerFn({ method: "GET" }).handler(async () => {
  const { listEnrichers } = await import("./prospeccion/enrich.server");
  return listEnrichers();
});

/** Agrega una columna. Si trae waterfall_, se puede correr enseguida. */
export const addColumnFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; label: string; kind: "enrich" | "ai" | "manual"; waterfall?: string[]; prompt?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    const { addColumn } = await import("./prospeccion/lists.server");
    const col = await addColumn({
      listId: Number(data.listId),
      label: data.label,
      kind: data.kind,
      recipe:
        data.kind === "enrich"
          ? { waterfall: data.waterfall ?? [] }
          : data.kind === "ai"
            ? { prompt: data.prompt ?? "" }
            : null,
    });
    return { ok: true as const, column: col };
  });

export const deleteColumnFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; key: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { deleteColumn } = await import("./prospeccion/lists.server");
    await deleteColumn(Number(data.listId), data.key);
    return { ok: true as const };
  });

/**
 * Corre una columna sobre la lista.
 *
 * Es SÍNCRONA a propósito en esta primera versión: una lista de 100 filas con concurrencia
 * 4 tarda segundos, y una respuesta que llega cuando terminó es infinitamente más simple
 * que una cola con estado que hay que sondear. Cuando las listas crezcan, esto se parte.
 */
export const runColumnFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; key: string; f?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    const { listColumns } = await import("./prospeccion/lists.server");
    const { runColumn } = await import("./prospeccion/enrich.server");
    const col = (await listColumns(Number(data.listId))).find((c) => c.key === data.key);
    if (!col) return { ok: false as const, error: "esa columna no existe" };
    // El filtro llega CODIFICADO, igual que en la URL: así la vista que se ve y la que se
    // enriquece son literalmente la misma cadena, sin traducción por medio.
    const { decodeFilter } = await import("../lib/prospeccion-filter");
    const cols = await listColumns(Number(data.listId));
    const fields = [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)];
    const p = await runColumn({
      listId: Number(data.listId),
      key: col.key,
      recipe: col.recipe,
      filter: decodeFilter(data.f),
      fields,
    });
    return { ok: true as const, ...p };
  });

/**
 * Corre una columna de AGENTE sobre la lista.
 *
 * Separada de `runColumnFn` aunque el gesto sea el mismo, porque el coste no lo es: aquí
 * cada fila es un turno de agente que se factura. Tenerlas juntas invitaría a correr sin
 * pensar una columna de 500 filas.
 */
export const runAiColumnFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; key: string; agentHandle?: string; f?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión", done: 0, total: 0, filled: 0 };

    const { listColumns } = await import("./prospeccion/lists.server");
    const col = (await listColumns(Number(data.listId))).find((c) => c.key === data.key);
    if (!col) return { ok: false as const, error: "esa columna no existe", done: 0, total: 0, filled: 0 };
    if (col.kind !== "ai" || !col.recipe?.prompt) {
      return { ok: false as const, error: "esa columna no la escribe el agente", done: 0, total: 0, filled: 0 };
    }

    const { runAiColumn } = await import("./prospeccion/write.server");
    // El origin explícito: aquí SÍ hay request vivo, pero se pasa igual porque el turno
    // corre dentro de un `await` largo y `reqOrigin()` lee cabeceras del request actual.
    // Sin él, el minteo del tool-token cae al catch y el agente corre SIN herramientas.
    const { reqOrigin } = await import("../origin.server");
    const origin = await reqOrigin().catch(() => undefined);
    const { decodeFilter } = await import("../lib/prospeccion-filter");
    const cols = await listColumns(Number(data.listId));
    const r = await runAiColumn({
      listId: Number(data.listId),
      key: col.key,
      instruction: col.recipe.prompt,
      agentHandle: data.agentHandle ?? null,
      filter: decodeFilter(data.f),
      fields: [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)],
      invokerSub: me.sub,
      origin,
    });
    return { ok: !r.error, error: r.error ?? null, done: r.done, total: r.total, filled: r.filled };
  });

/** Los agentes del workspace, para elegir quién escribe la columna. */
export const listProspAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return [];
  const { resolvedAgents } = await import("../agents.server");
  const agents = await resolvedAgents().catch(() => []);
  return agents.map((a) => ({ handle: a.handle, name: a.name ?? a.handle }));
});

/** Pasa lo que encontró una columna a la columna base `email`, que es la que usa el envío. */
export const promoteEmailFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; key: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, n: 0 };
    const { promoteToEmail } = await import("./prospeccion/enrich.server");
    return { ok: true as const, n: await promoteToEmail(Number(data.listId), data.key) };
  });

/**
 * Aplica a una lista existente el plan de importación que la persona ya confirmó.
 *
 * El plan (qué columna de la hoja va a qué campo) viene DECIDIDO desde la pantalla de
 * revisión. Aquí no se adivina nada.
 */
export const importTableFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; headers: string[]; rows: string[][]; targets: Record<string, string> }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "Inicia sesión para importar", added: 0, newColumns: [] as string[], truncated: 0 };

    // Se CORTA, no se rechaza. Un tope que devuelve error deja a la persona sin nada y sin
    // saber qué hacer; cortando entra lo que cabe y el aviso dice qué se quedó fuera.
    const total = data.rows.length;
    const rows = total > MAX_IMPORT_ROWS ? data.rows.slice(0, MAX_IMPORT_ROWS) : data.rows;

    const { importTable } = await import("./prospeccion/import.server");
    const r = await importTable({
      listId: Number(data.listId),
      headers: data.headers,
      rows,
      targets: data.targets,
    });
    return {
      ok: true as const,
      error: null,
      added: r.added,
      newColumns: r.newColumns,
      truncated: total > MAX_IMPORT_ROWS ? total - MAX_IMPORT_ROWS : 0,
    };
  });

/** Las optOuts del workspace. */
export const listOptOutsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return [];
  const { listOptOuts } = await import("./prospeccion/optout.server");
  return listOptOuts();
});

/** Las fuentes disponibles, para el selector y para enseñárselas al agente. */
export const listSourcesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { SOURCES } = await import("./prospeccion/sources/index");
  return SOURCES.map((s) => ({ id: s.id, label: s.label, blurb: s.blurb }));
});

/**
 * Crea una lista A PARTIR de una hoja soltada.
 *
 * Es un atajo de dos pasos en uno (crear vacía + importar): soltar un archivo en la pantalla
 * de listas es el gesto obvio de quien ya tiene su lista en Excel, y obligarlo a crear una
 * lista vacía primero es un paso que no aporta nada.
 */
export const createListFromSheetFn = createServerFn({ method: "POST" })
  .validator((d: { name: string; headers: string[]; rows: string[][]; targets: Record<string, string> }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión", listId: 0, added: 0 };
    const total = data.rows.length;
    const rows = total > MAX_IMPORT_ROWS ? data.rows.slice(0, MAX_IMPORT_ROWS) : data.rows;
    await (await import("./schema.server")).ensureSchema().catch(() => {});
    const { createList } = await import("./prospeccion/lists.server");
    const { importTable } = await import("./prospeccion/import.server");
    // El nombre de la lista es el del archivo sin extensión: es como la persona la llama.
    const name = data.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Lista importada";
    const listId = await createList({ name, criteria: null, source: "import", createdBy: me.sub });
    const r = await importTable({ listId, headers: data.headers, rows, targets: data.targets });
    return {
      ok: true as const,
      error: null,
      listId,
      added: r.added,
      truncated: total > MAX_IMPORT_ROWS ? total - MAX_IMPORT_ROWS : 0,
    };
  });
