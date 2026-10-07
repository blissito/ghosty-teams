import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCheck, ChevronLeft, ChevronRight, List, Loader2, MessageSquareText, RotateCcw, Wand2, X } from "lucide-react";
import type { DocComment } from "../lib/doc-comments";
import type { DocSuggestion } from "../lib/doc-suggest";
import { useT } from "../i18n";

// Observaciones del agente, cada una junto a SU párrafo.
//
// Verificado contra Word (vista contextual en el margen + lista aparte), Notion (Default en el
// margen / Minimal con íconos), Google Docs (minimizar a íconos) y Claude Docs (margen): la nota
// vive junto al texto y la lista completa es secundaria. Antes estaba en una barra arriba que se
// comía ~42 % del alto con 5 notas y separaba cada una de su párrafo.
//
//  · Siempre: número en el margen izquierdo + subrayado punteado (hoja de estilo por `data-id`,
//    no classList: React es dueño del className de los nodos de BlockNote). Tocar el párrafo
//    abre su nota.
//  · Panel angosto: chip ‹ i/n › en la pila de controles + tarjeta anclada al panel — el mismo
//    patrón del corrector, que a propósito no pega la tarjeta al texto para no taparlo.
//  · Hueco a la derecha de la hoja ≥ MARGEN_MIN: tarjetas en ese margen, a la altura de su bloque.

const MARGEN_MIN = 300;
const ANCHO_TARJETA = 260;

type Pos = { arriba: number; derecha: number; ancho: number };

