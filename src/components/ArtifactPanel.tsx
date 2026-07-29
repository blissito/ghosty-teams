import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ARTIFACT_CHROME_CSS } from "../lib/artifact-stream-doc";
import { LiveArtifactPreview, ArtifactSkeleton, ArtifactCalque } from "./LiveArtifactPreview";
import { X, ExternalLink, FileText, Download, Loader2, ChevronRight, ChevronLeft, RotateCw, Upload, Link as LinkIcon, Check, Pencil, Eye, Maximize2, Minimize2, Printer } from "lucide-react";
import { useT } from "../i18n";
import { officeToHtmlFn, xlsxToCsvFn, postMessage } from "../server/chat";
import { listTeamDocumentsFn, type TeamDocument } from "../server/documents";
import { updateArtifactHtmlFn } from "../server/artifacts";
import { CanvasEditor, EditorStore, htmlToDoc, htmlToNode, docToHtml, type Node as CeNode } from "@ghosty/canvas-editor";
import ArtifactShareBar from "./ArtifactShareBar";
import DocSurface from "./DocSurface";

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
// Mismo cromado que el artefacto en construcción: scrollbar del tema (no la barra blanca
// del sistema) dentro del iframe del resultado.
function withArtifactChrome(html: string): string {
  const tag = `<style>${ARTIFACT_CHROME_CSS}</style>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}

export type ArtifactView =
  | { kind: "pdf"; title: string; src: string }
  | { kind: "image"; title: string; src: string }
  | { kind: "audio"; title: string; src: string }
  | { kind: "video"; title: string; src: string }
  | { kind: "office"; title: string; src: string } // docx/xlsx/pptx → preview (visor) + descarga
  | { kind: "file"; title: string; src: string } // fallback genérico → descarga
  | { kind: "html"; title: string; embedUrl: string }
  // Redacción EN VIVO (Canvas): prosa (markdown), tabla (csv) o HTML (artifact). `sheet`/`artifact`
  // eligen el render; los tres streamean por el mismo camino de draft.
  // `patches` = edición QUIRÚRGICA en curso: en vez de un documento nuevo, el agente manda
  // subárboles por `data-id` que se aplican sobre `content` sin repintar el resto.
  | {
      kind: "draft";
      title: string;
      content: string;
      sheet: boolean;
      streaming?: boolean;
      artifact?: boolean;
      messageId?: number;
      patches?: {
        nodeId: string;
        html: string;
        closed: boolean;
        op?: "replace" | "remove" | "insert";
        pos?: "append" | "prepend" | "before" | "after";
        remove?: boolean;
      }[];
    }
  // Documento vivo (fuente local + versiones). `messageId` es el mensaje ancla, y aquí
  // pesa por una razón concreta: es el `key` del editor. Tiene que ser EL MISMO que usa
  // la rama `draft` para que al cerrarse el fence el editor no se remonte (si no, flash).
  // `patchRefs` = alias (`n3`) que el agente está tocando en ESTE turno, tal como llegan
  // del stream. Es lo que permite marcar el cambio EN EL MOMENTO en que ocurre, en vez de
  // reconstruirlo después de que el server publique y el panel se reabra — ese orden se
  // estorbaba a sí mismo: cada paso remontaba el editor y tiraba la marca.
  | { kind: "doc"; title: string; documentId: string; md: string; messageId?: number; patchRefs?: string[] }
  | { kind: "sheet"; title: string; documentId: string; csv: string } // hoja viva (CSV local + versiones)
  // Artefacto HTML interactivo: `html` = fuente (iframe srcDoc, sandbox aislado); `src` = URL pública S3.
  // `messageId` = mensaje ancla en gc_artifacts → guardado de ediciones del Canvas (nueva versión).
  // `versionId` = la FILA de gc_artifacts que se está viendo. El panel NO siempre enseña
  // la última: enseña la del mensaje que abriste, así que el enlace tiene que decir cuál.
  | { kind: "artifact"; title: string; documentId: string; html: string; src: string; messageId: number; versionId?: number }
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
const SIDEBAR_W = 240; // el sidebar (md:w-60) también es hermano in-flow → réstalo del ancho
const STORE_KEY = "eb_artifact_w";
// Máximo ancho del panel dejando SIEMPRE sidebar (240) + chat (380) visibles. Sin restar el
// sidebar, en tablet el centro se aplastaba a ~1 palabra/línea (chat = vw − panel, sin contar
// los 240 del sidebar). En overlay (<lg) el max-w-full manda; este clamp aplica al split.
const maxPanelW = (vw: number) => Math.max(MIN_W, vw - SIDEBAR_W - CHAT_MIN);

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
    return Math.min(saved || DEFAULT_W, maxPanelW(window.innerWidth));
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
  const [copied, setCopied] = useState(false); // feedback del botón "Copiar enlace" del artefacto HTML
  // Link ÚNICO del artefacto: su página /artefacto/<slug>. Se resuelve al abrir un
  // artefacto (acuña el slug si aún no tenía, sin tocar los permisos) para que
  // "abrir" y "copiar enlace" nunca vuelvan a repartir el /t3/<key> crudo.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false); // artefacto HTML: modo Ver (iframe) vs Editar (Canvas)
  const [confirmClose, setConfirmClose] = useState(false); // ESC en edición → advertencia
  const [fullscreen, setFullscreen] = useState(false); // panel a pantalla completa (cubre el chat)
  // Ancho del viewport → ancho efectivo del panel en fullscreen (100vw). Se mantiene al día
  // con el resize handler de abajo (setVw). El editor mide su viewport con ResizeObserver →
  // re-fluye solo al cambiar el contenedor a ancho completo.
  const [vw, setVw] = useState<number>(() => (typeof window === "undefined" ? DEFAULT_W : window.innerWidth));
  const effectiveW = fullscreen ? vw : width;
  // ¿La animación en curso es un toggle de pantalla completa? (vs abrir/cerrar el panel)
  // → elige la curva: tween suave para el fullscreen, spring para abrir/cerrar.
  const fullscreenAnim = useRef(false);
  // ¿El panel está montado como CAPA (fixed, fuera del flujo)? En pantalla completa
  // siempre; al SALIR se mantiene hasta que el ancho termina de animar.
  //
  // Antes se derivaba de `fullscreen` a secas y ése era el defecto de la salida: al
  // primer frame el panel volvía al flujo y el espaciador desaparecía, así que el
  // chat de atrás reflowaba de golpe mientras el ancho seguía animando — el panel
  // "saltaba" a su sitio y el resto se acomodaba a tirones detrás.
  const [overlay, setOverlay] = useState(false);
  const toggleFullscreen = () => {
    fullscreenAnim.current = true;
    setFullscreen((v) => {
      if (!v) setOverlay(true); // entrar: capa YA, antes de crecer
      return !v;
    });
  };

  // ESC cierra el panel, igual que el visor de docs (Modal). Solo activo cuando hay
  // artefacto abierto. Si estás en un drill-down (detail), ESC vuelve al índice primero.
  // Bandera en el DOM: el chat (c.$slug) tiene SU PROPIO listener global de ESC que
  // cierra el artefacto (con sonido). Sin esta marca, editando se cerraba igual.
  useEffect(() => {
    if (editing) document.body.dataset.artifactEditing = "1";
    else delete document.body.dataset.artifactEditing;
    return () => {
      delete document.body.dataset.artifactEditing;
    };
  }, [editing]);

  // En MODO EDICIÓN ESC no cierra de golpe: pide confirmación, porque cerrar tira
  // los cambios sin guardar. Fuera de edición, ESC cierra como siempre.
  useEffect(() => {
    if (!rootArtifact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) {
        setConfirmClose(true);
        return;
      }
      if (fullscreen) toggleFullscreen();
      else if (detail) setDetail(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootArtifact, detail, onClose, fullscreen, editing]);
  // Identidad ESTABLE del artefacto → el effect de fetch office NO se re-dispara al reabrir
  // el MISMO artefacto. El draft usa id constante para que su streaming NO resetee.
  const officeSrc = artifact?.kind === "office" ? artifact.src : null;
  // xlsx no lo cubre mammoth (docx-only) → lo previsualizamos con SheetJS (§effect abajo).
  const isXlsx = artifact?.kind === "office" && /\.xlsx?$/i.test(artifact.title ?? "");
  const isDocLike = artifact?.kind === "doc" || artifact?.kind === "office" || artifact?.kind === "sheet";
  // Artefacto HTML → Doc del Canvas. Se re-parsea SOLO al cambiar de artefacto (documentId),
  // no en cada guardado (el editor es dueño de su estado interno mientras edita).
  // HTML del artefacto. Tras GUARDAR desde el Canvas, la vista `artifact` que llega por
  // props sigue trayendo el HTML VIEJO (viene de la cache del mensaje, que se refresca por
  // el bus con retraso) → al salir del editor se veía la versión anterior y parecía que no
  // había guardado. Guardamos el HTML recién guardado y tiene prioridad mientras el panel
  // muestre ese mismo artefacto.
  const [savedHtml, setSavedHtml] = useState<{ id: string; html: string } | null>(null);
  // ¿ya cargó el iframe del artefacto? (para revelarlo con fade y no mostrar el blanco)
  const artifactIdent =
    artifact?.kind === "artifact" ? String(artifact.messageId ?? artifact.documentId) : null;
  const artifactHtml =
    artifact?.kind === "artifact"
      ? savedHtml && savedHtml.id === artifactIdent
        ? savedHtml.html
        : artifact.html
      : null;
  // Identidad ÚNICA por tarjeta: todos los artefactos de un hilo comparten
  // documentId (son versiones del mismo doc), así que memoizar/keyear por documentId
  // mostraba el artefacto equivocado al cambiar de tarjeta. El messageId sí distingue
  // cada tarjeta y se mantiene estable al guardar (updateArtifactHtmlFn reusa el mismo).
  const artifactKey =
    artifact?.kind === "artifact"
      ? String(artifact.messageId ?? artifact.documentId)
      : null;
  const editorDoc = useMemo(() => {
    if (artifactHtml == null) return null;
    const doc = htmlToDoc(artifactHtml);
    // Quitar nodos no-visuales (style/script/meta/link/title): su CSS lo inyectamos
    // por extraCss (reescrito); dejarlos como nodos ensucia Capas y no aporta.
    const NON_VISUAL = new Set(["style", "script", "meta", "link", "title", "head"]);
    const strip = (nodes: CeNode[]): CeNode[] =>
      nodes
        .filter((n) => !NON_VISUAL.has(n.tag))
        .map((n) => ({ ...n, children: strip(n.children) }));
    for (const ab of doc.artboards) ab.nodes = strip(ab.nodes);
    return doc;
    // Depende del HTML, no solo de la tarjeta: al Guardar, `savedHtml` cambia
    // `artifactHtml` y hay que re-parsear, o al volver a Editar el editor se
    // remonta con el doc VIEJO y los cambios guardados "se pierden" (aunque en
    // Ver sí se vieran). Reconstruirlo mientras editas es inocuo: el CanvasEditor
    // crea su store una sola vez al montar e ignora cambios del prop `doc`.
  }, [artifactKey, artifactHtml]);
  // El STORE del editor lo posee el PANEL (no el CanvasEditor): así los patches del agente
  // pueden entrar al documento abierto mientras el usuario edita. Se recrea con el doc —
  // misma dependencia que `editorDoc`.
  const editorStore = useMemo(
    () => (editorDoc ? new EditorStore(editorDoc) : null),
    [editorDoc]
  );
  // PATCHES DEL AGENTE → EDITOR ABIERTO. `replaceNodeSubtree` hace commit al historial, así
  // que el cambio del agente es des-hacible con ⌘Z como cualquier edición propia (no hace
  // falta un merge de tres vías: el agente gana y el usuario tiene undo).
  const editorPatches = artifact?.kind === "draft" ? artifact.patches : undefined;
  useEffect(() => {
    if (!editorStore || !editorPatches?.length) return;
    for (const p of editorPatches) {
      if (!p.closed) continue; // a medio streamear no parsea a un nodo
      const op = p.op ?? (p.remove ? "remove" : "replace");
      if (op === "remove") {
        editorStore.deleteNode(p.nodeId);
        continue;
      }
      if (op === "insert") {
        // El nodo nuevo estrena id propio (el de la cabecera es el ANCLA).
        const node = htmlToNode(p.html);
        const ab = editorStore.getSnapshot().doc.artboards[0];
        if (node && ab) editorStore.addNode(ab.id, p.nodeId, node);
        continue;
      }
      const node = htmlToNode(p.html, p.nodeId);
      if (node) editorStore.replaceNodeSubtree(p.nodeId, node);
    }
  }, [editorStore, editorPatches]);
  // Estilos embebidos del artefacto (<style>…</style>). Los quitamos del doc (nodos
  // no-visuales) → hay que reinyectarlos: RAW (body intacto) para el preview iframe
  // (docToHtml envuelve en <body>), y REESCRITO (body→.ce-artboard) para la superficie
  // de edición (el contenido vive en un <div.ce-artboard>, no en <body>).
  const artifactStyleCssRaw = useMemo(() => {
    if (!artifactHtml) return "";
    const blocks = artifactHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    return blocks.map((b) => b.replace(/<\/?style[^>]*>/gi, "")).join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactKey]);
  const artifactStyleCss = useMemo(
    () =>
      artifactStyleCssRaw
        .replace(/(^|[\s,{}])(html|body)\b/gi, "$1.ce-artboard")
        .replace(/:root\b/gi, ".ce-artboard")
        // EN EDICIÓN el TEMA lo manda el editor. El artefacto trae su propia paleta en
        // `:root` (autocontenida para su URL pública); al reescribirla a `.ce-artboard`
        // quedaba con la MISMA especificidad que la del editor y, al ir después en la
        // cascada, GANABA → cambiar de paleta en el panel no hacía nada (reportado
        // 2026-07-24). Quitamos solo esas declaraciones de token; el resto del CSS del
        // artefacto (keyframes, reglas propias) se conserva intacto.
        .replace(/^\s*--(?:color-[\w-]+|radius|font-(?:heading|body|mono))\s*:[^;]*;/gim, ""),
    [artifactStyleCssRaw]
  );
  // Al cambiar de artefacto (o cerrar), volver a modo Ver.
  useEffect(() => { setEditing(false); }, [artifactKey]);
  // Badge por tipo REAL: sheet vivo = CSV, doc generado = DOCX, office = su extensión
  // real (XLSX/PPTX/DOCX) derivada del nombre — no hardcodear DOCX para todo office.
  const extBadge = (title?: string): string | null => {
    const m = /\.(docx?|xlsx?|pptx?|pdf)$/i.exec(title ?? "");
    return m ? m[1].toUpperCase() : null;
  };
  const docBadge =
    artifact?.kind === "sheet"
      ? "XLSX"
      : artifact?.kind === "doc"
        ? "DOCX"
        : artifact?.kind === "office"
          ? extBadge(artifact.title) ?? "DOCX"
          : null;
  const downloadHref =
    artifact?.kind === "doc"
      ? `/api/doc-docx/${encodeURIComponent(artifact.documentId)}?name=${encodeURIComponent(artifact.title || "documento")}`
      : artifact?.kind === "sheet"
        ? `/api/doc-xlsx/${encodeURIComponent(artifact.documentId)}?name=${encodeURIComponent(artifact.title || "hoja")}`
        : artifact?.kind === "office"
          ? artifact.src
          : null;
  const artifactId = !artifact
    ? null
    : artifact.kind === "office"
      ? `office:${artifact.src}`
      : artifact.kind === "doc"
        ? `doc:${artifact.documentId}`
        : artifact.kind === "sheet"
          ? `sheet:${artifact.documentId}`
          : artifact.kind === "artifact"
            ? `artifact:${artifact.documentId}`
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
  // PREVIEW EN VIVO del artefacto HTML: el HTML PARCIAL se escribe con document.write() dentro
  // del iframe (ver StreamingHtmlFrame) → el parser incremental del navegador lo pinta desde el
  // primer token, igual que una página que llega por red. Sin throttle de re-montaje ni gates.
  const isDraftArtifact = artifact?.kind === "draft" && !!artifact.artifact;
  const draftPreview = isDraftArtifact && artifact?.kind === "draft" ? artifact.content : "";
  // Patches que NO encontraron su nodo. Se muestran con el id a la vista (ver la franja de
  // estado): si el modo quirúrgico se rompiera, tiene que verse en el primer turno, no
  // quedar tapado por un camino de respaldo silencioso.
  const [failedPatches, setFailedPatches] = useState<string[]>([]);
  // ¿Ya arrancó el iframe del artefacto final? Hasta entonces se muestra el calco en DOM
  // (evita el parpadeo en blanco al pasar del preview al iframe). Con tope de seguridad:
  // si `onLoad` no llega (subrecurso colgado), no dejamos el calco para siempre.
  // Fases del calco: "on" (tapando) → "fading" (desvaneciéndose) → "off" (desmontado).
  // No basta con quitarlo en `onLoad`: el artefacto carga Tailwind por CDN y sus estilos se
  // aplican DESPUÉS del load, así que destapar justo ahí deja ver un instante el HTML crudo
  // — el mismo parpadeo, disfrazado. Se espera un poco y se desvanece.
  //
  // ⚠️ Y por eso mismo el calco YA CASI NUNCA hace falta: desde que el CSS se hornea
  // al publicar (bakeTailwind en artifacts.ts), el artefacto abre estilado en el
  // primer frame. Ponerlo igual era el defecto que se veía al abrir — el calco es el
  // MISMO HTML pero pintado con el Tailwind del app (scoped a .gt-live, sin
  // preflight y sin las fuentes del artefacto), así que sus medidas NO coinciden:
  // se veía una versión "de otro tamaño" y al desvanecerse, el flash. Sólo se pone
  // cuando el HTML depende del CDN, que es el caso que el calco vino a tapar.
  const [calque, setCalque] = useState<"on" | "fading" | "off">("off");
  const frameKey = artifact?.kind === "artifact" ? String(artifact.messageId ?? artifact.documentId) : null;
  const needsCalque =
    artifact?.kind === "artifact" &&
    /cdn\.tailwindcss\.com/i.test(artifactHtml ?? artifact.html ?? "") &&
    !/<style[^>]*>/i.test(artifactHtml ?? artifact.html ?? "");
  useEffect(() => {
    if (!frameKey) return;
    if (!needsCalque) {
      setCalque("off");
      return;
    }
    setCalque("on");
    // Red de seguridad: si `onLoad` no llega (un subrecurso colgado), el calco se va igual.
    const id = setTimeout(() => setCalque("fading"), 6000);
    return () => clearTimeout(id);
  }, [frameKey, needsCalque]);
  // Desvanecido en dos tiempos, para que el iframe alcance a aplicar sus estilos.
  useEffect(() => {
    if (calque !== "fading") return;
    const id = setTimeout(() => setCalque("off"), 260);
    return () => clearTimeout(id);
  }, [calque]);
  const onFrameLoad = useCallback(() => {
    // +200ms tras el load: margen para que el CDN de Tailwind del artefacto pinte.
    setTimeout(() => setCalque((c) => (c === "on" ? "fading" : c)), 200);
  }, []);
  const patchSig = artifact?.kind === "draft" ? (artifact.patches ?? []).map((p) => p.nodeId).join(",") : "";
  useEffect(() => { setFailedPatches([]); }, [patchSig]);
  const onPatchFail = useCallback((nodeId: string) => {
    setFailedPatches((cur) => (cur.includes(nodeId) ? cur : [...cur, nodeId]));
  }, []);
  // Hasta que abre el <body> no hay nada visual: mostramos el código en vivo (auto-scroll).
  const draftSrcRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = draftSrcRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draftPreview]);
  // Descarga con FEEDBACK: doc→.docx (compila en EasyBits) y sheet→.xlsx (convierte el CSV
  // fuente con SheetJS en /api/doc-xlsx) tardan un poco; fetch same-origin → blob → download,
  // con spinner. Office = URL pública externa → navegación directa (evita CORS del blob).
  const doDownload = async () => {
    if (downloading) return;
    if (!downloadHref) return;
    if (artifact?.kind === "office") {
      window.open(downloadHref, "_blank", "noopener");
      return;
    }
    const ext = artifact?.kind === "sheet" ? "xlsx" : "docx";
    const fallbackName = artifact?.kind === "sheet" ? "hoja" : "documento";
    setDownloading(true);
    try {
      const r = await fetch(downloadHref);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(artifact?.title || fallbackName).replace(/[^\w.\- ]/g, "_")}.${ext}`;
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
    const docId = artifact?.kind === "artifact" ? artifact.documentId : null;
    setShareUrl(null);
    if (!docId) return;
    let alive = true;
    (async () => {
      try {
        const { setArtifactShareFn } = await import("../server/artifacts");
        const s = await setArtifactShareFn({ data: { documentId: docId } });
        // El enlace lleva la versión que ESTÁS VIENDO. `latest` sólo como respaldo
        // (artefacto recién creado, todavía sin fila conocida). El enlace "limpio" —el
        // que respeta la versión fijada para quien lo recibe— se copia desde el diálogo
        // Compartir de la propia página.
        const v = artifact?.kind === "artifact" ? artifact.versionId : null;
        if (alive && s?.slug) setShareUrl(`${window.location.origin}/artefacto/${s.slug}?v=${v ?? "latest"}`);
      } catch {
        // No eres el dueño (o es un artefacto de antes): sin link propio. Los
        // botones caen al blob local, que no depende de nada.
      }
    })();
    return () => {
      alive = false;
    };
  }, [artifact?.kind === "artifact" ? artifact.documentId : null, artifact?.kind === "artifact" ? artifact.versionId : null]);

  // Artefacto HTML (kind:"artifact"): acciones self-contained a partir de la fuente
  // (`artifact.html`), que SIEMPRE está disponible aunque el publish a S3 haya fallado o
  // `src` sea null. Antes el header no mostraba ningún botón para HTML (newTabHref=src → si
  // src=null, nada; y no es isDocLike → sin descarga). Ahora: abrir (src o blob), descargar
  // .html, y copiar enlace cuando hay src.
  const artifactFileName = () =>
    `${((artifact?.kind === "artifact" ? artifact.title : "") || "artefacto").replace(/[^\w.\- ]/g, "_")}.html`;
  const openHtmlArtifact = () => {
    if (artifact?.kind !== "artifact") return;
    // La página del artefacto (con su barra y su permiso), NO el /t3/<key> crudo:
    // ese link se abría sin marco y seguía sirviendo después de poner el artefacto
    // en privado. El HTML de ahí dentro sí lo sirve el CDN.
    if (shareUrl) {
      window.open(shareUrl, "_blank", "noopener");
      return;
    }
    const url = URL.createObjectURL(new Blob([artifactHtml ?? artifact.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const downloadHtmlArtifact = () => {
    if (artifact?.kind !== "artifact") return;
    const url = URL.createObjectURL(new Blob([artifactHtml ?? artifact.html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = artifactFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const copyArtifactLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt(t("Copia el enlace:"), shareUrl);
    }
  };

  // Descarga de MEDIA (imagen/audio/video/file): antes solo tenían "abrir" (el src es una
  // URL firmada/presigned → abrir la previsualiza, no la baja). Intenta fetch→blob (funciona
  // same-origin /api/attachment y si el bucket permite CORS); si falla (cross-origin), cae a
  // un <a download> directo. Nombre = título + extensión adivinada de la URL.
  const mediaSrc = artifact && (artifact.kind === "image" || artifact.kind === "audio" || artifact.kind === "video" || artifact.kind === "file") ? artifact.src : null;
  const [dlingMedia, setDlingMedia] = useState(false);
  const downloadMedia = async () => {
    if (!mediaSrc || dlingMedia) return;
    const extFromUrl = (() => {
      try {
        const p = new URL(mediaSrc, window.location.origin).pathname;
        const m = /\.([a-z0-9]{2,5})$/i.exec(p);
        return m ? m[1] : "";
      } catch {
        return "";
      }
    })();
    const fallbackExt = artifact?.kind === "image" ? "png" : artifact?.kind === "audio" ? "mp3" : artifact?.kind === "video" ? "mp4" : "bin";
    const base = (artifact?.title || "archivo").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^\w.\- ]/g, "_");
    const name = `${base}.${extFromUrl || fallbackExt}`;
    setDlingMedia(true);
    try {
      const r = await fetch(mediaSrc);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    } catch {
      const a = document.createElement("a");
      a.href = mediaSrc;
      a.download = name;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setDlingMedia(false);
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
      const w = Math.min(Math.max(window.innerWidth - e.clientX, MIN_W), maxPanelW(window.innerWidth));
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

  // Re-clampa el ancho al redimensionar la ventana: un ancho guardado en una sesión desktop
  // ancha (localStorage) NO debe heredarse tal cual en tablet y aplastar el centro.
  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setWidth((w) => Math.min(w, maxPanelW(window.innerWidth)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Al cerrar el panel, vuelve al split normal → la próxima apertura no hereda fullscreen.
  useEffect(() => {
    if (!rootArtifact) setFullscreen(false);
  }, [rootArtifact]);

  // ↗ "abrir en pestaña nueva" (reemplaza el botón expandir, que era defectuoso). Donde
  // hay URL real: docindex → la página global /artifacts; office/pdf/imagen/etc → su src
  // (firmado); html → embed. doc/sheet (md local) y draft no tienen URL → sin botón.
  const newTabHref =
    !artifact || artifact.kind === "draft" || artifact.kind === "doc" || artifact.kind === "sheet" || artifact.kind === "ask-user" || artifact.kind === "artifact"
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
          {/* Backdrop en móvil Y tablet (overlay hasta lg). Solo en desktop ≥lg el panel va
              en-flujo (split de 3 columnas); en tablet iría aplastando el centro. */}
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          {/* Espaciador: en fullscreen el aside sale del flujo (fixed). Sin este hueco del
              ancho que tenía, el chat de atrás reflowaba de golpe al entrar/salir → el
              movimiento se veía tosco (saltaba el layout mientras el ancho animaba). */}
          {overlay ? <div className="hidden shrink-0 lg:block" style={{ width }} /> : null}
          <motion.aside
            className={
              overlay
                // Anclado a la derecha (no inset-0): así crece/decrece SOLO por el borde
                // izquierdo, que es el mismo eje del panel normal → una única animación
                // continua de ancho, sin reposicionar nada a media transición.
                ? "fixed inset-y-0 right-0 z-[100] flex max-w-none overflow-hidden bg-surface"
                : "fixed right-0 top-0 z-50 flex h-full max-w-full overflow-hidden border-l border-border bg-surface shadow-2xl lg:relative lg:z-auto lg:h-auto lg:max-w-[75vw] lg:shrink-0 lg:shadow-none lg:self-stretch"
            }
            initial={{ width: 0 }}
            animate={{ width: effectiveW }}
            exit={{ width: 0 }}
            // Al arrastrar, sin animación. Para expandir/contraer a pantalla completa un
            // spring rebotón se sentía tosco (overshoot sobre un panel enorme) → tween con
            // ease de salida; la apertura/cierre del panel conserva el spring de siempre.
            transition={
              isDragging
                ? { duration: 0 }
                : fullscreenAnim.current
                  ? { duration: 0.34, ease: [0.32, 0.72, 0, 1] }
                  : { type: "spring", stiffness: 320, damping: 34 }
            }
            onAnimationComplete={() => {
              fullscreenAnim.current = false;
              // Ya llegó a su ancho normal → devolver el panel al flujo. Hacerlo aquí
              // y no al hacer clic es lo que hace que la salida no dé el tirón.
              if (!fullscreen) setOverlay(false);
            }}
          >
            {artifact ? (
              <>
            {/* Handle de redimensión: arrastra el borde izquierdo; doble clic resetea. En
                fullscreen no aplica (el panel ocupa todo el viewport) → se oculta. */}
            {!fullscreen ? (
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
            ) : null}
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
                (no se aplasta) al ABRIR y CERRAR.
                Pero en el toggle de pantalla completa eso mismo era el defecto: el
                contenido saltaba a su ancho final en un frame mientras el contenedor
                animaba, así que el artefacto se re-maquetaba de golpe y sólo después
                terminaba de descubrirse. En ese caso el ancho se anima IGUAL que el
                aside, con la misma curva, y todo se mueve junto.
                Contenido: cambio INSTANTÁNEO al alternar de artefacto estando el panel
                ya abierto (sin fade ni re-animación → no se siente como "abrir de
                nuevo"). El deslizamiento vive solo en el motion.aside. */}
            <motion.div
              className="flex min-w-0 shrink-0 flex-col"
              animate={{ width: effectiveW }}
              transition={
                isDragging || !fullscreenAnim.current
                  ? { duration: 0 }
                  : { duration: 0.34, ease: [0.32, 0.72, 0, 1] }
              }
            >
              {/* La barra es la MISMA que la de la página pública /a/<slug>
                  (ArtifactShareBar): se colapsa sola por ancho real, así que los
                  botones dejaron de pelear con el título al angostar el panel. Las
                  acciones de aquí abajo son las propias de esta superficie y viajan
                  como slot; al compactar se van al ⋯. */}
              <ArtifactShareBar
                title={artifact.title || t("Documento")}
                subtitle={docBadge}
                // Sin Compartir aquí: en el panel se trabaja el artefacto (editar,
                // copiar, abrir). Los permisos y la versión que se publica se manejan
                // en SU página — abrirla es el ícono de la pestaña nueva.
                documentId={null}
                leading={
                  detail ? (
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
                  )
                }
                primaryAction={
                  // Ver/Editar: la acción principal del artefacto — con etiqueta, a la
                  // izquierda del grupo, y nunca escondida en el ⋯.
                  artifact.kind === "artifact" ? (
                      <button
                        type="button"
                        onClick={() => setEditing((v) => !v)}
                        title={editing ? t("Preview") : t("Editar")}
                        className="mr-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        {editing ? <Eye size={14} /> : <Pencil size={14} />}
                        {/* "Ver" no decía nada estando ya viéndolo: lo que hace es
                            salir del editor y enseñar el artefacto corriendo. */}
                        {editing ? t("Preview") : t("Editar")}
                      </button>
                  ) : null
                }
                pinnedActions={
                  <>
                    <button
                      type="button"
                      onClick={toggleFullscreen}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      title={fullscreen ? t("Salir de pantalla completa") : t("Expandir por completo")}
                      aria-label={fullscreen ? t("Salir de pantalla completa") : t("Expandir por completo")}
                    >
                      {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
                      title={t("Cerrar")}
                    >
                      <X size={16} />
                    </button>
                  </>
                }
                actions={
                  <>
                {/* Acciones estilo claude.ai: iconos en el header (no barra abajo). La EDICIÓN
                    de un doc/hoja del agente se hace CHATEANDO (se re-redacta en vivo) — sin
                    editor embebido. Aquí solo Descargar y, para un .docx adjunto, Actualizar. */}
                {isDocLike ? (
                  <>
                    {downloadHref ? (
                      <button
                        type="button"
                        onClick={doDownload}
                        disabled={downloading}
                        title={downloading ? t("Descargando…") : artifact.kind === "sheet" ? t("Descargar Excel") : artifact.kind === "office" ? t("Descargar") : t("Descargar Word")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand disabled:opacity-60"
                      >
                        {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                      </button>
                    ) : null}
                    {/* Imprimir. UN botón, no dos: el diálogo del navegador ofrece también
                        "Guardar como PDF", así que esto cubre imprimir Y exportar a PDF sin
                        un endpoint de render en el servidor. Sólo para el documento de
                        prosa: una hoja de cálculo o un .docx adjunto no tienen la hoja en
                        flujo que el `@media print` sabe paginar. */}
                    {artifact.kind === "doc" ? (
                      <button
                        type="button"
                        onClick={async () => {
                          const { imprimirDocumento } = await import("../lib/doc-print");
                          imprimirDocumento();
                        }}
                        title={t("Imprimir o guardar como PDF")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        <Printer size={15} />
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
                {artifact.kind === "artifact" ? (
                  <>
                    {shareUrl ? (
                      <button
                        type="button"
                        onClick={copyArtifactLink}
                        title={copied ? t("¡Copiado!") : t("Copiar enlace")}
                        className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                      >
                        {copied ? <Check size={15} className="text-brand" /> : <LinkIcon size={15} />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={downloadHtmlArtifact}
                      title={t("Descargar HTML")}
                      className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                    >
                      <Download size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={openHtmlArtifact}
                      title={t("Abrir en pestaña nueva")}
                      className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand"
                    >
                      <ExternalLink size={15} />
                    </button>
                  </>
                ) : null}
                {mediaSrc ? (
                  <button
                    type="button"
                    onClick={downloadMedia}
                    disabled={dlingMedia}
                    title={t("Descargar")}
                    className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-brand disabled:opacity-60"
                  >
                    {dlingMedia ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  </button>
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
                  </>
                }
              />

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
                                  decoding="async"
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
                ) : artifact.kind === "draft" && artifact.artifact ? (
                  // Artefacto HTML EN CONSTRUCCIÓN: el usuario ve el RESULTADO formándose
                  // (nunca código, nunca esqueleto, nunca barra de espera).
                  // `absolute inset-0`, NO `flex-1`: el contenedor de arriba es un BLOQUE con
                  // overflow-auto (no un flex container), así que `flex-1` aquí no aplicaba y
                  // esta caja quedaba con ALTURA 0 — su único hijo real es absolute. Por eso el
                  // preview en vivo (y luego el esqueleto) nunca se veían: se pintaban en 0px de
                  // alto y el panel se leía como un rectángulo negro. CAUSA RAÍZ del "artefacto
                  // vacío mientras se construye" (2026-07-25).
                  <div data-gt-branch="draft-artifact" className="absolute inset-0 flex flex-col bg-surface-2">
                    {/* Franja de ESTADO mientras streamea. Va aquí arriba, FUERA del preview,
                        porque es la única señal que no depende de que el preview logre pintar
                        algo: si el artefacto no aparece, esta línea dice si el HTML está
                        llegando (bytes subiendo) o no (0 B) — la diferencia entre "el agente
                        no manda nada" y "llega pero no se pinta". Desaparece al cerrar el
                        fence. */}
                    {artifact.streaming || failedPatches.length ? (
                      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted">
                        {artifact.streaming ? (
                          <>
                            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand" />
                            {artifact.patches?.length ? t("Ajustando el artefacto…") : t("Construyendo el artefacto…")}
                          </>
                        ) : null}
                        {/* Fallo VISIBLE con el id a la vista: un aviso genérico (o ninguno)
                            deja "el patch nunca aplica" disfrazado de "todo bien". */}
                        {failedPatches.length ? (
                          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">
                            {failedPatches.length} {t("sin aplicar")} ({failedPatches.join(", ")})
                          </span>
                        ) : null}
                        <span className="ml-auto tabular-nums">
                          {artifact.patches?.length
                            ? `${artifact.patches.length} ${t("ajuste(s)")}`
                            : `${(draftPreview.length / 1024).toFixed(1)} KB`}
                        </span>
                      </div>
                    ) : null}
                    <div className="relative min-h-0 flex-1">
                      {/* ES EL MISMO IFRAME DEL RESULTADO, desde el primer token: apunta UNA
                          vez a /api/artifact-stream/:id (respuesta HTTP en chunks) y el
                          navegador lo pinta conforme llega. `key` fijo al mensaje → NO se
                          remonta mientras el agente escribe (remontarlo era justo lo que
                          impedía ver la construcción). Sin messageId (cliente viejo / draft
                          sin ancla) caemos al re-emisor de srcDoc. */}
                      {/* SIN IFRAME: el HTML parcial se pinta como DOM real dentro del
                          panel (mismo montaje que el editor). No hay documento que
                          reiniciar, así que cada pedazo que llega se ve al instante. */}
                      <LiveArtifactPreview
                        html={draftPreview}
                        patches={artifact.patches}
                        onPatchFail={onPatchFail}
                        loadingLabel={t("Construyendo el artefacto…")}
                        className="absolute inset-0 overflow-auto thin-scroll"
                      />
                    </div>
                  </div>
                ) : artifact.kind === "draft" && artifact.sheet ? (
                  // Hoja EN VIVO: el csv streamea a la tabla mientras el agente escribe;
                  // al cerrar el fence pasa a `kind:"sheet"` real.
                  <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-surface-3 p-4 sm:p-6">
                    <CsvTable csv={artifact.content} />
                    {artifact.streaming ? (
                      <span className="mt-2 inline-block h-4 w-[3px] animate-pulse bg-brand" />
                    ) : null}
                  </div>
                ) : artifact.kind === "draft" ? (
                  // Prosa EN VIVO: el documento se redacta DENTRO del editor real
                  // (BlockNote), no en una hoja de markdown renderizado. Mismo montaje
                  // y mismo `key` que la rama `kind:"doc"` de abajo → al cerrarse el
                  // fence el editor NO se remonta: sólo le cambia el `md`.
                  <DocSurface
                    key={artifact.messageId ? `msg:${artifact.messageId}` : "draft"}
                    md={artifact.content}
                    streaming={!!artifact.streaming}
                  />
                ) : artifact.kind === "image" ? (
                  <div className="grid min-h-full place-items-center p-4">
                    {/* Vista activa del artefacto → eager (no lazy); solo decoding async. */}
                    <img
                      src={artifact.src}
                      alt={artifact.title}
                      decoding="async"
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
                  // Documento VIVO en el editor real. Es el MISMO montaje que el borrador
                  // de arriba y con el MISMO `key`: al cerrarse el fence, el editor no se
                  // remonta — sólo le cambia el `md` — y el reconciliador diffea eso a
                  // casi nada. De ahí que el swap borrador→doc no dé ni un parpadeo.
                  // Descargar Word arriba.
                  <DocSurface
                    // La identidad es el DOCUMENTO, no el mensaje. Con `msg:<id>` el
                    // editor se remontaba entero en CADA ajuste quirúrgico —cada patch
                    // crea un mensaje nuevo—, lo que anula el reconciliador (102 bloques
                    // reconstruidos para cambiar una fecha) y deja el árbol oculto un
                    // instante mientras React lo reemplaza. Ahí se perdía el resaltado:
                    // se pintaba sobre el árbol que estaba siendo desechado.
                    key={`doc:${artifact.documentId}`}
                    md={artifact.md ?? ""}
                    documentId={artifact.documentId}
                    messageId={artifact.messageId}
                    title={artifact.title}
                    patchRefs={artifact.patchRefs}
                  />
                ) : artifact.kind === "artifact" ? (
                  // Artefacto HTML interactivo. Modo Ver: iframe AISLADO (sandbox sin
                  // allow-same-origin → no lee cookies/DOM del app), render desde el HTML
                  // FUENTE local. Modo Editar: el Canvas (@ghosty/canvas-editor) sobre el mismo
                  // HTML; al Guardar publica una NUEVA versión (gc_artifacts) + re-publica a S3.
                  <div className="relative flex h-full flex-col">
                    {/* ESC en edición → advertencia en vez de cerrar y perder cambios. */}
                    {confirmClose ? (
                      <div className="absolute inset-0 z-30 grid place-items-center bg-black/50 p-6">
                        <div className="w-full max-w-xs rounded-xl border border-border bg-surface p-4 shadow-xl">
                          <p className="text-sm text-ink">{t("Estás editando el artefacto. Si cierras ahora, pierdes los cambios sin guardar.")}</p>
                          <div className="mt-3 flex justify-end gap-2">
                            <button
                              onClick={() => setConfirmClose(false)}
                              className="rounded-md border border-border px-2.5 py-1 text-xs text-ink transition hover:border-brand"
                            >
                              {t("Seguir editando")}
                            </button>
                            <button
                              onClick={() => {
                                setConfirmClose(false);
                                setEditing(false);
                                onClose();
                              }}
                              className="rounded-md bg-ink px-2.5 py-1 text-xs text-surface transition hover:bg-brand"
                            >
                              {t("Cerrar sin guardar")}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {/* Ver/Editar vive en la topbar (ArtifactShareBar), no en una barra
                        propia: una segunda fila para UN botón robaba alto al artefacto y
                        partía el marco en dos. */}
                    {editing && editorDoc ? (
                      <div className="min-h-0 flex-1">
                        <CanvasEditor
                          key={artifactKey ?? artifact.documentId}
                          doc={editorDoc}
                          // El store lo posee el panel: así los ```eb-patch``` del agente
                          // entran al documento ABIERTO mientras el usuario edita.
                          store={editorStore ?? undefined}
                          extraCss={artifactStyleCss}
                          // Ya NO se suprime: themeToCss emite los tokens SCOPED a
                          // .ce-artboard (no al :root global), así que el selector de
                          // paleta del panel sí recolorea el artefacto sin tocar la UI.
                          // La paleta inicial sale del propio artefacto: htmlToDoc lee su
                          // bloque :root y siembra doc.theme.
                          tailwindPlay
                          renderPreview={(doc) =>
                            docToHtml(doc).replace(
                              "</head>",
                              `<style>${artifactStyleCssRaw}</style></head>`
                            )
                          }
                          onSave={async (doc) => {
                            // El export del editor NO conserva el <style> propio del
                            // artefacto (keyframes, reglas custom): sin esto, guardar lo
                            // borraba. Lo reinyectamos sin sus tokens (esos los emite el
                            // tema del editor, que es lo que el usuario acaba de elegir).
                            const custom = artifactStyleCssRaw.replace(
                              /^\s*--(?:color-[\w-]+|radius|font-(?:heading|body|mono))\s*:[^;]*;/gim,
                              ""
                            );
                            const html = docToHtml(doc).replace(
                              "</head>",
                              custom.trim() ? `<style>${custom}</style></head>` : "</head>"
                            );
                            await updateArtifactHtmlFn({
                              data: {
                                documentId: artifact.documentId,
                                messageId: artifact.messageId,
                                html,
                                title: artifact.title || undefined,
                              },
                            });
                            // Lo guardado manda en el panel hasta que el refresh del bus
                            // traiga la nueva versión: sin esto, salir del editor mostraba
                            // el HTML viejo y parecía que no se guardó.
                            setSavedHtml({
                              id: String(artifact.messageId ?? artifact.documentId),
                              html,
                            });
                          }}
                        />
                      </div>
                    ) : (
                      // NADA de ocultar el iframe hasta que "cargue": `onLoad` espera a TODOS
                      // los subrecursos (CDN de Tailwind, fuentes, imágenes), así que gatear
                      // la opacidad con él dejaba el panel en negro varios segundos con el
                      // artefacto ya renderizado debajo — se leía como pantalla de espera y
                      // luego "aparece todo de golpe". El iframe se ve DESDE EL PRIMER PIXEL;
                      // el fondo del tema detrás evita el flash blanco.
                      <div data-gt-branch="artifact-final" className="relative min-h-0 flex-1 bg-surface-2">
                        {/* HTML vacío = el artefacto todavía no tiene contenido (se está
                            regenerando / la fila llegó sin md). Sin esto el panel es un
                            rectángulo NEGRO indistinguible de un cuelgue. */}
                        {!(artifactHtml ?? artifact.html ?? "").trim() ? (
                          <ArtifactSkeleton label={t("Construyendo el artefacto…")} />
                        ) : null}
                        <iframe
                          key={artifactKey ?? "artifact"}
                          title={artifact.title || "artefacto"}
                          sandbox="allow-scripts allow-forms allow-popups"
                          referrerPolicy="no-referrer"
                          // `artifactHtml`, NO `artifact.html`: el prop viene de la cache del
                          // mensaje y tras guardar sigue trayendo la versión anterior — por eso
                          // al salir del editor se veía el cambio "perdido" hasta cerrar y
                          // reabrir el artefacto.
                          srcDoc={withArtifactChrome(artifactHtml ?? artifact.html)}
                          onLoad={onFrameLoad}
                          className="absolute inset-0 h-full w-full border-0 bg-transparent"
                        />
                        {/* CALCO del artefacto mientras el iframe arranca. Al terminar la
                            edición, el panel pasa del preview (DOM, ya pintado) al iframe, y
                            ese cambio dejaba un parpadeo en blanco antes de mostrar todo de
                            golpe. Aquí NO se gatea el iframe con onLoad (eso fue el error
                            anterior: dejaba el panel en negro esperando el CDN); el iframe se
                            pinta abajo desde el primer pixel y esta capa —el MISMO HTML, en
                            DOM directo, sin documento que arrancar— lo tapa sin vacío y se
                            desvanece en cuanto el iframe está listo. */}
                        {calque !== "off" ? (
                          <ArtifactCalque
                            html={artifactHtml ?? artifact.html}
                            className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-200 ${
                              calque === "fading" ? "opacity-0" : "opacity-100"
                            }`}
                          />
                        ) : null}
                      </div>
                    )}
                    {/* El link que se muestra es la PÁGINA del artefacto, no la key
                        de storage: es el único que respeta el permiso y trae barra. */}
                    {shareUrl ? (
                      <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
                        <span className="truncate text-xs text-muted">{shareUrl}</span>
                        <a
                          href={shareUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink transition hover:border-brand"
                        >
                          {t("Abrir")}
                        </a>
                      </div>
                    ) : null}
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
            </motion.div>

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
