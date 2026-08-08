import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Server fns de la memoria del workspace (/memory).
// Lectura y escritura para CUALQUIER miembro (decidido 2026-08-08): es conocimiento del
// equipo y cualquiera corrige un hecho falso — igual que los brand kits. La escritura de
// los AGENTES no pasa por aquí (va por la tool memory_write, en native.server.ts).

async function ready() {
  const { ensureSchema } = await import("./schema.server");
  await ensureSchema().catch(() => {});
  return import("../db.server");
}

async function requireMember() {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  return user;
}

export const listWorkspaceMemoryFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireMember();
  const db = await ready();
  const [workspace, rooms] = await Promise.all([db.listWorkspaceMemory(), db.listAllRoomMemory()]);
  return {
    workspace,
    rooms,
    limits: { maxNotes: db.WS_MEMORY_MAX_NOTES, maxChars: db.WS_MEMORY_MAX_CHARS, titleMax: db.WS_MEMORY_TITLE_MAX },
  };
});

export type SaveWorkspaceNoteInput = { id?: number; title: string; note: string };

export const saveWorkspaceMemoryFn = createServerFn({ method: "POST" })
  .validator((d: SaveWorkspaceNoteInput) => d)
  .handler(async ({ data }) => {
    const user = await requireMember();
    const db = await ready();
    const title = data.title.trim().slice(0, db.WS_MEMORY_TITLE_MAX);
    const note = data.note.trim();
    if (!title || !note) return { ok: false as const, error: "faltan título o contenido" };
    if (note.length > db.WS_MEMORY_MAX_CHARS)
      return { ok: false as const, error: `máximo ${db.WS_MEMORY_MAX_CHARS} caracteres` };
    if (data.id) {
      const ok = await db.updateWorkspaceMemory(data.id, { title, note });
      return ok ? { ok: true as const, id: data.id } : { ok: false as const, error: "esa nota ya no existe" };
    }
    const existing = await db.listWorkspaceMemory();
    if (existing.length >= db.WS_MEMORY_MAX_NOTES)
      return { ok: false as const, error: `la memoria está llena (${db.WS_MEMORY_MAX_NOTES} notas)` };
    const id = await db.addWorkspaceMemory(title, note, user.sub, null);
    return { ok: true as const, id };
  });

export const deleteWorkspaceMemoryFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireMember();
    const db = await ready();
    return { ok: await db.deleteWorkspaceMemory(data.id) };
  });

// Borrar una nota de room desde la curaduría: hasta hoy sólo el agente podía olvidarlas.
export const deleteRoomMemoryFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; scopeKey: string; agentHandle: string }) => d)
  .handler(async ({ data }) => {
    await requireMember();
    const db = await ready();
    return { ok: await db.deleteAgentMemory(data.id, data.scopeKey, data.agentHandle) };
  });