function blockNode(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.gt-doc .bn-block[data-id="${CSS.escape(id)}"]`);
}

export default function CommentsLayer({
  comments,
  pos,
  estrecho,
  visible,
  top,
  hoja,
  onResolve,
  onAbrir,
  suggestions,
  onFix,
  onSuggestion,
}: {
  comments: DocComment[];
  /** Rect del panel (el `posBoton` del editor): ancla de chip y tarjeta. */
  pos: Pos;
  estrecho: boolean;
  visible: boolean;
  /** Dónde va el chip (debajo de los controles que ya hay). */
  top: number;
  /** El contenedor de la hoja (relativo): ahí se cuelga la columna del margen. */
  hoja: HTMLElement | null;
  onResolve: (id: string | "*", resolved: boolean) => Promise<void>;
  /** Abrir una nota cierra la revisión ortográfica: una tarjeta a la vez. */
  onAbrir?: () => void;
  /** Propuestas del agente ligadas a una nota («Arreglar»), por `commentId`. */
  suggestions?: DocSuggestion[];
  onFix?: (commentId: string) => Promise<void>;
  onSuggestion?: (suggestionId: string, accept: boolean) => Promise<void>;
}) {
  const t = useT();
  const [arreglando, setArreglando] = useState<string | null>(null);
  const [errorFix, setErrorFix] = useState<string | null>(null);
  const propuestaDe = (id: string) => suggestions?.find((s) => s.commentId === id);
  const abiertas = useMemo(() => comments.filter((c) => !c.resolved), [comments]);
  const resueltas = useMemo(() => comments.filter((c) => c.resolved), [comments]);
  const num = useMemo(() => new Map(abiertas.map((c, i) => [c.id, i + 1])), [abiertas]);
  const [actual, setActual] = useState<string | null>(null);
  const [lista, setLista] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [margen, setMargen] = useState(false);
  const [tops, setTops] = useState<Record<string, number>>({});

  const idx = actual ? abiertas.findIndex((c) => c.id === actual) : -1;
  const nota = idx >= 0 ? abiertas[idx] : null;

  const ir = useCallback(
    (c: DocComment) => {
      onAbrir?.();
      setActual(c.id);
      blockNode(c.blockId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [onAbrir],
  );

  // Tocar un párrafo comentado (o su número) abre su nota. No se impide el click: el cursor
  // se coloca igual y se puede seguir editando.
  useEffect(() => {
    if (!hoja) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.(".bn-block[data-id]");
      const id = el?.getAttribute("data-id");
      const c = id ? abiertas.find((x) => x.blockId === id) : undefined;
      if (c) {
        onAbrir?.();
        setActual(c.id);
      }
    };
    hoja.addEventListener("click", onClick);
    return () => hoja.removeEventListener("click", onClick);
  }, [hoja, abiertas, onAbrir]);

  // ¿Cabe la columna del margen? Se mide el hueco a la derecha de la hoja, no el panel.
  useLayoutEffect(() => {
    if (!hoja) return;
    const medir = () => {
      const art = hoja.querySelector("article");
      const cont = hoja.parentElement;
      if (!art || !cont) return;
      const hueco = cont.getBoundingClientRect().right - art.getBoundingClientRect().right;
      setMargen(hueco >= MARGEN_MIN);
      // Alto de cada bloque comentado, relativo a la hoja. Apiladas: si una choca con la de
      // arriba, se empuja hacia abajo (como el margen de Word).
      const base = hoja.getBoundingClientRect().top;
      const out: Record<string, number> = {};
      let piso = -Infinity;
      for (const c of abiertas) {
        const n = blockNode(c.blockId);
        if (!n) continue;
        const y = Math.max(n.getBoundingClientRect().top - base, piso);
        out[c.id] = y;
        const card = document.querySelector<HTMLElement>(`[data-nota="${CSS.escape(c.id)}"]`);
        piso = y + (card?.offsetHeight ?? 96) + 8;
      }
      setTops(out);
    };
    medir();
    // Segunda pasada: las alturas reales de las tarjetas existen hasta después de pintarlas.
    const raf = requestAnimationFrame(medir);
    const ro = new ResizeObserver(medir);
    ro.observe(hoja);
    if (hoja.parentElement) ro.observe(hoja.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [hoja, abiertas, actual]);

  const resolver = async (id: string | "*", resolved: boolean) => {
    setOcupado(true);
    try {
      // Resolver la actual pasa a la siguiente: se recorre la revisión sin tocar nada más.
      if (id !== "*" && resolved && id === actual) {
        const sig = abiertas[idx + 1] ?? abiertas[idx - 1] ?? null;
        setActual(sig?.id ?? null);
        if (sig) blockNode(sig.blockId)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (id === "*") setActual(null);
      await onResolve(id, resolved);
    } finally {
      setOcupado(false);
    }
  };

  // Marcas en el documento: número a la izquierda, subrayado punteado, y la actual resaltada.
  const css = abiertas
    .map((c) => {
      const sel = `.gt-doc .bn-block[data-id="${CSS.escape(c.blockId)}"] > .bn-block-content`;
      const on = actual === c.id;
      return (
        `${sel}{position:relative;cursor:pointer;text-decoration:underline dotted #3b82f6;text-underline-offset:4px;` +
        `${on ? "background-color:rgba(59,130,246,.12);border-radius:4px;" : ""}}` +
        `${sel}::after{content:"${num.get(c.id)}";position:absolute;left:-32px;top:2px;width:20px;height:20px;` +
        `border-radius:999px;background:${on ? "#1d4ed8" : "#3b82f6"};color:#fff;font:600 11px/20px system-ui;` +
        `text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.25)}`
      );
    })
    .join("\n");

  if (!abiertas.length && !resueltas.length) return null;

  const tarjeta = (c: DocComment, compacta: boolean) => (
    <div
      data-nota={c.id}
      onClick={() => ir(c)}
      className={`cursor-pointer rounded-xl border bg-surface/98 p-3 text-sm shadow-xl backdrop-blur transition ${
        actual === c.id ? "border-blue-500" : "border-border"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-blue-500 text-[11px] font-semibold text-white">
          {num.get(c.id)}
        </span>
        <p className={`min-w-0 flex-1 leading-relaxed text-ink ${compacta && actual !== c.id ? "line-clamp-3" : ""}`}>
          {c.by ? <span className="mr-1 text-[11px] font-medium text-muted">@{c.by}</span> : null}
          {c.text}
        </p>
      </div>
      {/* Mini hilo: lo que contestó el agente al arreglar. */}
      {c.replies?.length && (!compacta || actual === c.id) ? (
        <div className="mt-2 space-y-1.5 border-l-2 border-blue-500/40 pl-2">
          {c.replies.map((r, i) => (
            <p key={i} className="text-[13px] leading-relaxed text-ink">
              <span className="mr-1 font-semibold text-blue-500">@{r.by}</span>
              {r.text}
            </p>
          ))}
        </div>
      ) : null}
      {/* La propuesta: antes/después por palabras, y la persona decide. */}
      {(() => {
        const p = propuestaDe(c.id);
        if (!p || (compacta && actual !== c.id)) return null;
        return (
          <div className="mt-2 rounded-lg border border-border bg-surface-2 p-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs text-muted">{t("La propuesta está marcada en el párrafo.")}</p>
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void onSuggestion?.(p.id, false)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface-3 hover:text-ink disabled:opacity-60"
              >
                <X size={13} /> {t("Dejar el mío")}
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => {
                  // Aceptar resuelve la nota: se pasa a la siguiente, como «Resolver».
                  const sig = abiertas[idx + 1] ?? abiertas[idx - 1] ?? null;
                  setActual(sig?.id ?? null);
                  void onSuggestion?.(p.id, true);
                }}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
              >
                <Check size={13} /> {t("Aceptar")}
              </button>
            </div>
          </div>
        );
      })()}
      {arreglando === c.id ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-500">
          <Loader2 size={13} className="animate-spin" /> {t("@{agent} está preparando la propuesta…", { agent: c.by ?? "agente" })}
        </p>
      ) : null}
      {errorFix && actual === c.id ? <p className="mt-1 text-xs text-red-500">{errorFix}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            disabled={ocupado}
            onClick={(e) => {
              e.stopPropagation();
              void resolver(c.id, true);
            }}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface-3 hover:text-emerald-600 disabled:opacity-60"
          >
            <Check size={13} /> {t("Marcar resuelta")}
          </button>
          {onFix && !propuestaDe(c.id) ? (
            <button
              type="button"
              disabled={ocupado || !!arreglando}
              onClick={async (e) => {
                e.stopPropagation();
                setActual(c.id);
                setArreglando(c.id);
                setErrorFix(null);
                try {
                  await onFix(c.id);
                } catch (err) {
                  setErrorFix(err instanceof Error ? err.message : t("No se pudo"));
                } finally {
                  setArreglando(null);
                }
              }}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
            >
              <Wand2 size={13} /> {t("Proponer cambio")}
            </button>
          ) : null}
      </div>
    </div>
  );

  const maxW = Math.max(200, Math.min(320, pos.ancho - 24));

  return (
    <>
      <style>{css}</style>

      {/* Chip: ‹ i/n › · lista · resolver todas. Sólo resueltas → micro chip gris. */}
      {visible ? (
        <div
          style={{ position: "fixed", top, right: pos.derecha }}
          className="z-[70] flex items-center gap-0.5 rounded-full border border-border bg-surface/95 px-1.5 py-1 text-ink shadow-lg backdrop-blur"
        >
          {abiertas.length ? (
            <>
              <MessageSquareText size={14} className="mx-1 text-blue-500" />
              <button
                type="button"
                aria-label={t("Observación anterior")}
                disabled={idx <= 0}
                onClick={() => abiertas[idx - 1] && ir(abiertas[idx - 1])}
                className="rounded-full p-1 transition hover:text-brand disabled:opacity-40"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => ir(abiertas[Math.max(0, idx)])}
                className="px-1 text-[11px] font-semibold tabular-nums text-ink hover:text-brand"
                title={t("Observaciones del agente sobre este documento")}
              >
                {idx < 0
                  ? abiertas.length === 1
                    ? t("1 observación")
                    : t("{n} observaciones", { n: abiertas.length })
                  : estrecho
                    ? `${idx + 1}/${abiertas.length}`
                    : t("Observación {i}/{n}", { i: idx + 1, n: abiertas.length })}
              </button>
              <button
                type="button"
                aria-label={t("Observación siguiente")}
                disabled={idx >= abiertas.length - 1}
                onClick={() => abiertas[idx + 1] && ir(abiertas[idx + 1])}
                className="rounded-full p-1 transition hover:text-brand disabled:opacity-40"
              >
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                aria-label={t("Ver todas")}
                title={t("Ver todas")}
                onClick={() => setLista((v) => !v)}
                className="rounded-full p-1 transition hover:text-brand"
              >
                <List size={14} />
              </button>
              {abiertas.length > 1 ? (
                <button
                  type="button"
                  aria-label={t("Resolver todas")}
                  title={t("Resolver todas")}
                  disabled={ocupado}
                  onClick={() => void resolver("*", true)}
                  className="rounded-full p-1 transition hover:text-emerald-600 disabled:opacity-40"
                >
                  <CheckCheck size={14} />
                </button>
              ) : null}
              {nota && !margen ? (
                <button
                  type="button"
                  aria-label={t("Cerrar observación")}
                  onClick={() => setActual(null)}
                  className="rounded-full p-1 transition hover:text-brand"
                >
                  <X size={14} />
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setLista((v) => !v)}
              className="inline-flex items-center gap-1 px-1 text-[11px] text-muted hover:text-brand"
            >
              <Check size={12} />
              {estrecho ? resueltas.length : resueltas.length === 1 ? t("1 resuelta") : t("{n} resueltas", { n: resueltas.length })}
            </button>
          )}
        </div>
      ) : null}

      {/* Panel angosto: la tarjeta de la actual, anclada al panel como la del corrector. */}
      {visible && nota && !margen && !lista ? (
        <div style={{ position: "fixed", top: top + 44, right: pos.derecha, width: maxW }} className="z-[70]">
          {tarjeta(nota, false)}
        </div>
      ) : null}

      {/* Lista completa (vista secundaria, como la de lista de Word): abiertas y resueltas. */}
      {visible && lista ? (
        <div
          style={{ position: "fixed", top: top + 44, right: pos.derecha, width: Math.max(maxW, 300) }}
          className="z-[71] max-h-[60vh] space-y-1.5 overflow-auto rounded-xl border border-border bg-surface/98 p-2 text-sm shadow-xl backdrop-blur"
        >
          {abiertas.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setLista(false);
                ir(c);
              }}
              className="flex w-full gap-2 rounded-lg p-2 text-left transition hover:bg-surface-3"
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-blue-500 text-[11px] font-semibold text-white">
                {num.get(c.id)}
              </span>
              <span className="line-clamp-2 text-ink">{c.text}</span>
            </button>
          ))}
          {resueltas.length ? <p className="px-2 pt-1 text-[11px] font-medium text-muted">{t("Resueltas")}</p> : null}
          {resueltas.map((c) => (
            <div key={c.id} className="flex gap-2 rounded-lg p-2 opacity-70">
              <Check size={14} className="mt-0.5 shrink-0 text-emerald-600" />
              <span className="line-clamp-2 min-w-0 flex-1 text-muted line-through decoration-muted/50">{c.text}</span>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void resolver(c.id, false)}
                className="inline-flex h-7 shrink-0 items-center gap-1 self-start rounded-md px-2 text-xs text-muted transition hover:bg-surface-3 hover:text-ink"
              >
                <RotateCcw size={12} /> {t("Reabrir")}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Hueco ancho: tarjetas en el margen derecho de la hoja, a la altura de su párrafo. */}
      {margen && hoja
        ? createPortal(
            <div className="pointer-events-none absolute top-0" style={{ left: "calc(100% + 20px)", width: ANCHO_TARJETA }}>
              {abiertas.map((c) => (
                <div
                  key={c.id}
                  className="pointer-events-auto absolute left-0 right-0 transition-[top] duration-200"
                  style={{ top: tops[c.id] ?? 0 }}
                >
                  {tarjeta(c, true)}
                </div>
              ))}
            </div>,
            hoja,
          )
        : null}
    </>
  );
}
