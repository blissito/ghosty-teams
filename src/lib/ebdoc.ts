// Protocolo del artefacto en vivo (OLA 2 — "Canvas"). El agente redacta el artefacto DENTRO
// de un bloque cercado en su respuesta y GTeams lo streamea al panel EN VIVO:
//   ```eb-doc      … ```  → documento de PROSA (Markdown)  → hoja tipo Word, export .docx
//   ```eb-sheet    … ```  → HOJA de cálculo (CSV)           → tabla, export .csv
//   ```eb-artifact … ```  → ARTEFACTO HTML interactivo      → iframe sandbox + publicado a S3
// Al terminar, GTeams lo commitea LOCAL (gc_artifacts.md = la verdad) y al MODIFICAR re-inyecta
// ese contenido al agente para que re-emita el artefacto COMPLETO (misma vía de streaming).
// Funciones PURAS: las usa el cliente (parseo en vivo) y el server (post-step + limpieza).

export type EbDocKind = "doc" | "sheet" | "artifact";

export type EbDoc = {
  kind: EbDocKind; // doc = markdown; sheet = csv; artifact = HTML autocontenido
  before: string; // texto antes del bloque (narración)
  md: string; // el contenido del artefacto (markdown | csv)
  after: string; // texto después del bloque (vacío mientras streamea)
  closed: boolean; // ¿ya llegó el ``` de cierre?
  fenceTitle?: string; // título opcional en la línea de apertura (```eb-sheet Nombre)
  /**
   * El agente declaró que esto es un documento NUEVO (```eb-artifact nuevo Título```),
   * no una versión del que ya hay en el hilo.
   *
   * Existe porque el default es lo contrario: re-emitir el fence completo es cómo se
   * edita un artefacto, así que sin esta marca todo lo que pidiera después caía como
   * versión del anterior — una propuesta comercial entró como "Versión 4" de una
   * comparativa de TTS y su enlace abría el documento equivocado.
   */
  isNew?: boolean;
};

// Extrae el bloque ```eb-doc``` o ```eb-sheet``` del texto. Tolera el fence ABIERTO (aún
// streameando, sin cierre) → toma todo lo que va después de la apertura como el contenido.
export function extractEbDoc(body: string): EbDoc | null {
  // El fence SOLO cuenta si abre una LÍNEA (^```eb-…) y su resto de línea no trae backtick.
  // Si no, la MENCIÓN del protocolo en prosa ("lo pongo en un bloque ```eb-artifact`, y la
  // plataforma lo renderiza…") abría el panel con la charla adentro (reportado 2026-07-25).
  const open = body.match(/(^|\n)```eb-(doc|sheet|artifact)([^\n`]*)\n/);
  if (!open || open.index == null) return null;
  const kind = open[2] as EbDocKind;
  // `nuevo` / `new` como PRIMERA palabra de la cabecera es una marca, no el título.
  const header = (open[3] ?? "").trim();
  const newMark = /^(nuevo|new)\b[:\s-]*/i.exec(header);
  const isNew = !!newMark;
  const fenceTitle = (newMark ? header.slice(newMark[0].length).trim() : header) || undefined;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) {
    return { kind, before: body.slice(0, open.index), md: rest, after: "", closed: false, fenceTitle, isNew };
  }
  return {
    kind,
    before: body.slice(0, open.index),
    md: rest.slice(0, closeIdx),
    after: rest.slice(closeIdx + 3),
    closed: true,
    fenceTitle,
    isNew,
  };
}

/**
 * ¿Este fence continúa el artefacto del hilo, o empieza otro?
 *
 * Re-emitir el fence completo es a la vez "edítalo" y "hazme otro", así que el server
 * tenía que adivinar y siempre adivinaba lo mismo: versión del anterior. Por eso una
 * propuesta comercial nueva aterrizó como "Versión 4" de una comparativa de TTS, y su
 * enlace compartido abría el documento equivocado.
 *
 * Tres señales, de la más fuerte a la más débil:
 * 1. el agente lo declaró (`nuevo` en la cabecera);
 * 2. cambió el TIPO (una hoja no es una versión de un HTML);
 * 3. para artefactos HTML, no comparte NI UN `data-id` con el actual. Una edición
 *    re-emite el mismo árbol —el agente recibió el documento ya estampado— así que
 *    cero coincidencias significa que esto es otro documento. Sólo se aplica cuando
 *    el actual tiene ids; si no los tiene, no hay señal y se conserva el default.
 */
