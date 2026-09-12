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
  // El namespace viaja para que gs sume las novedades dirigidas a ESTE workspace (un
  // regalo, un aviso de su plan) a las globales. Sin tenant (no debería pasar aquí) van
  // sólo las globales; nunca se deja de pintar por esto.
  const ns = await import("./tenant.server").then((t) => t.currentNamespace()).catch(() => "");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return [];
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.announcements`).digest("hex");
  try {
    const res = await fetch(`${IDP}/internal/announcements?ts=${ts}&sig=${sig}&ws=${encodeURIComponent(ns)}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { announcements?: Announcement[] | null };
    return Array.isArray(j.announcements) ? j.announcements : [];
  } catch {
    return [];
  }
}

/** Aviso de mantenimiento global (de gs). `null` = no hay.
 *
 * ⚠️ NO es una novedad, y por eso no viaja con ellas: una novedad se descarta al
 * verla una vez, y esto tiene que seguir visible mientras dure, para todo el
 * mundo y en cada carga. Fallar es no pintar nada: un aviso que no se pudo leer
 * jamás puede impedir entrar al chat.
 */
export const maintenanceNoticeFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ message: string; until: string | null } | null> => {
    try {
      const crypto = await import("node:crypto");
      const secret = process.env.GHOSTY_PARTNER_SECRET;
      if (!secret) return null;
      const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac("sha256", secret).update(`${ts}.status`).digest("hex");
      const res = await fetch(`${IDP}/internal/status?ts=${ts}&sig=${sig}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { maintenance?: { message: string; until: string | null } | null };
      return j.maintenance ?? null;
    } catch {
      return null;
    }
  },
);

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
