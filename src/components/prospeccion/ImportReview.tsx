import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, FileSpreadsheet, Minus, X } from "lucide-react";
import { useT } from "../../i18n";
import { BASE_COLUMNS, type Plan, type Target } from "../../lib/prospeccion-mapping";

/**
 * Revisar antes de importar.
 *
 * Es el paso que faltaba, y no es adorno: los importadores serios —Flatfile, CSVBox,
 * Dromo— convergen en la misma regla, *validar y enseñar antes de persistir nada*. La
 * versión anterior escribía directo y quien soltaba el archivo se quedaba mirando una
 * tabla llena sin saber si el auto-mapeo había acertado ni si aquello ya estaba guardado.
 *
 * Lo que se enseña son tres cosas y en este orden, que es el orden en que se duda:
 *   1. QUÉ archivo es y cuántas filas trae.
 *   2. A DÓNDE va cada columna — el auto-mapeo como propuesta, no como decisión.
 *   3. CÓMO se van a ver las primeras filas.
 *
 * El mapeo se lee de izquierda a derecha —«Tel. de contacto → Teléfono»— porque eso es
 * literalmente lo que va a pasar. Un par de selects uno encima de otro diría lo mismo y se
 * entendería peor.
 */
export function ImportReview({
  open,
  fileName,
  plan,
  existingColumns,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  fileName: string;
  plan: Plan | null;
  /** Columnas dinámicas que la lista YA tiene, para poder mandar ahí una de la hoja. */
  existingColumns: { key: string; label: string }[];
  onCancel: () => void;
  /** Recibe también un reporte de avance para poder pintarlo. */
  onConfirm: (
    targets: Record<string, Target>,
    onProgress: (p: { done: number; total: number }) => void
  ) => Promise<void>;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [importing, setImporting] = useState(false);
  /** Avance real, en filas. Null mientras no ha empezado. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => { if (plan) setTargets(plan.targets); }, [plan]);

  /** Un campo base sólo puede recibir UNA columna: la segunda tendría que pisar a la primera. */
  const taken = useMemo(() => {
    const m = new Map<string, string>();
    for (const [h, tg] of Object.entries(targets)) {
      if (tg !== "__new__" && tg !== "__skip__") m.set(tg, h);
    }
    return m;
  }, [targets]);

  if (!plan) return null;

  const mapped = Object.values(targets).filter((x) => x !== "__skip__" && x !== "__new__").length;
  const created = Object.values(targets).filter((x) => x === "__new__").length;
  const skipped = Object.values(targets).filter((x) => x === "__skip__").length;

  const confirm = async () => {
    if (importing) return;
    setImporting(true);
    setProgress({ done: 0, total: plan.rows.length });
    await onConfirm(targets, setProgress);
    setImporting(false);
    setProgress(null);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-card/85 backdrop-blur-sm"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
        >
          <motion.div
            className="gt-card rounded-2xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden"
            initial={still ? false : { opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 440, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 1. Qué archivo es. El nombre y el conteo, no un icono decorativo. */}
            <header className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-border">
              <div className="w-10 h-10 rounded-xl bg-brand/15 grid place-items-center shrink-0">
                <FileSpreadsheet size={19} className="text-brand" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-[15px] truncate">{fileName}</div>
                <div className="text-xs text-muted mt-0.5">
                  {plan.rows.length} {t("filas")} · {plan.headers.length} {t("columnas")}
                </div>
              </div>
              <button onClick={onCancel} className="p-1.5 rounded-lg text-muted hover:bg-surface-3">
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* 2. A dónde va cada columna. */}
              <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
                {t("A dónde va cada columna")}
              </div>
              <ul className="flex flex-col gap-1">
                {plan.headers.map((h) => {
                  const tg = targets[h] ?? "__new__";
                  const conflict = taken.get(tg as string) === h ? null : taken.get(tg as string);
                  return (
                    <li key={h} className="flex items-center gap-2 text-sm">
                      <span
                        className={`flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-surface-2 border border-border ${
                          tg === "__skip__" ? "line-through text-faint" : ""
                        }`}
                        title={h}
                      >
                        {h}
                      </span>
                      {tg === "__skip__" ? (
                        <Minus size={14} className="text-faint shrink-0" />
                      ) : (
                        <ArrowRight size={14} className="text-muted shrink-0" />
                      )}
                      <select
                        value={tg}
                        onChange={(e) => setTargets((p) => ({ ...p, [h]: e.target.value as Target }))}
                        className="flex-1 min-w-0 bg-surface-2 border border-border rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                      >
                        {BASE_COLUMNS.map((b) => (
                          <option key={b.key} value={b.key} disabled={!!conflict && taken.get(b.key) !== h && taken.has(b.key)}>
                            {b.label}
                          </option>
                        ))}
                        {existingColumns.map((c) => (
                          <option key={c.key} value={c.key}>{c.label}</option>
                        ))}
                        <option value="__new__">{t("Columna nueva")}</option>
                        <option value="__skip__">{t("No importar")}</option>
                      </select>
                    </li>
                  );
                })}
              </ul>

              {/* 3. Cómo se van a ver. Tres filas bastan para reconocer un desfase de columnas,
                  que es el error que un preview tiene que cazar. */}
              <div className="text-xs font-semibold uppercase tracking-wide text-muted mt-5 mb-2">
                {t("Las primeras filas")}
              </div>
              <div className="gt-prosp-scroll overflow-x-auto border border-border rounded-xl">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="bg-surface-2">
                      {plan.headers.map((h) => (
                        <th key={h} className={`text-left font-semibold px-2.5 py-2 whitespace-nowrap ${targets[h] === "__skip__" ? "text-faint line-through" : ""}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.slice(0, 3).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {plan.headers.map((h, j) => (
                          <td key={h} className={`px-2.5 py-1.5 whitespace-nowrap max-w-[180px] truncate ${targets[h] === "__skip__" ? "text-faint" : ""}`}>
                            {r[j] || <span className="text-faint">·</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <footer className="shrink-0 px-5 py-4 border-t border-border">
              {/*
                Mientras importa, el pie se convierte en la barra. Un botón que dice
                «Importando…» durante once segundos se lee como que se colgó; una barra que
                avanza con el número de filas dice que está pasando algo y cuánto falta.
              */}
              <AnimatePresence>
                {progress ? (
                  <motion.div
                    initial={still ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mb-3"
                  >
                    <div className="flex items-baseline justify-between text-xs mb-1.5">
                      <span className="text-muted">{t("Guardando filas")}</span>
                      <span className="tabular-nums font-medium">
                        {progress.done.toLocaleString("es-MX")} / {progress.total.toLocaleString("es-MX")}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <motion.div
                        className="h-full bg-brand rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                        transition={{ type: "spring", stiffness: 120, damping: 26 }}
                      />
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-muted">
                {mapped} {t("a columnas existentes")}
                {created ? ` · ${created} ${t("nuevas")}` : ""}
                {skipped ? ` · ${skipped} ${t("fuera")}` : ""}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onCancel} className="text-sm px-3 py-2 rounded-lg text-muted hover:bg-surface-3">
                  {t("Cancelar")}
                </button>
                {/* El botón dice el número: se confirma lo que se va a hacer, no una intención. */}
                <button
                  onClick={confirm}
                  disabled={importing}
                  className="bg-brand text-brand-fg font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 disabled:opacity-50"
                >
                  {importing
                    ? t("Importando…")
                    : `${t("Importar")} ${plan.rows.length.toLocaleString("es-MX")} ${t("filas")}`}
                </button>
              </div>
              </div>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
