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

// Registra el service worker (requisito de instalabilidad). Idempotente.
export function registerSW() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  });
}
