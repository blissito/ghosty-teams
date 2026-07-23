// Ghosty Teams PWA — Service Worker stub.
// Su único propósito es satisfacer el criterio de instalabilidad de Chrome
// (un SW registrado con handler `fetch`). NO cachea nada: deja pasar la red sin
// tocarla. El shell del chat vive en la VM y el estado en EasyBits, así que el
// caché offline llega después (fase 2).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// (Sin handler `fetch`: Chrome moderno ya NO lo exige para instalabilidad y un
// no-op agrega overhead en cada navegación — Chrome lo marca como warning.)

// Push: notificación cuando te taggean.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Ghosty Teams";
  const options = {
    body: data.body || "",
    icon: "/ghosty-192.png",
    badge: "/ghosty-192.png",
    data: { url: data.url || "/" },
    // Tag ÚNICO por notificación (a menos que el server mande uno explícito): con
    // un tag compartido (antes = data.url), notifs seguidas se REEMPLAZAN
    // silenciosamente entre sí en vez de mostrarse cada una → parecía "no llegan".
    tag: data.tag || "gt-" + Date.now() + "-" + Math.round(Math.random() * 1e6),
    renotify: true,
    // Persiste hasta que el usuario la cierre (más confiable de ver en desktop,
    // donde el banner se auto-oculta rápido y con throttling puede perderse).
    requireInteraction: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clic → enfoca una pestaña abierta en esa URL o abre una nueva.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const c of clientsArr) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
