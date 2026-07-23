import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Novedades / anuncios ("What's New" estilo Discord) — GALERÍA ────────────
// El CONTENIDO es GLOBAL y lo redactan los admins de sistema en gs (modelo Announcement,
// UI en /admin/announcements). Teams CONSUME: pide TODAS las publicadas al endpoint
// interno HMAC de gs y muestra las que el usuario NO ha visto (set gt_announcement_seen),
// una por una en carrusel. Al pasar cada card se marca vista.
//
// IMPORTANTE: este módulo lo importa el cliente (c.$slug.tsx). NADA de node:crypto /
// process.env a nivel módulo → romperían el bundle del browser. Todo server-only vive
// DENTRO de los handlers (dynamic import).

export type Announcement = {
  id: string;
  title: string;
  body: string;
  heroImage: string | null;
  publishedAt: string | null;
};

// Todas las novedades publicadas (global, desde gs) firmado con GHOSTY_PARTNER_SECRET.
async function fetchPublishedFromControlPlane(): Promise<Announcement[]> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return [];
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.announcements`).digest("hex");
  try {
    const res = await fetch(`${IDP}/internal/announcements?ts=${ts}&sig=${sig}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { announcements?: Announcement[] | null };
    return Array.isArray(j.announcements) ? j.announcements : [];
  } catch {
    return [];
  }
}

// Las novedades que el usuario AÚN NO ha visto (para la galería). Orden = como llegan
// de gs (más nuevas primero).
export const unreadAnnouncementsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<Announcement[]> => {
    const me = await sessionUser();
    if (!me) return [];
    const db = await import("../db.server");
    const [published, seen] = await Promise.all([
      fetchPublishedFromControlPlane(),
      db.getSeenAnnouncementIds(me.sub),
    ]);
    const seenSet = new Set(seen);
    return published.filter((a) => !seenSet.has(a.id));
  }
);

// Marca UNA novedad como vista (al pasar la card en la galería). Idempotente.
export const markAnnouncementSeenFn = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const db = await import("../db.server");
    await db.markAnnouncementSeen(me.sub, data.id);
    return { ok: true as const };
  });
