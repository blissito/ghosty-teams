import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Suscripción a Web Push (por usuario). La pública se expone; el envío ocurre
// server-side cuando te taggean (ver postMessage → notifyMentions).

export const getVapidKeyFn = createServerFn({ method: "GET" }).handler(async () => {
  const { VAPID_PUBLIC_KEY } = await import("../push.server");
  return { key: VAPID_PUBLIC_KEY };
});

export const subscribePushFn = createServerFn({ method: "POST" })
  .validator((d: { endpoint: string; p256dh: string; auth: string }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("no autenticado");
    const db = await import("../db.server");
    await db.savePushSub(user.sub, data);
    return { ok: true as const };
  });

export const unsubscribePushFn = createServerFn({ method: "POST" })
  .validator((d: { endpoint: string }) => d)
  .handler(async ({ data }) => {
    const db = await import("../db.server");
    await db.deletePushSub(data.endpoint);
    return { ok: true as const };
  });
