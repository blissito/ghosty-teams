import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── VIEWS (Fase 2.1) ────────────────────────────────────────────────────────
// Barra de vistas estilo Zulip: Recientes (último mensaje por conversación),
// Menciones (@handle en rooms visibles) y Destacados (star). Cada una es una query
// filtrada; el centro las pinta como lista clickable (room → salta; DM → abre).
// Se sirven como estado-cliente (center-focused), coherente con hilos y DMs.

// Recientes: último mensaje por room visible + por DM propio, mezclados por fecha.
export const recentViewFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return [];
  const visible = await db.listChannels(me.sub, !!me.isOwner);
  const hits = await db.listRecentHits(me.sub, visible.map((c) => c.id));
  return db.attachMeta(hits, me.sub) as Promise<typeof hits>;
});

// Menciones: mensajes que taggean mi @handle en rooms visibles.
export const mentionsViewFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return [];
  const handle = await db.getUserHandle(me.sub);
  if (!handle) return [];
  const visible = await db.listChannels(me.sub, !!me.isOwner);
  const hits = await db.listMentionHits(handle, visible.map((c) => c.id));
  return db.attachMeta(hits, me.sub) as Promise<typeof hits>;
});

// Destacados: mis mensajes con star, con contexto de room cuando aplica.
export const starredViewFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  const me = await sessionUser();
  if (!me) return [];
  const hits = await db.listStarredHits(me.sub);
  return db.attachMeta(hits, me.sub) as Promise<typeof hits>;
});
