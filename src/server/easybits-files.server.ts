import { getConfig, setConfig } from "../config.server";

// ── Storage EasyBits (Files API v2) — adjuntos de chat ──────────────────────
// Espejo del contrato ya probado en Formmy (server/integrations/whatsapp/
// easybits-upload.ts). Flujo: init (pide PUT firmado) → PUT bytes a Tigris →
// GET :id (re-mintea readUrl firmado, TTL ~1h). Los objetos son `private`: se
// sirven SOLO vía el proxy autenticado (/api/attachment/:id), que re-firma el
// readUrl on-demand — así nunca guardamos una URL que expira ni exponemos storage
// público. Guardamos únicamente el `fileId` en gc_attachments.
//
// Token: preferimos el `eb_access_token` del owner (ya conectó su cuenta EasyBits)
// y caemos a EASYBITS_API_KEY (key global de la plataforma, el path que Formmy usa).
const EB = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";

interface InitResponse {
  file: { id: string; url: string };
  putUrl: string;
}
interface GetResponse {
  id: string;
  url: string;
  readUrl: string;
}

async function currentToken(): Promise<string | null> {
  const owner = await getConfig("eb_access_token");
  return owner || process.env.EASYBITS_API_KEY || null;
}

// Refresca el access token del owner con el refresh_token (OAuth). Best-effort:
// si algo falta o falla, devuelve null y el caller cae al token vigente/global.
async function refreshOwnerToken(): Promise<string | null> {
  const [refresh, clientId, clientSecret] = await Promise.all([
    getConfig("eb_refresh_token"),
    getConfig("eb_client_id"),
    getConfig("eb_client_secret"),
  ]);
  if (!refresh || !clientId || !clientSecret) return null;
  try {
    const res = await fetch(`${EB}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { access_token: string; refresh_token?: string };
    await setConfig("eb_access_token", j.access_token);
    if (j.refresh_token) await setConfig("eb_refresh_token", j.refresh_token);
    return j.access_token;
  } catch {
    return null;
  }
}

// fetch a EasyBits con Bearer. Escalera ante 401: (1) refresca el token del owner
// y reintenta (los OAuth caducan); (2) si sigue 401, cae al EASYBITS_API_KEY
// global (por si el scope "mcp" del owner no cubre Files) — el path probado de Formmy.
async function ebFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await currentToken();
  if (!token) throw new Error("easybits: sin token (ni eb_access_token ni EASYBITS_API_KEY)");
  const call = (tk: string) =>
    fetch(`${EB}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tk}` } });

  let res = await call(token);
  if (res.status === 401) {
    const fresh = await refreshOwnerToken();
    if (fresh && fresh !== token) res = await call(fresh);
  }
  if (res.status === 401) {
    const global = process.env.EASYBITS_API_KEY;
    if (global && global !== token) res = await call(global);
  }
  return res;
}

export interface UploadedFile {
  fileId: string;
  mime: string;
  size: number;
  name: string;
}

// Sube un Blob (el File de la request es un Blob): init → PUT a Tigris. Devuelve
// el fileId persistible. Server-side (los bytes pasan por la VM) para evitar CORS
// browser→Tigris.
export async function uploadToEasyBits(opts: {
  blob: Blob;
  contentType: string;
  fileName: string;
}): Promise<UploadedFile> {
  const contentType = opts.contentType || "application/octet-stream";
  const size = opts.blob.size;
  const initRes = await ebFetch(`/api/v2/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: opts.fileName || `file-${Date.now()}`,
      contentType,
      size,
      access: "private",
      source: "ghosty-chat",
    }),
  });
  if (!initRes.ok) throw new Error(`easybits init ${initRes.status}: ${await initRes.text().catch(() => "")}`);
  const init = (await initRes.json()) as InitResponse;

  const putRes = await fetch(init.putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: opts.blob,
  });
  if (!putRes.ok) throw new Error(`easybits PUT ${putRes.status}: ${await putRes.text().catch(() => "")}`);

  return { fileId: init.file.id, mime: contentType, size, name: opts.fileName };
}

// Re-firma un readUrl (TTL ~1h) para servir un objeto ya subido. El proxy lo
// llama on-demand por cada render de adjunto.
export async function mintReadUrl(fileId: string): Promise<string | null> {
  if (!fileId) return null;
  try {
    const res = await ebFetch(`/api/v2/files/${encodeURIComponent(fileId)}`, { method: "GET" });
    if (!res.ok) return null;
    const j = (await res.json()) as GetResponse;
    return j.readUrl || null;
  } catch {
    return null;
  }
}

// Borra un objeto (al eliminar un mensaje con adjuntos). 2xx o 404 = ok.
export async function deleteEasyBitsFile(fileId: string): Promise<boolean> {
  if (!fileId) return false;
  try {
    const res = await ebFetch(`/api/v2/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
