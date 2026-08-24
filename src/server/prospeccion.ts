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

/** La conversación del drawer con el agente. Sólo la de quien la pide. */
export const drawerHistoryFn = createServerFn({ method: "GET" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { msgs: [] };
    const { drawerHistory } = await import("./prospeccion/agent.server");
    return { msgs: await drawerHistory(Number(data.listId), me.sub) };
  });

/** Vaciar la conversación. No toca la memoria del agente, sólo lo que se ve. */
export const clearDrawerFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { clearDrawer } = await import("./prospeccion/agent.server");
    await clearDrawer(Number(data.listId), me.sub);
    return { ok: true as const };
  });

/** Guardar el ancho de una columna. Lo dispara soltar el borde. */
export const setColumnWidthFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; key: string; width: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { setColumnWidth } = await import("./prospeccion/lists.server");
    await setColumnWidth(Number(data.listId), data.key, Number(data.width));
    return { ok: true as const };
  });

/** Reordenar columnas. Lo dispara arrastrar una cabecera. */
export const setColumnOrderFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; keys: string[] }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    // No pide permiso: reordenar es cosmético y reversible arrastrando otra vez.
    const { setColumnOrder } = await import("./prospeccion/lists.server");
    await setColumnOrder(Number(data.listId), data.keys);
    return { ok: true as const };
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
    if (!me) return { ok: false as const, error: "sin sesión" };
    // Borra de verdad, con el trabajo de enriquecer las filas. Archivar sí lo hace
    // cualquiera: se recupera 30 días.
    const { puede } = await import("./prospeccion/permisos.server");
    if (!(await puede(me, "purgar", Number(data.listId)))) {
      return { ok: false as const, error: "Sólo quien creó esta lista, o el dueño del espacio, puede borrarla para siempre." };
    }
    const { purgeList } = await import("./prospeccion/lists.server");
    await purgeList(Number(data.listId));
    return { ok: true as const, error: null };
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
  .validator((d: { listId: number; label: string; kind: "enrich" | "ai" | "manual"; waterfall?: string[]; prompt?: string; mode?: "write" | "research"; f?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    /**
     * ⚠️ Si NINGUNA fila puede llenarse, no se crea la columna.
     *
     * Antes se creaba igual y quedaba vacía: el usuario veía una columna nueva sin un solo
     * dato y concluía —con razón— que enriquecer «sólo añade columnas vacías». Una columna
     * que no se puede llenar no es un resultado parcial, es basura que hay que borrar a
     * mano, y encima invita a intentarlo otra vez.
     *
     * Se comprueba contra la VISTA, que es sobre lo que va a correr.
     */
    if (data.kind === "enrich" && (data.waterfall ?? []).length) {
      const { ENRICHERS } = await import("./prospeccion/enrich.server");
      const { listRows } = await import("./prospeccion/lists.server");
      const { decodeFilter, matches } = await import("../lib/prospeccion-filter");
      const { listColumns } = await import("./prospeccion/lists.server");

      const cols = await listColumns(Number(data.listId));
      const fields = [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)];
      const todas = await listRows(Number(data.listId), 20000);
      const filtro = decodeFilter(data.f);
      const vista = filtro.length
        ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, filtro, fields))
        : todas;

      const pasos = (data.waterfall ?? []).map((id) => ENRICHERS[id]).filter(Boolean);
      const alguna = vista.some((r) => pasos.some((e) => e.needs(r)));
      if (!alguna && vista.length) {
        return {
          ok: false as const,
          error: `No se creó la columna: ninguna de las ${vista.length} filas tiene ${pasos[0]?.requires ?? "el dato de partida"}.`,
        };
      }
    }

    const { addColumn } = await import("./prospeccion/lists.server");
    const col = await addColumn({
      listId: Number(data.listId),
      label: data.label,
      kind: data.kind,
      recipe:
        data.kind === "enrich"
          ? { waterfall: data.waterfall ?? [] }
          : data.kind === "ai"
            ? { prompt: data.prompt ?? "", mode: data.mode ?? "write" }
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
  .validator((d: { listId: number; key: string; f?: string; limit?: number }) => d)
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
      limit: data.limit,
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
  .validator((d: { listId: number; key: string; agentHandle?: string; f?: string; limit?: number }) => d)
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
      mode: col.recipe.mode ?? "write",
      writesTo: col.recipe.writesTo,
      agentHandle: data.agentHandle ?? null,
      filter: decodeFilter(data.f),
      fields: [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)],
      invokerSub: me.sub,
      origin,
      limit: data.limit,
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

/**
 * El WhatsApp al que escriben los prospectos.
 *
 * ⚠️ Es el número TUYO, no el del prospecto. El correo lleva un botón `wa.me` que apunta
 * aquí; el prospecto le da clic, escribe, y **ese envío suyo abre la ventana de 24 h** que
 * permite contestarle con texto libre. Por eso el teléfono del prospecto no hace falta para
 * el loop: el que viaja es éste.
 *
 * Vive en la config del WORKSPACE y no por lista: es el número de la empresa. Si algún día
 * hace falta uno por campaña (agencia que prospecta para varios clientes), la columna se
 * añade a `gt_prosp_lists` y este valor pasa a ser el default.
 */
export const getProspWaFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return { phone: "" };
  const { getConfig } = await import("../config.server");
  const guardado = await getConfig("prospeccion_wa_phone");
  if (guardado) return { phone: guardado };
  // Si hay un canal de WhatsApp conectado, ése es el número obvio: se propone solo.
  const { dbq } = await import("../dbq.server");
  const r = await dbq(`SELECT phone FROM gt_wa_channels LIMIT 1`).catch(() => []);
  return { phone: r[0]?.phone ? String(r[0].phone) : "" };
});

