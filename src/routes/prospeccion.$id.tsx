import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Plus, Send, ShieldCheck, Sparkles, Target } from "lucide-react";
import { useT } from "../i18n";
import { me } from "../server/auth";
import { addColumnFn, deleteColumnFn, getListFn, importTableFn, misPermisosFn, promoteEmailFn, runAiColumnFn, runColumnFn, setCellFn, setColumnOrderFn, setColumnWidthFn } from "../server/prospeccion";
import { ProspGrid, aplanar, findLatLon, type GridRow } from "../components/prospeccion/Grid";
import { FilterBar } from "../components/prospeccion/FilterBar";
import { SendReview } from "../components/prospeccion/SendReview";
import { AgentDrawer } from "../components/prospeccion/AgentDrawer";
import { Permisos } from "../components/prospeccion/Permisos";
import { useRtSubscribe } from "../utils/rt-bus";
import { decodeFilter, encodeFilter, matches, type Condition, type Filter } from "../lib/prospeccion-filter";
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
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSubject, setSendSubject] = useState("");
  /** Lo que ESTA persona puede. El servidor lo comprueba igual; esto es para no ofrecerlo. */
  const [permisos, setPermisos] = useState<{ mandar: boolean; purgar: boolean; puedeConceder: boolean } | null>(null);
  const [permisosOpen, setPermisosOpen] = useState(false);

  /*
    Ancho de columna. Se guarda y ya: NO se recarga la lista.

    Recargar repintaría la rejilla entera a media interacción, y el ancho nuevo ya está en
    pantalla porque lo puso react-data-grid. La lectura siguiente lo trae de la base.
  */
  const onResize = useCallback(
    (key: string, width: number) => {
      void setColumnWidthFn({ data: { listId, key, width } }).catch(() => {});
    },
    [listId]
  );

  const reload = useCallback(async () => {
    const r = await getListFn({ data: { listId } });
    if (r.ok) setData(r);
  }, [listId]);

  /**
   * Reordenar columnas.
   *
   * Se guarda y se recarga. No se pinta optimista a propósito: el orden lo aplica `useMemo`
   * sobre `colOrder`, así que si se pintara antes de guardar y el guardado fallara, la
   * pantalla se quedaría enseñando un orden que no existe en ningún sitio.
   */
  const onReorder = useCallback(
    async (keys: string[]) => {
      await setColumnOrderFn({ data: { listId, keys } }).catch(() => {});
      await reload();
    },
    [listId, reload]
  );

  useEffect(() => { reload(); }, [reload]);
  // ⚠️ Con la lista: quien la creó manda sobre ella, y sin el `listId` el servidor no
  // puede saberlo — le negaría el permiso a su propio dueño.
  useEffect(() => { misPermisosFn({ data: { listId } }).then(setPermisos).catch(() => {}); }, [listId]);

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

  /** ¿La lista trae coordenadas? Si sí, las dos columnas se colapsan en un enlace a Maps. */
  const latLon = useMemo(() => (data ? findLatLon(fields) : null), [data, fields]);

  const rows: GridRow[] = useMemo(() => aplanar(view, busy, latLon), [view, busy, latLon]);

  /**
   * El filtro que aplica el AGENTE aterriza aquí, en la barra de la persona.
   *
   * Es la diferencia entre una herramienta y una caja negra: el chip aparece, se lee, y se
   * puede quitar si entendió mal. Un `refresh` no serviría — este evento trae DATOS (el
   * filtro exacto), no un «vuelve a leer».
   */
  /*
    ⌘K / Ctrl+K abre y cierra el agente. Es el atajo que ya espera todo el mundo para «la
    caja donde le pido cosas», y sin él el panel sólo se alcanza con el ratón — justo lo
    contrario de lo que se quiere de una superficie agéntica.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setAgentOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "prospeccion:filter" && ev.listId === listId) {
        navigate({ search: (prev) => ({ ...prev, f: ev.f ?? undefined }), replace: true });
        return;
      }
      // El agente propuso mandar: se abre la confirmación con su asunto. Decide la persona.
      if (ev.t === "prospeccion:send" && ev.listId === listId) {
        setSendSubject(ev.subject);
        setSendOpen(true);
        return;
      }
      // El agente pidió una columna: se crea y se corre por el MISMO camino que el modal,
      // así que hereda el pulso de progreso y el aviso de por qué se saltó cada fila.
      if (ev.t === "prospeccion:column" && ev.listId === listId) {
        crearColumnaRef.current?.(
          { label: ev.label, kind: ev.kind, waterfall: ev.waterfall, prompt: ev.prompt, mode: ev.mode } as NewColumn,
          ev.limit ?? undefined
        );
      }
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

    const hueco = (key: string) =>
      view.filter((r) => {
        const v = ["name", "phone", "email", "website", "address", "category"].includes(key)
          ? (r as unknown as Record<string, string | null>)[key]
          : r.data[key]?.v;
        return !String(v ?? "").trim();
      }).length;

    /**
     * ⚠️ El orden lo dicta EL LOOP, no el tamaño del hueco.
     *
     * La primera versión ordenaba por cuántas filas faltaban y proponía «a las 2,000 sin
     * dirección, búscaselo»: el hueco más grande, y la sugerencia más inútil que existe.
     * Nadie prospecta por dirección — y encima no hay enriquecedor de direcciones, así que
     * era ofrecer trabajo que no se puede hacer.
     *
     * El loop es: el correo abre, WhatsApp cierra. Sin correo no hay nada que abrir, así
     * que ése es siempre el primer hueco que importa. Y sólo se ofrece lo que se sabe
     * llenar: una sugerencia que no se puede cumplir es peor que ninguna.
     */
    const out: string[] = [];
    const sinCorreo = hueco("email");
    const sinTel = hueco("phone");
    const listas = view.length;

    if (sinCorreo) out.push(`Búscale el correo a las ${sinCorreo.toLocaleString("es-MX")} que no lo tienen`);
    if (sinTel && !sinCorreo) out.push(`Filtra las ${sinTel.toLocaleString("es-MX")} sin teléfono`);
    if (!sinCorreo && listas) out.push(`Escríbeles una primera línea a las ${listas.toLocaleString("es-MX")}`);

    // Preguntas sobre los datos: siempre útiles y no cuestan nada más que un turno.
    out.push("¿Qué tienen en común las que ya contestaron?");
    out.push("Enséñame 5 y dime cuáles se ven mejores");

    return out.slice(0, 4);
  }, [data, view]);

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
    async (key: string, kind?: string, limit?: number) => {
      if (running) return;
      const tipo = kind ?? data?.columns.find((c) => c.key === key)?.kind;
      setRunning(key);
      // El pulso sólo en las filas de la VISTA: son las que van a cambiar.
      // El pulso, sólo en las filas que de verdad van a correr.
      setBusy(Object.fromEntries(view.slice(0, limit && limit > 0 ? limit : undefined).map((r) => [r.id, new Set([key])])));
      try {
        // ⚠️ Va el MISMO filtro que está en la URL. Lo que se ve es lo que se enriquece.
        const r = tipo === "ai"
          ? await runAiColumnFn({ data: { listId, key, f, limit } })
          : await runColumnFn({ data: { listId, key, f, limit } });
        if (r.ok) {
          // El motivo va JUNTO al número: «0 de 4 llenadas» sin explicación se lee como
          // que la herramienta está rota. «0 de 4 · ninguna fila tenía un valor en la
          // columna Correo» se lee como qué hacer a continuación.
          const nota = "note" in r && r.note ? ` · ${r.note}` : "";
          setNotice(`${r.filled} de ${r.total} llenadas${nota}`);
        }
        else setNotice(("error" in r && r.error) || "No se pudo correr la columna");
      } finally {
        setBusy({});
        setRunning(null);
        await reload();
      }
    },
    [listId, reload, running, data, view, f]
  );

  /*
    El bus llega antes de que `createColumn` esté declarada, y meterla en las dependencias
    del suscriptor lo re-suscribiría en cada render. Una ref lo resuelve sin ninguna de las
    dos cosas.
  */
  const crearColumnaRef = useRef<((c: NewColumn, limit?: number) => void) | null>(null);

  const createColumn = useCallback(
    async (c: NewColumn, limit?: number) => {
      const r = await addColumnFn({ data: { listId, ...c, f } });
      // ⚠️ Callarse aquí era el bug: el agente decía «ya la lancé», el guard la rechazaba
      // («ninguna de las N filas tiene…») y en pantalla no pasaba nada de nada.
      if (!r.ok) {
        setNotice(("error" in r && r.error) || t("No se pudo crear la columna"));
        return;
      }
      await reload();
      // Una columna de búsqueda sin correr no sirve de nada: se dispara sola al crearla.
      if (r.column && (c.kind === "enrich" || c.kind === "ai")) runColumn_(r.column.key, c.kind, limit);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listId, reload]
  );

  useEffect(() => { crearColumnaRef.current = createColumn; }, [createColumn]);

  /**
   * Corre una columna y pinta el pulso mientras.
   *
   * El pulso se enciende en TODAS las filas de esa columna de golpe, no fila por fila: el
   * servidor corre la columna entera en una llamada y no reporta progreso parcial. Es honesto
   * — la columna está working — y evita fingir un detalle que no tenemos.
   */
  /**
   * Pasa los correos de una columna propia a la columna base Correo.
   *
   * Existe porque el envío y el verificador miran SÓLO la columna base, y una hoja
   * importada trae los correos donde los traiga. Nunca pisa un correo que ya está.
   */
  const promote = useCallback(
    async (key: string) => {
      const r = await promoteEmailFn({ data: { listId, key } });
      if (r.ok) setNotice(`✓ ${r.n} ${r.n === 1 ? "correo pasado" : "correos pasados"} a la columna Correo`);
      await reload();
    },
    [listId, reload]
  );

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
            {/*
              El embudo, en el vocabulario de prospección y no en el del mecanismo.
              «Abrieron» y «contestaron» nombran lo que pasó; TIBIO y CALIENTE nombran qué
              hacer con cada uno, que es lo que se pregunta en voz alta.

              ⚠️ Caliente = te escribió él, y ésa es exactamente la ventana de 24h de
              WhatsApp: se le puede contestar libre. A un frío sólo plantilla aprobada, y
              masivo eso quema el número. Por eso la línea que los separa se pinta.

              Cada número FILTRA al hacer clic: un contador que no lleva a las filas que
              cuenta obliga a reconstruir el filtro a mano.
            */}
            {[
              { n: list.rows, l: t("filas"), c: null as Condition | null, hint: t("Toda la lista") },
              { n: list.sent, l: t("mandados"), c: { op: "status", value: "sent" } as Condition, hint: t("Ya les salió el correo") },
              { n: list.opened + list.clicked, l: t("tibios"), c: { op: "temp", value: "tibio" } as Condition, hint: t("Abrieron o dieron clic") },
              { n: list.replied, l: t("calientes"), c: { op: "temp", value: "caliente" } as Condition, hint: t("Te escribieron: se les puede contestar libre") },
            ].map((x) => (
              <button
                key={x.l}
                onClick={() => setFilter(x.c ? [x.c] : [])}
                title={x.hint}
                disabled={!x.n && !!x.c}
                className="text-center px-1 rounded-lg hover:bg-surface-3 disabled:hover:bg-transparent disabled:opacity-50 transition-colors"
              >
                <div className={`text-base font-bold tabular-nums ${x.l === t("calientes") && x.n ? "text-amber-500" : ""}`}>
                  {x.n}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted">{x.l}</div>
              </button>
            ))}
            {/*
              ⚠️ El botón dice el NÚMERO, nunca sólo el verbo. Del spec: «Mandar» sobre una
              vista de 312 y sobre una lista de 10,728 es la misma palabra y dos
              consecuencias muy distintas.
            */}
            {/* Se esconde si no puede, en vez de dejarlo y fallar al apretar: ofrecer algo
                que va a ser rechazado es peor que no ofrecerlo. El servidor lo comprueba
                igual — esconder un botón NO es un permiso. */}
            {permisos?.mandar !== false ? (
            <button
              onClick={() => setSendOpen(true)}
              disabled={!view.length}
              className="inline-flex items-center gap-1.5 text-xs font-semibold border border-border rounded-lg px-3 py-2 hover:bg-surface-3 disabled:opacity-40"
              title={t("Mandarles correo a las filas que estás viendo")}
            >
              <Send size={13} /> {t("Mandar a")} {view.length.toLocaleString("es-MX")}
            </button>
            ) : null}
            {/* Sólo lo ve quien puede repartir: el dueño del espacio, o quien creó la lista. */}
            {permisos?.puedeConceder ? (
              <button
                onClick={() => setPermisosOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold border border-border rounded-lg px-3 py-2 hover:bg-surface-3"
                title={t("Quién puede mandar y borrar en esta lista")}
              >
                <ShieldCheck size={13} /> {t("Permisos")}
              </button>
            ) : null}
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
              /* Se cuenta sobre la VISTA: si filtraste, la acción va a actuar sobre eso. */
              emailCount={view.filter((r) => (r.data[c.key]?.v ?? "").includes("@")).length}
              /* Sólo se distingue cuando hace falta: un contador permanente sería ruido. */
              duplicada={data.columns.filter((x) => x.label === c.label).length > 1}
              filled={view.filter((r) => (r.data[c.key]?.v ?? "").trim()).length}
              total={view.length}
              running={running === c.key}
              onRun={() => runColumn_(c.key, c.kind)}
              onUseAsEmail={() => promote(c.key)}
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
            colOrder={data.list.colOrder}
            colWidths={data.list.colWidths}
            onReorder={onReorder}
            onResize={onResize}
            latLon={latLon}
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

      <SendReview
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        listId={listId}
        filter={f}
        initialSubject={sendSubject}
        onSent={(resumen) => { setNotice(resumen); reload(); }}
      />

      <AgentDrawer
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        listId={listId}
        filter={f}
        suggestions={sugerencias}
      />

      <Permisos
        open={permisosOpen}
        onClose={() => setPermisosOpen(false)}
        listId={listId}
        listName={data?.list.name}
        creadorSub={data?.list.createdBy}
      />

      <NewColumnModal open={columnModal} onClose={() => setColumnModal(false)} onCreate={createColumn} />
    </div>
  );
}
