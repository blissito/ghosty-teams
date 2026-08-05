import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { useT } from "../i18n";

// Diálogo de confirmación para acciones destructivas. Vivía dentro de c.$slug.tsx y se
// sacó aquí (2026-08-03) cuando el panel de documentos necesitó el mismo diálogo para
// archivar: duplicar un confirm destructivo es como acaban divergiendo en lo que avisan.
//
// Sustituye a `window.confirm`, que el repo todavía usa en varios sitios: no se puede
// estilar, no distingue lo peligroso de lo rutinario y no admite un cuerpo que explique
// las consecuencias.
export default function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Ejecuta la acción mostrando spinner; si resuelve OK normalmente el componente
  // se desmonta (el ítem borrado desaparece). Si falla, se libera el spinner.
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      setBusy(false);
    }
  };
  // ⚠️ El evento que ABRE el diálogo no puede además contestarlo.
  //
  // Un keydown burbujea desde donde se originó hasta `document`. Si el diálogo se abre
  // desde un handler de teclado —escribir `/clear` y pulsar Enter— React aplica el
  // cambio de estado de forma síncrona (es un evento discreto), este efecto engancha su
  // listener en `document`… y el MISMO Enter, que todavía va subiendo, lo encuentra ahí
  // y ejecuta la acción. El usuario ve el modal aparecer y desaparecer, y la acción
  // hecha sin que él confirmara nada. En una acción destructiva eso es grave.
  //
  // Se descarta por marca de tiempo en vez de con un `setTimeout(0)`: un retraso es una
  // carrera que a veces se gana, y esto es una regla — los eventos anteriores al montaje
  // no son respuestas a una pregunta que todavía no existía.
  const nacidoEn = useRef(0);
  if (!nacidoEn.current) nacidoEn.current = typeof performance !== "undefined" ? performance.now() : 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp && e.timeStamp <= nacidoEn.current) return;
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") void run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, busy]);
  // Portal a document.body: un `fixed` dentro de un ancestro con `transform`
  // (la barra de acciones usa -translate-y-1/2) se ancla a ESE ancestro, no al
  // viewport → se aplasta. El portal lo saca del árbol transformado.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-xs text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border px-3.5 py-1.5 text-sm text-muted transition hover:text-ink disabled:opacity-50"
          >
            {/* Cancelar es el default seguro → foco aquí */}
            {t("Cancelar")}
          </button>
          <button
            onClick={run}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white transition disabled:opacity-70 ${
              danger ? "bg-red-500 hover:bg-red-600" : "bg-brand hover:brightness-110"
            }`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
