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

// Detecta una URL de documento EasyBits en el texto del reply del agente y
// extrae su slug. Reconoce www.easybits.cloud/s/<slug>/ y <slug>.easybits.cloud.
// Devuelve el primer match, o null. (Fase 2: parseo del reply; el objetivo
// posterior es que el fleet devuelva {reply, artifacts[]} estructurado.)
export function detectDocRef(reply: string): { slug: string } | null {
  // www.easybits.cloud/s/<slug>/  (share URL de un doc desplegado)
  const m1 = reply.match(/easybits\.cloud\/s\/([a-z0-9][a-z0-9-]*)/i);
  if (m1) return { slug: m1[1] };
  // <slug>.easybits.cloud  (subdominio; excluir www/api/sandboxes/otros conocidos)
  const m2 = reply.match(/https?:\/\/([a-z0-9][a-z0-9-]*)\.easybits\.cloud/i);
  if (m2 && !["www", "api", "sandboxes", "easybits-db"].includes(m2[1].toLowerCase())) {
    return { slug: m2[1] };
  }
  return null;
}
