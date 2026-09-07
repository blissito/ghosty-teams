import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useT } from "../i18n";
import type { DocKind, TeamDocument } from "../server/documents";
import {
  docKindLabel,
  kindCounts,
  toggleKind,
  type DocFilter,
} from "../lib/doc-filter";

/**
 * Buscador + «Míos» + chips de tipo para la lista de Documentos.
 *
 * Una sola barra para las DOS vistas: el panel lateral (ArtifactPanel, rama "docindex",
 * ~320 px → `compact`) y la página completa (/artifacts). Repartirla en dos habría
 * garantizado que se separaran al primer ajuste.
 *
 * No hay carpetas y no las va a haber: los documentos los redacta el agente, que no
 * acertaría la carpeta, y una jerarquía obliga a decidir al subir. Lo que la gente pide
 * cuando dice «carpeta» es esto — filtrar por autoría y encontrar por nombre.
 */
export function DocFilters({
  docs,
  filter,
  onChange,
  compact,
}: {
  /** Los documentos del ALCANCE, sin filtrar: de aquí salen los conteos de los chips. */
  docs: TeamDocument[];
  filter: DocFilter;
  onChange: (f: DocFilter) => void;
  /** `true` en el panel lateral, donde no cabe la fila holgada. */
  compact?: boolean;
}) {
  const t = useT();

  // El texto vive aquí y sube con retraso: filtrar en cada tecla repinta la lista entera.
  // 220 ms es el mismo valor que `prospeccion/FilterBar`, para que las dos búsquedas del
  // producto se sientan igual.
  const [q, setQ] = useState(filter.q);
  useEffect(() => {
    setQ(filter.q);
  }, [filter.q]);
  useEffect(() => {
    if (q === filter.q) return;
    const id = setTimeout(() => onChange({ ...filter, q }), 220);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const counts = useMemo(() => kindCounts(docs), [docs]);
  // Los chips salen ordenados por frecuencia: el tipo que más tienes es el que más vas a
  // querer aislar, y así el orden no baila cuando entra un documento nuevo de un tipo raro.
  const kinds = useMemo(
    () =>
      [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [counts]
  );

  // «Míos» sólo se pinta si hay algo ajeno que esconder. En un DM con el agente todo es
  // tuyo, y un control que nunca cambia nada es ruido que estorba en 320 px.
  const hayAjenos = docs.some((d) => !d.mine);

  // `whitespace-nowrap` y sin `truncate`: son dos palabras cortas y recortarlas («To…»)
  // ahorra ocho píxeles a cambio de un control que ya no se entiende.
  const seg = (activo: boolean) =>
    `whitespace-nowrap rounded-md px-2.5 py-1 transition ${
      activo ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
    }`;

  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-2 ${compact ? "mb-3" : "mb-5"}`}
    >
      {/* En el panel (320 px) el buscador se queda con la fila entera: compartiéndola con
          el segmentado, «Todos» salía recortado como «To…». */}
      <div
        className={`flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1 ${compact ? "w-full" : "flex-1"}`}
      >
        <Search size={12} className="shrink-0 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Buscar documento o room…")}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
        />
        {q ? (
          <button
            type="button"
            onClick={() => setQ("")}
            title={t("Limpiar")}
            className="shrink-0 text-muted hover:text-ink"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {hayAjenos ? (
        <div className="flex shrink-0 gap-1 rounded-lg bg-surface-3 p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => onChange({ ...filter, mine: false })}
            className={seg(!filter.mine)}
          >
            {t("Todos")}
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...filter, mine: true })}
            className={seg(filter.mine)}
          >
            {t("Míos")}
          </button>
        </div>
      ) : null}

      {kinds.length > 1 ? (
        <div className="flex w-full flex-wrap items-center gap-1.5">
          {kinds.map(([k, n]) => {
            const on = filter.kinds.includes(k as DocKind);
            return (
              <button
                key={k}
                type="button"
                onClick={() => onChange(toggleKind(filter, k as DocKind))}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] transition ${
                  on
                    ? "border-brand bg-brand/5 font-medium text-ink"
                    : "border-border text-muted hover:text-ink"
                }`}
              >
                {t(docKindLabel(k))}
                <span className={on ? "text-brand" : "text-muted"}>{n}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
