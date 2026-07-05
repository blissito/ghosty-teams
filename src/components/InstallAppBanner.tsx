import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useEffect, useState } from "react";
import {
  type BeforeInstallPromptEvent,
  clearDeferredPrompt,
  getDeferredPrompt,
  onInstallable,
} from "../utils/pwa-install";

const DISMISS_KEY = "ghosty-teams-pwa-dismissed";

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="inline-block h-4 w-4 align-text-bottom text-brand"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="ícono Compartir"
    >
      <path d="M12 16V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 12v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
    </svg>
  );
}

function getIsStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function getIsIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iphone|ipad|ipod/i.test(ua) || iPadOS;
}

function getIOSBrowser(): "safari" | "chrome" | "other" {
  if (typeof navigator === "undefined") return "safari";
  const ua = navigator.userAgent;
  if (/CriOS/i.test(ua)) return "chrome";
  if (/FxiOS|EdgiOS/i.test(ua)) return "other";
  return "safari";
}

/**
 * Banner de instalación de la PWA (Ghosty Teams).
 * - Chrome/Android/desktop: captura `beforeinstallprompt` y dispara el diálogo
 *   nativo al click → pone el ícono en el escritorio o pantalla de inicio.
 * - iOS Safari: no hay prompt programático → mini tutorial "Compartir → Agregar
 *   a inicio".
 * - Ya instalada (standalone) o descartada: no renderiza nada.
 */
export function InstallAppBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [iosBrowser, setIosBrowser] = useState<"safari" | "chrome" | "other">("safari");
  const [dismissed, setDismissed] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (getIsStandalone()) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    setDismissed(false);

    if (getIsIOS()) {
      setIosBrowser(getIOSBrowser());
      setShowIOS(true);
      return;
    }

    const existing = getDeferredPrompt();
    if (existing) setDeferred(existing);
    const unsubscribe = onInstallable((event) => setDeferred(event));
    const onInstalled = () => {
      setDeferred(null);
      setDismissed(true);
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      unsubscribe();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // localStorage puede fallar en modo privado; no crítico.
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    clearDeferredPrompt();
    close();
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 100 || info.velocity.y > 600) close();
  };

  const visible = !dismissed && (showIOS || Boolean(deferred));

  const textBlock = showIOS ? (
    <>
      <p className="font-semibold text-ink">Instala Ghosty Teams en tu iPhone</p>
      <p className="mt-1 text-sm text-muted">
        1. Toca <ShareIcon /> <span className="font-semibold text-ink">Compartir</span>{" "}
        {iosBrowser === "safari" ? "en la barra de abajo" : "del navegador"}.
        <br />
        2. Elige <span className="font-semibold text-ink">"Agregar a inicio"</span>.
      </p>
    </>
  ) : (
    <>
      <p className="font-semibold text-ink">Instala Ghosty Teams</p>
      <p className="mt-1 text-sm text-muted">
        Ponlo en tu {isMobile ? "pantalla de inicio" : "escritorio"}: acceso directo, sin barra del navegador.
      </p>
    </>
  );

  const ghostyImg = (
    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white">
      <img src="/ghosty.svg" alt="Ghosty" className="h-11 w-11 object-contain" />
    </div>
  );

  const installBtn = (full?: boolean) => (
    <button
      onClick={showIOS ? close : install}
      className={`cursor-pointer rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 active:scale-[0.98] ${
        full ? "w-full" : ""
      }`}
    >
      {showIOS ? "Entendido" : "Instalar app"}
    </button>
  );

  return (
    <AnimatePresence>
      {visible &&
        (isMobile ? (
          <>
            <motion.div
              key="pwa-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={close}
              className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-[2px]"
            />
            <motion.div
              key="pwa-sheet"
              role="dialog"
              aria-modal="true"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.4 }}
              onDragEnd={onDragEnd}
              className="fixed inset-x-0 bottom-0 z-[90] mx-auto w-full max-w-md rounded-t-3xl border-t border-border bg-surface-2 shadow-2xl"
              style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))" }}
            >
              <div className="flex justify-center pt-3">
                <div className="h-1.5 w-10 rounded-full bg-surface-3" />
              </div>
              <div className="px-5 pt-4">
                <div className="flex items-start gap-3">
                  {ghostyImg}
                  <div className="flex-1">{textBlock}</div>
                </div>
                <div className="mt-5 flex flex-col gap-2">
                  {installBtn(true)}
                  <button
                    onClick={close}
                    className="min-h-[40px] text-sm text-muted transition hover:text-ink"
                  >
                    Ahora no
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        ) : (
          <motion.div
            key="pwa-card"
            role="dialog"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-surface-2 p-4 shadow-xl"
          >
            <button
              onClick={close}
              aria-label="Cerrar"
              className="absolute right-3 top-3 text-muted transition hover:text-ink"
            >
              ✕
            </button>
            <div className="flex items-start gap-3 pr-4">
              {ghostyImg}
              <div className="flex-1">
                {textBlock}
                {!showIOS && <div className="mt-3">{installBtn()}</div>}
              </div>
            </div>
          </motion.div>
        ))}
    </AnimatePresence>
  );
}
