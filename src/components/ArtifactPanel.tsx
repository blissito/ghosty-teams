import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText, Download, Loader2, ChevronRight, RotateCw, Maximize2, Minimize2 } from "lucide-react";
import { useT } from "../i18n";
import { officeToHtmlFn } from "../server/chat";
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
  // Redacción EN VIVO (Canvas): prosa (markdown) o tabla (csv), según `sheet`.
  | { kind: "draft"; title: string; content: string; sheet: boolean; streaming?: boolean }
  | { kind: "doc"; title: string; documentId: string; md: string } // documento vivo (markdown local + versiones)
  | { kind: "sheet"; title: string; documentId: string; csv: string }; // hoja viva (CSV local + versiones)

// URL del VISOR OFICIAL de Microsoft (Office Online) para un office con URL pública. Word/
// Excel/PowerPoint renderizados fieles. Microsoft hace fetch server-side → solo sirve con
// URLs públicas (no el proxy /api/attachment autenticado). Devuelve null si no aplica.
export function officeViewerSrc(src: string): string | null {
  if (!/^https?:\/\//i.test(src) || /\/api\/attachment\//.test(src)) return null;
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(src)}`;
}

// Parse CSV mínimo (comillas dobles, comas y saltos escapados). Suficiente para el CSV que
// el agente emite en ```eb-sheet```. Devuelve filas de celdas.
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = csv.replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ""));
}

// Render de una hoja CSV como tabla estilo planilla (primera fila = encabezado).
function CsvTable({ csv }: { csv: string }) {
  const rows = parseCsv(csv);
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <div className="mx-auto max-w-full overflow-x-auto rounded-sm bg-white shadow-md">
      <table className="w-full border-collapse text-sm text-black">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-left font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className={ri % 2 ? "bg-neutral-50" : ""}>
              {head.map((_, ci) => (
                <td key={ci} className="border border-neutral-200 px-3 py-1.5 align-top">{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  // Preview PROPIO de un .docx ADJUNTO (subido por el usuario): EasyBits lo convierte a HTML
  // (mammoth) y lo renderizamos inline. "loading" | HTML sanitizado | "error" (xlsx/pptx no
  // soportados → descarga). Los docs que REDACTA el agente NO pasan por aquí: son `md` local.
  const [officeHtml, setOfficeHtml] = useState<string | null>(null);
  const [officeState, setOfficeState] = useState<"idle" | "loading" | "error">("idle");
  const [refreshTick, setRefreshTick] = useState(0); // botón "refrescar" del header (re-fetch manual)
  const [expanded, setExpanded] = useState(false); // botón "expandir" (ancho máximo)
  const [downloading, setDownloading] = useState(false); // el export docx es lento → spinner
  // Identidad ESTABLE del artefacto → el effect de fetch office NO se re-dispara al reabrir
  // el MISMO artefacto. El draft usa id constante para que su streaming NO resetee.
  const officeSrc = artifact?.kind === "office" ? artifact.src : null;
  const isDocLike = artifact?.kind === "doc" || artifact?.kind === "office" || artifact?.kind === "sheet";
  const docBadge =
    artifact?.kind === "sheet" ? "CSV" : artifact?.kind === "doc" || artifact?.kind === "office" ? "DOCX" : null;
  const downloadHref =
    artifact?.kind === "doc"
      ? `/api/doc-docx/${encodeURIComponent(artifact.documentId)}?name=${encodeURIComponent(artifact.title || "documento")}`
      : artifact?.kind === "office"
        ? artifact.src
        : null; // sheet → descarga CSV client-side (blob), ver doDownload
  const artifactId = !artifact
    ? null
    : artifact.kind === "office"
      ? `office:${artifact.src}`
      : artifact.kind === "doc"
        ? `doc:${artifact.documentId}`
        : artifact.kind === "sheet"
          ? `sheet:${artifact.documentId}`
          : artifact.kind === "draft"
            ? "draft"
            : artifact.kind === "html"
              ? `html:${artifact.embedUrl}`
              : `${artifact.kind}:${artifact.src}`;
  // Al cambiar a OTRO artefacto, resetea el preview office.
  useEffect(() => {
    setOfficeHtml(null);
    setOfficeState("idle");
  }, [artifactId]);
  // Fetch del HTML del preview de un .docx ADJUNTO (mammoth). Solo office; el doc del agente
  // se renderiza desde su markdown local (sin fetch).
  useEffect(() => {
    if (!officeSrc) return;
    let alive = true;
    setOfficeState("loading");
    (async () => {
      try {
        const r = await officeToHtmlFn({ data: { url: officeSrc } });
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
  }, [officeSrc, refreshTick]);
  // Descarga con FEEDBACK: el export docx (doc) tarda; fetch same-origin → blob → download,
  // con spinner. Office = URL pública externa → navegación directa (evita CORS del blob).
  // Sheet = el CSV vive en el cliente → blob directo, sin red.
  const doDownload = async () => {
    if (downloading) return;
    if (artifact?.kind === "sheet") {
      const blob = new Blob([artifact.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(artifact.title || "hoja").replace(/[^\w.\- ]/g, "_")}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return;
    }
    if (!downloadHref) return;
    if (artifact?.kind === "office") {
      window.open(downloadHref, "_blank", "noopener");
      return;
    }
    setDownloading(true);
    try {
      const r = await fetch(downloadHref);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(artifact?.title || "documento").replace(/[^\w.\- ]/g, "_")}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      alert(t("No se pudo descargar. Intenta de nuevo."));
    } finally {
      setDownloading(false);
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
    !artifact ||
    artifact.kind === "draft" ||
    artifact.kind === "office" ||
    artifact.kind === "doc" ||
    artifact.kind === "sheet"
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
                  {docBadge ? <span className="ml-1.5 text-xs font-normal text-muted">· {docBadge}</span> : null}
                </span>
                {/* Acciones estilo claude.ai: iconos en el header (no barra abajo). La EDICIÓN
                    de un doc/hoja del agente se hace CHATEANDO (se re-redacta en vivo) — sin
                    editor embebido. Aquí solo Descargar y, para un .docx adjunto, Actualizar. */}
                {isDocLike ? (
                  <>
                    {downloadHref || artifact.kind === "sheet" ? (
                      <button
                        type="button"
                        onClick={doDownload}
                        disabled={downloading}
                        title={downloading ? t("Descargando…") : artifact.kind === "sheet" ? t("Descargar CSV") : t("Descargar Word")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand disabled:opacity-60"
                      >
                        {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                      </button>
                    ) : null}
                    {artifact.kind === "office" ? (
                      <button
                        type="button"
                        onClick={() => setRefreshTick((n) => n + 1)}
                        title={t("Actualizar")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        <RotateCw size={15} />
                      </button>
                    ) : null}
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
                  // Redacción EN VIVO (Canvas): prosa (markdown) o tabla (csv) streamea a la
                  // hoja mientras el agente escribe; al cerrar el fence pasa a doc/sheet real.
                  <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                    {artifact.sheet ? (
                      <>
                        <CsvTable csv={artifact.content} />
                        {artifact.streaming ? (
                          <span className="mt-2 inline-block h-4 w-[3px] animate-pulse bg-brand" />
                        ) : null}
                      </>
                    ) : (
                      <article className="mx-auto max-w-[8.5in] rounded-sm bg-white p-10 shadow-md sm:p-14">
                        <Markdown body={artifact.content} light />
                        {artifact.streaming ? (
                          <span className="mt-1 inline-block h-4 w-[3px] animate-pulse bg-brand align-text-bottom" />
                        ) : null}
                      </article>
                    )}
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
                  // Office (.docx/.xlsx/.pptx). Preview propio con mammoth (docx → HTML, privado)
                  // cuando existe; si no (xlsx/pptx, o mammoth vacío) y la URL es pública →
                  // VISOR OFICIAL DE MICROSOFT (Office Online) embebido, que renderiza fiel
                  // Word/Excel/PowerPoint. Fallback final: card de descarga.
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
                      ) : officeViewerSrc(artifact.src) ? (
                        <iframe
                          src={officeViewerSrc(artifact.src)!}
                          title={artifact.title || "Office"}
                          className="mx-auto block h-full w-full max-w-[8.5in] rounded-sm border-0 bg-white shadow-md"
                        />
                      ) : (
                        <div className="grid h-full place-items-center p-6">
                          <a href={artifact.src} target="_blank" rel="noreferrer" download className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center transition hover:border-brand">
                            <FileText size={40} className="text-brand" />
                            <span className="max-w-xs truncate text-sm text-ink">{artifact.title || t("Documento")}</span>
                            <span className="text-xs text-muted">{t("Descarga el archivo")}</span>
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                ) : artifact.kind === "sheet" ? (
                  // Hoja de cálculo VIVA: el CSV FUENTE (local) se renderiza como tabla. Mismo
                  // render que el draft de hoja en vivo → al modificarla (chateando), el draft
                  // streamea encima y al cerrarse vuelve aquí con la nueva versión.
                  <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                    {(artifact.csv ?? "").trim() ? (
                      <CsvTable csv={artifact.csv} />
                    ) : (
                      <div className="grid h-full place-items-center text-sm text-neutral-400">{t("Sin contenido")}</div>
                    )}
                  </div>
                ) : artifact.kind === "doc" ? (
                  // Documento VIVO: el markdown FUENTE (local) se renderiza en una "hoja" tipo
                  // Word. Es el MISMO render que el draft en vivo → al modificarlo (chateando),
                  // el draft streamea encima y al cerrarse vuelve aquí con la nueva versión.
                  // Editar = chatear con el agente (re-redacta completo). Descargar Word arriba.
                  <div className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                    <article className="mx-auto max-w-[8.5in] rounded-sm bg-white p-10 text-black shadow-md sm:p-14">
                      {(artifact.md ?? "").trim() ? (
                        <Markdown body={artifact.md} light />
                      ) : (
                        <div className="grid h-full place-items-center text-sm text-neutral-400">{t("Sin contenido")}</div>
                      )}
                    </article>
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
