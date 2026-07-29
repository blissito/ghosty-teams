import { blockSignature, type DocBlock } from "./doc-blocks";

/**
 * Lo mínimo que el reconciliador necesita de un editor BlockNote. Se declara aquí
 * (en vez de importar el tipo del editor) para que este módulo NO arrastre
 * @blocknote: así se prueba en node, y el riesgo que cubre —parpadeo y pérdida de
 * ids— se verifica sin montar un editor.
 */
export interface ReconcilableEditor {
  document: unknown;
  replaceBlocks(target: unknown, blocks: unknown): void;
  insertBlocks(blocks: unknown, reference: unknown, placement: string): void;
  removeBlocks(target: unknown): void;
}

/**
 * Deja intacto el prefijo que no cambió y reemplaza sólo la cola.
 *
 * Es el corazón anti-parpadeo. Durante el streaming el markdown se re-parsea en cada
 * tick, y `tryParseMarkdownToBlocks` acuña uuids NUEVOS cada vez: reemplazar el
 * documento completo remontaría todos los bloques en cada tick, con parpadeo, scroll
 * al principio y cursor perdido. Comparando por CONTENIDO —`blockSignature`, que
 * ignora el id a propósito— el prefijo estable se reconoce y se conserva, y con él
 * sus ids.
 *
 * El markdown en streaming crece por la cola, así que en la práctica toca un solo
 * bloque por tick.
 */
export function reconcile(editor: ReconcilableEditor, next: DocBlock[]): void {
  const cur = (editor.document ?? []) as DocBlock[];
  // Nunca vaciamos el documento: un tick con markdown a medio parsear (o un fence que
  // aún no abrió) no puede borrar lo que ya se veía.
  if (!next.length) return;

  let i = 0;
  const min = Math.min(cur.length, next.length);
  while (i < min && blockSignature(cur[i]) === blockSignature(next[i])) i++;

  // Idéntico: no tocar el editor. Sin esta salida, un tick sin cambios (el agente
  // escribiendo dentro del mismo bloque, o un repaint del body) haría trabajo de DOM
  // y movería el cursor por nada.
  if (i === cur.length && i === next.length) return;

  const tail = cur.slice(i);
  const newTail = next.slice(i);
  try {
    if (!tail.length) {
      // Sólo creció. `cur[i-1]` es el último bloque que sí coincidió; si i===0 el
      // documento estaba vacío, y ahí no hay ancla: se reemplaza todo.
      if (i === 0) editor.replaceBlocks(cur, next);
      else editor.insertBlocks(newTail, cur[i - 1], "after");
    } else if (!newTail.length) {
      editor.removeBlocks(tail);
    } else {
      editor.replaceBlocks(tail, newTail);
    }
  } catch {
    // Un splice inválido (bloque que ya no está, esquema inesperado) no puede dejar el
    // documento a medias: se reemplaza todo. Cuesta un remonte, que es justo lo que
    // este reconciliador evita en el camino normal.
    try {
      editor.replaceBlocks(cur, next);
    } catch {
      /* el editor se está desmontando */
    }
  }
}
