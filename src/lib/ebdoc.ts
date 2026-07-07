// Protocolo del artefacto en vivo (OLA 2 — "Canvas"). El agente redacta un documento
// de prosa como Markdown DENTRO de un bloque cercado ```eb-doc … ``` en su respuesta.
// GTeams lo streamea al panel (draft), lo quita de la burbuja del chat, y al terminar
// compila ese mismo Markdown a un .docx (endpoint md-to-docx). Funciones PURAS: las usa
// tanto el cliente (parseo en vivo) como el server (post-step + limpieza del body).

export type EbDoc = {
  before: string; // texto antes del bloque (narración)
  md: string; // el markdown del documento
  after: string; // texto después del bloque (vacío mientras streamea)
  closed: boolean; // ¿ya llegó el ``` de cierre?
};

// Extrae el bloque ```eb-doc del texto. Tolera el fence ABIERTO (aún streameando, sin
// cierre) → toma todo lo que va después de la apertura como el markdown del doc.
export function extractEbDoc(body: string): EbDoc | null {
  const open = body.match(/```eb-doc[^\n]*\n/);
  if (!open || open.index == null) return null;
  const start = open.index + open[0].length;
  const rest = body.slice(start);
  const closeIdx = rest.indexOf("```");
  if (closeIdx === -1) {
    return { before: body.slice(0, open.index), md: rest, after: "", closed: false };
  }
  return {
    before: body.slice(0, open.index),
    md: rest.slice(0, closeIdx),
    after: rest.slice(closeIdx + 3),
    closed: true,
  };
}

// Título del doc: primer heading markdown, o primera línea no vacía. Fallback genérico.
export function draftTitle(md: string): string {
  const h = md.match(/^#{1,6}\s+(.+)$/m);
  if (h) return h[1].trim().slice(0, 80);
  const first = md.trim().split("\n").find((l) => l.trim());
  const clean = first?.replace(/^[#>\-*\s]+/, "").trim();
  return (clean && clean.slice(0, 80)) || "Documento";
}

// Texto de la burbuja del chat SIN el bloque eb-doc (narración alrededor). Mientras
// streamea (no cerrado) deja un marcador para que el chat no muestre el markdown crudo.
export function bubbleWithoutEbDoc(body: string): string {
  const doc = extractEbDoc(body);
  if (!doc) return body;
  const around = [doc.before.trim(), doc.after.trim()].filter(Boolean).join("\n\n");
  if (doc.closed) return around || "📄 Documento listo — ábrelo en el panel.";
  return around ? `${around}\n\n✍️ Redactando el documento…` : "✍️ Redactando el documento…";
}
