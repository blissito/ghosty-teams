import { applyBlockPatches, type BlockPatchDeps, type BlockPatchResult, type EbPatchLike } from "./doc-patch";
import { blockText, containerAt, findBlockPath, resolveBlockId, type DocBlock } from "./doc-blocks";

// ── Sugerencias por bloque: lo que el agente quiere cambiar de lo que escribió una PERSONA ──
//
// Visto en descti (24-sep): la persona editó 28 bloques a mano, pidió "revisa respetando mis
// modificaciones", y el agente retocó 13 de esos 28 sin decirlo. El agente no sabía cuáles eran
// suyos y cuáles de ella, y ella no tenía cómo ver qué le cambiaron.
//
// La regla: un `eb-patch` sobre un bloque que tocó una persona NO se aplica; queda como
// sugerencia pendiente en el sobre (antes/después) y la persona la acepta o la rechaza. Lo que
// nadie tocó se aplica como siempre. Es el patrón de Word Copilot y Docs+Gemini, pero sin Yjs:
// vive sobre el árbol de bloques y `changedIds`, que ya existían.

export interface DocSuggestion {
  /** Id propio de la sugerencia (para aceptarla/rechazarla). */
  id: string;
  /** El bloque de la persona que el agente quiere cambiar. */
  targetId: string;
  op: "replace" | "remove";
  /** Los bloques que propone el agente (vacío en un remove). */
  after: DocBlock[];
  /** Texto de la persona al momento de proponer: para pintar el antes/después sin buscarlo. */
  beforeText: string;
  afterText: string;
  /** unix ms */
  at: number;
  /** La observación que esta propuesta atiende («Arreglar»): aceptarla la resuelve. */
  commentId?: string;
}

/** Firma de un bloque SIN sus hijos (los hijos se comparan por su propio id). */
function sig(b: DocBlock): string {
  return JSON.stringify([b.type ?? "", b.props ?? {}, b.content ?? null]);
}

function flat(list: DocBlock[] = [], out: DocBlock[] = []): DocBlock[] {
  for (const b of list) {
    out.push(b);
    if (b.children?.length) flat(b.children, out);
  }
  return out;
}

/**
 * Bloques que una persona creó o cambió entre `base` y `edited`.
 *
 * Por id: el editor conserva el uuid del bloque al teclear en él, así que un id que ya existía
 * con otra firma es un bloque editado, y un id nuevo es uno que escribió ella.
 */
export function humanTouchedIds(base: DocBlock[], edited: DocBlock[]): string[] {
  const before = new Map(flat(base).map((b) => [b.id, sig(b)]));
  const out: string[] = [];
  for (const b of flat(edited)) {
    if (!b.id) continue;
    if (before.get(b.id) !== sig(b)) out.push(b.id);
  }
  return out;
}

/** Une las marcas de la persona, sin repetir y sólo con ids que siguen en el documento. */
export function mergeHumanIds(prev: string[] | undefined, nuevos: string[], blocks: DocBlock[]): string[] {
  const vivos = new Set(flat(blocks).map((b) => b.id));
  return [...new Set([...(prev ?? []), ...nuevos])].filter((id) => vivos.has(id));
}

export interface GuardedPatchResult extends BlockPatchResult {
  /** Sugerencias NUEVAS de este turno (las que tocaban bloques de la persona). */
  suggestions: DocSuggestion[];
}

/**
 * `applyBlockPatches`, pero los patches que tocan un bloque de la persona se vuelven sugerencia.
 *
 * Un `insert` nunca se frena aunque su ancla sea de la persona: agregar no le quita nada.
 */
