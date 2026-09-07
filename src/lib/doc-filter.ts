import type { DocKind, TeamDocument } from "../server/documents";

// ── Filtro de la lista de Documentos ────────────────────────────────────────────
//
// Puro, isomorfo y sin React: lo comparten el panel lateral (ArtifactPanel, rama
// "docindex") y la página completa (/artifacts), y así se puede probar sin montar nada.
// Mismo patrón que `lib/prospeccion-filter.ts`.
//
// Nació de una queja concreta: una usuaria abrió Documentos, vio 37 tiles y escribió
// «todo esto no es mío…». No pedía carpetas — pedía filtrar por autoría.

export type DocFilter = {
  /** Texto libre. Busca en el título Y en el nombre del room. */
  q: string;
  /** Sólo los que hice yo (`TeamDocument.mine`, decidido en el servidor). */
  mine: boolean;
  /** Tipos seleccionados. **Vacío = todos**, que es lo que espera quien no ha tocado
   *  ningún chip. Un array vacío que significara "ninguno" dejaría la lista en blanco
   *  nada más abrir el panel. */
  kinds: DocKind[];
};

export const EMPTY_DOC_FILTER: DocFilter = { q: "", mine: false, kinds: [] };

/** ¿Hay algo puesto? Decide si el encabezado dice «12 de 37» y si se ofrece limpiar. */
export function isDocFilterActive(f: DocFilter): boolean {
  return f.q.trim() !== "" || f.mine || f.kinds.length > 0;
}

/** Sin acentos ni mayúsculas. Buscar "cedula" TIENE que encontrar "Cédula": en un
 *  producto en español, exigir el acento convierte el buscador en un adorno. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function filterDocs(docs: TeamDocument[], f: DocFilter): TeamDocument[] {
  const q = fold(f.q.trim());
  const kinds = f.kinds.length ? new Set(f.kinds) : null;
  return docs.filter((d) => {
    if (f.mine && !d.mine) return false;
    if (kinds && !kinds.has(d.kind)) return false;
    if (!q) return true;
    // El room entra en la búsqueda a propósito: cuando no recuerdas cómo se llamaba el
    // documento, lo que recuerdas es DÓNDE pasó.
    return fold(d.title).includes(q) || fold(d.channelName ?? "").includes(q);
  });
}

/** Los tipos que de verdad están presentes, con su conteo. Los chips se arman con esto
 *  y no con `DOC_KINDS` entero: un chip «Hoja · 0» invita a un clic que vacía la lista. */
export function kindCounts(docs: TeamDocument[]): Map<DocKind, number> {
  const m = new Map<DocKind, number>();
  for (const d of docs) m.set(d.kind, (m.get(d.kind) ?? 0) + 1);
  return m;
}

/** Cómo se llama cada tipo para una persona. La fila del panel lleva hoy el valor crudo
 *  de la DB («Subido · office»); los chips no lo repiten. El copy lo traduce el
 *  componente con `t()` — aquí no hay React ni i18n. */
export function docKindLabel(k: DocKind): string {
  switch (k) {
    case "doc":
      return "Documento";
    case "sheet":
      return "Hoja";
    case "artifact":
      return "Artefacto";
    case "office":
      return "Word/Excel";
    case "pdf":
      return "PDF";
    case "html":
      return "Página";
    case "image":
      return "Imagen";
    case "file":
      return "Archivo";
  }
}

/** Alterna un tipo en el filtro. Un clic pone, otro quita. */
export function toggleKind(f: DocFilter, k: DocKind): DocFilter {
  return {
    ...f,
    kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k],
  };
}
