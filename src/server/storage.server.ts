import { createHash, createHmac, randomUUID } from "node:crypto";

// ── Storage propio (Tigris, S3-compatible) — sin dependencias ────────────────
// Reemplaza la Files API de EasyBits: hablamos S3 directo a NUESTRO bucket
// (`ghosty-teams`), firmando cada request con AWS SigV4 a mano (query-presign
// para GET/PUT/DELETE). Cero SDK → caja liviana. Ver memoria
// project_teams_own_storage: Tigris ahora, MinIO al escalar; misma interfaz.
//
// Visibilidad por-bucket (Tigris hace público a nivel bucket, no por-objeto):
//   privado  → `ghosty-teams`         (default; se sirve por proxy con signed URL)
//   público  → `ghosty-teams-public`  (URL directa, sin firma)
// "Transformar" = copiar el objeto entre buckets (download+upload, ver makePublic).

const ENDPOINT = (process.env.STORAGE_ENDPOINT ?? "https://t3.storage.dev").replace(/\/$/, "");
const REGION = process.env.STORAGE_REGION ?? "auto";
const SERVICE = "s3";
const ACCESS_KEY = process.env.TIGRIS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "";
const SECRET_KEY = process.env.TIGRIS_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
const BUCKET_PRIVATE = process.env.STORAGE_BUCKET ?? "ghosty-teams";
const BUCKET_PUBLIC = process.env.STORAGE_BUCKET_PUBLIC ?? "ghosty-teams-public";

export type Visibility = "private" | "public";

export function storageConfigured(): boolean {
  return !!(ACCESS_KEY && SECRET_KEY);
}
function requireCreds(): void {
  if (!storageConfigured())
    throw new Error("storage: faltan TIGRIS_ACCESS_KEY_ID / TIGRIS_SECRET_ACCESS_KEY");
}

// El host es path-style: t3.storage.dev/<bucket>/<key>. La firma va sobre ese host.
const HOST = new URL(ENDPOINT).host;

// URI-encode estilo AWS (RFC3986). `keepSlash` para el path canónico.
function uriEncode(str: string, keepSlash = false): string {
  let out = "";
  for (const ch of str) {
    // AWS: no-encode de A-Za-z0-9-_.~ ; sí encode de todo lo demás (incl. ! ' ( ) *
    // que encodeURIComponent deja pasar). `/` se preserva sólo en el path canónico.
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/" && keepSlash) out += "/";
    else out += encodeURIComponent(ch).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }
  return out;
}
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function amzDates(): { amzDate: string; dateStamp: string } {
  // 20260722T101112Z / 20260722
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}
function signingKey(dateStamp: string): Buffer {
  const kDate = hmac("AWS4" + SECRET_KEY, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

// Genera una URL presignada (query-auth) para method sobre bucket/key, válida ttl s.
function presign(method: "GET" | "PUT" | "DELETE", bucket: string, key: string, ttl: number): string {
  requireCreds();
  const { amzDate, dateStamp } = amzDates();
  const canonicalUri = "/" + uriEncode(bucket, true) + "/" + uriEncode(key, true);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const q: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${ACCESS_KEY}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(q[k])}`)
    .join("&");
  const canonicalHeaders = `host:${HOST}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(dateStamp)).update(stringToSign, "utf8").digest("hex");
  return `${ENDPOINT}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function bucketFor(v: Visibility): string {
  return v === "public" ? BUCKET_PUBLIC : BUCKET_PRIVATE;
}
// Prefijo que marca una key nuestra (Tigris) vs un id legacy de EasyBits.
const PREFIX = "t3/";
export function isOwnKey(id: string): boolean {
  return id.startsWith(PREFIX);
}
function newKey(fileName: string): string {
  const safe = (fileName || "file").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(-60);
  return `${PREFIX}${randomUUID()}-${safe}`;
}

// ── API pública (estilo Flystorage) ─────────────────────────────────────────

export interface PutResult {
  key: string;
  mime: string;
  size: number;
  name: string;
  visibility: Visibility;
}

// Sube bytes server-side (evita CORS browser→Tigris). Devuelve la `key` persistible.
export async function put(opts: {
  blob: Blob;
  contentType: string;
  fileName: string;
  visibility?: Visibility;
}): Promise<PutResult> {
  const visibility = opts.visibility ?? "private";
  const contentType = opts.contentType || "application/octet-stream";
  const key = newKey(opts.fileName);
  const url = presign("PUT", bucketFor(visibility), key, 300);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: opts.blob,
  });
  if (!res.ok) throw new Error(`storage PUT ${res.status}: ${await res.text().catch(() => "")}`);
  return { key, mime: contentType, size: opts.blob.size, name: opts.fileName, visibility };
}

// URL firmada de lectura (TTL en segundos). El proxy la re-mintea on-demand.
export function signedUrl(key: string, ttl = 3600, visibility: Visibility = "private"): string {
  return presign("GET", bucketFor(visibility), key, ttl);
}

// URL pública directa (sin firma) — sólo válida para objetos del bucket público.
export function publicUrl(key: string): string {
  return `${ENDPOINT}/${uriEncode(BUCKET_PUBLIC, true)}/${uriEncode(key, true)}`;
}

// Descarga los bytes (para inline base64 de media chico → el agente).
export async function getBytes(key: string, visibility: Visibility = "private"): Promise<Buffer | null> {
  try {
    const res = await fetch(signedUrl(key, 300, visibility));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Borra el objeto. 2xx/404 = ok.
export async function del(key: string, visibility: Visibility = "private"): Promise<boolean> {
  try {
    const res = await fetch(presign("DELETE", bucketFor(visibility), key, 300), { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// Transform público↔privado. Tigris no muta ACL por-objeto → copiamos entre
// buckets (download+reupload; volumen bajo). Devuelve la key nueva (misma key,
// distinto bucket) o null. NOTA: cuando pasemos a MinIO/AWS-ACLs esto será un
// PutObjectAcl in-place — misma firma de función, distinto driver.
export async function setVisibility(key: string, to: Visibility): Promise<boolean> {
  const from: Visibility = to === "public" ? "private" : "public";
  const bytes = await getBytes(key, from);
  if (!bytes) return false;
  const url = presign("PUT", bucketFor(to), key, 300);
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(bytes) });
  if (!res.ok) return false;
  await del(key, from).catch(() => false);
  return true;
}
