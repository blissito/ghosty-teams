import {
  isDocEnvelope,
  parseDocEnvelope,
  serializeDocEnvelope,
  type DocBlock,
} from "../lib/doc-blocks";

// Conversión markdown ↔ bloques del lado del SERVER. El agente escribe markdown en el
// fence (es lo que hace bien y ya funcionaba); la verdad que se persiste son bloques.
// Esta es la única traducción entre los dos.
//
// `ServerBlockNoteEditor` es headless pero necesita DOM: trae su propio jsdom. Se
// instancia UNA sola vez y se reusa — mismo criterio que `serverParseOpts()` de
// artifact-dom.server.ts, y por la misma razón: crearlo por llamada lo pondría en el
// camino de la request del room, que es caliente.
//
// Ojo con la asimetría: aquí `tryParseMarkdownToBlocks` es ASÍNCRONO, mientras que en
// el editor del cliente el método del mismo nombre es sincrónico.

let cached: Promise<unknown> | null = null;

async function server() {
  if (!cached) {
    cached = (async () => {
      const { BlockNoteSchema } = await import("@blocknote/core");
      const { withMultiColumn } = await import("@blocknote/xl-multi-column");
      const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
      // El MISMO schema que el editor del cliente (`DocEditor.tsx`). Si divergen, un
      // bloque válido de un lado se cae del otro al parsear.
      const schema = withMultiColumn(BlockNoteSchema.create());
      return ServerBlockNoteEditor.create({ schema } as never);
    })();
  }
  return cached as Promise<{
    tryParseMarkdownToBlocks(md: string): Promise<unknown[]>;
    blocksToMarkdownLossy(blocks: unknown[]): Promise<string>;
  }>;
}

/** Markdown → bloques (con uuid). Devuelve [] si no hay nada que convertir. */
export async function mdToBlocks(md: string): Promise<DocBlock[]> {
  if (!md?.trim()) return [];
  const e = await server();
  return (await e.tryParseMarkdownToBlocks(md)) as DocBlock[];
}

/** Bloques → markdown. Se usa para el export .docx y cuando ya no hay `sourceMd`. */
export async function blocksToMd(blocks: DocBlock[]): Promise<string> {
  if (!blocks?.length) return "";
  const e = await server();
  return await e.blocksToMarkdownLossy(blocks as unknown[]);
}

/**
 * Serializa un documento para `gc_artifacts.md`: convierte el markdown del agente a
 * bloques y lo envuelve.
 *
 * **Best-effort a propósito.** Si la conversión revienta (schema inesperado, markdown
 * que el parser no digiere), se devuelve el markdown CRUDO — la forma legacy, que
 * sigue abriendo. Perder el documento porque no se pudo convertir sería mucho peor
 * que perder la edición quirúrgica de un turno.
 */
export async function docEnvelopeFromMd(md: string): Promise<string> {
  try {
    const blocks = await mdToBlocks(md);
    if (!blocks.length) return md;
    return serializeDocEnvelope({ blocks, sourceMd: md });
  } catch (e) {
    console.error("[doc] mdToBlocks failed, guardo markdown crudo", e);
    return md;
  }
}

/**
 * El markdown de un documento, sea sobre o fila legacy. Es lo que se le devuelve al
 * agente y lo que alimenta el export .docx.
 *
 * Prefiere `sourceMd` (el texto TAL COMO lo escribió el agente) sobre derivarlo de los
 * bloques: derivarlo en cada turno son dos saltos lossy por turno
 * (blocks→md→agente→md→blocks) y la deriva se acumula versión tras versión. Sólo
 * cuando una persona ya editó el documento —y `sourceMd` dejó de ser la verdad— se
 * paga el `blocksToMarkdownLossy`.
 */
export async function docMarkdown(rawMd: string | null | undefined): Promise<string> {
  if (!rawMd) return "";
  if (!isDocEnvelope(rawMd)) return rawMd; // legacy: ya es markdown
  const env = parseDocEnvelope(rawMd);
  if (!env) return rawMd; // sobre corrupto: que lo vea tal cual, no lo escondemos
  if (env.sourceMd && !env.humanEdited) return env.sourceMd;
  try {
    return await blocksToMd(env.blocks);
  } catch (e) {
    console.error("[doc] blocksToMd failed", e);
    return env.sourceMd ?? "";
  }
}
