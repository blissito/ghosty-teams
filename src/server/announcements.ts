import { createServerFn } from "@tanstack/react-start";
import crypto from "node:crypto";
import { sessionUser } from "./chat";

// ── Novedades / anuncios ("What's New" estilo Discord) ──────────────────────
// El CONTENIDO es GLOBAL y lo redactan los admins de sistema en el control-plane gs
// (modelo Announcement, UI en /admin/announcements). Teams solo CONSUME: pide la última
// publicada al endpoint interno HMAC de gs y la cruza con el estado "visto" per-usuario
// (gt_announcement_reads). La card se muestra si announcement.id != lastSeenId.

export type Announcement = {
  id: string;
  title: string;
  body: string;
  heroImage: string | null;
  publishedAt: string | null;
};

const IDP = process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

// Última novedad publicada (global, desde gs) firmada con GHOSTY_PARTNER_SECRET.
async function fetchLatestFromControlPlane(): Promise<Announcement | null> {
  const secret = process.env.GHOSTY_PARTNER_SECRET;
  if (!secret) return null;
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
