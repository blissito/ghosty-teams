import { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { useT } from "../../i18n";

/** Lo que sale de un archivo: la cabecera y las filas, todo como text. */
export type Sheet = { headers: string[]; rows: string[][] };

/**
 * Lee un .csv o .xlsx en el NAVEGADOR.
 *
 * En el cliente y no en el servidor a propósito: subir el archivo costaría una ruta de
 * upload, un límite de tamaño y un archivo temporal, cuando lo único que se necesita son
 * las celdas. SheetJS ya es dependencia del repo (se usa para exportar) y pesa lo mismo
 * de un lado que del otro.
 *
 * ⚠️ El import es DINÁMICO: SheetJS son ~400KB y no tienen por qué viajar en el bundle de
 * quien nunca suelta un archivo.
 */
async function readSheetFile(file: File): Promise<Sheet | null> {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith(".csv") || fileName.endsWith(".tsv") || file.type === "text/csv") {
    const text = await file.text();
    // El separador se detecta contando en la PRIMERA línea: un CSV mexicano exportado from
    // Excel usa punto y coma, porque la coma ya es el separador decimal.
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const sep = [",", ";", "\t"]
      .map((s) => ({ s, n: firstLine.split(s).length }))
      .sort((a, b) => b.n - a.n)[0].s;
    const newRows = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n+$/, "")
      .split("\n")
      .map((l) => splitCsvLine(l, sep));
    if (!newRows.length) return null;
    return { headers: newRows[0], rows: newRows.slice(1) };
  }

  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return null;
  // `header: 1` = matriz cruda, sin inventar nombres de columna. `defval: ""` para que una
  // celda vacía no desalinee la fila entera, que es el bug clásico de leer hojas.
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });
  const nonEmpty = matrix.filter((f) => f.some((c) => String(c ?? "").trim()));
  if (!nonEmpty.length) return null;
  return {
    headers: nonEmpty[0].map((c) => String(c ?? "").trim()),
    rows: nonEmpty.slice(1).map((f) => f.map((c) => String(c ?? "").trim())),
  };
}

/** Parte una línea de CSV respetando las comillas. Excel entrecomilla lo que lleva el separador. */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // Dos comillas seguidas dentro de un campo = una comilla literal.
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === sep && !inQuotes) {
      out.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current.trim());
  return out;
}

/**
 * Zona de soltar que envuelve a sus hijos.
 *
 * El contador de arrastres (`depth`) existe porque `dragleave` se dispara al pasar de
 * un hijo a otro dentro de la misma zona: sin contar, el aviso parpadea mientras el cursor
 * cruza la rejilla.
 */
export function DropZone({
  onSheet,
  children,
}: {
  onSheet: (t: Sheet, fileName: string) => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const depth = useRef(0);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      const ok = /\.(csv|tsv|xlsx|xls)$/i.test(file.name);
      if (!ok) { setError(t("Sólo .xlsx, .xls o .csv")); return; }
      setReading(file.name);
      try {
        const sheet = await readSheetFile(file);
        if (!sheet || !sheet.rows.length) { setError(t("El archivo no traía filas")); return; }
        await onSheet(sheet, file.name);
      } catch {
        setError(t("No se pudo leer el archivo"));
      } finally {
        setReading(null);
      }
    },
    [onSheet, t]
  );

  return (
    <div
      className="relative h-full"
      onDragEnter={(e) => { e.preventDefault(); depth.current++; if (e.dataTransfer.types.includes("Files")) setOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { e.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void handleFile(f);
      }}
    >
      {children}

      <AnimatePresence>
        {over || reading ? (
          <motion.div
            initial={still ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            /* ⚠️ El velo va con `--color-card`, NO con `bg-surface`: el token `--color-bg` no
               está definido en el tema, así que `bg-surface/88` se resuelve a rgba(0,0,0,0) —
               medido — y el overlay quedaba SIN velo. Mismo gotcha que `bg-surface-1`. */
            className="absolute inset-0 z-30 grid place-items-center bg-ink/25 backdrop-blur-sm pointer-events-none"
          >
            <motion.div
              initial={still ? false : { scale: 0.94, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 480, damping: 30 }}
              className="rounded-2xl px-10 py-9 text-center border-2 border-dashed border-brand bg-card shadow-2xl"
            >
              <motion.div
                className="w-14 h-14 rounded-2xl bg-brand/15 grid place-items-center mx-auto mb-3"
                animate={still || reading ? {} : { y: [0, -5, 0] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              >
                {reading ? (
                  <Loader2 size={24} className="text-brand animate-spin" />
                ) : (
                  <Upload size={24} className="text-brand" />
                )}
              </motion.div>
              <div className="font-bold text-[15px] text-ink">
                {reading ? t("Leyendo la hoja…") : t("Suelta la hoja aquí")}
              </div>
              <div className="text-xs text-muted mt-1">
                {reading ?? t(".xlsx, .xls o .csv")}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {error ? (
          <motion.div
            initial={still ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onAnimationComplete={() => setTimeout(() => setError(null), 3500)}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 gt-card rounded-xl px-4 py-2.5 text-xs flex items-center gap-2"
          >
            <FileSpreadsheet size={14} className="text-red-500" /> {error}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
