import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { wordDiff, type DocSuggestion } from "../lib/doc-suggest";
import { resolveDocSuggestionFn } from "../server/artifacts";
import { useT } from "../i18n";

// La barra de "el agente propone cambios en lo que escribiste".
//
// Va ARRIBA del documento y no en el margen: en móvil no hay margen, y es lo primero que hay
// que ver al abrir. Cada tarjeta enseña el antes/después por palabras y, al pasar o tocar,
// señala el párrafo en el documento (contorno punteado, como una zona marcada).

function blockNode(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.gt-doc [data-id="${CSS.escape(id)}"]`);
}

export default function DocSuggestions({
  documentId,
  suggestions,
  onResolved,
  onHeight,
}: {
  documentId: string;
  suggestions: DocSuggestion[];
  /** Tras aceptar/rechazar: el panel recarga el documento (llega también por el bus). */
  /** El sobre nuevo y, si se aceptó algo, los bloques que cambiaron (para iluminarlos). */
  onResolved?: (md: string, changedIds: string[]) => void;
  /** Alto de la barra, para que los controles flotantes del editor no la tapen. */
  onHeight?: (h: number) => void;
}) {
  const raiz = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = raiz.current;
    if (!el || !onHeight) return;
    // Redondeado y sólo si cambia: un alto que oscila 1px por el wrap no debe re-renderizar.
    let ultimo = -1;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.offsetHeight);
      if (Math.abs(h - ultimo) < 2) return;
      ultimo = h;
      onHeight(h);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);
  const t = useT();
  const [abierto, setAbierto] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Los párrafos con sugerencia quedan señalados mientras haya pendientes. Va por una hoja de
  // estilo con selectores por `data-id` y NO con classList: React es dueño del className de
  // los nodos de BlockNote y lo sobrescribe en su siguiente render (ver `.gt-cambio`).
  const [foco, setFoco] = useState<string | null>(null);
  const css = suggestions
    .map((s) => {
      const sel = `.gt-doc .bn-block[data-id="${CSS.escape(s.targetId)}"] > .bn-block-content`;
      const on = foco === s.targetId;
      return `${sel}{outline:2px dashed #f59e0b;outline-offset:4px;border-radius:4px;${on ? "background-color:rgba(253,230,138,.45);" : ""}}`;
    })
    .join("\n");

  const resolver = async (suggestionId: string, accept: boolean) => {
    setOcupado(suggestionId);
    setError(null);
    try {
      const r = await resolveDocSuggestionFn({ data: { documentId, suggestionId, accept } });
      if (r?.md) onResolved?.(r.md, r.changedIds ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("No se pudo"));
    } finally {
      setOcupado(null);
    }
  };

  const ir = (id: string) => {
    blockNode(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFoco(id);
  };

  if (!suggestions.length) return null;
  const n = suggestions.length;

  return (
    <div ref={raiz} className="shrink-0 border-b border-border bg-surface-2 text-sm">
      <style>{css}</style>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="grid size-5 place-items-center rounded-full bg-amber-400 text-[11px] font-bold text-black">{n}</span>
        <button type="button" onClick={() => setAbierto((v) => !v)} className="flex flex-1 items-center gap-1 text-left font-medium text-ink">
          {n === 1 ? t("El agente propone 1 cambio en lo que escribiste") : t("El agente propone {n} cambios en lo que escribiste", { n })}
          {abierto ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          type="button"
          disabled={!!ocupado}
          onClick={() => resolver("*", false)}
          className="rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface-3 hover:text-ink disabled:opacity-60"
        >
          {t("Rechazar todo")}
        </button>
        <button
          type="button"
          disabled={!!ocupado}
          onClick={() => resolver("*", true)}
          className="rounded-md bg-ink px-2 py-1 text-xs font-medium text-surface transition hover:opacity-90 disabled:opacity-60"
        >
          {t("Aceptar todo")}
        </button>
      </div>
      {error && <p className="px-3 pb-2 text-xs text-red-500">{error}</p>}
      {abierto && (
        <ul className="max-h-[40vh] space-y-2 overflow-auto px-3 pb-3">
          {suggestions.map((s) => (
            <li
              key={s.id}
              onMouseEnter={() => setFoco(s.targetId)}
              onMouseLeave={() => setFoco((f) => (f === s.targetId ? null : f))}
              className="rounded-lg border border-border bg-surface p-2.5"
            >
              <button type="button" onClick={() => ir(s.targetId)} className="block w-full text-left leading-relaxed text-ink">
                {s.op === "remove" ? (
                  <span>
                    <span className="mr-1 text-xs font-medium text-muted">{t("Quitar:")}</span>
                    <del className="text-red-600 decoration-red-400">{s.beforeText}</del>
                  </span>
                ) : (
                  wordDiff(s.beforeText, s.afterText).map((d, i) =>
                    d.t === "eq" ? (
                      <span key={i}>{d.s}</span>
                    ) : d.t === "del" ? (
                      <del key={i} className="bg-red-500/10 text-red-600 decoration-red-400">
                        {d.s}
                      </del>
                    ) : (
                      <ins key={i} className="bg-emerald-500/15 text-emerald-700 no-underline">
                        {d.s}
                      </ins>
                    ),
                  )
                )}
              </button>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  disabled={!!ocupado}
                  onClick={() => resolver(s.id, false)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface-3 hover:text-ink disabled:opacity-60"
                >
                  <X size={13} /> {t("Dejar el mío")}
                </button>
                <button
                  type="button"
                  disabled={!!ocupado}
                  onClick={() => resolver(s.id, true)}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
                >
                  <Check size={13} /> {t("Aceptar")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
