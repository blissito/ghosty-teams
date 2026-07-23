// Captura de `beforeinstallprompt` a nivel de módulo.
//
// Chrome dispara este evento UNA sola vez y muy temprano — normalmente antes de
// que React hidrate y monte los `useEffect`. Si el listener se engancha en un
// componente, se pierde el evento (aparece el ⊕ del navegador pero no nuestro
// banner). Engancharlo en module-scope (importado desde __root) lo captura apenas
// se evalúa el bundle del cliente y lo guarda para cuando el componente monte.

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(event: BeforeInstallPromptEvent) => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Evita el mini-infobar automático de Chrome; lo disparamos nosotros.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    for (const cb of listeners) cb(deferredPrompt);
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
  });
}

export function getDeferredPrompt() {
  return deferredPrompt;
}

export function clearDeferredPrompt() {
  deferredPrompt = null;
}

export function onInstallable(cb: (event: BeforeInstallPromptEvent) => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Registra el service worker (requisito de instalabilidad + push). Idempotente.
// BUG (2026-07-22): antes registraba SOLO en `window.addEventListener("load", …)`,
// pero registerSW() se llama desde un useEffect (post-hydration) → el evento `load`
// YA disparó → el listener nunca corría → el SW NUNCA se registraba →
// `serviceWorker.ready` colgaba para siempre en enablePush ("..." infinito) y 0 subs.
// Fix: registrar YA si el documento ya cargó; si no, en el próximo `load`.
export function registerSW() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const doRegister = () =>
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {});
  if (typeof document !== "undefined" && document.readyState === "complete") {
    doRegister();
  } else {
    window.addEventListener("load", doRegister, { once: true });
  }
}
