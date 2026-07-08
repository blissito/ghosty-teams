import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText, Pencil, Download, Loader2, ChevronRight, RotateCw, Maximize2, Minimize2, Eye } from "lucide-react";
import { useT } from "../i18n";
import { officeToEditableFn, officeToHtmlFn, docToHtmlFn, docEmbedFn } from "../server/chat";
import { Markdown } from "./Markdown";

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
  | { kind: "office"; title: string; src: string } // docx/xlsx/pptx → preview (visor) + descarga
  | { kind: "file"; title: string; src: string } // fallback genérico → descarga
  | { kind: "html"; title: string; embedUrl: string }
  | { kind: "draft"; title: string; md: string; streaming?: boolean } // redacción en vivo (Canvas)
  | { kind: "doc"; title: string; documentId: string }; // documento vivo (preview + editar + versiones)

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
  docRefreshKey = 0,
}: {
  artifact: ArtifactView | null;
  onClose: () => void;
  // Sube cuando el doc abierto avanzó de versión (agente lo modificó) → re-fetch del preview.
  docRefreshKey?: number;
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
  // "Editar" un office: EasyBits lo importa a un doc editable → editUrl (editor colab).
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  // Preview PROPIO de un .docx: EasyBits lo convierte a HTML (mammoth) y lo renderizamos
  // inline. "loading" | HTML sanitizado | "error" (xlsx/pptx no soportados → descarga).
  const [officeHtml, setOfficeHtml] = useState<string | null>(null);
  const [officeState, setOfficeState] = useState<"idle" | "loading" | "error">("idle");
  const [refreshTick, setRefreshTick] = useState(0); // botón "refrescar" del header (re-fetch manual)
  const [expanded, setExpanded] = useState(false); // botón "expandir" (ancho máximo)
  // Identidad ESTABLE del artefacto → los effects (reset + fetch office) NO se re-disparan
  // al reabrir el MISMO artefacto (evita "recarga aunque ya esté visible"). El draft usa
  // id constante para que su streaming NO resetee.
  const officeSrc = artifact?.kind === "office" ? artifact.src : null;
  const docId = artifact?.kind === "doc" ? artifact.documentId : null;
  // Clave del preview: office (.docx) o doc (Landing) → mismo render de "hoja".
  const previewKey = officeSrc ?? docId;
  const isDocLike = artifact?.kind === "doc" || artifact?.kind === "office";
  const downloadHref =
    artifact?.kind === "doc"
      ? `/api/doc-docx/${encodeURIComponent(artifact.documentId)}?name=${encodeURIComponent(artifact.title || "documento")}`
      : artifact?.kind === "office"
        ? artifact.src
        : null;
  const artifactId = !artifact
    ? null
    : artifact.kind === "office"
      ? `office:${artifact.src}`
      : artifact.kind === "doc"
        ? `doc:${artifact.documentId}`
        : artifact.kind === "draft"
          ? "draft"
          : artifact.kind === "html"
            ? `html:${artifact.embedUrl}`
            : `${artifact.kind}:${artifact.src}`;
  // Al cambiar a OTRO artefacto (id distinto), resetea el modo edición y el preview.
  useEffect(() => {
    setEditUrl(null);
    setConverting(false);
    setOfficeHtml(null);
    setOfficeState("idle");
  }, [artifactId]);
  // Fetch del HTML del preview (office = mammoth; doc = secciones actuales). Se re-dispara
  // en docRefreshKey → auto-refresh a la nueva versión cuando el agente modifica.
  useEffect(() => {
    if (!previewKey || editUrl) return;
    let alive = true;
    setOfficeState("loading");
    (async () => {
      try {
        const r = docId
          ? await docToHtmlFn({ data: { documentId: docId } })
          : await officeToHtmlFn({ data: { url: officeSrc! } });
        if (!alive) return;
        if (r.ok && r.html) {
          const DOMPurify = (await import("dompurify")).default;
          setOfficeHtml(DOMPurify.sanitize(r.html));
          setOfficeState("idle");
        } else {
          setOfficeState("error");
        }
      } catch {
        if (alive) setOfficeState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [previewKey, docId, officeSrc, editUrl, docRefreshKey, refreshTick]);
  const handleEdit = async () => {
    if (converting || !artifact || (artifact.kind !== "office" && artifact.kind !== "doc")) return;
    setConverting(true);
    try {
      const r =
        artifact.kind === "doc"
          ? await docEmbedFn({ data: { documentId: artifact.documentId } })
          : await officeToEditableFn({ data: { url: artifact.src, name: artifact.title || "Documento" } });
      if (r.ok && r.embedUrl) setEditUrl(r.embedUrl);
      else alert(t("No se pudo abrir para editar."));
    } catch {
      alert(t("No se pudo abrir para editar. Intenta de nuevo."));
    } finally {
      setConverting(false);
    }
  };

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

  // ↗ "abrir en pestaña": solo cuando abrir la URL MUESTRA algo (html/pdf/imagen).
  // En office la URL es un .docx → el navegador la DESCARGA (no es "abrir"), así que
  // no ponemos el ↗ ahí (la descarga vive en su botón). Draft no tiene URL.
  const externalHref =
    !artifact || artifact.kind === "draft" || artifact.kind === "office" || artifact.kind === "doc"
      ? undefined
      : artifact.kind === "html"
        ? artifact.embedUrl
        : artifact.src;

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
            className="fixed right-0 top-0 z-50 flex h-full max-w-full overflow-hidden border-l border-border bg-surface shadow-2xl md:relative md:z-auto md:h-auto md:max-w-[75vw] md:shrink-0 md:shadow-none md:self-stretch"
            // Animamos el WIDTH (no x): en desktop el panel va en-flujo (flex child);
            // con x el hueco flex quedaba reservado hasta el unmount → el chat saltaba
            // de golpe al terminar el cierre. Animando width, el chat se expande/colapsa
            // suave. Durante el resize (drag) la transición es instantánea para no lagear.
            initial={{ width: 0 }}
            animate={{ width }}
            exit={{ width: 0 }}
            transition={
              isDragging ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 34 }
            }
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
            {/* Colapsar: pastilla contrastante DENTRO del borde izquierdo (el overflow-hidden
                del aside recortaba la versión que sobresalía). Chevron → indica "cerrar hacia
                la derecha". */}
            <button
              type="button"
              onClick={onClose}
              title={t("Cerrar panel")}
              aria-label={t("Cerrar panel")}
              className="absolute left-2 top-1/2 z-20 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-ink text-surface shadow-md ring-1 ring-black/10 transition hover:scale-105 hover:bg-brand active:scale-95"
            >
              <ChevronRight size={16} />
            </button>

            {/* Ancho fijo = target: mientras el aside anima su width, este contenido
                mantiene su tamaño y el overflow-hidden lo recorta → efecto slide/reveal
                (no se aplasta). */}
            <div className="flex min-w-0 shrink-0 flex-col" style={{ width }}>
              <header className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-3 py-2">
                <FileText size={16} className="mr-1 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {artifact.title || t("Documento")}
                  {isDocLike ? <span className="ml-1.5 text-xs font-normal text-muted">· DOCX</span> : null}
                </span>
                {/* Acciones estilo claude.ai: iconos en el header (no barra abajo). */}
                {isDocLike ? (
                  <>
                    {editUrl ? (
                      <button
                        type="button"
                        onClick={() => setEditUrl(null)}
                        title={t("Ver documento")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        <Eye size={15} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleEdit}
                        disabled={converting}
                        title={t("Editar")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand disabled:opacity-50"
                      >
                        {converting ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />}
                      </button>
                    )}
                    {downloadHref ? (
                      <a
                        href={downloadHref}
                        download
                        {...(artifact.kind === "office" ? { target: "_blank", rel: "noreferrer" } : {})}
                        title={t("Descargar Word")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        <Download size={15} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setRefreshTick((n) => n + 1)}
                      title={t("Actualizar")}
                      className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                    >
                      <RotateCw size={15} />
                    </button>
                  </>
                ) : externalHref ? (
                  <a
                    href={externalHref}
                    target="_blank"
                    rel="noreferrer"
                    className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                    title={t("Abrir en pestaña nueva")}
                  >
                    <ExternalLink size={15} />
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    const max = window.innerWidth - CHAT_MIN;
                    setExpanded((e) => !e);
                    setWidth(expanded ? Math.min(DEFAULT_W, max) : max);
                  }}
                  title={expanded ? t("Reducir") : t("Expandir")}
                  className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                >
                  {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
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
                {artifact.kind === "draft" ? (
                  // Redacción EN VIVO (Canvas): el markdown streamea a la hoja mientras
                  // el agente escribe; al terminar se reemplaza por el .docx real.
                  <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                    <article className="mx-auto max-w-[8.5in] rounded-sm bg-white p-10 shadow-md sm:p-14">
                      <Markdown body={artifact.md} light />
                      {artifact.streaming ? (
                        <span className="mt-1 inline-block h-4 w-[3px] animate-pulse bg-brand align-text-bottom" />
                      ) : null}
                    </article>
                  </div>
                ) : artifact.kind === "image" ? (
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
                ) : artifact.kind === "office" ? (
                  // Modo EDICIÓN: EasyBits importó el docx a un doc editable → editor colab.
                  editUrl ? (
                    <iframe src={editUrl} title={artifact.title || "editor"} className="size-full border-0 bg-white" />
                  ) : (
                    // Preview PROPIO: EasyBits convierte el .docx a HTML (mammoth) server-side
                    // y lo renderizamos inline en una "hoja" tipo Word. NO manda la URL a
                    // Microsoft (privado), sin CORS. Barra: Editar (importa a editable) · Descargar.
                    <div className="flex h-full flex-col">
                      <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                        {officeState === "loading" ? (
                          <div className="grid h-full place-items-center text-muted">
                            <Loader2 size={20} className="animate-spin" />
                          </div>
                        ) : officeHtml ? (
                          <article
                            className="prose prose-sm mx-auto max-w-[8.5in] rounded-sm bg-white p-10 text-black shadow-md sm:p-14"
                            // HTML sanitizado con DOMPurify antes de setState.
                            dangerouslySetInnerHTML={{ __html: officeHtml }}
                          />
                        ) : (
                          <div className="grid h-full place-items-center p-6">
                            <a href={artifact.src} target="_blank" rel="noreferrer" download className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center transition hover:border-brand">
                              <FileText size={40} className="text-brand" />
                              <span className="max-w-xs truncate text-sm text-ink">{artifact.title || t("Documento")}</span>
                              <span className="text-xs text-muted">
                                {t("Vista previa solo para Word (.docx) por ahora — descarga el archivo")}
                              </span>
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                ) : artifact.kind === "doc" ? (
                  // Documento VIVO: preview de las secciones actuales (se AUTO-REFRESCA cuando
                  // el agente modifica) · Editar (editor colab) · Descargar Word.
                  editUrl ? (
                    <iframe src={editUrl} title={artifact.title || "editor"} className="size-full border-0 bg-white" />
                  ) : (
                    <div className="flex h-full flex-col">
                      <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                        {officeState === "loading" && !officeHtml ? (
                          <div className="grid h-full place-items-center text-muted">
                            <Loader2 size={20} className="animate-spin" />
                          </div>
                        ) : officeHtml ? (
                          <article
                            className="prose prose-sm mx-auto max-w-[8.5in] rounded-sm bg-white p-10 text-black shadow-md sm:p-14"
                            dangerouslySetInnerHTML={{ __html: officeHtml }}
                          />
                        ) : (
                          <div className="grid h-full place-items-center text-sm text-muted">{t("Sin contenido")}</div>
                        )}
                      </div>
                    </div>
                  )
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
