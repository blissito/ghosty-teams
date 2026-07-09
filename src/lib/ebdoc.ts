// Protocolo del artefacto en vivo (OLA 2 — "Canvas"). El agente redacta el artefacto DENTRO
// de un bloque cercado en su respuesta y GTeams lo streamea al panel EN VIVO:
//   ```eb-doc   … ```  → documento de PROSA (Markdown)   → hoja tipo Word, export .docx
//   ```eb-sheet … ```  → HOJA de cálculo (CSV)            → tabla, export .csv
// Al terminar, GTeams lo commitea LOCAL (gc_artifacts.md = la verdad) y al MODIFICAR re-inyecta
// ese contenido al agente para que re-emita el artefacto COMPLETO (misma vía de streaming).
// Funciones PURAS: las usa el cliente (parseo en vivo) y el server (post-step + limpieza).

export type EbDocKind = "doc" | "sheet";

export type EbDoc = {
  kind: EbDocKind; // doc = markdown; sheet = csv
  before: string; // texto antes del bloque (narración)
  md: string; // el contenido del artefacto (markdown | csv)
  after: string; // texto después del bloque (vacío mientras streamea)
  closed: boolean; // ¿ya llegó el ``` de cierre?
  fenceTitle?: string; // título opcional en la línea de apertura (```eb-sheet Nombre)
};

// Extrae el bloque ```eb-doc``` o ```eb-sheet``` del texto. Tolera el fence ABIERTO (aún
// streameando, sin cierre) → toma todo lo que va después de la apertura como el contenido.
export function extractEbDoc(body: string): EbDoc | null {
  const open = body.match(/```eb-(doc|sheet)([^\n]*)\n/);
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

// Texto de la burbuja del chat SIN el bloque (narración alrededor). Mientras streamea (no
// cerrado) deja un marcador para que el chat no muestre el markdown/csv crudo.
export function bubbleWithoutEbDoc(body: string): string {
  const doc = extractEbDoc(body);
  if (!doc) return body;
  const around = [doc.before.trim(), doc.after.trim()].filter(Boolean).join("\n\n");
  if (doc.closed) {
    const ready = doc.kind === "sheet" ? "📊 Hoja lista" : "📄 Documento listo";
    return around || `${ready} — ábrelo en el panel.`;
  }
  const writing = doc.kind === "sheet" ? "📊 Generando la hoja…" : "✍️ Redactando el documento…";
  return around ? `${around}\n\n${writing}` : writing;
}
