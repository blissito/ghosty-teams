// ── La verdad de un documento de texto: el ÁRBOL DE BLOQUES ──────────────────
//
// Un `kind:"doc"` guardaba markdown pelado en `gc_artifacts.md`. Markdown no tiene
// ids, y sin ids no hay a qué apuntar: la edición quirúrgica (`eb-patch`) era
// imposible para documentos, y "cámbiame la cláusula tercera" obligaba al agente a
// re-emitir el documento entero.
//
// Ahora la verdad es el árbol de bloques de BlockNote — el mismo modelo de Notion:
// cada bloque lleva su UUID, anidable, y editar es un patch por id. Eso da tres
// cosas de un golpe: lo quirúrgico, un editor que consume la verdad sin parsearla
// (ni perder nada), y el puente directo a Yjs para la co-edición (los bloques son
// el input de `blocksToYXmlFragment`).
//
// Este módulo es ISOMORFO y **no importa @blocknote en runtime** (sólo tipos): lo
// usan el cliente (dentro del editor vivo) y el server (con ServerBlockNoteEditor),
// y así se puede testear en node sin arrastrar jsdom.

/**
 * Un bloque, con la forma mínima que nos importa. No re-declaramos el tipo de
 * BlockNote (tiene genéricos por schema y cambia entre versiones): tratamos el
 * bloque como dato opaco salvo los cuatro campos que sí leemos.
 */
export interface DocBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  /** Inline content (texto con marcas), o filas si es tabla. Forma variable. */
  content?: unknown;
  children?: DocBlock[];
}

/** Versión del sobre. Súbela sólo si cambia la forma de manera incompatible. */
export const DOC_ENVELOPE_VERSION = 1;

/**
 * Lo que se guarda en `gc_artifacts.md` para un doc.
 *
 * `sourceMd` no es redundante: es el markdown TAL COMO lo escribió el agente. Sin
 * él, devolverle su documento en el siguiente turno exige `blocksToMarkdownLossy`,
 * o sea **dos saltos lossy por turno** (blocks→md→agente→md→blocks) y deriva que
 * se acumula versión tras versión. Mientras nadie humano lo haya tocado, se le
 * devuelve su propio texto y la deriva es cero.
 *
 * `yUpdate` está reservado para la co-edición (estado Yjs en base64). Existe hoy
 * para no tener que migrar el sobre otra vez cuando llegue.
 */
export interface DocEnvelope {
  v: number;
  blocks: DocBlock[];
  sourceMd?: string;
  /** Cierto en cuanto una persona edita: desde ahí `sourceMd` ya no es la verdad. */
  humanEdited?: boolean;
  yUpdate?: string;
  /**
   * uuid de los bloques que cambiaron EN ESTA VERSIÓN (los aplica un `eb-patch`).
   *
   * Es metadato de la versión, no contenido: no entra al .docx ni al markdown que ve el
   * agente. Vive aquí porque así viaja CON la versión — el resaltado del cambio funciona
   * aunque el panel se abra después del turno (el caso normal: pides el ajuste, lees la
   * respuesta y recién entonces abres el documento) y sobrevive a una recarga.
   */
  changedIds?: string[];
}

/**
 * ¿Este `md` es un sobre o markdown legacy? El sniff se hace sobre el TEXTO y no
 * parseando: un `JSON.parse` de un documento de 200 KB por cada lectura, sólo para
 * descubrir que era markdown, es caro y se hace en el camino de la request.
 *
 * `{"v":1` es suficiente y no colisiona: un doc markdown que empiece exactamente
 * así tendría que abrir con esa llave literal.
 */
export function isDocEnvelope(md: string | null | undefined): boolean {
  if (!md) return false;
  const head = md.trimStart().slice(0, 16);
  return head.startsWith('{"v":') || head.startsWith('{ "v":');
}

/** Parsea el sobre. Devuelve null si no lo es o si está corrupto (→ tratar legacy). */
export function parseDocEnvelope(md: string | null | undefined): DocEnvelope | null {
  if (!isDocEnvelope(md)) return null;
  try {
    const o = JSON.parse(md as string) as DocEnvelope;
    // `blocks` es lo único indispensable: sin él no hay documento que mostrar, y
    // caer a legacy (renderizar el JSON como markdown) sería peor que fallar.
    if (!o || typeof o !== "object" || !Array.isArray(o.blocks)) return null;
    return { ...o, v: typeof o.v === "number" ? o.v : DOC_ENVELOPE_VERSION };
  } catch {
    return null;
  }
}

