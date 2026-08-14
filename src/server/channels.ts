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

// ── Salas de evento ──────────────────────────────────────────────────────────
// Convierte un room en la puerta de un evento abierto: webinar (la gente entra a
// escuchar) o taller (entra con voz). Sólo el creador o el owner.
//
// ⚠️ Encender esto abre el room a INTERNET, que es una frontera distinta de la
// que ya conocía el producto (`is_private = 0` = "todo el workspace"). Por eso es
// una acción aparte y explícita, y no una casilla más del formulario de room.

const EVENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,48}$/;

export const setChannelEventFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      slug: string;
      mode?: "webinar" | "taller" | null;
      shareSlug?: string | null;
      title?: string | null;
      courseId?: string | null;
      livekitUrl?: string | null;
      publicAccess?: boolean;
      agentEnabled?: boolean;
      callOpen?: boolean;
      startsAt?: number | null;
    }) => d
  )
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);

    let shareSlug = data.shareSlug === undefined ? undefined : (data.shareSlug?.trim().toLowerCase() || null);
    if (shareSlug && !EVENT_SLUG_RE.test(shareSlug)) {
      throw new Error("La liga sólo admite minúsculas, números y guiones (3-49)");
    }
    // Encender el acceso público sin liga dejaría un room "abierto" al que no se
    // puede llegar: se genera una a partir del nombre para que nunca pase.
    if (data.publicAccess && !shareSlug && !ch.call_share_slug) {
      shareSlug = ch.slug;
    }

    try {
      await db.setChannelEvent(ch.id, {
        mode: data.mode,
        shareSlug,
        title: data.title === undefined ? undefined : data.title?.trim() || null,
        // El id del taller de fixtergeek: se pega tal cual, es un ObjectId de Mongo.
        courseId: data.courseId === undefined ? undefined : data.courseId?.trim() || null,
        livekitUrl: data.livekitUrl === undefined ? undefined : data.livekitUrl?.trim() || null,
        publicAccess: data.publicAccess,
        agentEnabled: data.agentEnabled,
        callOpen: data.callOpen,
        startsAt: data.startsAt,
      });
    } catch (e) {
      // El índice único de `call_share_slug` es lo que impide que dos eventos
      // compartan liga; sin este mensaje el error sale como un fallo de SQL.
      if (String(e).includes("UNIQUE")) throw new Error("Esa liga ya está en uso por otro room");
      throw e;
    }
    const fresh = await db.getChannel(data.slug);
    return { ok: true as const, channel: fresh };
  });

export const listEventRegistrationsFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    const { db, ch } = await requireManage(data.slug);
    return { registrations: await db.listEventRegistrations(ch.id) };
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
    // 1) Lo que ya conocemos del workspace: correo o @handle.
    let sub = await db.getUserSubByEmailOrHandle(data.email);
    if (!sub) {
      // 2) El padrón de verdad está en gs. `gc_users` solo tiene a quien YA entró a
      //    Teams, así que un miembro nuevo —o uno que vive en Ghosty Tasks— era
      //    invisible aquí y el error culpaba a la persona equivocada.
      const { workspaceRoster } = await import("./roster.server");
      const target = data.email.trim().toLowerCase();
      const hit = (await workspaceRoster()).find((m) => m.email === target);
      if (hit) sub = hit.sub;
    }
    if (!sub) {
      throw new Error(
        data.email.trim().startsWith("@")
          ? "no encuentro ese @usuario en este workspace"
          : "esa persona no es miembro del workspace todavía: invítala en Ajustes → Invitar miembros"
      );
    }
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
