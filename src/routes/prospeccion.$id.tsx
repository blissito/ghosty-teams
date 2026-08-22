import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Plus, Sparkles, Target } from "lucide-react";
import { useT } from "../i18n";
import { me } from "../server/auth";
import { addColumnFn, deleteColumnFn, getListFn, importTableFn, runAiColumnFn, runColumnFn, setCellFn } from "../server/prospeccion";
import { ProspGrid, aplanar, type GridRow } from "../components/prospeccion/Grid";
import { FilterBar } from "../components/prospeccion/FilterBar";
import { AgentDrawer } from "../components/prospeccion/AgentDrawer";
import { useRtSubscribe } from "../utils/rt-bus";
import { decodeFilter, encodeFilter, matches, type Filter } from "../lib/prospeccion-filter";
import { NewColumnModal, type NewColumn } from "../components/prospeccion/NewColumnModal";
import { ColumnChip } from "../components/prospeccion/ColumnChip";
import { DropZone, type Sheet } from "../components/prospeccion/DropZone";
import { ImportReview } from "../components/prospeccion/ImportReview";
import { planImport, type Plan, type Target as ImportTarget } from "../lib/prospeccion-mapping";
import "react-data-grid/lib/styles.css";

export const Route = createFileRoute("/prospeccion/$id")({
  // ⚠️ El router parsea los search params como JSON: `?guardadas=5` llega como NÚMERO.
  // Un validador que exigiera `string` lo descartaría y el router redirigiría (307) a la
  // URL sin el parámetro — es el mismo tropiezo que costó rato con `?v` en artefactos.
  validateSearch: (s: Record<string, unknown>) => ({
    guardadas: typeof s.guardadas === "number" ? s.guardadas : undefined,
    // El filtro va como UNA clave opaca (base64url del JSON). Ver el comentario de
    // `encodeFilter`: el router deforma los search params al parsearlos como JSON, y un
    // filtro es de largo variable, así que no hay juego fijo de claves que lo represente.
    f: typeof s.f === "string" ? s.f : undefined,
  }),
  loader: async () => ({ user: await me() }),
  component: ListPage,
});

type Payload = Extract<Awaited<ReturnType<typeof getListFn>>, { ok: true }>;

