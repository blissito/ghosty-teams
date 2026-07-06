import { useCallback, useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText } from "lucide-react";
import { useT } from "../i18n";

// Panel lateral de artefactos del room. Fase 0 = visor PDF/imagen (adjuntos).
// Fase 3 añadirá kind:"html" (editor Tiptap embebido / colab). El panel es
// agnóstico a la fuente: solo conoce esta vista, no el modelo Attachment/Artifact.
export type ArtifactView =
  | { kind: "pdf"; title: string; src: string }
  | { kind: "image"; title: string; src: string }
  | { kind: "html"; title: string; embedUrl: string };

// Mapea un adjunto (PDF/imagen) a una vista de artefacto. Devuelve null si el
// mime no es visualizable en el panel (se queda como card de descarga).
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
  return null;
}

const MIN_W = 360;
const DEFAULT_W = 520;
const STORE_KEY = "eb_artifact_w";

function clampWidth(w: number): number {
  const max = Math.min(1100, Math.round(window.innerWidth * 0.85));
  return Math.max(MIN_W, Math.min(w, max));
}

// Solo en desktop el ancho es ajustable; en móvil el panel es overlay full-screen.
function useIsDesktop(): boolean {
  const [d, setD] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width:768px)").matches : true,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width:768px)");
    const h = () => setD(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return d;
}

export default function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ArtifactView | null;
  onClose: () => void;
}) {
  const t = useT();
  const isDesktop = useIsDesktop();
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(STORE_KEY));
      return v >= MIN_W ? v : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  const widthRef = useRef(width);
  const setW = useCallback((w: number) => {
    widthRef.current = w;
    setWidth(w);
  }, []);

  // Arrastre desde el borde izquierdo. El panel está anclado a la derecha, así
  // que el ancho = viewport - clientX. Listeners en window para no perder el
  // drag si el cursor sale del handle.
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const onMove = (ev: MouseEvent) => setW(clampWidth(window.innerWidth - ev.clientX));
      const onUp = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          localStorage.setItem(STORE_KEY, String(widthRef.current));
        } catch {}
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setW],
  );

  if (!artifact) return null;

  const externalHref = artifact.kind === "html" ? artifact.embedUrl : artifact.src;

  return (
    // Overlay a pantalla completa en móvil; columna redimensionable en desktop.
    <aside
      style={isDesktop ? { width } : undefined}
      className="fixed inset-0 z-50 flex flex-col bg-surface md:static md:inset-auto md:z-auto md:shrink-0 md:border-l md:border-border"
    >
      {/* Handle de redimensión (solo desktop): barra en el borde izquierdo que
          resalta al hover y arrastra para ensanchar. */}
      <div
        onMouseDown={onDragStart}
        title={t("Arrastra para redimensionar")}
        className="group absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize md:block"
      >
        <div className="absolute inset-y-0 left-1 w-0.5 bg-transparent transition-colors group-hover:bg-brand" />
      </div>

      <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
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

      <div className="min-h-0 flex-1 overflow-auto bg-surface-3">
        {artifact.kind === "image" ? (
          <div className="grid min-h-full place-items-center p-4">
            <img
              src={artifact.src}
              alt={artifact.title}
              className="max-h-full max-w-full rounded-lg object-contain"
            />
          </div>
        ) : (
          <iframe
            src={artifact.kind === "html" ? artifact.embedUrl : artifact.src}
            title={artifact.title || "artifact"}
            className="size-full border-0"
          />
        )}
      </div>
    </aside>
  );
}
