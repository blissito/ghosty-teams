// Comentarios de un documento, del lado de Teams.
//
// Los hilos viven dentro del Y.Doc, así que el único que los tiene completos y vivos es
// el sidecar. Aquí se decide QUIÉN puede tocarlos (el mismo `resolveDocRole` de siempre)
// y se le pide a él la operación por loopback. El sidecar no vuelve a preguntar: confía
// en el secreto compartido porque sólo escucha dentro de la VM.
//
// Existe por la ley agent-native: los comentarios son una conversación sobre el
// documento, y dejar a Ghosty fuera de ella —pudiendo escribir el documento entero— sería
// una capacidad a medias.

import type { DocRole } from "../db.server";

const BASE = (process.env.COLLAB_SIDECAR_HTTP_URL || "http://127.0.0.1:9400").replace(/\/$/, "");

export type DocThread = {
  id: string;
  resolved: boolean;
  resolvedBy: string | null;
  comments: Array<{ id: string; userId: string; createdAt: number | null; text: string; deleted: boolean }>;
};

async function sidecar(documentId: string, init: RequestInit): Promise<Record<string, unknown>> {
  const secret = process.env.COLLAB_SECRET;
  if (!secret) throw new Error("co-edición no configurada");
  const r = await fetch(`${BASE}/threads/${encodeURIComponent(documentId)}`, {
    ...init,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(body.error ?? `sidecar ${r.status}`));
  return body;
}

/** Permiso mínimo para tocar los hilos de un documento. `view` sólo lee. */
async function permiso(documentId: string, sub: string, minimo: "read" | "write"): Promise<DocRole> {
  const { resolveDocRole } = await import("./doc-access.server");
  const role = await resolveDocRole(documentId, { sub, isOwner: false });
  if (!role) throw new Error("sin acceso a ese documento");
  if (minimo === "write" && role === "view") throw new Error("sólo puedes leer ese documento");
  return role;
}

export async function listarHilos(documentId: string, sub: string): Promise<DocThread[]> {
  await permiso(documentId, sub, "read");
  const body = await sidecar(documentId, { method: "GET" });
  return (body.threads as DocThread[]) ?? [];
}

export async function responderHilo(
  documentId: string,
  sub: string,
  threadId: string,
  text: string
): Promise<{ commentId: string }> {
  await permiso(documentId, sub, "write");
  // El comentario queda firmado por la PERSONA en cuyo nombre corre el turno, no por un
  // "agente" genérico: en el hilo se ve quién pidió lo que Ghosty escribió.
  const body = await sidecar(documentId, {
    method: "POST",
    body: JSON.stringify({ op: "reply", threadId, text, userId: sub }),
  });
  return { commentId: String(body.commentId ?? "") };
}

export async function resolverHilo(
  documentId: string,
  sub: string,
  threadId: string,
  resolver: boolean
): Promise<void> {
  await permiso(documentId, sub, "write");
  await sidecar(documentId, {
    method: "POST",
    body: JSON.stringify({ op: resolver ? "resolve" : "unresolve", threadId, userId: sub }),
  });
}
