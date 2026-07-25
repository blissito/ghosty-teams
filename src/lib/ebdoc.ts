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
  const fenceTitle = open[3]?.trim() || undefined;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) {
    return { kind, before: body.slice(0, open.index), md: rest, after: "", closed: false, fenceTitle };
  }
  return {
    kind,
    before: body.slice(0, open.index),
    md: rest.slice(0, closeIdx),
    after: rest.slice(closeIdx + 3),
    closed: true,
    fenceTitle,
  };
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
export type EbPatch = {
  nodeId: string; // dirección: el `data-id` del nodo a reemplazar
  html: string; // subárbol completo (outerHTML) ya con el cambio
  closed: boolean; // ¿llegó el ``` de cierre? (mientras no, sigue streameando)
};

const PATCH_OPEN = /(^|\n)```eb-patch[ \t]+([^\n`]+)\n/g;

/**
 * Extrae TODOS los bloques ```eb-patch``` del body acumulado. Igual que `extractEbDoc`:
 * idempotente (se re-escanea el body entero en cada chunk; el llamador compara con lo ya
 * aplicado), tolerante al fence abierto, y el fence SOLO cuenta si abre línea — mencionarlo
 * en prosa no debe disparar nada (regresión sufrida el 2026-07-25 con eb-artifact).
 * Un patch sin id o con cuerpo vacío no existe: se descarta aquí y nunca llega a aplicarse.
 */
export function extractEbPatches(body: string): EbPatch[] {
  const out: EbPatch[] = [];
  PATCH_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATCH_OPEN.exec(body))) {
    const nodeId = m[2].trim();
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const closeIdx = rest.indexOf("\n```");
    const html = closeIdx === -1 ? rest : rest.slice(0, closeIdx);
    if (nodeId && html.trim()) out.push({ nodeId, html, closed: closeIdx !== -1 });
    if (closeIdx === -1) break; // fence abierto → no hay nada más que parsear
    PATCH_OPEN.lastIndex = start + closeIdx;
  }
  return out;
}

/** Quita los bloques de patch del texto (para el bubble del chat). */
export function stripEbPatches(body: string): string {
  return body.replace(/(^|\n)```eb-patch[ \t]+[^\n`]+\n[\s\S]*?(\n```|$)/g, "$1").trim();
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

// Versión para RENDER (cliente): mientras el bloque ```eb-audio``` aún streamea (sin
// cierre), en vez de mostrar el JSON crudo pinta un placeholder; ya cerrado lo quita
// (el reproductor entra como adjunto). Tolera el fence a medio abrir (```eb-au…).
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
export function bubbleWithoutEbDoc(body: string): string {
  // Primero saca el bloque de estado de tools (se pinta como burbuja) y la nota de voz.
  body = stripToolBlock(body);
  body = bubbleWithoutEbAudio(body);
  // Patches quirúrgicos: fuera del bubble (nunca HTML crudo en el chat) con su propio
  // marcador. Van antes que eb-doc porque un turno puede traer patches y nada más.
  const patches = extractEbPatches(body);
  if (patches.length) {
    const around = stripEbPatches(body);
    const done = patches.every((p) => p.closed);
    const mark = done
      ? `✅ Artefacto actualizado — ${patches.length} ajuste${patches.length > 1 ? "s" : ""}`
      : "🩹 Ajustando el artefacto…";
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
