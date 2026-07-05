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

self.addEventListener("fetch", () => {
  // Handler intencionalmente vacío: sin `respondWith`, el navegador resuelve
  // cada request normal. Solo existe para contar como "tiene fetch handler".
});

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
    tag: data.url || "ghosty-teams",
    renotify: true,
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