export async function applyPatchesGuarded(
  blocks: DocBlock[],
  patches: EbPatchLike[],
  humanIds: string[] | undefined,
  deps: BlockPatchDeps,
): Promise<GuardedPatchResult> {
  const guard = new Set(humanIds ?? []);
  const libres: EbPatchLike[] = [];
  const frenados: { p: EbPatchLike; targetId: string }[] = [];
  for (const p of patches) {
    const op = p.remove ? "remove" : (p.op ?? "replace");
    // El alias se resuelve contra el documento de ENTRADA, igual que en applyBlockPatches.
    const id = resolveBlockId(blocks, p.nodeId);
    if (id && guard.has(id) && op !== "insert" && p.closed) frenados.push({ p, targetId: id });
    else libres.push(p);
  }

  const res = await applyBlockPatches(blocks, libres, deps);
  const byId = new Map(flat(blocks).map((b) => [b.id, b]));
  const suggestions: DocSuggestion[] = [];
  for (const { p, targetId } of frenados) {
    const remove = !!p.remove || p.op === "remove";
    let after: DocBlock[] = [];
    if (!remove) {
      try {
        after = await deps.parse(p.html);
      } catch {
        res.failed.push({ ref: p.nodeId, reason: "unparseable" });
        continue;
      }
      if (!after.length) {
        res.failed.push({ ref: p.nodeId, reason: "unparseable" });
        continue;
      }
    }
    const target = byId.get(targetId);
    suggestions.push({
      id: `s_${targetId.slice(0, 8)}_${Date.now().toString(36)}_${suggestions.length}`,
      targetId,
      op: remove ? "remove" : "replace",
      after,
      beforeText: target ? blockText(target) : "",
      afterText: after.map(blockText).join("\n"),
      at: Date.now(),
    });
    res.applied.push(p.nodeId);
  }
  return { ...res, suggestions };
}

/** Pendientes viejas + nuevas; una por bloque, gana la más nueva. Descarta las de bloques que ya no existen. */
export function mergeSuggestions(
  prev: DocSuggestion[] | undefined,
  nuevas: DocSuggestion[],
  blocks: DocBlock[],
): DocSuggestion[] {
  const vivos = new Set(flat(blocks).map((b) => b.id));
  const out = new Map<string, DocSuggestion>();
  for (const s of [...(prev ?? []), ...nuevas]) if (vivos.has(s.targetId)) out.set(s.targetId, s);
  return [...out.values()];
}

/**
 * Aplica (aceptar) una sugerencia sobre el árbol. Devuelve null si el bloque ya no existe.
 *
 * Los ids de `after` se conservan: así el resaltado de "esto acaba de cambiar" apunta a ellos.
 */
export function acceptSuggestion(
  blocks: DocBlock[],
  s: DocSuggestion,
): { blocks: DocBlock[]; changedIds: string[] } | null {
  const out = JSON.parse(JSON.stringify(blocks)) as DocBlock[];
  const path = findBlockPath(out, s.targetId);
  const at = path ? containerAt(out, path) : null;
  if (!at) return null;
  if (s.op === "remove") {
    at.list.splice(at.index, 1);
    return { blocks: out, changedIds: [] };
  }
  const fresh = JSON.parse(JSON.stringify(s.after)) as DocBlock[];
  // Los hijos del bloque de la persona se quedan: el agente propuso ESE bloque, no su subárbol.
  const kids = at.list[at.index].children;
  if (kids?.length && fresh[0] && !fresh[0].children?.length) fresh[0].children = kids;
  at.list.splice(at.index, 1, ...fresh);
  return { blocks: out, changedIds: fresh.map((b) => b.id).filter((i): i is string => !!i) };
}

// ── Diff por palabras, para pintar el antes/después ─────────────────────────────

export type DiffPart = { t: "eq" | "del" | "ins"; s: string };

/** LCS por palabras. Los bloques son párrafos: n·m cabe de sobra. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 250_000) return [{ t: "del", s: a }, { t: "ins", s: b }];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (t: DiffPart["t"], s: string) => {
    const last = out[out.length - 1];
    if (last?.t === t) last.s += s;
    else out.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) (push("eq", A[i]), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]);
    else push("ins", B[j++]);
  }
  while (i < A.length) push("del", A[i++]);
  while (j < B.length) push("ins", B[j++]);
  return out;
}
