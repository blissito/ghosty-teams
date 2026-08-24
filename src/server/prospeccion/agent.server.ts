/**
 * Lo que el agente sabe y puede hacer sobre una lista.
 *
 * Dos piezas:
 *  · `listContext` — lo que se le cuenta al empezar cada turno del drawer.
 *  · los handlers de las tools `prospect_*`.
 *
 * ⚠️ La regla que gobierna todo: **el agente opera sobre la VISTA y mueve la barra que la
 * persona ve.** No filtra por dentro y contesta «listo»: aplica el filtro a la pantalla,
 * como chips editables. Sobre diez mil filas de datos de clientes, una caja negra no es
 * aceptable — y además así se puede corregir cuando entiende mal.
 */
import { dbq, num } from "../../dbq.server";
import { decodeFilter, encodeFilter, matches, STATUSES, TEMPS, type Filter, type TempId } from "../../lib/prospeccion-filter";
import { BASE_COLUMNS, listColumns, listRows, type ProspRow } from "./lists.server";

const BASE_KEYS = BASE_COLUMNS.map((c) => c.key);

async function fieldsOf(listId: number): Promise<{ key: string; label: string }[]> {
  const cols = await listColumns(listId);
  return [...BASE_COLUMNS, ...cols.map((c) => ({ key: c.key, label: c.label }))];
}

function viewOf(rows: ProspRow[], filter: Filter, fields: string[]): ProspRow[] {
  if (!filter.length) return rows;
  return rows.filter((r) => matches(r as unknown as Record<string, unknown>, filter, fields));
}

/**
 * El estado de la lista, en texto, para el turno.
 *
 * Incluye **cuántas filas les falta cada dato**, que es lo que permite al agente proponer
 * en vez de esperar: «8,400 no tienen correo, ¿se lo busco?». Un wizard de pasos fijos no
 * puede decir eso; sólo se puede mirando los datos.
 */