function ListPage() {
  const t = useT();
  const still = useReducedMotion();
  const { id } = Route.useParams();
  const { guardadas, f } = Route.useSearch();
  const navigate = useNavigate({ from: "/prospeccion/$id" });
  const listId = Number(id);

  const [data, setData] = useState<Payload | null>(null);
  /** Qué celdas están enriqueciéndose AHORA: {rowId → llaves}. Alimenta el pulso. */
  const [busy, setBusy] = useState<Record<number, Set<string>>>({});
  const [columnModal, setColumnModal] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ plan: Plan; fileName: string } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);

  const reload = useCallback(async () => {
    const r = await getListFn({ data: { listId } });
    if (r.ok) setData(r);
  }, [listId]);

  useEffect(() => { reload(); }, [reload]);

  // Confirmación del alta recién hecha desde la pantalla de listas.
  useEffect(() => {
    if (guardadas) setNotice(`✓ ${guardadas} filas guardadas`);
  }, [guardadas]);

  const filter: Filter = useMemo(() => decodeFilter(f), [f]);

  /** Las columnas que se pueden filtrar: las base y las que se hayan agregado. */
  const fields = useMemo(
    () => (data ? [...data.base, ...data.columns.map((c) => ({ key: c.key, label: c.label }))] : []),
    [data]
  );

  /**
   * LA VISTA. Todo lo demás cuelga de aquí.
   *
   * Se filtra en el cliente porque las filas ya están todas cargadas (la rejilla es
   * virtualizada, no paginada): filtrar en el servidor costaría un viaje por cada tecla y
   * no daría nada a cambio.
   */
  const view = useMemo(() => {
    if (!data) return [];
    if (!filter.length) return data.rows;
    const keys = fields.map((x) => x.key);
    return data.rows.filter((r) => matches(r as unknown as Record<string, unknown>, filter, keys));
  }, [data, filter, fields]);

  const rows: GridRow[] = useMemo(() => aplanar(view, busy), [view, busy]);

  /**
   * El filtro que aplica el AGENTE aterriza aquí, en la barra de la persona.
   *
   * Es la diferencia entre una herramienta y una caja negra: el chip aparece, se lee, y se
   * puede quitar si entendió mal. Un `refresh` no serviría — este evento trae DATOS (el
   * filtro exacto), no un «vuelve a leer».
   */
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t !== "prospeccion:filter" || ev.listId !== listId) return;
      navigate({ search: (prev) => ({ ...prev, f: ev.f ?? undefined }), replace: true });
    },
  });

  /**
   * Lo que se le propone al agente cuando la conversación está vacía.
   *
   * ⚠️ Sale de MIRAR LOS DATOS, no de una lista fija. Ésta es la versión útil del «wizard»:
   * un flujo de pasos fijos no puede decir «8,400 no tienen correo» porque no ha visto la
   * hoja. Aquí la primera sugerencia es siempre el hueco más grande, que es exactamente el
   * siguiente paso obvio.
   */
  const sugerencias = useMemo(() => {
    if (!data) return [];
    const huecos = fields
      .map((f) => ({
        label: f.label,
        n: view.filter((r) => {
          const v = ["name", "phone", "email", "website", "address", "category"].includes(f.key)
            ? (r as unknown as Record<string, string | null>)[f.key]
            : r.data[f.key]?.v;
          return !String(v ?? "").trim();
        }).length,
      }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);

    const out: string[] = [];
    if (huecos[0]) out.push(`A las ${huecos[0].n.toLocaleString("es-MX")} sin ${huecos[0].label.toLowerCase()}, búscaselo`);
    if (huecos[1]) out.push(`Filtra las que no tienen ${huecos[1].label.toLowerCase()}`);
    out.push("¿De qué colonias son estas empresas?");
    out.push("Escribe una primera línea para cada una");
    return out.slice(0, 4);
  }, [data, fields, view]);

  const setFilter = useCallback(
    (next: Filter) => {
      // `replace` para que teclear en el buscador no llene el historial de vueltas atrás.
      navigate({ search: (prev) => ({ ...prev, f: encodeFilter(next) }), replace: true });
    },
    [navigate]
  );

  /** Edición de una celda: optimista en pantalla, persistida detrás. */
  const onCellChange = useCallback(
    (rowId: number, key: string, value: string) => {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.id !== rowId) return r;
            if (["name", "phone", "email", "website", "address", "category"].includes(key)) {
              return { ...r, [key]: value } as typeof r;
            }
            return { ...r, data: { ...r.data, [key]: { v: value, src: "manual", verified: false } } };
          }),
        };
      });
      setCellFn({ data: { rowId, key, value: value || null } }).catch(() => {});
    },
    []
  );

  /**
   * Pegado de un bloque de Excel: se reparte sobre las filas y columnas que quepan a
   * partir de la celda seleccionada. Lo que se sale del borde se descarta en silencio —
   * es lo que hace una hoja de cálculo y es lo que la gente espera.
   */
  const onPasteBlock = useCallback(
    (rowIdx: number, colKey: string, matrix: string[][]) => {
      if (!data) return;
      const order = [...data.base.map((b) => b.key), ...data.columns.map((c) => c.key)];
      const colIdx = order.indexOf(colKey);
      if (colIdx < 0) return;

      for (let dr = 0; dr < matrix.length; dr++) {
        const row = data.rows[rowIdx + dr];
        if (!row) break;
        for (let dc = 0; dc < matrix[dr].length; dc++) {
          const key = order[colIdx + dc];
          if (!key) break;
          onCellChange(row.id, key, matrix[dr][dc]);
        }
      }
    },
    [data, onCellChange]
  );

  const runColumn_ = useCallback(
    async (key: string, kind?: string) => {
      if (running) return;
      const tipo = kind ?? data?.columns.find((c) => c.key === key)?.kind;
      setRunning(key);
      // El pulso sólo en las filas de la VISTA: son las que van a cambiar.
      setBusy(Object.fromEntries(view.map((r) => [r.id, new Set([key])])));
      try {
        // ⚠️ Va el MISMO filtro que está en la URL. Lo que se ve es lo que se enriquece.
        const r = tipo === "ai"
          ? await runAiColumnFn({ data: { listId, key, f } })
          : await runColumnFn({ data: { listId, key, f } });
        if (r.ok) setNotice(`${r.filled} de ${r.total} llenadas`);
        else setNotice(("error" in r && r.error) || "No se pudo correr la columna");
      } finally {
        setBusy({});
        setRunning(null);
        await reload();
      }
    },
    [listId, reload, running, data, view, f]
  );

  const createColumn = useCallback(
    async (c: NewColumn) => {
      const r = await addColumnFn({ data: { listId, ...c } });
      if (!r.ok) return;
      await reload();
      // Una columna de búsqueda sin correr no sirve de nada: se dispara sola al crearla.
      if (r.column && (c.kind === "enrich" || c.kind === "ai")) runColumn_(r.column.key, c.kind);
    },
    // eslint-disable-next-línea react-hooks/exhaustive-deps
    [listId, reload]
  );

  /**
   * Corre una columna y pinta el pulso mientras.
   *
   * El pulso se enciende en TODAS las filas de esa columna de golpe, no fila por fila: el
   * servidor corre la columna entera en una llamada y no reporta progreso parcial. Es honesto
   * — la columna está working — y evita fingir un detalle que no tenemos.
   */
  const removeColumn = useCallback(
    async (key: string) => {
      await deleteColumnFn({ data: { listId, key } });
      await reload();
    },
    [listId, reload]
  );


  /**
   * Llega una hoja soltada: se PROPONE, no se importa.
   *
   * Mismo criterio que en la pantalla de listas. Aquí importa incluso más, porque la hoja
   * cae sobre una lista que ya tiene trabajo hecho: un mapeo mal adivinado escribiría
   * encima de columnas que costó llenar.
   */
  const importSheet = useCallback((sheet: Sheet, fileName: string) => {
    setReview({ plan: planImport(sheet.headers, sheet.rows), fileName });
  }, []);

  const confirmImport = useCallback(
    async (targets: Record<string, ImportTarget>) => {
      if (!review) return;
      const r = await importTableFn({
        data: { listId, headers: review.plan.headers, rows: review.plan.rows, targets },
      });
      setReview(null);
      if (r.ok) {
        setNotice(
          `✓ ${r.added} ${r.added === 1 ? "fila guardada" : "filas guardadas"}` +
            (r.newColumns.length ? ` · columnas nuevas: ${r.newColumns.join(", ")}` : "") +
            (r.truncated ? ` · ${r.truncated} no cupieron` : "")
        );
        await reload();
      } else {
        setNotice(r.error ?? "No se pudo importar");
      }
    },
    [listId, reload, review]
  );

  if (!data) {
    return (
      <div className="min-h-screen bg-surface text-ink flex items-center justify-center">
        <div className="animate-pulse text-muted text-sm">{t("Cargando…")}</div>
      </div>
    );
  }

  const { list } = data;

  return (
    <div className="h-screen bg-surface text-ink flex flex-col">
      <header className="shrink-0 border-b border-border px-5 py-3">
        <Link to="/prospeccion" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink mb-1.5">
          <ArrowLeft size={13} /> {t("Prospección")}
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Target size={18} className="text-brand" /> {list.name}
            </h1>
            {list.criteria && list.criteria !== list.name ? (
              <p className="text-xs text-muted mt-0.5">{list.criteria}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-4">
            {[
              { n: list.rows, l: t("filas") },
              { n: list.sent, l: t("mandados") },
              { n: list.opened, l: t("abrieron") },
              { n: list.replied, l: t("contestaron") },
            ].map((c) => (
              <div key={c.l} className="text-center">
                <div className="text-base font-bold tabular-nums">{c.n}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted">{c.l}</div>
              </div>
            ))}
            <button
              data-keep-agent
              onClick={() => setAgentOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 transition-colors ${
                agentOpen ? "bg-brand text-brand-fg" : "border border-border hover:bg-surface-3"
              }`}
              title={t("Pídele al agente que trabaje esta lista")}
            >
              <Sparkles size={13} /> {t("Agente")}
            </button>
            <button
              onClick={() => setColumnModal(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold border border-border rounded-lg px-3 py-2 hover:bg-surface-3"
              title={t("Agregar una columna: buscar un dato en internet, pedírselo al agente, o llenarla a mano")}
            >
              <Plus size={13} /> {t("Enriquecer")}
            </button>
          </div>
        </div>
      </header>

      <FilterBar
        filter={filter}
        onChange={setFilter}
        fields={fields}
        shown={view.length}
        total={data.rows.length}
      />

      {data.columns.length || notice ? (
        <div className="shrink-0 border-b border-border px-5 py-2 flex items-center gap-2 flex-wrap">
          {data.columns.map((c) => (
            <ColumnChip
              key={c.key}
              label={c.label}
              kind={c.kind}
              running={running === c.key}
              onRun={() => runColumn_(c.key, c.kind)}
              onRemove={() => removeColumn(c.key)}
            />
          ))}
          <AnimatePresence>
            {notice ? (
              <motion.span
                key={notice}
                initial={still ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                onAnimationComplete={() => { setTimeout(() => setNotice(null), 4000); }}
                className="text-xs text-brand ml-auto"
              >
                {notice}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <motion.div
        className="flex-1 min-h-0"
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      >
        <DropZone onSheet={importSheet}>
          <ProspGrid
            rows={rows}
            base={data.base}
            columns={data.columns}
            onCellChange={onCellChange}
            onPasteBlock={onPasteBlock}
          />
        </DropZone>
      </motion.div>

      <ImportReview
        open={!!review}
        fileName={review?.fileName ?? ""}
        plan={review?.plan ?? null}
        existingColumns={data.columns.map((c) => ({ key: c.key, label: c.label }))}
        onCancel={() => setReview(null)}
        onConfirm={confirmImport}
      />

      <AgentDrawer
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        listId={listId}
        filter={f}
        suggestions={sugerencias}
      />

      <NewColumnModal open={columnModal} onClose={() => setColumnModal(false)} onCreate={createColumn} />
    </div>
  );
}
