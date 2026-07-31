import { useEffect, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import { cachedShare, putCachedShare, type Share } from "./ArtifactShareDialog";

/**
 * Historial de un artefacto: qué versiones hay, cuándo se cortaron y QUIÉN co-editó cada
 * una.
 *
 * Existe porque la autoría vivía escondida dentro de "Compartir → Versión compartida", y
 * ese `<select>` hace otra cosa: elige qué versión ENTREGA EL ENLACE. Son dos preguntas
 * distintas —"qué ve el que recibe mi link" vs "quién tocó esto y cuándo"— y mezclarlas
 * hacía que la segunda no se encontrara.
 *
 * La atribución es POR SESIÓN, no por párrafo: la sala de co-edición corta una versión al
 * quedarse vacía y la firma con quienes estuvieron dentro con permiso de escribir. El
 * "quién escribió esta línea" llega con Yjs 14 (ver el plan de autoría). Lo que se muestra
 * aquí es lo que sí podemos afirmar.
 *
 * No pide nada nuevo al servidor: `getArtifactShareFn` ya devuelve `versions` con los
 * autores resueltos a nombres, y hay caché compartida con el diálogo de compartir.
 */

function iniciales(nombre: string): string {
  return (nombre.trim()[0] ?? "?").toUpperCase();
}

// Paleta estable por nombre: el mismo autor se ve igual en todas las versiones. Es la
// misma idea que el color del cursor en la sala.
const COLORES = ["#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#ea580c", "#db2777"];
function colorDe(nombre: string): string {
  let h = 0;
  for (let i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) >>> 0;
  return COLORES[h % COLORES.length];
}

function Autores({ nombres }: { nombres: string[] }) {
  const t = useT();
  if (!nombres.length) {
    // Sin autores = versión publicada por el agente, no por una sesión de sala. Decirlo
    // es mejor que dejar el hueco: el hueco se lee como "no se sabe".
    return <span className="text-xs text-muted">{t("Publicada por Ghosty")}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex shrink-0 items-center">
        {nombres.slice(0, 4).map((n) => (
          <span
            key={n}
            title={n}
            className="-ml-1.5 grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white ring-2 ring-surface-2 first:ml-0"
            style={{ backgroundColor: colorDe(n) }}
          >
            {iniciales(n)}
          </span>
        ))}
      </span>
      <span className="truncate text-xs text-muted">{nombres.join(", ")}</span>
    </span>
  );
}

export default function ArtifactHistoryPanel({
  documentId,
  onClose,
  /** Ver una versión concreta. Sin esto la lista es informativa (el panel de Teams). */
  onSelect,
  /** Versión que se está viendo ahora, para marcarla. */
  actual,
}: {
  documentId: string;
  onClose: () => void;
  onSelect?: (versionId: number | null) => void;
  actual?: number | null;
}) {
  const t = useT();
  const [share, setShare] = useState<Share | null>(() => cachedShare(documentId));
  const [loading, setLoading] = useState(() => !cachedShare(documentId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const { getArtifactShareFn } = await import("../server/artifacts");
        const s = (await getArtifactShareFn({ data: { documentId } })) as Share | null;
        putCachedShare(documentId, s);
        if (vivo) setShare(s);
      } catch (e) {
        if (vivo) setError(String((e as Error)?.message ?? e));
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [documentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  // Más nueva arriba: el historial se lee hacia atrás.
  const versiones = [...(share?.versions ?? [])].reverse();

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Historial")}
        className="absolute right-2 top-11 z-50 flex max-h-[70vh] w-[min(24rem,calc(100vw-1rem))] flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-ink">
            <History size={16} className="text-muted" />
            {t("Historial")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Cerrar")}
            className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="grid place-items-center py-8 text-muted">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : error ? (
          <p className="py-4 text-sm text-muted">{error}</p>
        ) : !versiones.length ? (
          <p className="py-4 text-sm text-muted">{t("Todavía no hay versiones.")}</p>
        ) : (
          <ul className="thin-scroll -mx-1 flex flex-col gap-1 overflow-y-auto px-1">
            {versiones.map((v, i) => {
              const esActual = actual != null ? v.id === actual : i === 0;
              const fila = (
                <>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {v.label}
                      {i === 0 ? (
                        <span className="ml-1.5 text-[10px] font-medium uppercase text-muted">
                          {t("la más reciente")}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{fmt(v.createdAt)}</span>
                  </span>
                  <Autores nombres={v.authors} />
                </>
              );
              const clases = `flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-left ${
                esActual ? "border-brand/40 bg-surface-3" : "border-border bg-surface"
              }`;
              return (
                <li key={v.id}>
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(i === 0 ? null : v.id)}
                      className={`${clases} w-full transition hover:border-brand/40 hover:bg-surface-3`}
                    >
                      {fila}
                    </button>
                  ) : (
                    <div className={clases}>{fila}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs leading-relaxed text-muted">
          {t(
            "Cada versión se corta al terminar una sesión de co-edición y queda firmada por quienes estuvieron dentro."
          )}
        </p>
      </div>
    </>
  );
}