export function serializeDocEnvelope(e: {
  blocks: DocBlock[];
  sourceMd?: string;
  humanEdited?: boolean;
  yUpdate?: string;
  changedIds?: string[];
}): string {
  const out: DocEnvelope = { v: DOC_ENVELOPE_VERSION, blocks: e.blocks };
  // Sólo lo que aporta: un sobre con `"humanEdited":false` y `"sourceMd":""` en
  // cada versión es peso muerto en una columna que se guarda 20 veces por doc.
  if (e.sourceMd) out.sourceMd = e.sourceMd;
  if (e.humanEdited) out.humanEdited = true;
  if (e.yUpdate) out.yUpdate = e.yUpdate;
  if (e.changedIds?.length) out.changedIds = e.changedIds;
  return JSON.stringify(out);
}

// ── Texto plano de un bloque ──────────────────────────────────────────────────

/**
 * Texto visible de un bloque, sin sus hijos. Recorre el inline content y también
 * las filas de una tabla, cuyo contenido vive en `content.rows[].cells[]` y no en
 * el array de siempre — sin ese caso una tabla firma como vacía y el
 * reconciliador la cree igual a cualquier otra.
 */
export function blockText(b: DocBlock): string {
  return blockTextMapped(b).texto;
}

/**
 * El texto de un bloque MÁS de dónde salió cada carácter.
 *
 * Existe porque el corrector ortográfico devuelve offsets sobre este texto y hay que poder
 * volver: resaltar la palabra en pantalla y, si aceptas la sugerencia, reemplazarla sin
 * tocar el resto. `blockText` concatena runs y colapsa espacios, así que un offset suyo no
 * sirve ni para el DOM ni para el inline content — hace falta el rastro.
 *
 * ⚠️ **`blockText` ES esta función**, no una copia parecida. Si fueran dos, el día que
 * alguien toque una las dos dejarían de coincidir y los offsets apuntarían a otra cosa —
 * en silencio, y corrompiendo texto sólo al aplicar una corrección.
 *
 * - `texto`: lo mismo que devolvía siempre `blockText`.
 * - `origen[i]`: índice, en el texto CRUDO (sin colapsar ni recortar), del carácter `i`.
 *   Vale `-1` para los separadores que inventa el recorrido (los de celdas de tabla), que
 *   no existen en el documento y por eso no se pueden señalar ni reemplazar.
 * - `runs`: cada nodo de texto visitado con su tramo en el crudo, para saber si un rango
 *   cae dentro de un solo run (aplicable sin tocar formato) o cruza varios.
 */
export interface TextoMapeado {
  texto: string;
  origen: number[];
  runs: { ini: number; fin: number }[];
}

export function blockTextMapped(b: DocBlock): TextoMapeado {
  // El inline content de UNA celda/párrafo se concatena sin separador: los runs
  // ("El " + "arrendatario" + " pagará") son un texto partido por marcas, y meterle
  // espacios lo deformaría. Celdas y filas de una tabla sí se separan — pegarlas
  // daba "ConceptoMontoRenta5000", donde se pierde el límite entre celdas y dos
  // tablas distintas pueden firmar igual.
  let crudo = "";
  const runs: { ini: number; fin: number }[] = [];
  /** Posiciones del crudo que NO existen en el documento (separadores inventados). */
  const inventados = new Set<number>();

  const escribir = (s: string, real: boolean) => {
    if (!real) for (let i = 0; i < s.length; i++) inventados.add(crudo.length + i);
    else runs.push({ ini: crudo.length, fin: crudo.length + s.length });
    crudo += s;
  };

  const walk = (node: unknown, sep = ""): void => {
    if (node == null) return;
    if (typeof node === "string") return escribir(node, true);
    if (Array.isArray(node)) {
      node.forEach((n, i) => {
        if (i > 0 && sep) escribir(sep, false);
        walk(n, sep);
      });
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.text === "string") return escribir(o.text, true);
      // Tabla: {type:"tableContent", rows:[{cells:[[inline…], …]}]}
      if (Array.isArray(o.rows)) return walk(o.rows, " ");
      if (Array.isArray(o.cells)) return walk(o.cells, " ");
      if (o.content != null) return walk(o.content, sep);
      // Link: {type:"link", href, content:[…]} — ya cubierto por o.content.
      return;
    }
  };
  walk(b.content);

  // Normalización con rastro: el mismo `\s+ → " "` y `trim` de siempre, pero anotando de
  // qué posición del crudo sale cada carácter que se emite.
  let texto = "";
  const origen: number[] = [];
  let i = 0;
  while (i < crudo.length) {
    if (/\s/.test(crudo[i])) {
      const ini = i;
      while (i < crudo.length && /\s/.test(crudo[i])) i++;
      // El espacio colapsado apunta al PRIMERO del run: es el único que existe seguro.
      texto += " ";
      origen.push(inventados.has(ini) ? -1 : ini);
      continue;
    }
    texto += crudo[i];
    origen.push(inventados.has(i) ? -1 : i);
    i++;
  }
  // trim, arrastrando el mapa.
  let a = 0;
  let z = texto.length;
  while (a < z && texto[a] === " ") a++;
  while (z > a && texto[z - 1] === " ") z--;
  return { texto: texto.slice(a, z), origen: origen.slice(a, z), runs };
}

