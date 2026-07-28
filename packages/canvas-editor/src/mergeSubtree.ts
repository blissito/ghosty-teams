// Reconciliación del subárbol que devuelve un refine.
//
// POR QUÉ EXISTE: `htmlToNode` → `elToNode` (serialize.ts) conserva el `data-id`
// de un elemento SÓLO si el modelo lo devolvió; cuando no, mintea uno nuevo con
// `genId`. Aplicar ese resultado con `replaceNodeSubtree` cambia la identidad de
// TODOS los descendientes de golpe, aunque el modelo sólo haya tocado un `h2`.
// Consecuencias reales: se pierde la selección, el árbol de capas parpadea
// entero, un refine posterior ya no puede apuntar al mismo nodo, y `hidden` /
// `locked` (que viven en el doc, no en el HTML) se borran en silencio.
//
// `mergeSubtree` reancla el resultado sobre el árbol previo: mismo `data-id`
// primero y, si falta, por posición + tag. Lo que el modelo no tocó conserva su
// identidad; lo que sí, cambia sólo en lo que cambió.

import type { Node } from './model'

/**
 * Funde `next` (lo que devolvió el modelo) sobre `prev` (lo que había), de forma
 * que la identidad se preserve al máximo.
 *
 * - La raíz SIEMPRE conserva el id de `prev`: es el nodo que el usuario apuntó.
 * - Los hijos se emparejan primero por `data-id`; los que el modelo devolvió sin
 *   id se emparejan por posición **y sólo si el tag coincide** — un `<p>` que
 *   pasó a ser `<h2>` es un nodo nuevo, no el mismo con otro traje.
 * - `hidden` y `locked` viven en el doc y no viajan en el HTML: se heredan del
 *   nodo previo, nunca se pierden por un refine.
 */
export function mergeSubtree(prev: Node, next: Node): Node {
  return mergeOne(prev, next, prev.id)
}

function mergeOne(prev: Node, next: Node, keepId: string): Node {
  const merged: Node = {
    ...next,
    id: keepId,
    children: mergeChildren(prev.children, next.children),
  }
  // Flags que no existen en el HTML: si el modelo no las trae, se conservan.
  if (prev.hidden !== undefined && next.hidden === undefined) merged.hidden = prev.hidden
  if (prev.locked !== undefined && next.locked === undefined) merged.locked = prev.locked
  return merged
}

function mergeChildren(prev: Node[], next: Node[]): Node[] {
  const byId = new Map<string, Node>()
  for (const p of prev) byId.set(p.id, p)

  // Los previos que el modelo YA reclamó por id no pueden volver a emparejarse
  // por posición: si no, un hijo previo se fundiría en dos nodos distintos.
  const claimed = new Set<string>()
  for (const n of next) if (byId.has(n.id)) claimed.add(n.id)

  return next.map((n, i) => {
    const match = byId.get(n.id) ?? positional(prev, i, n, claimed)
    if (!match) return n // nodo genuinamente nuevo: se queda con su id fresco
    claimed.add(match.id)
    return mergeOne(match, n, match.id)
  })
}

/** Empareja por posición, sólo si el tag coincide y ese previo sigue libre. */
function positional(prev: Node[], i: number, next: Node, claimed: Set<string>): Node | null {
  const cand = prev[i]
  if (!cand || claimed.has(cand.id)) return null
  return cand.tag === next.tag ? cand : null
}
