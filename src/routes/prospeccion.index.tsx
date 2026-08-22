import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Target as TargetIcon, ArrowLeft, Search, Loader2, Archive, ArchiveRestore, ChevronRight, ClipboardPaste, Trash2, X } from "lucide-react";
import { DropZone, type Sheet } from "../components/prospeccion/DropZone";
import { ImportReview } from "../components/prospeccion/ImportReview";
import { planImport, type Plan, type Target } from "../lib/prospeccion-mapping";
import { importInChunks } from "../lib/prospeccion-import-client";
import { useT } from "../i18n";
import { me } from "../server/auth";
import { archiveListFn, createListFromSheetFn, createListFn, createEmptyListFn, importTableFn, listArchivedFn, listProspListsFn, purgeListFn, restoreListFn } from "../server/prospeccion";

type ListRow = Awaited<ReturnType<typeof listProspListsFn>>["lists"][number];

// Cache de módulo, igual que /forms: re-entrar no vuelve a enseñar el skeleton.
let cache: ListRow[] | null = null;

// ⚠️ El archivo es `prospeccion.index.tsx`, no `prospeccion.tsx`.
//
// En TanStack Router, `prospeccion.tsx` junto a `prospeccion.$id.tsx` convierte al primero
// en LAYOUT PADRE del segundo. Sin un `<Outlet/>` dentro, entrar a /prospeccion/7 cambiaba
// la URL y seguía pintando el índice — la navegación se veía como que "no pasó nada".
// Con `.index` son hermanas y cada una manda en su ruta.
export const Route = createFileRoute("/prospeccion/")({
  loader: async () => ({ user: await me() }),
  component: ProspeccionPage,
});

/**
 * CountUp hacia el número nuevo en vez de saltar a él.
 *
 * Es la única animación de la pantalla que existe por una razón funcional y no estética:
 * estos contadores se mueven solos cuando alguien abre un correo, y un número que salta
 * sin avisar no se percibe. Contando, el ojo lo caza.
 */