export const setProspWaFn = createServerFn({ method: "POST" })
  .validator((d: { phone: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, phone: "" };
    const { normalizeWaPhone } = await import("../lib/prospeccion-wa-phone");
    const n = normalizeWaPhone(data.phone);
    if (data.phone.trim() && !n) {
      return { ok: false as const, phone: "", error: "No parece un número de WhatsApp" };
    }
    const { setConfig } = await import("../config.server");
    await setConfig("prospeccion_wa_phone", n ?? "");
    return { ok: true as const, phone: n ?? "" };
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

/**
 * Qué pasaría si mandas. NO manda nada.
 *
 * Invariante del spec: «el agente propone, la persona confirma todo lo que sale hacia
 * fuera». Y es lo único honesto que se puede enseñar: «Mandar a 312» no dice que 40 están
 * dadas de baja y 60 tienen el correo muerto. El número que de verdad sale es otro.
 */
export const planSendFn = createServerFn({ method: "GET" })
  .validator((d: { listId: number; f?: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { listRows, listColumns } = await import("./prospeccion/lists.server");
    const { decodeFilter, matches } = await import("../lib/prospeccion-filter");
    const { planSend } = await import("./prospeccion/send.server");

    const cols = await listColumns(Number(data.listId));
    const fields = [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)];
    const todas = await listRows(Number(data.listId), 20000);
    const filtro = decodeFilter(data.f);
    const rows = filtro.length
      ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, filtro, fields))
      : todas;

    const plan = await planSend({ listId: Number(data.listId), campaign: "", rows });
    /**
     * Qué columnas pueden ser EL MENSAJE.
     *
     * ⚠️ Las de tipo `ai` primero y marcadas, porque son las escritas para eso. Una columna
     * `manual` puede serlo (alguien pegó los mensajes desde Excel) pero también puede ser
     * «Madurez digital» — y ofrecerla igual llevó a mandar un correo cuyo cuerpo entero
     * decía «Alta». Se ofrecen las dos, pero se distinguen, y se propone una `ai`.
     */
    const mensajes = cols
      .filter((c) => c.kind === "ai" || c.kind === "manual")
      .map((c) => ({ key: c.key, label: c.label, escrita: c.kind === "ai" }))
      .sort((a, b) => Number(b.escrita) - Number(a.escrita));
    return { ok: true as const, plan, mensajes };
  });

/**
 * Manda de verdad.
 *
 * ⚠️ Va sobre la VISTA, pasa por opt-out sin excepción, y sólo se llama después de que una
 * persona vio el plan y confirmó.
 */
