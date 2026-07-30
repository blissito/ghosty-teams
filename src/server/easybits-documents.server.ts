// Puente a los documentos de EasyBits para el artefacto colaborativo del room.
// Cuando @ghosty produce un doc, GTeams detecta su URL en el reply y llama a
// /api/v2/documents/collab-embed-link → recibe el editor colab embebible
// (/collab/document/:token?embed=1) que el panel abre en un iframe.
import { ebFetch } from "./easybits-files.server";

// Origen desde el que se sirve el room (para el CSP frame-ancestors del embed).
// El iframe del editor vive dentro de teams.formmy.app.
const GTEAMS_ORIGIN = process.env.GTEAMS_PUBLIC_ORIGIN ?? "https://teams.formmy.app";

export type CollabEmbed = { documentId: string; title: string | null; embedUrl: string };

// Mintea el link colab embebible de un doc EasyBits (por slug o documentId).
// Devuelve null si el doc no se resuelve o EasyBits rechaza.
export async function mintCollabEmbed(
  ref: { slug?: string; documentId?: string }
): Promise<CollabEmbed | null> {
  try {
    const res = await ebFetch(`/api/v2/documents/collab-embed-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ref, origin: GTEAMS_ORIGIN }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; documentId?: string; title?: string; embedUrl?: string };
    if (!j.ok || !j.embedUrl || !j.documentId) return null;
    return { documentId: j.documentId, title: j.title ?? null, embedUrl: j.embedUrl };
  } catch {
    return null;
  }
}

// Preview privado de un .docx → HTML (mammoth server-side en EasyBits). Devuelve el
// HTML crudo o null (ej. xlsx/pptx no soportados). El panel lo renderiza inline.
export async function officeToHtml(url: string): Promise<string | null> {
  try {
    const res = await ebFetch(`/api/v2/documents/office-to-html`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; html?: string };
    return j.ok && j.html ? j.html : null;
  } catch {
    return null;
  }
}

// Ya NO hay `mdToDocx`: el .docx se genera EN CASA desde los bloques con el exportador
// oficial de BlockNote (`doc-export.server.ts`). El camino viejo compilaba markdown allá y
// devolvía una URL para bajarla en un segundo salto — y por pasar por markdown perdía lo
// único que hacía falta: una tabla sin bordes para las firmas.

// Detecta un artefacto en el texto del reply del agente. Dos formas:
//   - DOC EasyBits (easybits.cloud/s/<slug> o <slug>.easybits.cloud) → co-edición
//     (se resuelve a link colab embebible vía mintCollabEmbed).
//   - ARCHIVO crudo (storage público t3.storage.dev / easybits-public) → visor
//     pdf/imagen directo en el panel (no editable, pero al menos se ve).
// Devuelve el primer match, o null. (Fase 2: parseo del reply; el objetivo
// posterior es que el fleet devuelva {reply, artifacts[]} estructurado.)
// Familias de media que el panel/card sabe renderizar. "file" = fallback genérico
// (descarga) para cualquier MIME/extensión no reconocida → cubre "archivos de todo
// tipo, no reconocidos, todo". Contrato: docs/AGENT-MEDIA-CONTRACT.md §2.
export type FileKind = "pdf" | "image" | "audio" | "video" | "office" | "html" | "file";

export type DetectedArtifact =
  | { type: "doc"; slug?: string; documentId?: string }
  | { type: "file"; url: string; kind: FileKind; fmt?: string; title?: string };

// Deriva un título SEMÁNTICO para la card SIN depender del idioma del usuario. Señales
// NEUTRAS (sirven para cualquier idioma):
//   1. Nombre de archivo mencionado en el texto (la extensión .docx/.xlsx/… es universal)
//      → se muestra sin la extensión (ej. "Contrato de arrendamiento").
//   2. Si no hay filename: el label del link markdown TAL CUAL (lo que el agente escribió,
//      en su idioma — no adivinamos ni recortamos verbos).
// Devuelve undefined si no hay nada mejor que el genérico.
function titleFromReply(reply: string, url: string): string | undefined {
  // 1) Filename con extensión de documento (Unicode-friendly, sin lista de palabras).
  const fn = reply.match(
    /([^\s"'`(){}[\]<>/:]{1,80}\.(docx|xlsx|pptx|pdf|odt|ods|odp|doc|xls|ppt|csv|txt|md))\b/i
  );
  if (fn) return fn[1].replace(/\.[a-z0-9]+$/i, "").trim() || undefined;
  // 2) Label del link que envuelve la URL, verbatim.
  const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = reply.match(new RegExp(`\\[([^\\]]{2,80})\\]\\(\\s*${esc}`));
  if (link) {
    const label = link[1].trim();
    if (label) return label;
  }
  return undefined;
}