export function isSameDocument(
  ebdoc: Pick<EbDoc, "kind" | "md" | "isNew">,
  current: { kind: EbDocKind; md: string } | null | undefined
): boolean {
  if (!current) return false;
  if (ebdoc.isNew) return false;
  if (ebdoc.kind !== current.kind) return false;
  if (ebdoc.kind !== "artifact") return true;
  const ids = (s: string) => new Set(Array.from(s.matchAll(/\bdata-id="([^"]+)"/g), (m) => m[1]));
  const cur = ids(current.md);
  const next = ids(ebdoc.md);
  // Hace falta que los DOS lados tengan ids para poder comparar. El agente escribe HTML
  // limpio y los `data-id` se los estampa el server AL PUBLICAR, así que una re-emisión
  // completa suele llegar sin uno solo: tomar eso por "documento distinto" partía el
  // artefacto en dos en cada edición grande y dejaba el enlace apuntando al primero.
  if (cur.size === 0 || next.size === 0) return true;
  for (const id of next) if (cur.has(id)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// eb-patch — EDICIÓN QUIRÚRGICA del artefacto HTML. En vez de re-emitir el documento
// entero para cambiar una tarjeta (40 KB de ida y 40 KB de vuelta, más la deriva de que
// el modelo "mejore" lo que nadie pidió), el agente manda SOLO el subárbol del nodo:
//
//   ```eb-patch a17
//   <div data-id="a17" class="…">…</div>
//   ```
//
// El id va en la CABECERA, no solo dentro del fragmento: mientras el fence está abierto
// todavía no llegó el atributo, y el panel necesita saber YA a qué nodo apunta para
// resaltarlo. Si el fragmento trae otro `data-id`, gana la cabecera (mismo criterio que
// `htmlToNode(html, keepId)` del canvas-editor).
// Las TRES operaciones mínimas sobre un árbol — nada específico de un artefacto concreto:
//   ```eb-patch  a17```           reemplaza el nodo a17 por el subárbol que trae el bloque
//   ```eb-remove a17```           lo quita (sin re-emitir a sus hermanos)
//   ```eb-insert a12 append```    inserta el subárbol; `pos` = append|prepend|before|after
//                                 (append/prepend cuelgan DENTRO de a12; before/after lo
//                                  ponen junto a a12, como hermano)
export type EbPatchOp = "replace" | "remove" | "insert";
export type EbInsertPos = "append" | "prepend" | "before" | "after";

export type EbPatch = {
  nodeId: string; // dirección: el nodo objetivo (o el ancla, en insert)
  html: string; // subárbol completo (outerHTML); "" en remove
  closed: boolean; // ¿llegó el ``` de cierre? (mientras no, sigue streameando)
  op?: EbPatchOp; // por defecto "replace"
  pos?: EbInsertPos; // solo en insert
  remove?: boolean; // atajo de compatibilidad para op === "remove"
};

const PATCH_OPEN = /(^|\n)```eb-(patch|insert)[ \t]+([^\n`]+)\n/g;
// Borrado explícito. Sin esto, quitar una tarjeta obligaba a re-emitir el nodo PADRE
// completo (un bloque vacío no se distingue de uno a medio escribir) — y el preview
// repintaba toda la rejilla, que es justo lo que la edición quirúrgica quiere evitar.
const REMOVE_LINE = /(^|\n)```eb-remove[ \t]+([^\n`]+)\n?```/g;

/**
 * Extrae TODOS los bloques ```eb-patch``` del body acumulado. Igual que `extractEbDoc`:
 * idempotente (se re-escanea el body entero en cada chunk; el llamador compara con lo ya
 * aplicado), tolerante al fence abierto, y el fence SOLO cuenta si abre línea — mencionarlo
 * en prosa no debe disparar nada (regresión sufrida el 2026-07-25 con eb-artifact).
 * Un patch sin id o con cuerpo vacío no existe: se descarta aquí y nunca llega a aplicarse.
 */
export function extractEbPatches(body: string): EbPatch[] {
  const out: EbPatch[] = [];
  REMOVE_LINE.lastIndex = 0;
  let r: RegExpExecArray | null;
  while ((r = REMOVE_LINE.exec(body))) {
    const nodeId = r[2].trim();
    if (nodeId) out.push({ nodeId, html: "", closed: true, op: "remove", remove: true });
  }
  PATCH_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATCH_OPEN.exec(body))) {
    const isInsert = m[2] === "insert";
    // En insert la cabecera es `<ancla> <posición>`; en patch, solo el id.
    const [nodeId, rawPos] = m[3].trim().split(/[ \t]+/);
    const pos = (["append", "prepend", "before", "after"] as const).includes(rawPos as EbInsertPos)
      ? (rawPos as EbInsertPos)
      : "append";
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const closeIdx = rest.indexOf("\n```");
    const html = closeIdx === -1 ? rest : rest.slice(0, closeIdx);
    if (nodeId && html.trim()) {
      out.push(
        isInsert
          ? { nodeId, html, closed: closeIdx !== -1, op: "insert", pos }
          : { nodeId, html, closed: closeIdx !== -1, op: "replace" }
      );
    }
    if (closeIdx === -1) break; // fence abierto → no hay nada más que parsear
    PATCH_OPEN.lastIndex = start + closeIdx;
  }
  return out;
}

