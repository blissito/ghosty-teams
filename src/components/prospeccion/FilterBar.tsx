import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bookmark, Filter as FilterIcon, Plus, Search, X } from "lucide-react";
import { useT } from "../../i18n";
import {
  STATUSES,
  TEMPS,
  describe,
  encodeFilter,
  sameCondition,
  type Condition,
  type Filter,
} from "../../lib/prospeccion-filter";

/**
 * La barra de filtros.
 *
 * Es la pieza que convierte una lista de 10 mil filas en algo con lo que se puede trabajar.
 * A ese tamaño nadie scrollea para encontrar algo — filtra. Y como toda acción
 * (enriquecer, redactar, mandar) aplica a la VISTA, esta barra es también el control de
 * alcance: lo que está aquí es a lo que le va a pasar algo.
 *
 * ⚠️ Los chips son además la prueba de que el agente entendió. Cuando `prospect_filter`
 * traduce «las de Azcapotzalco sin teléfono», el resultado aparece AQUÍ, editable, no
 * dentro de una respuesta de chat. Un agente que acota diez mil filas de datos de clientes
 * y contesta «listo» es una caja negra.
 */
export function FilterBar({
  filter,
  onChange,
  fields,
  shown,
  total,
  views = [],
  onPickView,
  onSaveView,
  onDeleteView,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
  /** Todas las columnas filtrables, base y dinámicas. */
  fields: { key: string; label: string }[];
  shown: number;
  total: number;
  /**
   * Vistas guardadas de la lista. `f` es el filtro codificado, el mismo que va en `?f=`:
   * elegir una vista es navegar a ese `f`, no reconstruir condiciones.
   */
  views?: { name: string; f: string }[];
  onPickView?: (f: string) => void;
  onSaveView?: (name: string) => Promise<void> | void;
  onDeleteView?: (name: string) => void;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (naming) nameRef.current?.focus(); }, [naming]);

  // El texto libre es el filtro que la gente usa primero, así que tiene su propio campo
  // siempre visible en vez de esconderse tras «+ filtro».
  const textCond = filter.find((c) => c.op === "text") as { op: "text"; value: string } | undefined;
  const [q, setQ] = useState(textCond?.value ?? "");
  useEffect(() => { setQ(textCond?.value ?? ""); }, [textCond?.value]);

  // Debounce: filtrar en cada tecla sobre 10 mil filas repinta la rejilla entera.
  useEffect(() => {
    const id = setTimeout(() => {
      const rest = filter.filter((c) => c.op !== "text");
      onChange(q.trim() ? [{ op: "text", value: q.trim() }, ...rest] : rest);
    }, 220);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    if (!adding) return;
    const close = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAdding(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAdding(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [adding]);

  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const chips = filter.filter((c) => c.op !== "text");
  const filtering = filter.length > 0;
  // La vista activa se reconoce por el filtro codificado, no por nombre: si el usuario
  // toca un chip, deja de coincidir y el botón de guardar vuelve a aparecer.
  const encoded = encodeFilter(filter);
  const activeView = views.find((v) => v.f === encoded)?.name ?? null;
  const canSave = filtering && !activeView && !!onSaveView;

  const saveView = async () => {
    const n = viewName.trim();
    if (!n) return;
    await onSaveView?.(n);
    setNaming(false);
    setViewName("");
  };

  const add = (c: Condition) => {
    if (filter.some((x) => sameCondition(x, c))) { setAdding(false); return; }
    onChange([...filter, c]);
    setAdding(false);
  };

  return (
    <div className="shrink-0 border-b border-border px-5 py-2 flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1">
        <Search size={12} className="shrink-0 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("buscar…")}
          className="w-40 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted"
        />
        {q ? (
          <button onClick={() => setQ("")} className="text-muted hover:text-ink">
            <X size={12} />
          </button>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {chips.map((c) => (
          <motion.button
            key={`${c.op}:${"field" in c ? c.field : ""}:${"value" in c ? c.value : ""}`}
            layout
            initial={still ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 500, damping: 38 }}
            onClick={() => onChange(filter.filter((x) => x !== c))}
            title={t("Quitar este filtro")}
            className="group inline-flex items-center gap-1.5 rounded-lg border border-brand bg-brand/5 pl-2.5 pr-1.5 py-1 text-xs"
          >
            <span className="font-medium">{describe(c, labelOf)}</span>
            <X size={11} className="text-muted group-hover:text-ink" />
          </motion.button>
        ))}
      </AnimatePresence>

      {/* Vistas guardadas: un clic aplica el filtro entero. La activa se pinta. */}
      {views.map((v) => (
        <span
          key={v.name}
          className={`group inline-flex items-center gap-1 rounded-lg border pl-2 pr-1 py-1 text-xs ${
            activeView === v.name ? "border-brand bg-brand/10 text-brand" : "border-border bg-surface-2 hover:border-ink/40"
          }`}
        >
          <button onClick={() => onPickView?.(v.f)} className="inline-flex items-center gap-1 font-medium" title={t("Aplicar esta vista")}>
            <Bookmark size={11} />
            {v.name}
          </button>
          {onDeleteView ? (
            <button
              onClick={() => onDeleteView(v.name)}
              title={t("Borrar esta vista")}
              className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-ink"
            >
              <X size={11} />
            </button>
          ) : null}
        </span>
      ))}

      {/* Añadir condición. Menú en palabras, mismo patrón que ColumnChip. */}
      <div ref={addRef} className="relative">
        <button
          onClick={() => setAdding((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${
            adding ? "border-brand bg-brand/5" : "border-border text-muted hover:bg-surface-3 hover:text-ink"
          }`}
        >
          <Plus size={11} /> {t("filtro")}
        </button>

        <AnimatePresence>
          {adding ? (
            <motion.div
              initial={still ? false : { opacity: 0, y: -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              className="absolute left-0 top-full mt-1 z-30 gt-card rounded-xl py-1 min-w-[240px] max-h-[60vh] overflow-y-auto shadow-2xl"
            >
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {t("Sin dato")}
              </div>
              {fields.map((f) => (
                <button
                  key={`empty-${f.key}`}
                  onClick={() => add({ op: "empty", field: f.key })}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-3"
                >
                  {t("sin")} {f.label}
                </button>
              ))}

              <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {t("Con dato")}
              </div>
              {fields.map((f) => (
                <button
                  key={`filled-${f.key}`}
                  onClick={() => add({ op: "filled", field: f.key })}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-3"
                >
                  {t("con")} {f.label}
                </button>
              ))}

              {/*
                La temperatura va ANTES del embudo: es lo que la gente pide en voz alta
                («enséñame los tibios»), y el embudo es el detalle de cómo llegó ahí.
              */}
              <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {t("Temperatura")}
              </div>
              {TEMPS.map((x) => (
                <button
                  key={x.id}
                  onClick={() => add({ op: "temp", value: x.id })}
                  title={t(x.hint)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-3 flex items-baseline gap-2"
                >
                  <span>{t(x.label)}</span>
                  <span className="text-[10px] text-muted truncate">{t(x.hint)}</span>
                </button>
              ))}

              <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {t("En el embudo")}
              </div>
              {STATUSES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => add({ op: "status", value: s.id })}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-3"
                >
                  {s.label}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {filtering ? (
        <button
          onClick={() => onChange([])}
          className="text-xs text-muted hover:text-ink underline underline-offset-2"
        >
          {t("Quitar todo")}
        </button>
      ) : null}

      {/* Guardar la vista actual. Input en línea: un modal para escribir una palabra es mucho. */}
      {canSave && !naming ? (
        <button
          onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink underline underline-offset-2"
        >
          <Bookmark size={11} />
          {t("Guardar vista")}
        </button>
      ) : null}
      {canSave && naming ? (
        <span className="inline-flex items-center gap-1 rounded-lg border border-brand bg-surface-2 px-2 py-1">
          <input
            ref={nameRef}
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveView();
              if (e.key === "Escape") { setNaming(false); setViewName(""); }
            }}
            placeholder={t("nombre de la vista")}
            maxLength={40}
            className="w-36 bg-transparent text-xs outline-none placeholder:text-muted"
          />
          <button onClick={() => void saveView()} disabled={!viewName.trim()} className="text-xs font-medium text-brand disabled:opacity-40">
            {t("Guardar")}
          </button>
        </span>
      ) : null}

      {/* El contador es lo que dice a cuántas le va a pasar algo. Va SIEMPRE, y cuando hay
          filtro dice las dos cifras: «312 de 10,728» es la frase con la que se decide. */}
      <span className="ml-auto text-xs tabular-nums shrink-0">
        {filtering ? (
          <>
            <FilterIcon size={11} className="inline mr-1 text-brand" />
            <span className="font-semibold text-brand">{shown.toLocaleString("es-MX")}</span>
            <span className="text-muted"> {t("de")} {total.toLocaleString("es-MX")}</span>
          </>
        ) : (
          <span className="text-muted">{total.toLocaleString("es-MX")} {t("filas")}</span>
        )}
      </span>
    </div>
  );
}