// Clasifica un archivo crudo por su extensión → familia de render. Lo desconocido
// cae a "file" (card de descarga), nunca se pierde.
export function fileKindFromUrl(url: string): FileKind {
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i.test(url)) return "image";
  if (/\.pdf(\?|$)/i.test(url)) return "pdf";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)(\?|$)/i.test(url)) return "audio";
  if (/\.(mp4|webm|mov|m4v|mkv|avi)(\?|$)/i.test(url)) return "video";
  if (/\.x?html?(\?|$)/i.test(url)) return "html";
  return "file";
}

// Clasifica por CONTENT-TYPE (robusto): las URLs de upload_file NO traen extensión, y
// el reply no siempre menciona ".docx" → detectar por texto falla. Un HEAD al archivo
// da el mime real. Cubre "miles de tipos" por familia mime, no por adivinar.
function fileKindFromContentType(ct: string): FileKind | null {
  const t = ct.toLowerCase().split(";")[0].trim();
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  if (
    /(wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint|opendocument)/.test(t)
  )
    return "office";
  // HTML: el agente genera páginas/correos brandeados y los sube a storage SIN
  // extensión (.../fXA) → solo el content-type revela que es HTML. Sin esto cae a
  // "file" (card de descarga muerta) y el link inline se desvía al panel vacío.
  if (t === "text/html" || t === "application/xhtml+xml") return "html";
  return null;
}

// HEAD al archivo → kind por content-type real. Best-effort: si falla, null (el caller
// cae a la heurística por texto/URL). Rápido (solo headers).
export async function resolveFileKind(url: string): Promise<FileKind | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
    const ct = res.headers.get("content-type") || "";
    return fileKindFromContentType(ct);
  } catch {
    return null;
  }
}

export function detectArtifact(reply: string): DetectedArtifact | null {
  // 1a) URL del editor dash (create_document) → /documents/<id 24-hex>.
  const md = reply.match(/easybits\.cloud\/(?:dash\/)?documents\/(?:editor[^\s]*[?&]id=)?([a-f0-9]{24})/i);
  if (md) return { type: "doc", documentId: md[1] };
  // 1b) Doc desplegado (share URL con slug).
  const m1 = reply.match(/easybits\.cloud\/s\/([a-z0-9][a-z0-9-]*)/i);
  if (m1) return { type: "doc", slug: m1[1] };
  const m2 = reply.match(/https?:\/\/([a-z0-9][a-z0-9-]*)\.easybits\.cloud/i);
  if (m2 && !["www", "api", "sandboxes", "easybits-db"].includes(m2[1].toLowerCase())) {
    return { type: "doc", slug: m2[1] };
  }
  // 2) Archivo crudo en storage público → visor/descarga directo, clasificado por
  // extensión (imagen/pdf/audio/video/archivo). Cubre toda la superficie de media.
  const mf = reply.match(/https?:\/\/[^\s)]*(?:t3\.storage\.dev|easybits-public)[^\s)]*/i);
  if (mf) {
    const url = mf[0].replace(/[.,)]+$/, "");
    const title = titleFromReply(reply, url);
    // La URL de upload_file NO trae extensión (`.../9i4`) → detectamos office por el
    // filename que el agente menciona en el texto (ej. "Oficio …docx"). Se previsualiza
    // con nuestro visor propio (mammoth docx→HTML) sin convertir.
    const off = reply.match(/\.(docx|xlsx|pptx|odt|doc|xls|ppt)\b/i);
    if (off) return { type: "file", url, kind: "office", fmt: off[1].toLowerCase(), title };
    // PDF: la URL de upload_file NO trae extensión (`.../9i4`) → fileKindFromUrl cae a
    // "file" (card de descarga), y el HEAD (resolveFileKind) a veces falla → el visor no
    // renderizaba el PDF inline. Igual que con office (.docx), lo detectamos por el texto/
    // título (el agente dice "PDF"). resolveFileKind (HEAD) sigue teniendo prioridad en
    // chat.ts, así que si el content-type real difiere, gana el HEAD.
    let kind = fileKindFromUrl(url);
    if (kind === "file" && /\bpdf\b/i.test(`${reply} ${title ?? ""}`)) kind = "pdf";
    return { type: "file", url, kind, title };
  }
  return null;
}