export const sendFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; f?: string; messageKey: string; subject: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión", sent: 0, skippedOptOut: 0, failed: 0 };

    // ⚠️ Mandar sale a terceros con tu dominio y tu marca, y no se deshace. Se comprueba
    // AQUÍ, en el servidor: esconder el botón no es un permiso.
    const { puede } = await import("./prospeccion/permisos.server");
    if (!(await puede(me, "mandar", Number(data.listId)))) {
      return {
        ok: false as const,
        error: "No tienes permiso para mandar correo desde esta lista. Pídeselo a quien la creó.",
        sent: 0, skippedOptOut: 0, failed: 0,
      };
    }

    if (!data.subject.trim()) {
      return { ok: false as const, error: "Falta el asunto", sent: 0, skippedOptOut: 0, failed: 0 };
    }

    const { listRows, listColumns } = await import("./prospeccion/lists.server");
    const { decodeFilter, matches } = await import("../lib/prospeccion-filter");
    const { sendBatch } = await import("./prospeccion/send.server");
    const { getConfig } = await import("../config.server");

    const cols = await listColumns(Number(data.listId));
    const fields = [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)];
    const todas = await listRows(Number(data.listId), 20000);
    const filtro = decodeFilter(data.f);
    const rows = filtro.length
      ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, filtro, fields))
      : todas;

    // El cuerpo sale de la columna elegida, fila por fila. Una fila SIN mensaje no se manda:
    // un correo vacío es peor que ningún correo.
    // ⚠️ MISMO `renderDraft` que la previsualización. Si fueran dos caminos, la pantalla
    // enseñaría una cosa y saldría otra — que es exactamente el fallo que la previsualización
    // existe para evitar.
    const waPhonePrev = await getConfig("prospeccion_wa_phone");
    const redactados = (
      await Promise.all(
        rows.map(async (r) => {
          const cuerpo = r.data[data.messageKey]?.v?.trim();
          if (!cuerpo) return null;
          const { renderDraft } = await import("./prospeccion/send.server");
          const { html, text } = await renderDraft({
            subject: data.subject,
            body: cuerpo,
            businessName: r.name,
            waPhone: waPhonePrev,
          });
          return { rowId: r.id, subject: data.subject, html, text };
        })
      )
    ).filter(Boolean) as { rowId: number; subject: string; html: string; text: string }[];

    // La campaña ES la llave de idempotencia: el mismo asunto sobre la misma fila el mismo
    // día no sale dos veces, aunque se apriete el botón dos veces.
    const campaign = `${data.subject.slice(0, 40)}:${new Date().toISOString().slice(0, 10)}`;
    const r = await sendBatch({
      listId: Number(data.listId),
      campaign,
      rows,
      redactados,
      waPhone: waPhonePrev,
      // Quién manda: va a la bitácora de cada toque, y es lo que después deja decir
      // «Luis le escribió hace 3 días» en vez de un «bloqueado» que no se puede accionar.
      bySub: me.sub,
      byName: me.name ?? null,
      // Sin replyTo: el `From` del sobre ya lleva el dominio correcto, y meter el correo
      // personal de quien manda lo expone a 11 mil desconocidos.
    });
    return { ok: true as const, error: null, ...r };
  });


/**
 * El correo de UNA fila, ya renderizado, y opcionalmente mandado a quien lo pide.
 *
 * Es lo que hacen lemlist y Smartlead antes de lanzar: enseñar el mensaje con las variables
 * ya resueltas, y dejar mandarse una prueba para ver maquetación y enlaces en un cliente de
 * correo real. Un HTML se ve distinto en Gmail que en una previsualización, y el botón de
 * WhatsApp o abre o no abre — eso sólo se sabe apretándolo.
 */