export async function listContext(listId: number, encodedFilter?: string): Promise<string> {
  const [fields, rows] = await Promise.all([fieldsOf(listId), listRows(listId, 20000)]);
  const l = await dbq(`SELECT name, criteria FROM gt_prosp_lists WHERE id = ? LIMIT 1`, [listId]);
  const filter = decodeFilter(encodedFilter);
  const keys = fields.map((f) => f.key);
  const view = viewOf(rows, filter, keys);

  const faltan = fields
    .map((f) => {
      const n = view.filter((r) => {
        const v = BASE_KEYS.includes(f.key)
          ? (r as unknown as Record<string, string | null>)[f.key]
          : r.data[f.key]?.v;
        return !String(v ?? "").trim();
      }).length;
      return { label: f.label, key: f.key, n };
    })
    .filter((x) => x.n > 0);

  const estados = new Map<string, number>();
  for (const r of view) estados.set(r.status, (estados.get(r.status) ?? 0) + 1);

  return [
    `[LISTA DE PROSPECCIÓN #${listId}]`,
    `Nombre: ${l[0]?.name ?? "?"}${l[0]?.criteria ? ` · criterio: ${l[0].criteria}` : ""}`,
    `Filas: ${rows.length}${filter.length ? ` · EN LA VISTA ACTUAL: ${view.length}` : " (sin filtro)"}`,
    ``,
    `Columnas: ${fields.map((f) => f.label).join(" · ")}`,
    faltan.length
      ? `Sin dato en la vista: ${faltan.map((x) => `${x.label} (${x.n})`).join(" · ")}`
      : `Todas las columnas están completas en la vista.`,
    estados.size
      ? `Embudo: ${[...estados].map(([k, n]) => `${STATUSES.find((s) => s.id === k)?.label ?? k}: ${n}`).join(" · ")}`
      : ``,
    ``,
    `Puedes filtrar la vista con \`prospect_filter\`, agregar y correr columnas con`,
    `\`prospect_column\`, y leer una muestra con \`prospect_rows\`. Todo aplica a la VISTA.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Traduce lo que el agente pide a condiciones del modelo. Devuelve el filtro codificado. */
export async function applyFilter(args: {
  listId: number;
  conditions: { op: string; field?: string; value?: string }[];
}): Promise<{ ok: boolean; f?: string; shown: number; total: number; error?: string }> {
  const fields = await fieldsOf(args.listId);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  // El agente puede nombrar la columna por su ETIQUETA («Teléfono») en vez de por su llave.
  const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f]));

  const filter: Filter = [];
  for (const c of args.conditions ?? []) {
    const resolved = c.field ? byKey.get(c.field) ?? byLabel.get(c.field.toLowerCase()) : undefined;
    if (c.op === "text" && c.value) filter.push({ op: "text", value: c.value });
    else if (c.op === "status" && c.value) filter.push({ op: "status", value: c.value });
    else if (c.op === "temp" && TEMPS.some((x) => x.id === c.value)) {
      filter.push({ op: "temp", value: c.value as TempId });
    }
    else if ((c.op === "empty" || c.op === "filled") && resolved) filter.push({ op: c.op, field: resolved.key });
    else if (c.op === "has" && resolved && c.value) filter.push({ op: "has", field: resolved.key, value: c.value });
    else {
      return {
        ok: false,
        shown: 0,
        total: 0,
        error: `No entendí la condición ${JSON.stringify(c)}. Columnas: ${fields.map((f) => f.label).join(", ")}`,
      };
    }
  }

  const rows = await listRows(args.listId, 20000);
  const view = viewOf(rows, filter, fields.map((f) => f.key));
  return { ok: true, f: encodeFilter(filter), shown: view.length, total: rows.length };
}

/** Una muestra de la vista, para que el agente pueda contestar preguntas sobre ella. */
export async function sampleRows(args: {
  listId: number;
  f?: string;
  limit?: number;
}): Promise<{ shown: number; total: number; sample: Record<string, string>[] }> {
  const fields = await fieldsOf(args.listId);
  const rows = await listRows(args.listId, 20000);
  const view = viewOf(rows, decodeFilter(args.f), fields.map((x) => x.key));
  const n = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const sample = view.slice(0, n).map((r) => {
    const o: Record<string, string> = {};
    for (const f of fields) {
      const v = BASE_KEYS.includes(f.key)
        ? (r as unknown as Record<string, string | null>)[f.key]
        : r.data[f.key]?.v;
      if (v) o[f.label] = String(v);
    }
    o["estado"] = STATUSES.find((s) => s.id === r.status)?.label ?? r.status;
    return o;
  });
  return { shown: view.length, total: rows.length, sample };
}

/** Cuántas filas de la vista les falta cada dato. Lo que deja al agente PROPONER. */
export async function gaps(listId: number, f?: string): Promise<Record<string, number>> {
  const fields = await fieldsOf(listId);
  const rows = await listRows(listId, 20000);
  const view = viewOf(rows, decodeFilter(f), fields.map((x) => x.key));
  const out: Record<string, number> = {};
  for (const fl of fields) {
    const n = view.filter((r) => {
      const v = BASE_KEYS.includes(fl.key)
        ? (r as unknown as Record<string, string | null>)[fl.key]
        : r.data[fl.key]?.v;
      return !String(v ?? "").trim();
    }).length;
    if (n) out[fl.label] = n;
  }
  return out;
}

/** Las listas del workspace, en corto, para que el agente sepa de cuál se habla. */
export async function listsBrief(): Promise<{ id: number; name: string; rows: number }[]> {
  const rows = await dbq(
    `SELECT l.id, l.name, (SELECT COUNT(*) FROM gt_prosp_rows r WHERE r.list_id = l.id) AS n
       FROM gt_prosp_lists l WHERE l.archived_at IS NULL ORDER BY l.created_at DESC LIMIT 50`
  );
  return rows.map((r) => ({ id: num(r.id), name: r.name ?? "", rows: num(r.n) }));
}
