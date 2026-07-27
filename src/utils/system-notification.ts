// Notificación de escritorio disparada por la PÁGINA (pestaña abierta pero oculta).
// SIEMPRE por el Service Worker: el constructor `new Notification(...)` NO existe en
// Android/Chrome-PWA (lanza TypeError) y ahí el aviso se perdía en silencio dentro de
// un try/catch — era la mitad de "no me llegan las notificaciones" (2026-07-27).
// El otro camino, con la app CERRADA, es Web Push (notify.server.ts); no se pisan:
// el server sólo manda push a quien NO tiene pestaña conectada.
export async function showSystemNotification(
  title: string,
  body: string,
  slug?: string
): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    await reg.showNotification(title, {
      body,
      icon: "/ghosty-192.png",
      badge: "/ghosty-192.png",
      data: { url: slug ? `/c/${slug}` : "/" },
      // Tag único: con uno compartido, dos mensajes seguidos se reemplazan entre sí
      // (mismo motivo que en sw.js).
      tag: `gt-live-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    });
  } catch {
    /* permiso revocado a media sesión / SW muriendo → sin aviso, no rompe el chat */
  }
}