export const previewSendFn = createServerFn({ method: "POST" })
  .validator((d: { listId: number; f?: string; messageKey: string; subject: string; test?: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión", html: "", to: "", sent: false, sinBoton: false, marca: null };

    const { listRows, listColumns } = await import("./prospeccion/lists.server");
    const { decodeFilter, matches } = await import("../lib/prospeccion-filter");
    const { renderDraft } = await import("./prospeccion/send.server");
    const { getConfig } = await import("../config.server");

    const cols = await listColumns(Number(data.listId));
    const fields = [...BASE_FIELD_KEYS, ...cols.map((c) => c.key)];
    const todas = await listRows(Number(data.listId), 20000);
    const filtro = decodeFilter(data.f);
    const rows = filtro.length
      ? todas.filter((r) => matches(r as unknown as Record<string, unknown>, filtro, fields))
      : todas;

    // La primera fila que SÍ tenga mensaje y correo: previsualizar una vacía no enseña nada.
    const row = rows.find((r) => r.data[data.messageKey]?.v?.trim() && r.email);
    if (!row) {
      return { ok: false as const, error: "Ninguna fila de la vista tiene mensaje y correo todavía.", html: "", to: "", sent: false, sinBoton: false, marca: null };
    }

    const waPhone = await getConfig("prospeccion_wa_phone");
    const { html, text, inline, preview, sinBoton, marca } = await renderDraft({
      subject: data.subject || "(sin asunto)",
      body: row.data[data.messageKey]!.v!,
      businessName: row.name,
      waPhone,
    });

    // La pantalla enseña `preview` (imágenes incrustadas); la prueba manda `html` (cid:).
    if (!data.test) return { ok: true as const, error: null, html: preview, to: row.email!, sent: false, sinBoton, marca };

    // La prueba va al correo de QUIEN la pide, nunca al prospecto.
    const { getUserEmail } = await import("./prospeccion/send.server");
    const destino = await getUserEmail(me.sub);
    if (!destino) {
      return { ok: false as const, error: "No encuentro tu correo para mandarte la prueba.", html, to: row.email!, sent: false, sinBoton, marca };
    }
    const { sendSesEmail } = await import("./ses.server");
    const enviado = await sendSesEmail({
      to: destino,
      subject: `[PRUEBA] ${data.subject || "(sin asunto)"}`,
      html,
      text,
      // ⚠️ Las imágenes van adjuntas: sin esto la prueba llega con el logo roto y hace
      // dudar de un correo que está bien. Es el mismo `inline` que usa el envío real.
      inline,
    });
    return { ok: true as const, error: null, html: preview, to: destino, sent: enviado, sinBoton, marca };
  });


/** Qué puede hacer QUIEN está mirando. La pantalla esconde lo que no puede. */
export const misPermisosFn = createServerFn({ method: "GET" })
  .validator((d: { listId?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const me = await sessionUser();
    const nada = { mandar: false, purgar: false, esDueno: false, puedeConceder: false };
    if (!me) return nada;
    const { puede, puedeConceder } = await import("./prospeccion/permisos.server");
    const id = data.listId != null ? Number(data.listId) : undefined;
    return {
      mandar: await puede(me, "mandar", id),
      purgar: await puede(me, "purgar", id),
      esDueno: !!me.isOwner,
      // Quien creó la lista reparte permisos sobre ella; el dueño, sobre todas.
      puedeConceder: await puedeConceder(me, id),
    };
  });

/** El padrón con quién puede qué. Sólo lo pide el panel del dueño. */
export const listPermisosFn = createServerFn({ method: "GET" })
  .validator((d: { listId?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
  const me = await sessionUser();
  const vacio = { mandar: [], purgar: [], porLista: {} };
  const { concesiones, puedeConceder } = await import("./prospeccion/permisos.server");
  const id = data.listId != null ? Number(data.listId) : undefined;
  if (!me || !(await puedeConceder(me, id))) {
    return { ok: false as const, gente: [], concesiones: vacio, esDueno: false, listId: id ?? null };
  }
  const { listWorkspaceUsers } = await import("../users.server");
  const [c, gente] = await Promise.all([concesiones(), listWorkspaceUsers()]);
  return {
    ok: true as const,
    concesiones: c,
    esDueno: !!me.isOwner,
    listId: id ?? null,
    gente: gente.map((g) => ({ sub: g.sub, name: g.name, avatar: g.avatar, isOwner: !!g.isOwner })),
  };
});

export const concederFn = createServerFn({ method: "POST" })
  .validator((d: { sub: string; accion: "mandar" | "purgar"; dar: boolean; listId?: number }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const, error: "sin sesión" };
    const { conceder } = await import("./prospeccion/permisos.server");
    return conceder({
      actor: me,
      sub: data.sub,
      accion: data.accion,
      dar: data.dar,
      listId: data.listId != null ? Number(data.listId) : undefined,
    });
  });