/**
 * Traduce un rango del texto de `blockTextMapped` al texto CRUDO del bloque.
 *
 * Devuelve `null` cuando el rango no es direccionable, y esos casos importan porque son
 * justo los que corromperían el documento si se aplicara una corrección a ciegas:
 *
 * - toca un separador inventado (un match que cruza dos celdas de una tabla);
 * - cae sobre espacios colapsados, así que su longitud en el crudo no es la que dice el
 *   corrector;
 * - cruza dos runs con formato distinto ("arren**da**tario"): reemplazarlo colapsaría el
 *   formato a uno solo.
 *
 * En todos ellos el hallazgo se puede SEÑALAR, pero no aplicar de un clic.
 */
export function rangoCrudo(
  mapa: TextoMapeado,
  offset: number,
  length: number,
): { desde: number; hasta: number; unSoloRun: boolean } | null {
  if (offset < 0 || length <= 0 || offset + length > mapa.origen.length) return null;
  const desde = mapa.origen[offset];
  const ultimo = mapa.origen[offset + length - 1];
  if (desde < 0 || ultimo < 0) return null;
  const hasta = ultimo + 1;
  // Longitud distinta = por el medio hubo espacios colapsados o algo inventado.
  if (hasta - desde !== length) return null;
  for (let i = offset; i < offset + length; i++) if (mapa.origen[i] < 0) return null;
  const run = mapa.runs.find((r) => desde >= r.ini && hasta <= r.fin);
  return { desde, hasta, unSoloRun: !!run };
}

/**
 * Firma de un bloque para comparar dos versiones. **No incluye el id a propósito.**
 *
 * `tryParseMarkdownToBlocks` acuña UUIDs NUEVOS en cada llamada: durante el
 * streaming se re-parsea el markdown acumulado en cada tick, así que comparar por
 * id daría "todo cambió" siempre, se remontaría el documento completo cada tick y
 * el resultado es parpadeo y cursor perdido. Comparando por contenido, el prefijo
 * estable se reconoce y se deja intacto — que es lo que conserva los ids.
 */
export function blockSignature(b: DocBlock): string {
  const props = b.props ? JSON.stringify(b.props) : "";
  const kids = (b.children ?? []).map(blockSignature).join("");
  return `${b.type ?? "?"}|${props}|${blockText(b)}${kids ? `|[${kids}]` : ""}`;
}

// ── Alias: cómo el modelo se refiere a un bloque ──────────────────────────────

/**
 * Tabla alias → uuid, determinista por orden de recorrido (profundidad primero).
 *
 * Los UUIDs de BlockNote son de 36 chars. Un índice de 80 bloques serían ~3 KB de
 * ruido en el prompt de CADA turno, y el modelo tendría que copiarlos sin errar un
 * dígito. `n1`, `n2`… es lo mismo pero legible y barato, y es la convención que ya
 * usa el artefacto HTML (`nodeIndex`/`stampIds`), así que el protocolo `eb-patch`
 * no cambia de forma según el tipo de documento.
 *
 * Determinista importa: el mismo documento persistido produce la misma tabla en el
 * turno en que se le muestra al modelo y en el turno en que se resuelve su patch.
 */
