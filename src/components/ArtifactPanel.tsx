import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, FileText, Download, Loader2, ChevronRight, ChevronLeft, RotateCw, Upload } from "lucide-react";
import { useT } from "../i18n";
import { officeToHtmlFn, xlsxToCsvFn, postMessage } from "../server/chat";
import { listTeamDocumentsFn, type TeamDocument } from "../server/documents";
import { Markdown } from "./Markdown";

// Un documento del team (generado o subido) → vista del panel. Null si no es
// previsualizable. Reusado por el índice Cowork (kind:"docindex").
export function docToView(d: TeamDocument): ArtifactView | null {
  if (d.source === "uploaded" && d.fileId) {
    const src = `/api/attachment/${encodeURIComponent(d.fileId)}`;
    if (d.kind === "pdf") return { kind: "pdf", title: d.title, src };
    if (d.kind === "office") return { kind: "office", title: d.title, src };
    if (d.kind === "image") return { kind: "image", title: d.title, src };
    return { kind: "file", title: d.title, src };
  }
  if (d.kind === "doc") return { kind: "doc", title: d.title, documentId: d.documentId ?? d.key, md: d.md ?? "" };
  if (d.kind === "sheet") return { kind: "sheet", title: d.title, documentId: d.documentId ?? d.key, csv: d.md ?? "" };
  if (d.kind === "html" && d.documentId) return { kind: "html", title: d.title, embedUrl: d.documentId };
  // Doc GENERADO y hospedado (pdf/imagen/office/file): `documentId` = URL pública (g.url).
  // Antes caía a `null` → en el índice salía DISABLED (opacity-70) "como si ya no existiera",
  // aunque abre bien desde la tarjeta del chat (que usa esa misma URL).
  if (d.source === "generated" && d.documentId) {
    const src = d.documentId;
    if (d.kind === "pdf") return { kind: "pdf", title: d.title, src };
    if (d.kind === "image") return { kind: "image", title: d.title, src };
    if (d.kind === "office") return { kind: "office", title: d.title, src };
    if (d.kind === "file") return { kind: "file", title: d.title, src };
  }
  return null;
}

// Cache a nivel módulo de la lista de documentos del team (patrón forms.tsx/artifacts.tsx):
// abrir el índice 📂 muestra al instante lo cacheado y refresca en background — sin spinner
// cada vez. Se invalida al re-abrir (refreshTick) o al recargar la app.
let docsIndexCache: TeamDocument[] | null = null;

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
  | { kind: "sheet"; title: string; documentId: string; csv: string } // hoja viva (CSV local + versiones)
  // ask-user: pregunta con opciones clicables. Se pinta INLINE en el bubble (AskUserCard);
  // esta variante solo cubre el fallback read-only si se abriera en el panel.
  | { kind: "ask-user"; title: string; question: string; options: string[] }
  // Índice Cowork: lista los documentos de UN caso (room) como tiles; clic abre uno.
  // channelSlug para subir archivos al caso directo desde el panel (sin el agente).
  // threadRootId (opcional): abierto desde un HILO → toggle "Este hilo / Todo el caso".
  | { kind: "docindex"; title: string; channelId: number; channelSlug: string; threadRootId?: number };

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

// Documentos office (Word/Excel/PowerPoint) por MIME o por extensión (el MIME a
// veces llega genérico octet-stream). Se abren en el panel con preview propio
// (mammoth docx→HTML inline) + descarga → el expediente que el usuario arroja al
// room queda VISIBLE como artefacto, no solo como card de adjunto.
const OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.ms-powerpoint", // ppt
]);
function isOfficeDoc(mime: string, name?: string | null): boolean {
  if (OFFICE_MIMES.has(mime)) return true;
  return /\.(docx?|xlsx?|pptx?)$/i.test(name ?? "");
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
  if (isOfficeDoc(mime, a.name)) return { kind: "office", title, src };
  return null;
}

