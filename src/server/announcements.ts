import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Novedades / anuncios ("What's New" estilo Discord/Revolt) ───────────────
// Lectura: cualquier sesión ve el último anuncio PUBLICADO + su last_seen. La card
// de inicio se muestra si announcement.id > lastSeenId. Autoría/publicación: gate
// admin (Fase 1 = owner; Fase 2 amplía a requireAdmin cuando Teams honre el rol de gs).

// Gate de autoría. Fase 1: solo el owner. TODO Fase 2: sustituir por requireAdmin()
// (owner || rol OWNER/ADMIN sincronizado desde el control-plane gs).
async function requireAnnouncementAdmin() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("solo el owner/admin gestiona anuncios");
  return user;
}

// El último anuncio publicado + el id que este usuario ya vio (para decidir la card).
export const latestAnnouncementFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    announcement: import("../db.server").Announcement | null;
    lastSeenId: number;
  }> => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return { announcement: null, lastSeenId: 0 };
    const [announcement, lastSeenId] = await Promise.all([
      db.latestPublishedAnnouncement(),
      db.getAnnouncementLastSeen(me.sub),
    ]);
    return { announcement, lastSeenId };
  }
);

// Marca un anuncio como visto (al cerrar la card). Idempotente, nunca retrocede.
export const markAnnouncementSeenFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    await db.markAnnouncementSeen(me.sub, data.id);
    return { ok: true as const };
  });

// ── Admin ───────────────────────────────────────────────────────────────────

// Todos los anuncios (incluye borradores) para la pestaña de redacción.
export const listAnnouncementsFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireAnnouncementAdmin();
  const db = await import("../db.server");
  return db.listAnnouncements();
});

export const createAnnouncementFn = createServerFn({ method: "POST" })
  .validator((d: { title: string; body: string; heroImage?: string | null; published?: boolean }) => d)
  .handler(async ({ data }) => {
    const me = await requireAnnouncementAdmin();
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title) throw new Error("el título es obligatorio");
    if (!body) throw new Error("el cuerpo es obligatorio");
    const db = await import("../db.server");
    return db.createAnnouncement({
      title,
      body,
      heroImage: data.heroImage?.trim() || null,
      createdBy: me.sub,
      published: data.published,
    });
  });

export const updateAnnouncementFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; title: string; body: string; heroImage?: string | null }) => d)
  .handler(async ({ data }) => {
    await requireAnnouncementAdmin();
    const title = data.title.trim();
    const body = data.body.trim();
    if (!title) throw new Error("el título es obligatorio");
    if (!body) throw new Error("el cuerpo es obligatorio");
    const db = await import("../db.server");
    const updated = await db.updateAnnouncement(data.id, {
      title,
      body,
      heroImage: data.heroImage?.trim() || null,
    });
    if (!updated) throw new Error("anuncio no encontrado");
    return updated;
  });

// Publicar / despublicar (toggle). Publicar lo hace visible en la card de inicio.
export const publishAnnouncementFn = createServerFn({ method: "POST" })
  .validator((d: { id: number; published: boolean }) => d)
  .handler(async ({ data }) => {
    await requireAnnouncementAdmin();
    const db = await import("../db.server");
    const updated = await db.setAnnouncementPublished(data.id, data.published);
    if (!updated) throw new Error("anuncio no encontrado");
    return updated;
  });

export const deleteAnnouncementFn = createServerFn({ method: "POST" })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => {
    await requireAnnouncementAdmin();
    const db = await import("../db.server");
    await db.deleteAnnouncement(data.id);
    return { ok: true as const };
  });
