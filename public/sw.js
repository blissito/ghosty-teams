// Ghosty Teams PWA — Service Worker (solo push + instalabilidad).
// ⚠️ SIN handler `fetch` a propósito: un cache-first para /assets/ (probado 2026-07-24)
// EMPEORÓ la carga — con la red sobre HTTP/3 (QUIC) dando ERR_QUIC_PROTOCOL_ERROR, el
// `fetch` del SW fallaba y `cache.put` reventaba → el `respondWith` rechazaba → el asset
// no cargaba y el browser reintentaba lento (carga de ~10 min). Dejar que el browser
// maneje los assets NATIVO (retry/fallback a H2) es más robusto. El caché offline, si se
// hace, debe tolerar fetch fallido (never-reject) y NO cachear respuestas parciales.
// Limpia cualquier caché viejo que dejó la versión con fetch handler.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("gt-assets-")).map((k) => caches.delete(k)))),
    ])
  );
});

// Push: notificación cuando te taggean, te escriben o te llaman.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // Badge del ícono (PWA): el server manda el total de no-leídos del usuario. Con la
  // app CERRADA este es el único camino — la página no corre para llamar setAppBadge.
  if (typeof data.badge === "number" && navigator.setAppBadge) {
    if (data.badge > 0) navigator.setAppBadge(data.badge).catch(() => {});
    else navigator.clearAppBadge?.().catch(() => {});
  }
  // Cierre remoto: la llamada terminó / fue contestada → retira su notificación en vez
  // de dejar un "te llaman" muerto en pantalla. No muestra nada nuevo.
  if (data.close && data.tag) {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag }).then((ns) => ns.forEach((n) => n.close()))
    );
    return;
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
  // Llamada entrante: patrón de vibración de timbre y botón para entrar directo.
  if (data.kind === "call") {
    options.vibrate = [400, 200, 400, 200, 400];
    options.actions = [{ action: "join", title: "Entrar" }];
  }
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
