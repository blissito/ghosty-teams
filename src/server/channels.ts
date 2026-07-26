import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// CRUD de Rooms + miembros (privados). Auth: creador u owner.

export const createChannelFn = createServerFn({ method: "POST" })
  .validator((d: { name: string; description?: string; icon?: string; isPrivate: boolean }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("no autenticado");
    const name = data.name.trim();
    if (!name) throw new Error("nombre requerido");
    const db = await import("../db.server");
    const ch = await db.createChannel({
      name,
      description: data.description?.trim() || undefined,
      icon: data.icon,
      isPrivate: data.isPrivate,
      createdBy: user.sub,
    });
    return ch;
  });

async function requireManage(slug: string) {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const db = await import("../db.server");
  const ch = await db.getChannel(slug);
  if (!ch) throw new Error("room no encontrado");
  if (!user.isOwner && ch.created_by !== user.sub) throw new Error("solo el creador u owner");
  return { db, ch, user };
}

export const updateChannelFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      slug: string;
      name?: string;
      icon?: string | null;
      isPrivate?: boolean;
      description?: string | null;
      archived?: boolean;
    }) => d
  )
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    await db.updateChannel(ch.id, {
      name: data.name,
      icon: data.icon,
      isPrivate: data.isPrivate,
      description: data.description,
      archived: data.archived,
    });
    return { ok: true as const };
  });

export const deleteChannelFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    await db.deleteChannel(ch.id);
    return { ok: true as const };
  });

export const getChannelMembersFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    return db.listChannelMembersInfo(ch.id);
  });

// Quién está en ESTE room, para cualquiera que pueda VER el room (patrón Slack/Discord:
// la lista de miembros no es información administrativa). Deliberadamente NO pasa por
// requireManage — ese gate es para MUTAR (add/remove), y usarlo aquí dejaba a un member
// sin poder ver con quién comparte el canal. Devuelve solo datos de DISPLAY: nada de
// email (eso sí es del panel de administración).
export const listRoomMembersFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("no autenticado");
    const db = await import("../db.server");
    const ch = await db.getChannel(data.slug);
    if (!ch) throw new Error("room no encontrado");
    if (!(await db.canSeeChannel(ch, user.sub, user.isOwner))) throw new Error("no autorizado");
    const roster = await db.listRoomRoster(ch);
    return {
      // `derived` = room público: la lista sale de quién ha participado, no de una
      // membresía real. La UI lo rotula distinto para no mentir.
      derived: ch.is_private === 0,
      members: roster.map((m) => ({ sub: m.sub, name: m.name, avatar: m.avatar })),
    };
  });

// Usuarios del workspace (para elegir miembro existente al invitar, estilo Slack).
export const listWorkspaceUsersFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const users = await import("../users.server");
  return users.listUsers();
});

export const addChannelMemberFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; email: string }) => d)
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    const sub = await db.getUserSubByEmail(data.email);
    if (!sub) throw new Error("ese usuario aún no ha entrado a Ghosty Teams");
    await db.addChannelMember(ch.id, sub);
    return { ok: true as const };
  });

export const removeChannelMemberFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; sub: string }) => d)
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    await db.removeChannelMember(ch.id, data.sub);
    return { ok: true as const };
  });
