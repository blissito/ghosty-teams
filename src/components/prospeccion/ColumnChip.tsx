import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeftToLine, AtSign, ChevronDown, Loader2, Play, Sparkles, Trash2 } from "lucide-react";
import { useT } from "../../i18n";

/**
 * El chip de una columna, con su menú.
 *
 * Antes eran tres iconos sueltos junto al nombre: ▶, →| y una papelera. Nadie podía saber
 * qué hacía la flecha —significaba «pasar estos valores a la columna Correo», que sólo
 * tiene sentido en una columna de correos— y en una columna importada no aparecía ninguna
 * acción, así que el enriquecimiento parecía no existir.
 *
 * Dos reglas que quedan:
 *  · Las acciones se llaman por su nombre, no por un icono que hay que adivinar.
 *  · Sólo se ofrece lo que APLICA a esta columna. Una opción que no aplica no es una de
 *    más: es una pista falsa.
 *
 * Lo que ya NO está aquí: «pasar estos valores a la columna Correo». Esa acción existía
 * porque un enriquecedor de correos creaba una columna aparte — un detalle del modelo
 * interno que no le importa a nadie. Hoy escribe directo en Correo y no hay nada que pasar.
 */
export function ColumnChip({
  label,
  kind,
  emailCount,
  filled,
  total,
  duplicada,
  running,
  onRun,
  onUseAsEmail,
  onPromote,
  promoteTo,
  onRemove,
}: {
  label: string;
  kind: "base" | "enrich" | "ai" | "manual";
  /**
   * Cuántas de sus celdas parecen correos.
   *
   * ⚠️ La acción se ofrece SÓLO si hay: en «Madurez digital» era una pista falsa, y por eso
   * se quitó. Pero quitarla del todo dejó sin salida el caso real — una lista cuyos correos
   * viven en una columna propia («Correo de contacto») y no en la base, donde el envío y el
   * verificador los buscan. El error no era la acción: era ofrecerla siempre.
   */
  emailCount: number;
  /**
   * Cuántas celdas tiene llenas, sobre cuántas hay a la vista.
   *
   * ⚠️ **Se enseña SIEMPRE**, y es la cifra que decide si una columna sirve. Medido el
   * 2026-08-23 en `denik_barb`: 1,683 filas, 1,582 con teléfono y sólo 295 con correo. Sin
   * el número, «¿El correo sirve?» se ve casi entera vacía y parece rota — cuando lo que
   * pasa es que DENUE da teléfonos y casi nunca correos, y eso cambia el canal de la
   * campaña. Nació sólo para desempatar columnas homónimas y era demasiado poco.
   */
  filled?: number;
  /** Filas a la vista. Sin el denominador, `295` no dice nada. */
  total?: number;
  duplicada?: boolean;
  running: boolean;
  /**
   * La columna base a la que ESTA columna debería haber ido.
   *
   * ⚠️ Sale de que su etiqueta es la de una base. Es el rescate de una duplicada con datos
   * dentro: borrarla tira el trabajo y dejarla deja dos columnas con el mismo nombre. La
   * tercera salida es mover el dato a donde debía estar.
   */
  promoteTo?: { key: string; label: string } | null;
  onPromote?: () => void;
  onRun: () => void;
  onUseAsEmail: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const acciones = [
    kind === "enrich" && { id: "run", icon: Play, label: t("Volver a buscarlo"), hint: t("En todas las filas"), run: onRun },
    kind === "ai" && { id: "run", icon: Sparkles, label: t("Que el agente la escriba"), hint: t("Un turno por fila: cuesta"), run: onRun },
    promoteTo && {
      id: "promote",
      icon: ArrowLeftToLine,
      label: `${t("Pasar a")} ${promoteTo.label}`,
      hint: t("Llena los huecos de esa columna y quita ésta. No pisa lo que ya está"),
      run: onPromote ?? (() => {}),
    },
    emailCount > 0 && {
      id: "email",
      icon: AtSign,
      label: t("Usar como Correo"),
      hint: `${emailCount} ${emailCount === 1 ? "correo" : "correos"} · es la columna que usa el envío`,
      run: onUseAsEmail,
    },
    {
      id: "remove",
      icon: Trash2,
      label: t("Quitar columna"),
      hint: duplicada && !filled
        ? t("Está vacía y hay otra con el mismo nombre")
        : t("El dato conseguido se conserva"),
      run: onRemove,
      danger: true,
    },
  ].filter(Boolean) as { id: string; icon: typeof Play; label: string; hint: string; run: () => void; danger?: boolean }[];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg border pl-2.5 pr-1.5 py-1 text-xs transition-colors ${
          open ? "border-brand bg-brand/5" : "border-border bg-surface-2 hover:bg-surface-3"
        }`}
      >
        {running ? <Loader2 size={11} className="animate-spin text-brand" /> : null}
        <span className="font-medium">{label}</span>
        {/*
          La cobertura, siempre. En ámbar sólo cuando de verdad hay poco que mirar: una
          columna a menos de la mitad es una columna que no sostiene una campaña, y una
          vacía con nombre repetido es la que sobra.
        */}
        {total ? (
          <span
            className={`text-[10px] tabular-nums ${
              !filled ? "text-amber-500" : filled < total / 2 ? "text-amber-500/80" : "text-muted"
            }`}
            title={
              filled
                ? `${filled.toLocaleString("es-MX")} ${t("de")} ${total.toLocaleString("es-MX")} ${t("filas a la vista tienen este dato")}`
                : duplicada
                  ? t("Está vacía y hay otra con el mismo nombre")
                  : t("Ninguna fila a la vista tiene este dato")
            }
          >
            {filled ? `${filled.toLocaleString("es-MX")}/${total.toLocaleString("es-MX")}` : t("vacía")}
          </span>
        ) : null}
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={still ? false : { opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute left-0 top-full mt-1 z-30 gt-card rounded-xl py-1 min-w-[220px] shadow-2xl"
          >
            {acciones.map((a) => (
              <button
                key={a.id}
                onClick={() => { setOpen(false); a.run(); }}
                disabled={running && a.id === "run"}
                className={`w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-surface-3 disabled:opacity-40 ${
                  a.danger ? "text-red-500" : ""
                }`}
              >
                <a.icon size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{a.label}</span>
                  <span className={`block text-[11px] ${a.danger ? "text-red-500/70" : "text-muted"}`}>{a.hint}</span>
                </span>
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
