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
  const open = body.match(/```eb-(doc|sheet|artifact)([^\n]*)\n/);
  if (!open || open.index == null) return null;
  const kind = open[1] as EbDocKind;
  const fenceTitle = open[2]?.trim() || undefined;
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

// Texto de la burbuja del chat SIN el bloque (narración alrededor). Mientras streamea (no
// cerrado) deja un marcador para que el chat no muestre el markdown/csv crudo.
export function bubbleWithoutEbDoc(body: string): string {
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
