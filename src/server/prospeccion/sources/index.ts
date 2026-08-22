/**
 * Fuentes de prospectos — adaptadores enchufables.
 *
 * La fuente es la parte MÁS reemplazable del sistema y por eso vive detrás de una
 * interfaz de una sola función. El motor (listas, columnas, tocadas, opt-out) no sabe
 * de dónde salieron las filas, y agregar Google Maps o un CSV es un archivo más aquí
 * sin tocar nada del resto.
 *
 * ⚠️ La data se consigue POR TENANT Y POR PETICIÓN. No hay catálogo compartido entre
 * workspaces ni base que acumule: lo que se busca se guarda en las filas de ESE tenant.
 */
import type { ProspRow } from "../lists.server";

export type Found = Partial<Pick<ProspRow, "name" | "phone" | "email" | "website" | "address" | "category">> & {
  data?: Record<string, { v: string | null; src?: string; verified?: boolean }>;
};

export type SearchSource = {
  id: string;
  label: string;
  /** Qué sabe hacer, en una línea. Se le enseña al agente. */
  blurb: string;
  /**
   * Busca a partir del criterio en lenguaje natural.
   * Devuelve filas crudas; deduplicar y persistir es del motor, no de la fuente.
   */
  search(criteria: string, limit: number): Promise<Found[]>;
};

import { denue } from "./denue";

export const SOURCES: SearchSource[] = [denue];

export function sourceById(id: string): SearchSource {
  return SOURCES.find((s) => s.id === id) ?? denue;
}
