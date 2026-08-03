/**
 * Ícono de archivo: hoja con la esquina doblada y el tipo escrito dentro.
 *
 * Es el ícono universal de documento (Drive, Slack, macOS) y resuelve el problema
 * que tienen los sets de íconos: lucide no trae glifo de PDF, y el más cercano
 * (`FileType2`) dibuja una "T" que se lee como archivo de fuente tipográfica.
 * La forma dice "archivo" y las letras dicen CUÁL — sin adivinar.
 *
 * El color es la tercera señal, con las convenciones del escritorio (rojo = PDF,
 * verde = hoja), así que no hay que explicarlas.
 *
 * Vive aquí y no en `c.$slug.tsx` porque la lista de Documentos (panel y ruta
 * `/artefactos`) pintaba el MISMO `FileText` para un .pdf y un .docx.
 */
export function fileKind(mime: string | null | undefined, name: string | null | undefined) {
  const m = (mime ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  const ext = (n.match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "").toUpperCase();
  const es = (...exts: string[]) => exts.includes(ext.toLowerCase());

  if (m === "application/pdf" || es("pdf")) return { label: "PDF", cls: "text-red-400" };
  if (m.startsWith("image/") || es("png", "jpg", "jpeg", "webp", "gif", "svg"))
    return { label: ext || "IMG", cls: "text-violet-400" };
  if (m.startsWith("video/") || es("mp4", "mov", "webm")) return { label: ext || "VID", cls: "text-blue-400" };
  if (m.startsWith("audio/") || es("ogg", "mp3", "wav", "m4a")) return { label: ext || "AUD", cls: "text-amber-400" };
  if (m.includes("spreadsheet") || es("csv", "xlsx", "xls")) return { label: ext || "CSV", cls: "text-emerald-400" };
  if (m.includes("word") || es("docx", "doc")) return { label: ext || "DOC", cls: "text-sky-400" };
  if (m.includes("zip") || m.includes("compressed") || es("zip", "tar", "gz", "rar"))
    return { label: ext || "ZIP", cls: "text-zinc-400" };
  return { label: ext || "", cls: "text-brand" };
}

/**
 * Un documento REDACTADO no tiene mime ni extensión en el título: su tipo es el
 * `kind` de la fila. Sin esto, "RECURSO DE APELACIÓN" salía con la hoja vacía.
 */
export function glyphNameFor(title: string, kind: string) {
  if (/\.[a-z0-9]{1,5}$/i.test(title)) return title;
  if (kind === "sheet") return "x.csv";
  if (kind === "doc") return "x.doc";
  if (kind === "html") return "x.html";
  return title;
}

export function FileGlyph({
  mime,
  name,
  className = "h-9 w-[1.8rem]",
}: {
  mime: string | null | undefined;
  name: string | null | undefined;
  className?: string;
}) {
  const { label, cls } = fileKind(mime, name);
  return (
    <svg viewBox="0 0 32 40" className={`shrink-0 ${className} ${cls}`} aria-hidden focusable="false">
      {/* Hoja con la esquina doblada: el contorno va en currentColor y el relleno
          translúcido, así el mismo dibujo sirve en tema claro y oscuro. */}
      <path
        d="M4 3.5h15L28 12v24.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M19 3.5V10a2 2 0 0 0 2 2h7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {label ? (
        <text
          x="16"
          y="29"
          textAnchor="middle"
          fill="currentColor"
          style={{ font: "700 9px ui-sans-serif, system-ui, sans-serif", letterSpacing: "-0.02em" }}
        >
          {label.slice(0, 4)}
        </text>
      ) : null}
    </svg>
  );
}
