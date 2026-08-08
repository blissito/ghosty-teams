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
  const [workspace, rooms, docs] = await Promise.all([
    db.listWorkspaceMemory(),
    db.listAllRoomMemory(),
    db.listMemoryDocs(),
  ]);
  return {
    workspace,
    rooms,
    docs,
    limits: { maxNotes: db.WS_MEMORY_MAX_NOTES, maxChars: db.WS_MEMORY_MAX_CHARS, titleMax: db.WS_MEMORY_TITLE_MAX },
  };
});

function distillInstruction(docId: number): string {
  return (
    `Lee el documento adjunto y guarda lo importante en la memoria del workspace: ` +
    `memory_write con scope "workspace", un título corto por nota y source_doc: ${docId}. ` +
    `Destila hechos operativos (datos, formatos, reglas, contactos), no copies el texto. ` +
    `Si trae logos o lineamientos de marca (colores, tipografías), considera actualizar el brand kit con las tools brand_*.`
  );
}

async function pickAgentDm(userSub: string) {
  const db = await ready();
  const { resolvedAgents } = await import("../agents.server");
  const agent = (await resolvedAgents())[0];
  if (!agent) return null;
  const dmId = await db.openAgentDm(agent.handle, userSub);
  return { agent, dmId };
}

// Registra un documento soltado en /memory y abre el DM con el agente que lo va a
// destilar. El POSTEO del mensaje y el DISPARO del turno los hace el CLIENTE
// (postDmMessageFn + askDmAgentFn) — así el turno corre por el camino de siempre
// (bus, streaming, panel de turnos) sin duplicar nada aquí.
export const ingestMemoryDocFn = createServerFn({ method: "POST" })
  .validator((d: { fileId: string; name: string; mime?: string | null; size?: number | null }) => d)
  .handler(async ({ data }) => {
    const user = await requireMember();
    const db = await ready();
    const picked = await pickAgentDm(user.sub);
    if (!picked) return { ok: false as const, error: "este workspace no tiene ningún agente activo" };
    const docId = await db.addMemoryDoc({
      fileId: data.fileId,
      name: data.name,
      mime: data.mime ?? null,
      size: data.size ?? null,
      dmId: picked.dmId,
      uploadedBy: user.sub,
    });
    return { ok: true as const, docId, dmId: picked.dmId, agentHandle: picked.agent.handle, body: distillInstruction(docId) };
  });

// Reintentar la destilación de un doc que quedó sin notas (turno interrumpido, agente
// que no entendió, etc.). Devuelve lo mismo que la ingesta para que el cliente re-postee
// la instrucción con el MISMO adjunto y dispare el turno.
export const retryMemoryDocFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const user = await requireMember();
    const db = await ready();
    const doc = await db.getMemoryDoc(data.id);
    if (!doc) return { ok: false as const, error: "ese documento ya no está en la lista" };
    const picked = await pickAgentDm(user.sub);
    if (!picked) return { ok: false as const, error: "este workspace no tiene ningún agente activo" };
    return {
      ok: true as const,
      docId: doc.id,
      dmId: picked.dmId,
      agentHandle: picked.agent.handle,
      body: distillInstruction(doc.id),
      attachment: { fileId: doc.fileId, mime: doc.mime ?? "application/octet-stream", size: doc.size ?? 0, name: doc.name },
    };
  });

export const deleteMemoryDocFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireMember();
    const db = await ready();
    return { ok: await db.deleteMemoryDoc(data.id) };
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