export function aliasTable(blocks: DocBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  let n = 0;
  const walk = (list: DocBlock[]): void => {
    for (const b of list) {
      if (b?.id) map.set(`n${++n}`, b.id);
      if (b?.children?.length) walk(b.children);
    }
  };
  walk(blocks ?? []);
  return map;
}

/** Alias de un uuid (inverso de `aliasTable`), para logs y mensajes de fallo. */
export function aliasOf(blocks: DocBlock[], uuid: string): string | null {
  for (const [alias, id] of aliasTable(blocks)) if (id === uuid) return alias;
  return null;
}

/**
 * Resuelve lo que el modelo escribió en un `eb-patch` a un uuid real. Acepta el
 * alias (`n7`, lo normal) y también el uuid literal: si el modelo lo copió del
 * documento en vez de usar el alias, el patch debe aplicar igual — descartarlo
 * sería castigarlo por acertar de otra forma.
 */
export function resolveBlockId(blocks: DocBlock[], ref: string): string | null {
  const r = (ref || "").trim();
  if (!r) return null;
  const table = aliasTable(blocks);
  const byAlias = table.get(r);
  if (byAlias) return byAlias;
  for (const id of table.values()) if (id === r) return id;
  return null;
}

/**
 * Mapa del documento para el modelo: una línea por bloque con su alias y el inicio
 * de su texto. Es el equivalente de `nodeIndex()` del artefacto HTML — lo que hace
 * direccionable el documento sin volcárselo entero.
 */
export function blockIndex(blocks: DocBlock[], max = 80, snippet = 60): string {
  const table = aliasTable(blocks);
  const byId = new Map<string, DocBlock>();
  const collect = (list: DocBlock[]): void => {
    for (const b of list) {
      if (b?.id) byId.set(b.id, b);
      if (b?.children?.length) collect(b.children);
    }
  };
  collect(blocks ?? []);

  const lines: string[] = [];
  let n = 0;
  for (const [alias, id] of table) {
    if (n++ >= max) break;
    const b = byId.get(id);
    if (!b) continue;
    const txt = blockText(b);
    const cut = txt.length > snippet ? `${txt.slice(0, snippet)}…` : txt;
    // Un bloque sin texto (imagen, separador, tabla vacía) igual necesita su línea:
    // si no aparece, el modelo no puede insertar ni antes ni después de él.
    lines.push(`${alias} ${b.type ?? "?"}${cut ? `: ${cut}` : ""}`);
  }
  const total = table.size;
  if (total > max) lines.push(`… y ${total - max} bloques más`);
  return lines.join("\n");
}

// ── Navegación del árbol ──────────────────────────────────────────────────────

/**
 * Ruta a un bloque por uuid: la lista de índices desde la raíz. Devuelve null si
 * no está.
 *
 * Es una RUTA y no un índice plano porque los bloques anidan (una cláusula con sus
 * incisos, una columna). Aplanar el árbol para buscar haría imposible volver a
 * insertar en el lugar correcto.
 */
export function findBlockPath(blocks: DocBlock[], id: string): number[] | null {
  const walk = (list: DocBlock[], prefix: number[]): number[] | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b?.id === id) return [...prefix, i];
      if (b?.children?.length) {
        const hit = walk(b.children, [...prefix, i]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(blocks ?? [], []);
}

/**
 * El array que CONTIENE al bloque de una ruta, y su índice dentro de él. Es lo que
 * necesita un splice. Devuelve el array real (no una copia): quien llame ya trabaja
 * sobre un clon del árbol.
 */
export function containerAt(
  blocks: DocBlock[],
  path: number[],
): { list: DocBlock[]; index: number } | null {
  if (!path.length) return null;
  let list = blocks;
  for (let d = 0; d < path.length - 1; d++) {
    const next = list[path[d]]?.children;
    if (!Array.isArray(next)) return null;
    list = next;
  }
  const index = path[path.length - 1];
  return index >= 0 && index < list.length ? { list, index } : null;
}

/** Todos los uuids del árbol (para detectar colisiones al insertar). */
export function collectIds(blocks: DocBlock[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: DocBlock[]): void => {
    for (const b of list ?? []) {
      if (b?.id) out.add(b.id);
      if (b?.children?.length) walk(b.children);
    }
  };
  walk(blocks ?? []);
  return out;
}