const DEFAULT_W = 680;
const MIN_W = 360;
const CHAT_MIN = 380; // deja SIEMPRE espacio de chat a la izquierda (split, no overlay)
const STORE_KEY = "eb_artifact_w";

export default function ArtifactPanel({
  artifact: rootArtifact,
  onClose,
}: {
  artifact: ArtifactView | null;
  onClose: () => void;
  onOpen?: (a: ArtifactView) => void; // (compat) el caller aún lo pasa; el drill-down es interno (`detail`)
}) {
  // Drill-down índice→doc como estado INTERNO (`detail`): NO cambia `rootArtifact` (el
  // estado de "abierto") → el aside no se remonta al seleccionar → SIN re-slide/doble
  // apertura. `artifact` = la vista EFECTIVA (todo el render existente la usa sin cambios).
  // `open` = único disparador del slide (abrir/cerrar). Ver análisis en el plan.
  const [detail, setDetail] = useState<ArtifactView | null>(null);
  const artifact = detail ?? rootArtifact;
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
  const scrollRef = useRef<HTMLDivElement>(null); // contenedor del draft en vivo → auto-scroll al escribir
  // Preview PROPIO de un .docx ADJUNTO (subido por el usuario): EasyBits lo convierte a HTML
  // (mammoth) y lo renderizamos inline. "loading" | HTML sanitizado | "error" (xlsx/pptx no
  // soportados → descarga). Los docs que REDACTA el agente NO pasan por aquí: son `md` local.
  const [officeHtml, setOfficeHtml] = useState<string | null>(null);
  const [officeState, setOfficeState] = useState<"idle" | "loading" | "error">("idle");
  const [sheetCsv, setSheetCsv] = useState<string | null>(null); // xlsx → CSV (SheetJS, lazy)
  const [sheetState, setSheetState] = useState<"idle" | "loading" | "error">("idle");
  const [idxDocs, setIdxDocs] = useState<TeamDocument[] | null>(null); // docindex: docs del room (Cowork)
  const [idxScope, setIdxScope] = useState<"thread" | "case">("case"); // alcance del índice
  const [uploadingDoc, setUploadingDoc] = useState(false); // subir archivo al caso desde el índice
  const [dropActive, setDropActive] = useState(false); // arrastrar-y-soltar sobre el índice
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refreshTick, setRefreshTick] = useState(0); // botón "refrescar" del header (re-fetch manual)
  const [downloading, setDownloading] = useState(false); // el export docx es lento → spinner

  // ESC cierra el panel, igual que el visor de docs (Modal). Solo activo cuando hay
  // artefacto abierto. Si estás en un drill-down (detail), ESC vuelve al índice primero.
  useEffect(() => {
    if (!rootArtifact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (detail) setDetail(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootArtifact, detail, onClose]);
  // Identidad ESTABLE del artefacto → el effect de fetch office NO se re-dispara al reabrir
  // el MISMO artefacto. El draft usa id constante para que su streaming NO resetee.
  const officeSrc = artifact?.kind === "office" ? artifact.src : null;
  // xlsx no lo cubre mammoth (docx-only) → lo previsualizamos con SheetJS (§effect abajo).
  const isXlsx = artifact?.kind === "office" && /\.xlsx?$/i.test(artifact.title ?? "");
  const isDocLike = artifact?.kind === "doc" || artifact?.kind === "office" || artifact?.kind === "sheet";
  // Badge por tipo REAL: sheet vivo = CSV, doc generado = DOCX, office = su extensión
  // real (XLSX/PPTX/DOCX) derivada del nombre — no hardcodear DOCX para todo office.
  const extBadge = (title?: string): string | null => {
    const m = /\.(docx?|xlsx?|pptx?|pdf)$/i.exec(title ?? "");
    return m ? m[1].toUpperCase() : null;
  };
  const docBadge =
    artifact?.kind === "sheet"
      ? "CSV"
      : artifact?.kind === "doc"
        ? "DOCX"
        : artifact?.kind === "office"
          ? extBadge(artifact.title) ?? "DOCX"
          : null;
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
              : artifact.kind === "docindex"
                ? `docindex:${artifact.channelId}`
                : artifact.kind === "ask-user"
                  ? "ask-user"
                  : `${artifact.kind}:${artifact.src}`;
  // Al cambiar a OTRO artefacto, resetea el preview office.
  useEffect(() => {
    setOfficeHtml(null);
    setOfficeState("idle");
    setSheetCsv(null);
    setSheetState("idle");
  }, [artifactId]);
  // Al abrir/cerrar un artefacto NUEVO desde afuera (rootArtifact cambia), sal del detalle.
  // Seleccionar en el índice (setDetail) NO cambia rootArtifact → el detalle persiste.
  useEffect(() => {
    setDetail(null);
  }, [rootArtifact]);
  // Fetch del HTML del preview de un .docx ADJUNTO (mammoth). Solo docx; xlsx va por SheetJS.
  useEffect(() => {
    if (!officeSrc || isXlsx) return;
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
  }, [officeSrc, refreshTick, isXlsx]);
  // Preview de XLSX: SheetJS (lazy) parsea el .xlsx → CSV → tabla (mammoth es docx-only).
  // Fetch same-origin del adjunto (/api/attachment) con la sesión del navegador.
  useEffect(() => {
    if (!officeSrc || !isXlsx) return;
    let alive = true;
    setSheetState("loading");
    xlsxToCsvFn({ data: { url: officeSrc } })
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setSheetCsv(r.csv);
          setSheetState("idle");
        } else {
          setSheetState("error");
        }
      })
      .catch(() => {
        if (alive) setSheetState("error");
      });
    return () => {
      alive = false;
    };
  }, [officeSrc, isXlsx, refreshTick]);
  // Índice Cowork (kind:"docindex"): trae los docs del team (ya scopeados por membresía)
  // y los filtra al caso (room) abierto. Tiles → clic abre el doc vía onOpen.
  const idxChannelId = rootArtifact?.kind === "docindex" ? rootArtifact.channelId : null;
  const idxThreadRootId = rootArtifact?.kind === "docindex" ? rootArtifact.threadRootId : undefined;
  // Default del alcance: abierto desde un HILO → "Este hilo"; desde el room → "Todo el caso".
  useEffect(() => {
    setIdxScope(idxThreadRootId != null ? "thread" : "case");
  }, [idxChannelId, idxThreadRootId]);
  // Docs de ESTE hilo: por threadRootId (GLOBAL) → funciona aunque el room seleccionado no
  // sea el del hilo. La "sala" real del índice = el canal de esos docs (o idxChannelId si el
  // hilo aún no tiene docs). "Todo el room" muestra los docs de esa sala REAL, no la seleccionada.
  const threadDocs =
    idxDocs && idxThreadRootId != null ? idxDocs.filter((d) => d.threadRootId === idxThreadRootId) : null;
  const roomChannelId = threadDocs && threadDocs.length ? threadDocs[0].channelId : idxChannelId;
  const roomDocs = idxDocs ? idxDocs.filter((d) => d.channelId === roomChannelId) : null;
  const roomLabel =
    (threadDocs && threadDocs.length ? threadDocs[0].channelName : null) ??
    (roomDocs && roomDocs.length ? roomDocs[0].channelName : null) ??
    null;
  const shownDocs = idxScope === "thread" && idxThreadRootId != null ? threadDocs : roomDocs;
  useEffect(() => {
    if (idxChannelId == null) return;
    let alive = true;
    // Guardamos TODOS los docs accesibles (el alcance se filtra en `shownDocs`): así el
    // alcance "Este hilo" funciona por threadRootId aunque el room seleccionado NO sea el
    // del hilo (ThreadView pasa el room seleccionado, no el real → el channelId podía no
    // coincidir). Cache-first: pinta al instante, refresca en background.
    if (docsIndexCache) setIdxDocs(docsIndexCache);
    else setIdxDocs(null);
    listTeamDocumentsFn()
      .then((all) => {
        docsIndexCache = all;
        if (alive) setIdxDocs(all);
      })
      .catch(() => { if (alive && !docsIndexCache) setIdxDocs([]); });
    return () => { alive = false; };
  }, [idxChannelId, refreshTick]);
  // Auto-scroll EN VIVO: mientras el agente ESCRIBE el draft (streaming), seguimos el
  // texto conforme aparece → "ver construirse" el documento. Solo durante el streaming
  // (al terminar, no peleamos el scroll del usuario).
  const draftLen = artifact?.kind === "draft" ? artifact.content.length : 0;
  const draftStreaming = artifact?.kind === "draft" && !!artifact.streaming;
  useEffect(() => {
    if (!draftStreaming) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draftLen, draftStreaming]);
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

  // Subir archivo(s) directo al CASO desde el índice (sin pasar por el agente): sube a
  // EasyBits privado (/api/upload) y lo cuelga del room como adjunto SIN @mención → el
  // agente no responde; el archivo aparece en el índice y en el room.
  const doUploadToCase = async (files: FileList | null) => {
    if (!files?.length || artifact?.kind !== "docindex") return;
    // Sube al room REAL del hilo (derivado de sus docs), NO al room seleccionado: en un hilo
    // cuyo room ≠ el seleccionado (o estando en #general) el slug seleccionado mandaba el
    // archivo al chat equivocado y no aparecía en esta lista. Fallback al slug del artefacto.
    const slug = threadDocs?.[0]?.channelSlug ?? roomDocs?.[0]?.channelSlug ?? artifact.channelSlug;
    setUploadingDoc(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        if (!r.ok) continue;
        const up = (await r.json()) as { fileId: string; mime: string; size: number; name: string };
        await postMessage({ data: { slug, parentId: null, body: "", attachments: [up] } });
      }
      docsIndexCache = null; // invalida el cache → el refresh trae el nuevo
      setRefreshTick((n) => n + 1);
    } catch {
      alert(t("No se pudo subir. Intenta de nuevo."));
    } finally {
      setUploadingDoc(false);
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

  // ↗ "abrir en pestaña nueva" (reemplaza el botón expandir, que era defectuoso). Donde
  // hay URL real: docindex → la página global /artifacts; office/pdf/imagen/etc → su src
  // (firmado); html → embed. doc/sheet (md local) y draft no tienen URL → sin botón.
  const newTabHref =
    !artifact || artifact.kind === "draft" || artifact.kind === "doc" || artifact.kind === "sheet" || artifact.kind === "ask-user"
      ? undefined
      : artifact.kind === "docindex"
        ? "/artifacts"
        : artifact.kind === "html"
          ? artifact.embedUrl
          : artifact.src;

  return (
    <AnimatePresence>
      {/* Estructura IDÉNTICA a la de ayer (HEAD 3697c7b, cierre animado OK): fragmento
          gated en `rootArtifact` (abrir/cerrar). El drill-down índice→doc es INTERNO
          (`detail`) → NO cambia `rootArtifact` → el aside NO se remonta → sin re-slide.
          El contenido usa la sombra `artifact` (= detail ?? rootArtifact), envuelto para TS. */}
      {rootArtifact ? (
        <>
          {/* Backdrop SOLO en móvil (overlay). En desktop el panel va en-flujo (split). */}
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 flex h-full max-w-full overflow-hidden border-l border-border bg-surface shadow-2xl md:relative md:z-auto md:h-auto md:max-w-[75vw] md:shrink-0 md:shadow-none md:self-stretch"
            initial={{ width: 0 }}
            animate={{ width }}
            exit={{ width: 0 }}
            transition={isDragging ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 34 }}
          >
            {artifact ? (
              <>
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
            {/* Contenido: cambio INSTANTÁNEO al alternar de artefacto estando el panel ya
                abierto (sin fade ni re-animación → no se siente como "abrir de nuevo"). El
                deslizamiento vive solo en el motion.aside (abrir/cerrar). */}
            <div className="flex min-w-0 shrink-0 flex-col" style={{ width }}>
              <header className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-3 py-2">
                {detail ? (
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    title={t("Volver a Documentos")}
                    className="mr-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-md py-1 pl-1 pr-1.5 text-xs font-medium text-muted transition hover:bg-surface-3 hover:text-ink"
                  >
                    <ChevronLeft size={16} /> {t("Documentos")}
                  </button>
                ) : (
                  <FileText size={16} className="mr-1 shrink-0 text-muted" />
                )}
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
                        title={downloading ? t("Descargando…") : artifact.kind === "sheet" ? t("Descargar CSV") : artifact.kind === "office" ? t("Descargar") : t("Descargar Word")}
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
                ) : null}
                {newTabHref ? (
                  <a
                    href={newTabHref}
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
                  onClick={onClose}
                  className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
                  title={t("Cerrar")}
                >
                  <X size={16} />
                </button>
              </header>

              <div className="relative min-h-0 flex-1 overflow-auto bg-surface-3">
                {artifact.kind === "docindex" ? (
                  // Índice Cowork: los documentos del caso (room). Arriba, subir archivo
                  // directo al caso (sin el agente); abajo, la lista; clic abre uno.
                  // Toda el área es zona de DROP (arrastrar-y-soltar archivos al caso).
                  <div
                    className={`relative flex min-h-0 flex-1 flex-col p-3 sm:p-4 ${dropActive ? "ring-2 ring-inset ring-brand" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!dropActive) setDropActive(true);
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget === e.target) setDropActive(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropActive(false);
                      void doUploadToCase(e.dataTransfer.files);
                    }}
                  >
                    {dropActive ? (
                      <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg bg-brand/10 text-sm font-semibold text-brand backdrop-blur-[1px]">
                        <span className="inline-flex items-center gap-2">
                          <Upload size={18} /> {t("Suelta para subir a este room")}
                        </span>
                      </div>
                    ) : null}
                    {/* Nombre del ROOM (real, derivado de los docs) + conteo → claridad de dónde estás. */}
                    <div className="mb-2 flex shrink-0 items-center gap-1.5 text-xs">
                      <span className="min-w-0 truncate font-semibold text-ink">
                        {idxScope === "thread" && idxThreadRootId != null
                          ? t("Este hilo")
                          : roomLabel
                            ? `# ${roomLabel}`
                            : t("Documentos")}
                      </span>
                      {shownDocs ? (
                        <span className="shrink-0 text-muted">
                          · {shownDocs.length} {shownDocs.length === 1 ? t("documento") : t("documentos")}
                        </span>
                      ) : null}
                    </div>
                    {idxThreadRootId != null ? (
                      // Alcance: docs de ESTE hilo vs TODO el room (mismo artefacto). El room muestra su nombre.
                      <div className="mb-3 flex shrink-0 gap-1 rounded-lg bg-surface-3 p-0.5 text-xs font-medium">
                        <button
                          type="button"
                          onClick={() => setIdxScope("thread")}
                          className={`flex-1 truncate rounded-md px-2 py-1 transition ${idxScope === "thread" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                        >
                          {t("Este hilo")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setIdxScope("case")}
                          className={`flex-1 truncate rounded-md px-2 py-1 transition ${idxScope === "case" ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                        >
                          {roomLabel ? `# ${roomLabel}` : t("Todo el room")}
                        </button>
                      </div>
                    ) : null}
                    {/* Área de DROP VISIBLE (además de que todo el panel acepta soltar). Clic = picker. */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingDoc}
                      className="mb-3 flex shrink-0 items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-xs font-medium text-muted transition hover:border-brand hover:text-brand disabled:opacity-60"
                    >
                      {uploadingDoc ? (
                        <>
                          <Loader2 size={14} className="animate-spin" /> {t("Subiendo…")}
                        </>
                      ) : (
                        <>
                          <Upload size={14} /> {t("Arrastra archivos aquí o haz clic para subir")}
                        </>
                      )}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        void doUploadToCase(e.target.files);
                        e.currentTarget.value = "";
                      }}
                    />
                    <div className="min-h-0 flex-1 overflow-auto">
                    {shownDocs === null ? (
                      <div className="grid h-full place-items-center text-muted">
                        <Loader2 size={20} className="animate-spin" />
                      </div>
                    ) : shownDocs.length === 0 ? (
                      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
                        {idxScope === "thread" ? t("Este hilo aún no tiene documentos.") : t("Este room aún no tiene documentos.")}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {shownDocs.map((d) => {
                          const v = docToView(d);
                          return (
                            <button
                              key={d.key}
                              type="button"
                              onClick={() => {
                                if (!v) return;
                                // Drill-down INTERNO: no cambia rootArtifact → el aside no se
                                // remonta (sin re-slide). "← Documentos" vuelve con setDetail(null).
                                setDetail(v);
                              }}
                              className={`flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-left transition hover:border-brand ${v ? "cursor-pointer" : "cursor-default opacity-70"}`}
                            >
                              {d.kind === "image" && d.fileId ? (
                                // Thumbnail real de la imagen subida (el tile ya no muestra ícono genérico).
                                <img
                                  src={`/api/attachment/${encodeURIComponent(d.fileId)}`}
                                  alt=""
                                  loading="lazy"
                                  className="size-9 shrink-0 rounded-lg object-cover"
                                />
                              ) : (
                                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3">
                                  <FileText size={18} className="text-brand" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-ink">{d.title}</div>
                                <div className="mt-0.5 truncate text-xs text-muted">
                                  {d.source === "generated" ? t("Redactado") : t("Subido")} · {d.kind === "sheet" ? "hoja" : d.kind}
                                  {d.createdAt
                                    ? ` · ${new Date(d.createdAt * 1000).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                                    : ""}
                                  {d.versions && d.versions > 1 ? ` · ${d.versions} versiones` : ""}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    </div>
                  </div>
                ) : artifact.kind === "draft" ? (
                  // Redacción EN VIVO (Canvas): prosa (markdown) o tabla (csv) streamea a la
                  // hoja mientras el agente escribe; al cerrar el fence pasa a doc/sheet real.
                  <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
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
                      {isXlsx ? (
                        sheetState === "loading" ? (
                          <div className="grid h-full place-items-center text-muted">
                            <Loader2 size={20} className="animate-spin" />
                          </div>
                        ) : sheetCsv && sheetCsv.trim() ? (
                          <div className="mx-auto max-w-full rounded-sm bg-white p-4 shadow-md sm:p-6">
                            <CsvTable csv={sheetCsv} />
                          </div>
                        ) : (
                          <div className="grid h-full place-items-center p-6">
                            <a href={artifact.src} target="_blank" rel="noreferrer" download className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center transition hover:border-brand">
                              <FileText size={40} className="text-brand" />
                              <span className="max-w-xs truncate text-sm text-ink">{artifact.title || t("Documento")}</span>
                              <span className="text-xs text-muted">{t("Descarga el archivo")}</span>
                            </a>
                          </div>
                        )
                      ) : officeState === "loading" ? (
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
                ) : artifact.kind === "ask-user" ? (
                  // Fallback read-only (lo normal es que se pinte inline en el chat, no aquí).
                  <div className="grid min-h-full place-items-center p-6">
                    <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5">
                      <p className="mb-3 text-sm font-medium text-ink">{artifact.question || t("Elige una opción")}</p>
                      <div className="flex flex-col gap-2">
                        {artifact.options.map((o, i) => (
                          <div key={i} className="rounded-lg border border-border px-3 py-2 text-sm text-muted">{o}</div>
                        ))}
                      </div>
                      <p className="mt-3 text-xs text-muted">{t("Responde desde el chat.")}</p>
                    </div>
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
              </>
            ) : null}
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
