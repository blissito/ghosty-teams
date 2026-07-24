// Ghosty Teams PWA — Service Worker.
// Cachea SOLO los assets con hash de contenido (/assets/*.js|css|woff…): son
// INMUTABLES (el filename cambia en cada build) → cache-first sin caducidad es
// seguro y hace que la PWA arranque casi instantánea (no re-descarga ~2-3 MB de
// JS en cada apertura en frío). TODO lo demás — HTML, /api, server functions,
// SSE — pasa SIEMPRE a red (la app es dinámica; NUNCA cachear la app ni datos).

const ASSET_CACHE = "gt-assets-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Limpia versiones viejas del caché de assets (deja solo la actual).
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith("gt-assets-") && k !== ASSET_CACHE).map((k) => caches.delete(k)))
        ),
    ])
  );
});

// Cache-first estricto para assets hasheados del mismo origen. El resto: red directa.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Solo /assets/ del mismo origen (JS/CSS/fuentes con hash inmutable). HTML y datos NO.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) return;
  event.respondWith(
    caches.open(ASSET_CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
      })
    )
  );
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
