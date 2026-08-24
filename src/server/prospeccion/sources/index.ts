/**
 * Fuentes de prospectos — adaptadores enchufables.
 *
 * La fuente es la parte MÁS reemplazable del sistema y por eso vive detrás de una
 * interfaz de una sola función. El motor (listas, columnas, tocadas, opt-out) no sabe
 * de dónde salieron las filas, y agregar Google Maps o un CSV es un archivo más aquí
 * sin tocar nada del resto.
 *
 * ⚠️ **Esto cambió el 2026-08-24.** Antes decía que no había catálogo compartido y que la
 * data se conseguía por tenant y por petición. Hoy la fuente por defecto es un DIRECTORIO
 * PROPIO compartido por todos los workspaces (`directorio.server.ts`), y la frontera pasó
 * a ser otra:
 *
 *   · El **directorio** guarda hechos públicos del negocio y es de todos. Enriquecer una
 *     vez sirve a todos, que es lo que hace valioso a un motor de prospección.
 *   · Las **filas de una lista** siguen siendo del tenant: sus notas, su estado, su
 *     segmentación y a quién ya tocó no salen nunca de su namespace.
 */
import type { ProspRow } from "../lists.server";

export type Found = Partial<Pick<ProspRow, "name" | "phone" | "email" | "website" | "address" | "category">> & {
  data?: Record<string, { v: string | null; src?: string; verified?: boolean }>;
};

export type SearchSource = {
  id: string;
  label: string;
  /**
   * Qué sabe hacer, en una línea. Se le enseña al agente.
   *
   * ⚠️ NO nombra al proveedor. Este texto llega al modelo y de ahí al chat.
   */
  blurb: string;
  /**
   * Las celdas de `data` que esta fuente puede emitir, con la etiqueta que llevan.
   *
   * ⚠️ Existe porque una celda SIN columna es invisible. La rejilla pinta las columnas de
   * `gt_prosp_columns`, y las base son campos fijos de la fila; una llave suelta en
   * `data_json` no la enseña nadie. El tamaño de empresa llevaba así desde el principio:
   * se guardaba en cada fila y no se veía, no se podía filtrar y no salía al exportar.
   *
   * Se declaran aquí y no se crean a ciegas: sólo se registran las que de verdad
   * aparecieron en los resultados, para que una búsqueda sin coordenadas no deje dos
   * columnas vacías ocupando pantalla.
   */
  columns?: { key: string; label: string }[];
  /**
   * Busca a partir del criterio en lenguaje natural.
   * Devuelve filas crudas; deduplicar y persistir es del motor, no de la fuente.
   */
  search(criteria: string, limit: number): Promise<Found[]>;
};

import { denue } from "./denue";
import { directorio } from "./directorio";

/**
 * El orden importa: la primera es la que se ofrece por defecto.
 *
 * `denue` (consulta en vivo a la API del proveedor) se queda como respaldo y NO se usa
 * salvo que se pida por id. Sus techos son los que motivaron el directorio propio: ~100
 * resultados por consulta, radio máximo de 5 km, token con registro roto, y casi nunca
 * devuelve correo.
 */
export const SOURCES: SearchSource[] = [directorio, denue];

export function sourceById(id: string): SearchSource {
  return SOURCES.find((s) => s.id === id) ?? directorio;
}