/** Quita los bloques de patch del texto (para el bubble del chat). */
export function stripEbPatches(body: string): string {
  return body
    .replace(/(^|\n)```eb-(patch|insert)[ \t]+[^\n`]+\n[\s\S]*?(\n```|$)/g, "$1")
    .replace(/(^|\n)```eb-remove[ \t]+[^\n`]+\n?```/g, "$1")
    .trim();
}

// Título del artefacto. Prioriza el título del fence; si no, el primer heading markdown (doc)
// o la primera celda/columna (sheet); fallback genérico por tipo.
export function draftTitle(md: string, kind: EbDocKind = "doc", fenceTitle?: string): string {
  if (fenceTitle) return fenceTitle.slice(0, 80);
  if (kind === "artifact") {
    const t = md.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? md.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i)?.[1];
    return (t?.trim().slice(0, 80)) || "Artefacto";
  }
  if (kind === "sheet") {
    const first = md.trim().split("\n").find((l) => l.trim());
    const cell = first?.split(",")[0]?.replace(/^"|"$/g, "").trim();
    return (cell && cell.slice(0, 80)) || "Hoja de cálculo";
  }
  const h = md.match(/^#{1,6}\s+(.+)$/m);
  if (h) return h[1].trim().slice(0, 80);
  const first = md.trim().split("\n").find((l) => l.trim());
  const clean = first?.replace(/^[#>\-*\s]+/, "").trim();
  return (clean && clean.slice(0, 80)) || "Documento";
}

// ─────────────────────────────────────────────────────────────────────────────
// ask-user — artefacto INLINE de opciones clicables. El agente cierra el turno con
//   ```ask-user
//   {"question":"…","options":["A","B","C"]}
//   ```
// El surface lo detecta, quita el fence del bubble y pinta botones inline (un clic
// = enviar esa opción como respuesta). Agnóstico al modelo (texto puro): funciona
// igual para deepseek (ghosty-gc) y claude (claude-worker). Gemelo de extractEbDoc.

export type AskUser = {
  question: string; // pregunta (puede venir vacía → el bubble alrededor la cubre)
  options: string[]; // el texto de cada opción ES el body que se envía al elegirla
};

// Extrae el bloque ```ask-user``` (JSON {question, options[]}). Solo cuenta CERRADO y
// con al menos una opción válida — un fence a medio streamear no dispara la card.
export function extractAskUser(body: string): AskUser | null {
  const open = body.match(/```ask-user[^\n]*\n/);
  if (!open || open.index == null) return null;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // aún streameando → no pintamos card todavía
  const json = rest.slice(0, closeIdx).trim();
  try {
    const parsed = JSON.parse(json) as { question?: unknown; options?: unknown };
    const options = Array.isArray(parsed.options)
      ? parsed.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (!options.length) return null;
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    return { question, options: options.slice(0, 9) }; // cap 9 → teclas 1..9
  } catch {
    return null;
  }
}

// Texto de la burbuja SIN el bloque ask-user (narración alrededor). La pregunta se
// muestra dentro de la card, así que si no hay narración dejamos el bubble vacío.
export function stripAskUser(body: string): string {
  const open = body.match(/```ask-user[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// ── Nota de voz ────────────────────────────────────────────────────────────────
// El SDK del box (voice.mjs) sintetiza el audio, lo publica y emite un bloque
//   ```eb-audio\n{"url","waveform","durationMs","mime"}\n```
// que el agente incluye en su respuesta. El server lo parsea → re-sube el ogg a
// nuestro storage → adjunto audio (gc_attachments) → burbuja de nota de voz.
export type EbAudio = { url: string; waveform?: string; durationMs?: number; mime?: string };

export function extractEbAudio(body: string): EbAudio | null {
  const open = body.match(/```eb-audio[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // sólo al cerrar (el JSON debe estar completo)
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as EbAudio;
    if (!obj?.url || typeof obj.url !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

// Quita el bloque ```eb-audio``` de la burbuja (el audio se muestra como adjunto).
export function stripEbAudio(body: string): string {
  const open = body.match(/```eb-audio[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// ── Archivo generado (PDF, PNG, lo que sea) ───────────────────────────────────
// El SDK del box produce un archivo (render.mjs → PDF/PNG), lo publica y emite
//   ```eb-file\n{"url","name","mime","size"}\n```
// Mismo camino que eb-audio: el server lo descarga, lo re-sube a NUESTRO storage
// y lo adjunta → tarjeta de archivo con descarga.
//
// Existe porque un archivo ya generado no tenía bloque: al agente sólo le
// quedaba escribir un link en markdown, y `eb-doc` —lo único que daba tarjeta—
// exporta .docx, así que pedir "un PDF" devolvía Word.
//
// Que se vuelva adjunto no es sólo cosmético: deja de depender de que la URL
// publicada siga viva, y queda buscable y reenviable como cualquier otro archivo.
export type EbFile = { url: string; name?: string; mime?: string; size?: number; thumb?: string };

export function extractEbFile(body: string): EbFile | null {
  const open = body.match(/```eb-file[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // sólo al cerrar (el JSON debe estar completo)
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as EbFile;
    if (!obj?.url || typeof obj.url !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

/** Quita el bloque ```eb-file``` de la burbuja (el archivo se muestra como adjunto). */
export function stripEbFile(body: string): string {
  const open = body.match(/```eb-file[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

// Versión para RENDER (cliente): mientras el bloque ```eb-audio``` aún streamea (sin
// cierre), en vez de mostrar el JSON crudo pinta un placeholder; ya cerrado lo quita
// (el reproductor entra como adjunto). Tolera el fence a medio abrir (```eb-au…).

/**
 * Oculta un fence de apertura INCOMPLETO al final del cuerpo.
 *
 * Mientras el modelo escribe ```` ```eb-audio ```` el texto pasa por ```` ``` ````,
 * ```` ```e ````, ```` ```eb ````… y en esos instantes Markdown ve un bloque de
 * código ABIERTO y lo pinta como tal: un recuadro vacío que aparece y desaparece.
 * Los helpers por tipo (`bubbleWithoutEbAudio`, …) sólo cubren desde que el nombre
 * es reconocible, así que ese parpadeo se colaba igual.
 *
 * Esto es genérico a propósito: vale para eb-doc, eb-artifact, eb-file y para
 * cualquier bloque que se invente después. Sólo actúa sobre el fence FINAL sin
 * cerrar — un bloque de código legítimo del agente (ya cerrado) no se toca.
 */
export function hideDanglingFence(body: string): string {
  // Fence al final SIN newline todavía: aún se está escribiendo su nombre.
  const dangling = body.match(/\n?```[a-zA-Z0-9-]*$/);
  if (!dangling || dangling.index == null) return body;
  // ¿Éste ABRE un bloque a medio escribir, o CIERRA uno ya completo? Al final del
  // texto los dos se ven igual, y lo decide la PARIDAD de fences: impar → éste abre y
  // no tiene cierre (se oculta); par → éste ES el cierre, y quitarlo deja el bloque
  // abierto para siempre.
  //
  // Sin esta comprobación, un reply que termina exactamente en el fence de cierre
  // (sin salto final — el caso normal) perdía ese cierre, así que `extractEbPatches`
  // lo leía como abierto y el bubble se quedaba en "🩹 Ajustando el artefacto…" para
  // siempre. Lo grave no es el marcador optimista: es que un patch FALLIDO nunca
  // llegaba a anunciarse, que es justo la disciplina de fallo VISIBLE.
  const fences = (body.match(/(^|\n)```/g) ?? []).length;
  if (fences % 2 === 0) return body;
  return body.slice(0, dangling.index).trimEnd();
}

export function bubbleWithoutEbAudio(body: string): string {
  const open = body.match(/```eb-audio[^\n]*(\n|$)/);
  if (!open || open.index == null) {
    // ¿fence a medio escribir mientras streamea? (```eb-a … sin newline aún)
    const partial = body.match(/```eb-a[a-z-]*$/);
    if (partial && partial.index != null) {
      const before = body.slice(0, partial.index).trim();
      return [before, "🎙️ Grabando la nota de voz…"].filter(Boolean).join("\n\n");
    }
    return body;
  }
  const before = body.slice(0, open.index).trim();
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) {
    return [before, "🎙️ Grabando la nota de voz…"].filter(Boolean).join("\n\n");
  }
  const after = rest.slice(closeIdx + 3).trim();
  return [before, after].filter(Boolean).join("\n\n");
}

// ── Estado de tools (checklist estilo Claude Code) ───────────────────────────────
// El server emite el estado de las herramientas del turno como un bloque cercado al
// INICIO del body:  ```gt-tools\n{"tools":[{label,status,n?}]}\n```  . El cliente lo
// parsea → burbuja ToolGroup colapsable; el resto del body es prosa. Se re-emite entero
// en cada paint (siempre cerrado) → el cliente ve un bloque completo en cada update.
export type ToolStatus = "running" | "done" | "error";
export type ToolState = { label: string; status: ToolStatus; n?: number; detail?: string };

export function extractToolState(body: string): ToolState[] | null {
  const open = body.match(/```gt-tools[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // JSON a medio streamear → espera al cierre
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as { tools?: unknown };
    if (!Array.isArray(obj.tools)) return null;
    const tools = (obj.tools as ToolState[]).filter((t) => t && typeof t.label === "string" && !!t.status);
    return tools.length ? tools : null;
  } catch {
    return null;
  }
}

// ── Pasos de la narración ────────────────────────────────────────────────────────
// Lo que el agente va contando ENTRE tools ("saco el brandkit", "ya tengo la
// paleta") son pasos del trabajo, no la respuesta. Concatenados se leían como un
// párrafo corrido donde nada se distingue; el server los manda aparte en
// ```gt-steps\n{"steps":["…"]}\n``` y el chat los pinta con palomita.
//
// El ÚLTIMO segmento NO va acá: ése es la respuesta y se queda como prosa. Si
// entrara a la lista, la respuesta final quedaría disfrazada de paso.
export function extractSteps(body: string): string[] | null {
  const open = body.match(/```gt-steps[^\n]*\n/);
  if (!open || open.index == null) return null;
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return null; // a medio streamear
  try {
    const obj = JSON.parse(rest.slice(0, closeIdx).trim()) as { steps?: unknown };
    if (!Array.isArray(obj.steps)) return null;
    const steps = (obj.steps as string[]).filter((x) => typeof x === "string" && x.trim());
    return steps.length ? steps : null;
  } catch {
    return null;
  }
}

export function stripStepsBlock(body: string): string {
  const open = body.match(/```gt-steps[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return (before + after).replace(/^\s+/, "");
}

// Quita el bloque ```gt-tools``` del body (el estado se muestra como burbuja, no como texto).
export function stripToolBlock(body: string): string {
  const open = body.match(/```gt-tools[^\n]*\n/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index);
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  const after = closeIdx === -1 ? "" : rest.slice(closeIdx + 3);
  return (before + after).replace(/^\s+/, "");
}

// Texto de la burbuja del chat SIN el bloque (narración alrededor). Mientras streamea (no
// cerrado) deja un marcador para que el chat no muestre el markdown/csv crudo.

/**
 * Igual que `bubbleWithoutEbAudio` pero para archivos: mientras el bloque
 * ```eb-file``` streamea, en vez del JSON crudo deja un marcador; ya cerrado lo
 * quita (el archivo entra como adjunto).
 */
export function bubbleWithoutEbFile(body: string): string {
  const open = body.match(/```eb-file[^\n]*(\n|$)/);
  if (!open || open.index == null) return body;
  const before = body.slice(0, open.index).trim();
  const rest = body.slice(open.index + open[0].length);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) return [before, "📎 Preparando el archivo…"].filter(Boolean).join("\n\n");
  const after = rest.slice(closeIdx + 3).trim();
  return [before, after].filter(Boolean).join("\n\n");
}

export function bubbleWithoutEbDoc(body: string, patchOutcome?: { applied: number; failed: string[] }): string {
  // Primero saca el bloque de estado de tools (se pinta como burbuja) y la nota de voz.
  body = stripToolBlock(body);
  body = stripStepsBlock(body);
  body = bubbleWithoutEbAudio(body);
  body = bubbleWithoutEbFile(body);
  // Al final de todo: si quedó un fence a medio abrir (el modelo aún escribe el
  // nombre del bloque), fuera — si no, Markdown lo pinta como recuadro vacío.
  body = hideDanglingFence(body);
  // Patches quirúrgicos: fuera del bubble (nunca HTML crudo en el chat) con su propio
  // marcador. Van antes que eb-doc porque un turno puede traer patches y nada más.
  const patches = extractEbPatches(body);
  if (patches.length) {
    const around = stripEbPatches(body);
    const done = patches.every((p) => p.closed);
    // Con el resultado REAL (lo sabe el server tras aplicar) el marcador dice la verdad:
    // nada de "✅ actualizado" seguido de "⚠️ no pude aplicar" en el mismo mensaje.
    let mark: string;
    if (!done) mark = "🩹 Ajustando el artefacto…";
    else if (!patchOutcome) mark = `✅ Artefacto actualizado — ${patches.length} ajuste${patches.length > 1 ? "s" : ""}`;
    else if (patchOutcome.applied === 0)
      mark = `⚠️ No pude aplicar el ajuste (${patchOutcome.failed.join(", ")}). Pídemelo otra vez y regenero el artefacto completo.`;
    else if (patchOutcome.failed.length)
      mark =
        `✅ Artefacto actualizado — ${patchOutcome.applied} de ${patchOutcome.applied + patchOutcome.failed.length} ajustes` +
        ` (no aplicó: ${patchOutcome.failed.join(", ")})`;
    else mark = `✅ Artefacto actualizado — ${patchOutcome.applied} ajuste${patchOutcome.applied > 1 ? "s" : ""}`;
    return around ? `${around}\n\n${mark}` : mark;
  }
  const doc = extractEbDoc(body);
  if (!doc) return body;
  const around = [doc.before.trim(), doc.after.trim()].filter(Boolean).join("\n\n");
  if (doc.closed) {
    const ready = doc.kind === "sheet" ? "📊 Hoja lista" : doc.kind === "artifact" ? "🎨 Artefacto listo" : "📄 Documento listo";
    return around || `${ready} — ábrelo en el panel.`;
  }
  const writing =
    doc.kind === "sheet" ? "📊 Generando la hoja…" : doc.kind === "artifact" ? "🎨 Generando el artefacto…" : "✍️ Redactando el documento…";
  return around ? `${around}\n\n${writing}` : writing;
}
