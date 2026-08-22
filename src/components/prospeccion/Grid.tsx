import { useCallback, useMemo, useRef, useState } from "react";
import { DataGrid, type CellMouseArgs, type Column, type RenderCellProps, type RenderEditCellProps, type RowsChangeData } from "react-data-grid";
import { motion, useReducedMotion } from "motion/react";
import { Ban, Check, Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import type { getListFn } from "../../server/prospeccion";

type Payload = Extract<Awaited<ReturnType<typeof getListFn>>, { ok: true }>;
export type RowData = Payload["rows"][number];
export type ColumnDef = Payload["columns"][number];
export type Base = Payload["base"][number];

/** RowData tal como la ve la rejilla: todo aplanado a string, más metadatos de pintado. */
export type GridRow = {
  id: number;
  __status: string;
  /** Llaves de columna que están enriqueciéndose AHORA. Pinta el pulso. */
  __busy: Set<string>;
  [key: string]: unknown;
};

const BASE_KEYS = new Set(["name", "phone", "email", "website", "address", "category"]);

export function aplanar(rows: RowData[], busy: Record<number, Set<string>> = {}): GridRow[] {
  return rows.map((r) => {
    const o: GridRow = { id: r.id, __status: r.status, __busy: busy[r.id] ?? new Set() };
    for (const k of BASE_KEYS) o[k] = (r as unknown as Record<string, unknown>)[k] ?? "";
    for (const [k, cell] of Object.entries(r.data ?? {})) o[k] = cell?.v ?? "";
    return o;
  });
}

/**
 * Una celda.
 *
 * Los tres estados dicen cosas distintas y por eso se ven distinto: VACÍA es "todavía no
 * se ha pedido", PULSANDO es "está working" y LLENA entra con un desplazamiento corto
 * para que el ojo la cace — sin eso, cien celdas llenándose a destiempo se ven como una
 * pantalla que parpadea sola.
 */
function CellView({ row, column }: RenderCellProps<GridRow>) {
  const still = useReducedMotion();
  const key = column.key;
  const v = row[key];
  const text = v == null || v === "" ? null : String(v);
  const working = row.__busy.has(key);
  const opted = row.__status === "optout";

  if (working) {
    return (
      <motion.span
        className="flex items-center gap-1.5 text-muted text-xs"
        animate={still ? {} : { opacity: [0.45, 1, 0.45] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
      >
        <Loader2 size={12} className="animate-spin" /> {"···"}
      </motion.span>
    );
  }

  if (!text) return <span className="text-faint">·</span>;

  // Los sí/no se leen mejor como marca que como palabra.
  if (text === "true" || text === "sí" || text === "si") {
    return <span className="inline-flex items-center gap-1 text-emerald-600"><Check size={13} /> {"sí"}</span>;
  }
  if (text === "false" || text === "no") {
    return <span className="text-muted">no</span>;
  }

  return (
    <motion.span
      key={text}
      initial={still ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: opted ? 0.4 : 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={opted ? "line-through" : undefined}
    >
      {text}
    </motion.span>
  );
}

/** Editor de celda: un input plano. `autoFocus` y selección al abrir, como una hoja. */
function CellEditor({ row, column, onRowChange, onClose }: RenderEditCellProps<GridRow>) {
  return (
    <input
      className="w-full h-full px-2 bg-surface-1 text-ink outline-none border-2 border-brand rounded-[3px]"
      autoFocus
      defaultValue={String(row[column.key] ?? "")}
      onBlur={(e) => { onRowChange({ ...row, [column.key]: e.target.value }, true); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(false); }
        if (e.key === "Enter") { onRowChange({ ...row, [column.key]: e.currentTarget.value }, true); }
      }}
    />
  );
}

export function ProspGrid({
  rows,
  base,
  columns,
  onCellChange,
  onPasteBlock,
  onColumnHeaderClick,
}: {
  rows: GridRow[];
  base: Base[];
  columns: ColumnDef[];
  onCellChange: (rowId: number, key: string, value: string) => void;
  /** Pegado multi-celda: (filaInicial, colInicial, matriz). */
  onPasteBlock: (rowIdx: number, colKey: string, matrix: string[][]) => void;
  onColumnHeaderClick?: (key: string) => void;
}) {
  const t = useT();
  const [sel, setSel] = useState<{ rowIdx: number; colKey: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const cols = useMemo<Column<GridRow>[]>(() => {
    const built: Column<GridRow>[] = [
      {
        key: "__n",
        name: "#",
        width: 48,
        frozen: true,
        resizable: false,
        renderCell: ({ rowIdx, row }) =>
          row.__status === "optout" ? (
            <span title={t("Se dio de stop1. No se le vuelve a escribir.")} className="text-draft-500/70 flex items-center h-full">
              <Ban size={13} />
            </span>
          ) : (
            <span className="text-faint tabular-nums text-xs">{rowIdx + 1}</span>
          ),
      },
    ];
    for (const b of base) {
      built.push({
        key: b.key,
        name: b.label,
        width: b.key === "address" ? 240 : b.key === "name" ? 220 : 160,
        // El nombre del negocio va CONGELADO: con doce columnas, desplazarse a la derecha
        // sin él deja filas de puros datos sueltos sin saber de quién son.
        frozen: b.key === "name",
        resizable: true,
        editable: true,
        renderCell: CellView,
        renderEditCell: CellEditor,
      });
    }
    for (const c of columns) {
      built.push({
        key: c.key,
        name: c.label,
        width: c.width ?? 170,
        resizable: true,
        editable: true,
        renderCell: CellView,
        renderEditCell: CellEditor,
        renderHeaderCell: () => (
          <button
            onClick={() => onColumnHeaderClick?.(c.key)}
            className="w-full text-left truncate hover:text-brand"
            title={c.kind === "ai" ? t("Columna del agente") : c.kind === "enrich" ? t("Columna de enriquecimiento") : undefined}
          >
            {c.label}
          </button>
        ),
      });
    }
    return built;
  }, [base, columns, onColumnHeaderClick, t]);

  /**
   * Pegado from Excel.
   *
   * ⚠️ `onCellPaste` de react-data-grid es CELDA POR CELDA y por eso no sirve aquí: un
   * bloque de Excel llega como un solo string con tabuladores y saltos de línea, y hay que
   * repartirlo sobre N filas × M columnas. Se intercepta el evento nativo del contenedor.
   *
   * Excel envuelve en comillas las celdas que llevan tabulador o salto dentro; se limpian,
   * si no aparecen comillas de más en los datos pegados.
   */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const text = e.clipboardData.getData("text/plain");
      if (!text || !sel) return;
      const matrix = text
        .replace(/\r\n?/g, "\n")
        .replace(/\n$/, "")
        .split("\n")
        .map((line) =>
          line.split("\t").map((cell) => {
            const v = cell.trim();
            return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v;
          })
        );
      // Una sola celda: que lo maneje el flujo normal de edición.
      if (matrix.length === 1 && matrix[0].length === 1) return;
      e.preventDefault();
      onPasteBlock(sel.rowIdx, sel.colKey, matrix);
    },
    [sel, onPasteBlock]
  );

  /**
   * Arrastrar con la mano para desplazar.
   *
   * Se puede porque en esta rejilla el arrastre no significa nada más: seleccionar es un
   * clic y editar es doble clic. ⚠️ Si algún día se agrega selección de rango con arrastre,
   * esto tiene que pasar a un modificador (espacio, o botón central).
   *
   * No se toca cuando el objetivo es un input (celda en edición), un botón o la cabecera:
   * ahí el arrastre ya tiene dueño (redimensionar columnas).
   */
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, button, .rdg-header-row")) return;
    const grid = wrapRef.current?.querySelector(".rdg") as HTMLElement | null;
    if (!grid) return;
    pan.current = { x: e.clientX, y: e.clientY, left: grid.scrollLeft, top: grid.scrollTop };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const p = pan.current;
    if (!p) return;
    const grid = wrapRef.current?.querySelector(".rdg") as HTMLElement | null;
    if (!grid) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    // Umbral de 4px: sin él, un clic con un temblor de un pixel se lee como arrastre y la
    // celda no llega a seleccionarse.
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    setDragging(true);
    grid.scrollLeft = p.left - dx;
    grid.scrollTop = p.top - dy;
  }, []);

  const endPan = useCallback(() => { pan.current = null; setDragging(false); }, []);

  return (
    <div
      ref={wrapRef}
      onPaste={onPaste}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endPan}
      onMouseLeave={endPan}
      className={`gt-prosp h-full ${dragging ? "cursor-grabbing select-none" : "cursor-grab"}`}
    >
      <DataGrid
        columns={cols}
        rows={rows}
        rowKeyGetter={(r: GridRow) => r.id}
        onCellClick={({ row, column }: CellMouseArgs<GridRow>) => {
          const idx = rows.findIndex((r) => r.id === row.id);
          setSel({ rowIdx: idx, colKey: column.key });
        }}
        onRowsChange={(extras: GridRow[], { indexes, column }: RowsChangeData<GridRow>) => {
          for (const i of indexes) {
            const r = extras[i];
            onCellChange(r.id, column.key, String(r[column.key] ?? ""));
          }
        }}
        rowHeight={38}
        headerRowHeight={40}
        /* `h-full` no basta: react-data-grid dimensiona con `block-size` propio y por
           defecto se ajusta al CONTENIDO — la rejilla quedaba flotando en la mitad de arriba
           con un hueco negro debajo. */
        style={{ blockSize: "100%" }}
        /* Sin `rdg-light` ni `rdg-dark`: el tema lo pone `.gt-prosp .rdg` en styles.css
           con los tokens del workspace, así sigue al preset y al brand kit. */
      />
    </div>
  );
}
