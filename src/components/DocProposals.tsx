import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { wordDiff, type DocSuggestion } from "../lib/doc-suggest";
import { useT } from "../i18n";

// La propuesta del agente pintada DENTRO de su párrafo: tachado rojo lo que se va, verde lo que
// entra — como el control de cambios de Word o el modo sugerencia de Docs. Antes el antes/después
// vivía sólo en la tarjeta y el párrafo seguía con el texto viejo: dos versiones en pantalla.
//
// No toca el documento (aceptar sigue siendo explícito): es una capa encima del bloque. El texto
// original se oculta con `visibility` y el bloque crece con `min-height` hasta el alto de la capa,
// así lo de abajo no se encima. Todo por hoja de estilo con `data-id`: React es dueño del
// className de los nodos de BlockNote.

type Caja = { top: number; left: number; width: number; height: number; font: string; color: string };

function contenido(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.gt-doc .bn-block[data-id="${CSS.escape(id)}"] > .bn-block-content`);
}

export default function DocProposals({ hoja, suggestions }: { hoja: HTMLElement | null; suggestions: DocSuggestion[] }) {
  const t = useT();
  const [cajas, setCajas] = useState<Record<string, Caja>>({});
  const [altos, setAltos] = useState<Record<string, number>>({});

  useLayoutEffect(() => {
    if (!hoja || !suggestions.length) {
      setCajas({});
      return;
    }
    const medir = () => {
      const base = hoja.getBoundingClientRect();
      const out: Record<string, Caja> = {};
      for (const s of suggestions) {
        const el = contenido(s.targetId);
        const txt = el?.querySelector<HTMLElement>(".bn-inline-content") ?? el;
        if (!el || !txt) continue;
        const r = txt.getBoundingClientRect();
        const cs = getComputedStyle(txt);
        out[s.id] = {
          top: r.top - base.top,
          left: r.left - base.left,
          width: r.width,
          height: r.height,
          font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
          color: cs.color,
        };
      }
      setCajas(out);
    };
    medir();
    const raf = requestAnimationFrame(medir);
    const ro = new ResizeObserver(medir);
    ro.observe(hoja);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [hoja, suggestions]);

  if (!hoja || !suggestions.length) return null;

  // Oculta el texto viejo y reserva el alto de la propuesta (más larga o más corta).
  const css = suggestions
    .map((s) => {
      const sel = `.gt-doc .bn-block[data-id="${CSS.escape(s.targetId)}"] > .bn-block-content`;
      const h = altos[s.id];
      return `${sel} .bn-inline-content{visibility:hidden}` + (h ? `${sel} .bn-inline-content{min-height:${h}px}` : "");
    })
    .join("\n");

  return (
    <>
      <style>{css}</style>
      {createPortal(
        <>
          {suggestions.map((s) => {
            const c = cajas[s.id];
            if (!c) return null;
            return (
              <div
                key={s.id}
                ref={(el) => {
                  const h = el?.offsetHeight;
                  if (h && Math.abs((altos[s.id] ?? 0) - h) > 1) setAltos((a) => ({ ...a, [s.id]: h }));
                }}
                className="pointer-events-none absolute rounded-sm"
                style={{ top: c.top, left: c.left, width: c.width, font: c.font, color: c.color }}
                aria-label={t("Propuesta del agente")}
              >
                {s.op === "remove" ? (
                  <del className="text-red-600 decoration-red-500">{s.beforeText}</del>
                ) : (
                  wordDiff(s.beforeText, s.afterText).map((d, i) =>
                    d.t === "eq" ? (
                      <span key={i}>{d.s}</span>
                    ) : d.t === "del" ? (
                      <del key={i} className="bg-red-500/10 text-red-600 decoration-red-500">
                        {d.s}
                      </del>
                    ) : (
                      <ins key={i} className="bg-emerald-500/15 text-emerald-700 no-underline">
                        {d.s}
                      </ins>
                    ),
                  )
                )}
              </div>
            );
          })}
        </>,
        hoja,
      )}
    </>
  );
}
