/**
 * Importar una hoja grande, por trozos y con progreso real.
 *
 * Se parte en el CLIENTE y no en el servidor porque el progreso tiene que ser verdad: una
 * sola petición de 11 segundos sólo puede enseñar un spinner, y un spinner de 11 segundos
 * sobre 10 mil filas se lee como "se colgó". Partiendo, cada trozo que vuelve es un avance
 * que se puede pintar.
 *
 * El tamaño del trozo equilibra dos cosas: pocos viajes (cada uno son ~300 ms de ida y
 * vuelta) y una barra que se mueva seguido. 2,000 filas tardan ~2 s por trozo, que es el
 * ritmo al que un avance se percibe como avance y no como saltos.
 */
import type { Target } from "./prospeccion-mapping";

export const CHUNK_ROWS = 2000;

/**
 * El PRIMER trozo va chico a propósito.
 *
 * Medido: el primero tarda ~4.5 s y los siguientes ~1.6 s, porque además de insertar tiene
 * que crear la lista y las columnas nuevas. Con trozos iguales, la barra se queda clavada
 * en cero esos primeros segundos — que es justo cuando la persona decide si esto se colgó.
 * Con 300 filas el primer avance llega en menos de un segundo y el resto va a ritmo normal.
 */
export const FIRST_CHUNK_ROWS = 300;

export type ImportProgress = { done: number; total: number };

export type ChunkResult = {
  ok: boolean;
  added: number;
  newColumns: string[];
  error?: string | null;
};

/**
 * Manda las filas en trozos, avisando el avance.
 *
 * El PRIMER trozo es el que crea las columnas nuevas; los demás las encuentran ya hechas
 * (`importTable` reusa una columna con la misma etiqueta en vez de duplicarla).
 */
export async function importInChunks(args: {
  headers: string[];
  rows: string[][];
  targets: Record<string, Target>;
  send: (chunk: string[][], first: boolean) => Promise<ChunkResult>;
  onProgress?: (p: ImportProgress) => void;
}): Promise<{ added: number; newColumns: string[]; error: string | null }> {
  const total = args.rows.length;
  let added = 0;
  let newColumns: string[] = [];

  let i = 0;
  let first = true;
  while (i < total) {
    const size = first ? FIRST_CHUNK_ROWS : CHUNK_ROWS;
    const chunk = args.rows.slice(i, i + size);
    const r = await args.send(chunk, first);
    if (!r.ok) return { added, newColumns, error: r.error ?? "No se pudo importar" };
    added += r.added;
    if (first) newColumns = r.newColumns;
    i += size;
    first = false;
    args.onProgress?.({ done: Math.min(i, total), total });
  }
  return { added, newColumns, error: null };
}
