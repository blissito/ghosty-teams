// Ticket de co-edición: quién eres y qué puedes hacer en UN documento, firmado.
//
// Es lo que reemplaza al share token de EasyBits. GTeams lo mintea (ya tiene la sesión y
// resuelve el rol con `resolveDocRole`) y el sidecar Hocuspocus lo VERIFICA localmente con
// el mismo secreto: firma + expiración + que el documento del ticket sea el room que se
// está abriendo. Sin llamada HTTP por conexión — el sync server no necesita saber de
// documentos, sólo comprobar una firma.
//
// El ROL viaja firmado dentro del ticket, así que el cliente no puede subirse de `view` a
// `edit` tocando el payload. En Yjs esto importa: el solo-lectura tiene que aplicarse en el
// servidor porque el cliente siempre puede intentar escribir.
//
// Formato: <payloadB64Url>.<sigB64Url> (HMAC-SHA256). No es JWT: no hay negociación de
// algoritmo, así que no existe el ataque de `alg:none`.
import crypto from "node:crypto";
import type { DocRole } from "../db.server";

export type CollabTicket = {
  /** documentId — el room. */
  doc: string;
  sub: string;
  name: string;
  avatar: string;
  color: string;
  role: DocRole;
  /** epoch en segundos. */
  exp: number;
};

const TTL_SEC = 12 * 3600;

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function secret(): string {
  const s = process.env.COLLAB_SECRET;
  // Lazy: leer el env al usarlo, no al importar el módulo (un throw a nivel de import
  // rompe el prerender del build).
  if (!s) throw new Error("COLLAB_SECRET no configurado");
  return s;
}

function sign(payload: string): string {
  return b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
}

export function mintCollabTicket(t: Omit<CollabTicket, "exp">, ttlSec = TTL_SEC): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ ...t, exp: Math.floor(Date.now() / 1000) + ttlSec }))
  );
  return `${payload}.${sign(payload)}`;
}

/** `null` si la firma no cuadra, expiró o el ticket no es de este documento. */
export function verifyCollabTicket(token: string, doc?: string): CollabTicket | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;

  const expected = sign(payload);
  // timingSafeEqual exige mismo largo; distinto largo ya es firma inválida.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let t: CollabTicket;
  try {
    t = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!t?.doc || !t.exp || t.exp < Math.floor(Date.now() / 1000)) return null;
  if (doc && String(t.doc) !== String(doc)) return null;
  return t;
}
