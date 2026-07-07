import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText } from "lucide-react";
import { useT } from "../i18n";

// Panel lateral de artefactos del room. Fase 0 = visor PDF/imagen (adjuntos).
// Fase 3 añadirá kind:"html" (editor Tiptap embebido / colab). El panel es
// agnóstico a la fuente: solo conoce esta vista, no el modelo Attachment/Artifact.
// Patrón calcado del PreviewDrawer noVNC de ghosty-studio: drawer overlay que se
// desliza desde la derecha, redimensionable por el borde izquierdo, con un catcher
// de pointer-events durante el arrastre para que el iframe no se coma el drag.
export type ArtifactView =
  | { kind: "pdf"; title: string; src: string }
  | { kind: "image"; title: string; src: string }
  | { kind: "audio"; title: string; src: string }
  | { kind: "video"; title: string; src: string }
  | { kind: "file"; title: string; src: string } // fallback genérico → descarga
  | { kind: "html"; title: string; embedUrl: string };

// Mapea un adjunto a una vista de artefacto previsualizable en el panel. Devuelve
// null solo para lo no-previsualizable (se queda como card de descarga en la lista).
export function viewFromAttachment(a: {
  file_id: string;
  mime: string | null;
  name: string | null;
}): ArtifactView | null {
  const src = `/api/attachment/${encodeURIComponent(a.file_id)}`;
  const mime = a.mime ?? "";
  const title = a.name ?? "";
  if (mime === "application/pdf") return { kind: "pdf", title, src };
  if (mime.startsWith("image/")) return { kind: "image", title, src };
  if (mime.startsWith("audio/")) return { kind: "audio", title, src };
  if (mime.startsWith("video/")) return { kind: "video", title, src };
  return null;
}

const DEFAULT_W = 680;
const MIN_W = 360;
const CHAT_MIN = 380; // deja SIEMPRE espacio de chat a la izquierda (split, no overlay)
const STORE_KEY = "eb_artifact_w";

export default function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ArtifactView | null;
  onClose: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_W;
    const saved = Number(localStorage.getItem(STORE_KEY));
    const max = window.innerWidth - CHAT_MIN;
    return Math.min(saved || DEFAULT_W, max);
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragging = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      // Panel anclado a la derecha → ancho = viewport - clientX.
      const w = Math.min(Math.max(window.innerWidth - e.clientX, MIN_W), window.innerWidth - CHAT_MIN);
      setWidth(w);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(STORE_KEY, String(Math.round(widthRef.current)));
      } catch {}
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const externalHref = artifact && artifact.kind === "html" ? artifact.embedUrl : artifact?.src;

  return (
    <AnimatePresence>
      {artifact ? (
        <>
          {/* Backdrop SOLO en móvil (overlay). En desktop el panel va en-flujo (split)
              y NO oscurece el chat → puedes pedir y ver a la vez. */}
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-full max-w-full border-l border-border bg-surface shadow-2xl md:relative md:z-auto md:h-auto md:max-w-[75vw] md:shrink-0 md:shadow-none md:self-stretch"
            style={{ width }}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            {/* Handle de redimensión: arrastra el borde izquierdo; doble clic resetea. */}
            <div
              onPointerDown={(e) => {
                dragging.current = true;
                setIsDragging(true);
                document.body.style.userSelect = "none";
                e.preventDefault();
              }}
              onDoubleClick={() => setWidth(Math.min(DEFAULT_W, window.innerWidth - 40))}
              title={t("Arrastra para redimensionar (doble clic: reset)")}
              className="absolute left-0 top-0 z-10 -ml-1 h-full w-2 cursor-col-resize transition-colors hover:bg-brand/40 active:bg-brand/60"
            />

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
                <FileText size={16} className="shrink-0 text-brand" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {artifact.title || t("Documento")}
                </span>
                <a
                  href={externalHref}
                  target="_blank"
                  rel="noreferrer"
                  className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                  title={t("Abrir en pestaña nueva")}
                >
                  <ExternalLink size={15} />
                </a>
                <button
                  type="button"
                  onClick={onClose}
                  className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
                  title={t("Cerrar")}
                >
                  <X size={16} />
                </button>
              </header>

              <div className="relative min-h-0 flex-1 overflow-auto bg-surface-3">
                {artifact.kind === "image" ? (
                  <div className="grid min-h-full place-items-center p-4">
                    <img
                      src={artifact.src}
                      alt={artifact.title}
                      className="max-h-full max-w-full rounded-lg object-contain"
                    />
                  </div>
                ) : artifact.kind === "audio" ? (
                  <div className="grid min-h-full place-items-center p-6">
                    <audio src={artifact.src} controls className="w-full max-w-xl" />
                  </div>
                ) : artifact.kind === "video" ? (
                  <div className="grid min-h-full place-items-center p-4">
                    <video src={artifact.src} controls className="max-h-full max-w-full rounded-lg" />
                  </div>
                ) : artifact.kind === "file" ? (
                  <div className="grid min-h-full place-items-center p-6">
                    <a
                      href={artifact.src}
                      target="_blank"
                      rel="noreferrer"
                      download
                      className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center transition hover:border-brand"
                    >
                      <FileText size={40} className="text-brand" />
                      <span className="max-w-xs truncate text-sm text-ink">{artifact.title || t("Archivo")}</span>
                      <span className="text-xs text-muted">{t("Descargar")}</span>
                    </a>
                  </div>
                ) : (
                  <iframe
                    src={artifact.kind === "html" ? artifact.embedUrl : artifact.src}
                    title={artifact.title || "artifact"}
                    className="size-full border-0 bg-surface-3"
                  />
                )}
              </div>
            </div>

            {/* Catcher: durante el arrastre cubre todo (incluido el iframe) para que el
                pointer no se pierda dentro del visor. */}
            {isDragging ? <div className="fixed inset-0 z-[60] cursor-col-resize" /> : null}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
