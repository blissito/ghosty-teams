import {
  collectIds,
  containerAt,
  findBlockPath,
  resolveBlockId,
  type DocBlock,
} from "./doc-blocks";

// ── Edición quirúrgica de un DOCUMENTO ────────────────────────────────────────
//
// Gemelo de `artifact-patch.ts`, con la misma disciplina (fallos tipados, fallo
// VISIBLE, si no aplica nada NO se crea versión) pero por otro mecanismo: el
// artefacto HTML se parchea por DOM (`querySelector('[data-id]')` + `replaceWith`);
// un documento se parchea por SPLICE sobre el árbol de bloques.
//
// No es una elección de estilo. El full-HTML de BlockNote repite el mismo `data-id`
// en dos divs anidados, así que `applyPatches` (que reemplaza el primer match) y
// `stampIds` (que re-estampa ids duplicados) CORROMPERÍAN ese markup. Los bloques,
// en cambio, ya son un árbol JSON con un id único por nodo.
//
// `extractEbPatches()` se reusa tal cual: su salida es id + payload, agnóstica al
// formato. Lo único distinto es cómo se aplica.

export type BlockPatchFailReason =
  | "missing" // la dirección no existe en el documento
  | "unparseable" // el markdown del patch no produjo ningún bloque
  | "empty"; // el patch venía sin cuerpo

export interface BlockPatchFail {
  /** Tal como lo escribió el modelo (alias `n7` o uuid), para que el aviso lo nombre. */
  ref: string;
  reason: BlockPatchFailReason;
}

export interface BlockPatchResult {
  blocks: DocBlock[];
  applied: string[];
  failed: BlockPatchFail[];
}

/** Lo que `extractEbPatches` produce, en la forma que aquí importa. */
export interface EbPatchLike {
  nodeId: string;
  html: string;
  closed: boolean;
  op?: "replace" | "remove" | "insert";
  pos?: "append" | "prepend" | "before" | "after";
  remove?: boolean;
}

export interface BlockPatchDeps {
  /**
   * Markdown → bloques. Se INYECTA para que este módulo no dependa de @blocknote:
   * en el server es `mdToBlocks`, en el cliente el editor vivo. Así se prueba en node.
   */
  parse(md: string): Promise<DocBlock[]>;
}

/** Clon profundo del árbol: nunca mutamos los bloques que vinieron de la DB. */
function clone(blocks: DocBlock[]): DocBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as DocBlock[];
}

/**
 * Re-acuña los ids que ya existen en el documento.
 *
 * Pasa de verdad: si el modelo copió un bloque para insertarlo en otro sitio, el
 * markdown parseado puede traer un id que ya está en uso. Dos bloques con el mismo id
 * rompen la unicidad de la que depende TODO lo demás (los alias, `findBlockPath`, el
 * fragment de Yjs cuando llegue la co-edición).
 */
function reIdCollisions(fresh: DocBlock[], taken: Set<string>): void {
  const walk = (list: DocBlock[]): void => {
    for (const b of list) {
      if (b.id && taken.has(b.id)) {
        // Sufijo determinista y suficiente: sólo tiene que no colisionar.
        let n = 2;
        let candidate = `${b.id}-${n}`;
        while (taken.has(candidate)) candidate = `${b.id}-${++n}`;
        b.id = candidate;
      }
      if (b.id) taken.add(b.id);
      if (b.children?.length) walk(b.children);
    }
  };
  walk(fresh);
}

/**
 * Aplica los patches sobre el árbol de bloques.
 *
 * Devuelve SIEMPRE un resultado; nunca lanza. Lo que no aplica se reporta en `failed`
 * con su motivo, y el llamador decide: `applied.length === 0` significa no crear
 * versión (el documento anterior sigue en pie) y decirlo en el bubble. Una capa de
 * contención muda escondería que el modo quirúrgico está roto.
 */
export async function applyBlockPatches(
  blocks: DocBlock[],
  patches: EbPatchLike[],
  deps: BlockPatchDeps,
): Promise<BlockPatchResult> {
  const out = clone(blocks);
  const applied: string[] = [];
  const failed: BlockPatchFail[] = [];

  // Tabla de alias FIJA, calculada sobre el documento de ENTRADA y una sola vez.
  //
  // Es lo único correcto: el modelo eligió `n7` mirando el índice del documento que se
  // le mostró (la versión persistida). Si se re-resolviera contra el árbol que vamos
  // mutando, el primer patch renumeraría todo y el segundo `n3` del mismo turno
  // apuntaría a un bloque distinto del que el modelo quiso — un cambio quirúrgico
  // aplicado silenciosamente en el lugar equivocado, que es peor que no aplicarlo.
  //
  // Los uuid siguen valiendo sobre `out` porque los bloques que no se tocan conservan
  // el suyo; si un patch anterior borró el bloque, `findBlockPath` no lo encuentra y
  // sale como `missing`, que es la verdad.
  const refToId = new Map<string, string>();
  for (const p of patches) {
    if (refToId.has(p.nodeId)) continue;
    const id = resolveBlockId(blocks, p.nodeId);
    if (id) refToId.set(p.nodeId, id);
  }

  // Sólo los patches CERRADOS y con cuerpo (o un remove, que no lleva cuerpo). Mismo
  // filtro que el del artefacto: un fence a medio escribir no es una instrucción.
  const usable = patches.filter((p) => p.closed && (p.remove || p.op === "remove" || p.html.trim()));

  for (const p of usable) {
    const ref = p.nodeId;
    const id = refToId.get(ref);
    if (!id) {
      failed.push({ ref, reason: "missing" });
      continue;
    }
    const path = findBlockPath(out, id);
    const at = path ? containerAt(out, path) : null;
    if (!at) {
      failed.push({ ref, reason: "missing" });
      continue;
    }

    const op = p.remove ? "remove" : (p.op ?? "replace");

    if (op === "remove") {
      at.list.splice(at.index, 1);
      applied.push(ref);
      continue;
    }

    let fresh: DocBlock[];
    try {
      fresh = await deps.parse(p.html);
    } catch {
      failed.push({ ref, reason: "unparseable" });
      continue;
    }
    if (!fresh.length) {
      failed.push({ ref, reason: "unparseable" });
      continue;
    }
    reIdCollisions(fresh, collectIds(out));

    if (op === "replace") {
      at.list.splice(at.index, 1, ...fresh);
      applied.push(ref);
      continue;
    }

    // insert: la posición dice DÓNDE respecto del ancla. `append`/`prepend` entran
    // como hijos (una cláusula gana un inciso); `before`/`after` son hermanos.
    const pos = p.pos ?? "append";
    if (pos === "before" || pos === "after") {
      at.list.splice(pos === "before" ? at.index : at.index + 1, 0, ...fresh);
    } else {
      const target = at.list[at.index];
      target.children = target.children ?? [];
      if (pos === "prepend") target.children.unshift(...fresh);
      else target.children.push(...fresh);
    }
    applied.push(ref);
  }

  return { blocks: out, applied, failed };
}