function CountUp({ n }: { n: number }) {
  const still = useReducedMotion();
  const [v, setV] = useState(n);
  const prev = useRef(n);
  useEffect(() => {
    if (still || n === prev.current) { setV(n); prev.current = n; return; }
    const from = prev.current;
    const delta = n - from;
    const dur = Math.min(600, 200 + Math.abs(delta) * 12);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      // easeOutCubic: arranca rápido y frena, que es como se lee un contador.
      setV(Math.round(from + delta * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    prev.current = n;
    return () => cancelAnimationFrame(raf);
  }, [n, still]);
  return <span className="tabular-nums">{v}</span>;
}

/** Las cuatro cifras del embudo. Se pintan siempre, aunque estén en cero. */
function Funnel({ l }: { l: ListRow }) {
  const t = useT();
  const figures = [
    { n: l.rows, label: t("filas"), tone: "text-ink" },
    { n: l.sent, label: t("mandados"), tone: "text-ink" },
    { n: l.opened, label: t("abrieron"), tone: "text-ink" },
    { n: l.replied, label: t("contestaron"), tone: "text-brand" },
  ];
  return (
    <div className="flex items-center gap-4">
      {figures.map((c) => (
        <div key={c.label} className="text-center min-w-[52px]">
          <div className={`text-lg font-bold ${c.tone}`}><CountUp n={c.n} /></div>
          <div className="text-[10px] uppercase tracking-wide text-muted">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function ProspeccionPage() {
  const t = useT();
  const navigate = useNavigate();
  const still = useReducedMotion();
  const [lists, setLists] = useState<ListRow[] | null>(cache);
  const [criteria, setCriteria] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ plan: Plan; fileName: string } | null>(null);
  const [undo, setUndo] = useState<{ id: number; name: string; purgeAt: number } | null>(null);
  const [importing, setImporting] = useState<{ fileName: string; done: number; total: number } | null>(null);
  /** Qué se está mirando: lo vivo o el archivo. */
  const [view, setView] = useState<"live" | "archived">("live");
  const [archived, setArchived] = useState<ListRow[] | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);

  const refresh = () =>
    listProspListsFn()
      .then((r) => { cache = r.lists; setLists(r.lists); })
      .catch(() => {});

  useEffect(() => { refresh(); }, []);

  // Las archivadas se piden al ENTRAR a su vista, no con la página: casi ningún workspace
  // tiene, y una consulta más en cada carga por algo que se mira una vez al mes no se paga.
  // El mismo servidor aprovecha para purgar lo que ya cumplió plazo.
  useEffect(() => {
    if (view !== "archived") return;
    listArchivedFn()
      .then((r) => { setArchived(r.lists); setArchivedCount(r.lists.length); })
      .catch(() => setArchived([]));
  }, [view]);

  const restore = async (id: number) => {
    setArchived((p) => (p ?? []).filter((l) => l.id !== id));
    setArchivedCount((n) => Math.max(0, n - 1));
    await restoreListFn({ data: { listId: id } }).catch(() => {});
    await refresh();
  };

  /** Borrar YA, sin esperar el plazo. Es el único camino irreversible, y por eso pregunta. */
  const purge = async (id: number, name: string) => {
    if (!confirm(t("Borrar «") + name + t("» para siempre. Esto no se puede deshacer."))) return;
    setArchived((p) => (p ?? []).filter((l) => l.id !== id));
    setArchivedCount((n) => Math.max(0, n - 1));
    await purgeListFn({ data: { listId: id } }).catch(() => {});
  };

  const search = async () => {
    const c = criteria.trim();
    if (!c || searching) return;
    setSearching(true);
    setError(null);
    try {
      const r = await createListFn({ data: { criteria: c } });
      if (!r.ok) { setError(r.error ?? t("No se pudo buscar")); return; }
      setCriteria("");
      await refresh();
      // Entrar directo a la lista: buscar y quedarse mirando la tarjeta sería un clic de más.
      navigate({ to: "/prospeccion/$id", params: { id: String(r.listId) }, search: { guardadas: undefined, f: undefined } });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSearching(false);
    }
  };

  const createEmpty = async () => {
    if (searching) return;
    setSearching(true);
    const r = await createEmptyListFn({ data: {} }).catch(() => ({ ok: false as const }));
    setSearching(false);
    if (r.ok && "listId" in r) {
      await refresh();
      navigate({ to: "/prospeccion/$id", params: { id: String(r.listId) }, search: { guardadas: undefined, f: undefined } });
    }
  };

  /**
   * Soltar una hoja NO importa: propone.
   *
   * Se abre la revisión con lo que se entendió, y hasta que la persona confirma no se
   * escribe una sola fila. Es la diferencia entre «¿ya se guardó o es una vista previa?» y
   * saberlo. Es la regla en la que coinciden los importadores serios: enseñar y validar
   * antes de persistir.
   */
  const fromSheet = (sheet: Sheet, fileName: string) => {
    setError(null);
    setReview({ plan: planImport(sheet.headers, sheet.rows), fileName });
  };

  /**
   * Confirmar cierra el modal y sigue en segundo plano.
   *
   * No es un sistema de trabajos —a once segundos eso sería una cola, una tabla de estado y
   * un sondeo para nada—: es que el modal deja de bloquear en cuanto la persona decidió. Lo
   * que queda es una barra flotante con el avance real, y se puede seguir usando la app.
   *
   * ⚠️ Sigue atado a la pestaña: cerrarla a media importación deja la lista con las filas
   * que alcanzaron a entrar. Con hojas de este tamaño (11 s medidos para 10,728) es un
   * riesgo aceptable; el día que haya hojas de minutos, esto se convierte en un trabajo de
   * verdad del lado del servidor.
   */
  const confirmImport = async (targets: Record<string, Target>) => {
    if (!review) return;
    const { plan, fileName } = review;
    setReview(null);
    setImporting({ fileName, done: 0, total: plan.rows.length });

    let listId = 0;
    const r = await importInChunks({
      headers: plan.headers,
      rows: plan.rows,
      targets,
      onProgress: (p) => setImporting((prev) => (prev ? { ...prev, ...p } : prev)),
      send: async (chunk, first) => {
        if (first) {
          const res = await createListFromSheetFn({
            data: { name: fileName, headers: plan.headers, rows: chunk, targets },
          });
          if (res.ok) listId = res.listId;
          return { ok: res.ok, added: res.added ?? 0, newColumns: [], error: res.error };
        }
        const res = await importTableFn({
          data: { listId, headers: plan.headers, rows: chunk, targets },
        });
        return { ok: res.ok, added: res.added ?? 0, newColumns: [], error: res.error };
      },
    });

    setImporting(null);
    if (r.error) { setError(r.error); return; }
    await refresh();
    navigate({ to: "/prospeccion/$id", params: { id: String(listId) }, search: { guardadas: r.added, f: undefined } });
  };

  /**
   * Archiva. No borra.
   *
   * Sin diálogo de «¿seguro?» a propósito: preguntar sólo tiene sentido cuando la acción es
   * irreversible, y ésta no lo es. Lo que sí hace falta es DECIR que se recupera y hasta
   * cuándo, con un deshacer a mano. Un modal de confirmación en una acción reversible es
   * fricción que además enseña a la gente a darle a "sí" sin leer.
   */
  const archive = async (id: number, name: string) => {
    const antes = lists ?? [];
    setLists(antes.filter((l) => l.id !== id));
    cache = antes.filter((l) => l.id !== id);
    const r = await archiveListFn({ data: { listId: id } }).catch(() => ({ ok: false as const, purgeAt: 0 }));
    if (!r.ok) { setLists(antes); cache = antes; return; }
    setUndo({ id, name, purgeAt: r.purgeAt });
    // Al archivar la primera, la pestaña tiene que aparecer sin recargar.
    setArchivedCount((n) => n + 1);
  };

  const undoArchive = async () => {
    if (!undo) return;
    await restoreListFn({ data: { listId: undo.id } }).catch(() => {});
    setUndo(null);
    await refresh();
  };

  return (
    <DropZone onSheet={fromSheet}>
    <div className="min-h-screen bg-surface text-ink">
      <div className="max-w-4xl mx-auto px-5 py-8">
        <Link to="/c/$slug" params={{ slug: "general" }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink mb-4">
          <ArrowLeft size={15} /> {t("Volver al chat")}
        </Link>

        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TargetIcon size={22} className="text-brand" /> {t("Prospección")}
          </h1>
          <p className="text-muted text-sm mt-1">
            {t("Busca negocios, enriquécelos por columna y ábreles conversación. El correo abre; WhatsApp cierra.")}
          </p>
        </header>

        {/* La entrada es una frase, no un formulario de filtros. */}
        <div className="gt-card rounded-2xl p-4 mb-6">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("Qué negocios buscas")}
          </label>
          <div className="flex gap-2 mt-2">
            <input
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); }}
              placeholder={t("100 dentistas en Polanco")}
              disabled={searching}
              className="flex-1 bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand disabled:opacity-60"
            />
            <button
              onClick={search}
              disabled={searching || !criteria.trim()}
              className="inline-flex items-center gap-2 bg-brand text-brand-fg font-semibold text-sm rounded-xl px-4 py-2.5 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              {searching ? t("Buscando…") : t("Buscar")}
            </button>
          </div>
          <button
            onClick={createEmpty}
            disabled={searching}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            <ClipboardPaste size={13} /> {t("o suelta aquí tu .xlsx o .csv — o empieza con una lista vacía")}
          </button>
          <AnimatePresence>
            {error ? (
              <motion.p
                initial={still ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="text-xs text-red-500 mt-2 overflow-hidden"
              >
                {error}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>

        {/*
          Pestañas.
          «Archivadas» sólo aparece cuando hay alguna: una pestaña permanentemente en cero
          es ruido que se vuelve invisible en una semana, y quien nunca archiva no necesita
          saber que el archivo existe.
        */}
        {archivedCount || view === "archived" ? (
          <div className="flex items-center gap-1 mb-4 border-b border-border">
            {([
              ["live", t("Listas")],
              ["archived", t("Archivadas")],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={`relative px-3 py-2 text-sm transition-colors ${
                  view === id ? "text-ink font-semibold" : "text-muted hover:text-ink"
                }`}
              >
                {label}
                {view === id ? (
                  <motion.div
                    layoutId="prosp-tab"
                    className="absolute left-0 right-0 -bottom-px h-0.5 bg-brand rounded-full"
                    transition={{ type: "spring", stiffness: 480, damping: 36 }}
                  />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {view === "archived" ? (
          archived === null ? (
            <div className="text-sm text-muted py-8 text-center animate-pulse">{t("Cargando…")}</div>
          ) : archived.length === 0 ? (
            <div className="border border-dashed border-border rounded-2xl p-10 text-center text-muted text-sm">
              <p className="font-semibold text-ink mb-1">{t("No hay listas archivadas")}</p>
              <p>{t("Lo que archives aparece aquí y se puede recuperar durante 30 días.")}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              <AnimatePresence initial={false}>
                {archived.map((l) => (
                  <motion.li
                    key={l.id}
                    layout
                    exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                    className="gt-card rounded-2xl p-4 flex flex-wrap items-center gap-x-4 gap-y-2 group"
                  >
                    <div className="flex-1 min-w-[200px]">
                      <div className="font-semibold text-[15px]">{l.name}</div>
                      <div className="text-xs text-muted mt-0.5">
                        {l.rows} {t("filas")}
                        {l.purgeAt ? (
                          <>
                            {" · "}
                            {t("se borra el")}{" "}
                            {new Date(l.purgeAt * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "long" })}
                          </>
                        ) : null}
                      </div>
                    </div>
                    <button
                      onClick={() => restore(l.id)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold border border-border rounded-lg px-3 py-2 hover:bg-surface-3"
                    >
                      <ArchiveRestore size={13} /> {t("Recuperar")}
                    </button>
                    <button
                      onClick={() => purge(l.id, l.name)}
                      title={t("Borrar ahora, para siempre")}
                      className="p-2 rounded-lg text-muted hover:text-red-500 hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={15} />
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )
        ) : lists === null ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="gt-card rounded-2xl p-4 flex items-center gap-4 animate-pulse">
                <div className="flex-1">
                  <div className="h-4 w-2/3 bg-surface-3 rounded mb-2" />
                  <div className="h-3 w-1/3 bg-surface-3 rounded" />
                </div>
                <div className="h-8 w-40 bg-surface-3 rounded" />
              </li>
            ))}
          </ul>
        ) : lists.length === 0 ? (
          <div className="border border-dashed border-border rounded-2xl p-10 text-center text-muted text-sm">
            <p className="font-semibold text-ink mb-1">{t("Todavía no hay listas")}</p>
            <p>{t("Escribe arriba a quién quieres buscar, o pídeselo a")} <span className="text-brand">@ghosty</span> {t("desde el chat.")}</p>
          </div>
        ) : (
          <motion.ul
            className="flex flex-col gap-3"
            initial={still ? false : "oculto"}
            animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
          >
            <AnimatePresence initial={false}>
              {lists.map((l) => (
                <motion.li
                  key={l.id}
                  layout
                  variants={{ oculto: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
                  exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  className="gt-card rounded-2xl p-4 flex flex-wrap items-center gap-x-4 gap-y-3 group"
                >
                  <Link
                    to="/prospeccion/$id"
                    params={{ id: String(l.id) }}
                    search={{ guardadas: undefined, f: undefined }}
                    className="flex-1 min-w-[200px]"
                  >
                    <div className="font-semibold text-[15px] flex items-center gap-1">
                      {l.name}
                      <ChevronRight size={15} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    {l.criteria && l.criteria !== l.name ? (
                      <div className="text-xs text-muted mt-1 truncate">{l.criteria}</div>
                    ) : null}
                  </Link>
                  <Funnel l={l} />
                  <button
                    onClick={() => archive(l.id, l.name)}
                    title={t("Borrar la lista. Las tocadas y las optOuts se conservan.")}
                    className="p-2 rounded-lg text-muted hover:text-red-500 hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Archive size={15} />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>

      {/*
        El aviso de archivado.
        Dice las tres cosas que hacen falta para no dudar: qué se archivó, hasta cuándo se
        recupera, y cómo deshacerlo ahora mismo. Sin la fecha sería «se borrará pronto», con
        la que no se puede decidir nada.
      */}
      <AnimatePresence>
        {undo ? (
          <motion.div
            initial={still ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 gt-card rounded-xl px-4 py-3 flex items-center gap-4 shadow-2xl"
          >
            <div className="text-sm">
              <span className="font-semibold">{undo.name}</span>{" "}
              <span className="text-muted">
                {t("archivada · se borra el")}{" "}
                {new Date(undo.purgeAt * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "long" })}
              </span>
            </div>
            <button onClick={undoArchive} className="text-sm font-semibold text-brand hover:underline">
              {t("Deshacer")}
            </button>
            <button onClick={() => setUndo(null)} className="p-1 rounded text-muted hover:bg-surface-3">
              <X size={14} />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/*
        La barra de la importación en curso.
        Vive fuera del modal a propósito: el modal ya cerró y la persona puede seguir con lo
        suyo. Dice el nombre del archivo porque en un equipo puede haber más de una hoja
        entrando, y un «importando…» anónimo no sirve para saber cuál.
      */}
      <AnimatePresence>
        {importing ? (
          <motion.div
            initial={still ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 gt-card rounded-xl px-4 py-3 w-[min(92vw,420px)] shadow-2xl"
          >
            <div className="flex items-baseline justify-between gap-3 text-sm mb-2">
              <span className="font-semibold truncate">{importing.fileName}</span>
              <span className="text-xs text-muted tabular-nums shrink-0">
                {importing.done.toLocaleString("es-MX")} / {importing.total.toLocaleString("es-MX")}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <motion.div
                className="h-full bg-brand rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${Math.round((importing.done / Math.max(1, importing.total)) * 100)}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 26 }}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ImportReview
        open={!!review}
        fileName={review?.fileName ?? ""}
        plan={review?.plan ?? null}
        existingColumns={[]}
        onCancel={() => setReview(null)}
        onConfirm={confirmImport}
      />
    </div>
    </DropZone>
  );
}
