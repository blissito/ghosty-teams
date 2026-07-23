import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Novedades / anuncios ("What's New" estilo Discord) ──────────────────────
// El CONTENIDO es GLOBAL y lo redactan los admins de sistema en el control-plane gs
// (modelo Announcement, UI en /admin/announcements). Teams solo CONSUME: pide la última
// publicada al endpoint interno HMAC de gs y la cruza con el estado "visto" per-usuario
// (gt_announcement_reads). La card se muestra si announcement.id != lastSeenId.
//
// IMPORTANTE: este módulo lo importa el cliente (c.$slug.tsx usa las server fns + el
// type). NADA de node:crypto / process.env a nivel módulo → romperían el bundle del
// browser. Todo lo server-only vive DENTRO de los handlers (dynamic import).

export type Announcement = {
  id: string;
  title: string;
  body: string;
  heroImage: string | null;
  publishedAt: string | null;
};

// Última novedad publicada (global, desde gs) firmada con GHOSTY_PARTNER_SECRET.
// Solo se ejecuta server-side (dentro del handler).
async function fetchLatestFromControlPlane(): Promise<Announcement | null> {
  const crypto = await import("node:crypto");
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return null;
  const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.announcements`).digest("hex");
  try {
    const res = await fetch(`${IDP}/internal/announcements?ts=${ts}&sig=${sig}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { announcement?: Announcement | null };
    return j.announcement ?? null;
  } catch {
    return null;
  }
}

// La última novedad publicada + el id que este usuario ya vio (para decidir la card).
export const latestAnnouncementFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ announcement: Announcement | null; lastSeenId: string }> => {
    const me = await sessionUser();
    if (!me) return { announcement: null, lastSeenId: "" };
    const db = await import("../db.server");
    const [announcement, lastSeenId] = await Promise.all([
      fetchLatestFromControlPlane(),
      db.getAnnouncementLastSeen(me.sub),
    ]);
    return { announcement, lastSeenId };
  }
);

// Marca una novedad como vista (al cerrar la card). Idempotente.
export const markAnnouncementSeenFn = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const db = await import("../db.server");
    await db.markAnnouncementSeen(me.sub, data.id);
    return { ok: true as const };
  });
