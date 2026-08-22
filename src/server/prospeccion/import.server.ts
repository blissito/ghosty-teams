/**
 * Aplicar un plan de importación a una lista.
 *
 * ⚠️ Aquí ya NO se adivina nada: el mapeo llega decidido desde la pantalla de revisión
 * (`lib/prospeccion-mapping.ts`, isomorfo). Ése es el cambio que pide el consenso de los
 * importadores serios —Flatfile, CSVBox, Dromo—: *validar y enseñar antes de persistir*.
 * La versión anterior escribía directo y el usuario no tenía forma de saber si el
 * auto-mapeo había acertado.
 *
 * El archivo se lee en el NAVEGADOR (`components/prospeccion/DropZone.tsx`); aquí llegan
 * las celdas y el plan. Así no hace falta ruta de subida, tope de tamaño ni temporal.
 */
import { addColumn, insertRows, listColumns, type ProspRow } from "./lists.server";
import { columnKey, type Target } from "../../lib/prospeccion-mapping";

export type ImportResult = { added: number; newColumns: string[] };

export async function importTable(args: {
  listId: number;
  headers: string[];
  rows: string[][];
  /** header → destino. Sin él no se importa nada: adivinar aquí sería volver al bug. */
  targets: Record<string, Target>;
}): Promise<ImportResult> {
  const { headers, rows, targets } = args;

  // 1. Crear las columnas nuevas que haga falta, y quedarse con su llave REAL (addColumn
  //    desambigua colisiones, así que la llave final puede no ser la que se calculó aquí).
  const existing = new Map((await listColumns(args.listId)).map((c) => [c.label, c]));
  const keyByHeader = new Map<string, string>();
  const created: string[] = [];

  for (const h of headers) {
    if (targets[h] !== "__new__") continue;
    const label = (h || columnKey(h)).slice(0, 80);
    const ya = existing.get(label);
    if (ya) { keyByHeader.set(h, ya.key); continue; }
    const col = await addColumn({ listId: args.listId, label, kind: "manual" });
    keyByHeader.set(h, col.key);
    existing.set(label, col);
    created.push(label);
  }

  // 2. Armar las filas.
  const BASE = new Set(["name", "phone", "email", "website", "address", "category"]);
  const out: Partial<ProspRow>[] = [];
  for (const row of rows) {
    if (!row.some((c) => String(c ?? "").trim())) continue; // fila vacía
    const r: Partial<ProspRow> = { data: {} };
    headers.forEach((h, i) => {
      const v = String(row[i] ?? "").trim();
      if (!v) return;
      const t = targets[h];
      if (t === "__skip__" || !t) return;
      if (BASE.has(t)) {
        (r as unknown as Record<string, string>)[t] = v;
      } else {
        const k = keyByHeader.get(h);
        if (k) r.data![k] = { v, src: "importado", verified: false };
      }
    });
    out.push(r);
  }

  await insertRows(args.listId, out);
  return { added: out.length, newColumns: created };
}
