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

// "Editar" un artefacto office (.docx): EasyBits lo convierte a Documento editable
// (mammoth docx→html → Landing v4) y minteamos el editor colab embebible. Devuelve el
// embedUrl (que el panel abre como editor) o null si falla (ej. xlsx/pptx no soportados).
export async function officeToEditable(url: string, name?: string): Promise<CollabEmbed | null> {
  try {
    const res = await ebFetch(`/api/v2/documents/from-office`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, name }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; documentId?: string };
    if (!j.ok || !j.documentId) return null;
    return mintCollabEmbed({ documentId: j.documentId });
  } catch {
    return null;
  }
}

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
export type FileKind = "pdf" | "image" | "audio" | "video" | "office" | "file";

export type DetectedArtifact =
  | { type: "doc"; slug?: string; documentId?: string }
  | { type: "file"; url: string; kind: FileKind; fmt?: string };

// Clasifica un archivo crudo por su extensión → familia de render. Lo desconocido
// cae a "file" (card de descarga), nunca se pierde.
export function fileKindFromUrl(url: string): FileKind {
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i.test(url)) return "image";
  if (/\.pdf(\?|$)/i.test(url)) return "pdf";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)(\?|$)/i.test(url)) return "audio";
  if (/\.(mp4|webm|mov|m4v|mkv|avi)(\?|$)/i.test(url)) return "video";
  return "file";
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
    // La URL de upload_file NO trae extensión (`.../9i4`) → detectamos office por el
    // filename que el agente menciona en el texto (ej. "Oficio …docx"). Se previsualiza
    // con el visor Office Online (iframe) sin convertir.
    const off = reply.match(/\.(docx|xlsx|pptx|odt|doc|xls|ppt)\b/i);
    if (off) return { type: "file", url, kind: "office", fmt: off[1].toLowerCase() };
    return { type: "file", url, kind: fileKindFromUrl(url) };
  }
  return null;
}
