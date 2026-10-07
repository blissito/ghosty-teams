import { blockText, resolveBlockId, type DocBlock } from "./doc-blocks";

// ── Observaciones del agente ANCLADAS al párrafo ──────────────────────────────
//
// Visto en descti (28-sep): «Analiza el documento y señálame en esta ventana de chat las
// inconsistencias…». La revisión llegaba como una lista larga en el chat, y la persona tenía
// que ir y venir entre la lista y el documento para saber de qué párrafo hablaba cada punto.
//
// Ahora el agente deja cada observación sobre SU bloque (```eb-comment n12```): el documento
// las numera en el margen, el chat sólo lleva el resumen, y cada una se resuelve donde vive.
// Es lo que hacen Word Copilot, Docs+Gemini y Claude Docs; aquí va en el sobre, sin Yjs.

export interface DocComment {
  id: string;
  /** Bloque al que apunta. */
  blockId: string;
  text: string;
  author: "agent" | "human";
  /** Handle del agente (o nombre), para firmarla. */
  by?: string;
  /** Inicio del párrafo al comentarlo: sirve de cita aunque el bloque cambie después. */
  quote: string;
  resolved?: boolean;
  at: number;
  /** Mini hilo de la nota: lo que contestó el agente al pedirle «Arreglar». */
  replies?: { by: string; text: string; at: number }[];
}

const FENCE = /```eb-comment[ \t]+(\S+)[ \t]*\n([\s\S]*?)```/g;

/** Los ```eb-comment <dirección>``` de una respuesta, en orden. Sólo los cerrados. */
export function extractDocComments(reply: string): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  for (const m of reply.matchAll(FENCE)) {
    const text = m[2].trim();
    if (text) out.push({ ref: m[1], text });
  }
  return out;
}

/** La respuesta sin los fences de observación: en el chat queda sólo la prosa (el resumen). */
export function stripDocComments(reply: string): string {
  return reply.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Resuelve las direcciones contra el documento que el agente vio. Las que no existen se cuentan. */
export function attachComments(
  blocks: DocBlock[],
  raw: { ref: string; text: string }[],
  by?: string,
): { comments: DocComment[]; missing: string[] } {
  const byId = new Map<string, DocBlock>();
  const walk = (l: DocBlock[]) => l.forEach((b) => (b.id && byId.set(b.id, b), b.children?.length && walk(b.children)));
  walk(blocks);
  const comments: DocComment[] = [];
  const missing: string[] = [];
  const t = Date.now();
  raw.forEach((c, i) => {
    const id = resolveBlockId(blocks, c.ref);
    const b = id ? byId.get(id) : undefined;
    if (!id || !b) {
      missing.push(c.ref);
      return;
    }
    comments.push({
      id: `c_${t.toString(36)}_${i}`,
      blockId: id,
      text: c.text,
      author: "agent",
      by,
      quote: blockText(b).slice(0, 140),
      at: t,
    });
  });
  return { comments, missing };
}

/**
 * Las de una revisión nueva REEMPLAZAN a las abiertas del mismo autor (una revisión es una
 * foto del documento); las resueltas se quedan como historial. Descarta las de bloques borrados.
 */
export function mergeComments(prev: DocComment[] | undefined, nuevas: DocComment[], blocks: DocBlock[]): DocComment[] {
  const vivos = new Set<string>();
  const walk = (l: DocBlock[]) => l.forEach((b) => (b.id && vivos.add(b.id), b.children?.length && walk(b.children)));
  walk(blocks);
  const autores = new Set(nuevas.map((c) => c.by ?? ""));
  const quedan = (prev ?? []).filter((c) => c.resolved || !autores.has(c.by ?? ""));
  return [...quedan, ...nuevas].filter((c) => vivos.has(c.blockId));
}

/** La prosa de una respuesta sin ningún fence (eb-patch, gt-tools, …): lo que va a la nota. */
export function stripFences(reply: string): string {
  return reply.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
