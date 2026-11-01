// Server fns de «Transmisión en vivo» en Ajustes del room → Evento. Sólo el creador del room o el
// owner del espacio: conectar YouTube/Facebook y preparar la transmisión afectan a todo el espacio.
import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";

// Copia de `requireManage` de channels.ts (no exportado): misma regla, creador u owner.
async function requireRoomManager(slug: string) {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const db = await import("../../db.server");
  const ch = await db.getChannel(slug);
  if (!ch) throw new Error("room no encontrado");
  if (!user.isOwner && ch.created_by !== user.sub) throw new Error("solo el creador u owner");
  return { db, ch, user };
}

const PROVIDERS = ["youtube", "facebook"] as const;
type Provider = (typeof PROVIDERS)[number];
const isProvider = (p: unknown): p is Provider => p === "youtube" || p === "facebook";

/** Destinos conectados + lo que la caja de eventos tiene cargado. */
export const liveStatusFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) => {
    await requireRoomManager(data.slug);
    const { gsLive } = await import("./live-gs.server");
    const [s, c] = await Promise.all([gsLive("status"), gsLive("check")]);
    if (!s.ok) throw new Error(s.error);
    return { configured: s.configured, destinations: s.destinations, box: c.ok ? c.box : null };
  });

/** Liga firmada por gs al consentimiento de Google/Facebook; regresa al room con `?live=…`. */
export const liveConnectUrlFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; provider: string; locale?: string }) => d)
  .handler(async ({ data }) => {
    if (!isProvider(data.provider)) throw new Error("youtube o facebook");
    const { db, user } = await requireRoomManager(data.slug);
    const { reqOrigin } = await import("../../origin.server");
    const origin = await reqOrigin().catch(() => "");
    // gs sólo regresa a https de *.ghosty.studio.
    if (!/^https:\/\/([a-z0-9-]+\.)*ghosty\.studio$/i.test(origin)) throw new Error("conectar sólo funciona desde tu espacio en ghosty.studio");
    const email = (user as { email?: string | null }).email ?? (await db.emailsForSubsAny([user.sub]).catch(() => []))[0]?.email ?? null;
    const { gsLive } = await import("./live-gs.server");
    const r = await gsLive("connect_url", { provider: data.provider, returnTo: `${origin}/c/${encodeURIComponent(data.slug)}`, email, locale: data.locale === "en" ? "en" : "es" });
    if (!r.ok) throw new Error(r.error);
    return { url: r.url };
  });

export const liveUnlinkFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; provider: string }) => d)
  .handler(async ({ data }) => {
    if (!isProvider(data.provider)) throw new Error("youtube o facebook");
    const { user } = await requireRoomManager(data.slug);
    const { gsLive } = await import("./live-gs.server");
    const r = await gsLive("unlink", { provider: data.provider, by: user.name || user.sub });
    if (!r.ok) throw new Error(r.error);
    return { ok: true };
  });

/** Crea el evento en cada destino elegido y carga las llaves en la caja de eventos. */
export const livePrepareFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; title: string; privacy: string; startsAt?: string | null; only: string[] }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireRoomManager(data.slug);
    const title = data.title.trim();
    if (!title) throw new Error("falta el título");
    const only = data.only.filter(isProvider);
    if (!only.length) throw new Error("elige al menos un destino");
    const privacy = ["unlisted", "public", "private"].includes(data.privacy) ? data.privacy : "unlisted";
    const { gsLive } = await import("./live-gs.server");
    const r = await gsLive("prepare", { title, privacy, only, by: user.name || user.sub, ...(data.startsAt ? { startsAt: data.startsAt } : {}) });
    if (!r.ok) throw new Error(r.error);
    return { prepared: r.prepared, failed: r.failed, box: r.box };
  });
