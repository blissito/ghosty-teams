import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { AtSign, Check, Globe, PenLine, ShieldCheck, Sparkles, Wifi, X } from "lucide-react";
import { useT } from "../../i18n";
import { listEnrichersFn } from "../../server/prospeccion";

export type NewColumn = {
  label: string;
  kind: "enrich" | "ai" | "manual";
  waterfall?: string[];
  prompt?: string;
};

/**
 * Agregar una columna.
 *
 * ⚠️ La primera versión preguntaba tres cosas —cómo se llama, quién la llena, y una
 * «cascada» de fuentes— y no la entendía nadie. Dos errores, los dos míos:
 *
 *  1. Pedía el NOMBRE primero. Nadie sabe cómo llamar a una columna antes de saber qué va
 *     a contener.
 *  2. Presentaba «¿El sitio funciona?», «Correo del sitio» y «¿Tiene sitio?» como una
 *     cascada, o sea como tres formas de conseguir LO MISMO. Son tres datos distintos. La
 *     cascada de Clay aplica cuando varios proveedores dan el mismo campo (un correo por
 *     Hunter, luego Prospeo, luego scrape); copiarla sin ese caso volvía críptico algo
 *     simple.
 *
 * Ahora se elige QUÉ SE QUIERE SABER, en una frase, y el nombre se pone solo. La cascada
 * sigue existiendo en el modelo para el día que haya dos proveedores del mismo dato, pero
 * no se enseña hasta que exista.
 */

/** Icono por enriquecedor. El id viene del servidor; esto es sólo presentación. */
const ICONS: Record<string, typeof Globe> = {
  correo_sirve: ShieldCheck,
  correo_del_sitio: AtSign,
  sitio_vivo: Wifi,
  tiene_sitio: Globe,
};

export function NewColumnModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (c: NewColumn) => Promise<void>;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [enrichers, setEnrichers] = useState<{ id: string; label: string }[]>([]);
  /** Qué se eligió: un enriquecedor por id, o "__ai__" / "__manual__". */
  const [choice, setChoice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) listEnrichersFn().then(setEnrichers).catch(() => {}); }, [open]);
  useEffect(() => { if (!open) { setChoice(null); setLabel(""); setPrompt(""); } }, [open]);

  // El nombre se propone desde lo elegido, y se puede cambiar. Nunca se pide en blanco.
  useEffect(() => {
    if (!choice) return;
    const e = enrichers.find((x) => x.id === choice);
    setLabel(e ? e.label : choice === "__ai__" ? t("Mensaje") : t("Nota"));
  }, [choice, enrichers, t]);

  const isAi = choice === "__ai__";
  const canCreate = !!choice && !!label.trim() && (!isAi || !!prompt.trim());

  const create = async () => {
    if (!canCreate || saving) return;
    setSaving(true);
    await onCreate({
      label: label.trim(),
      kind: isAi ? "ai" : choice === "__manual__" ? "manual" : "enrich",
      waterfall: isAi || choice === "__manual__" ? [] : [choice!],
      prompt: isAi ? prompt.trim() : undefined,
    });
    setSaving(false);
    onClose();
  };

  /** Una opción de la lista: qué dato se va a conseguir, dicho como resultado. */
  const Option = ({ id, icon: Icon, title, hint }: { id: string; icon: typeof Globe; title: string; hint: string }) => {
    const active = choice === id;
    return (
      <button
        onClick={() => setChoice(id)}
        className={`w-full text-left flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
          active ? "border-brand bg-brand/5" : "border-border hover:bg-surface-3"
        }`}
      >
        <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${active ? "bg-brand text-brand-fg" : "bg-surface-3 text-muted"}`}>
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted mt-0.5">{hint}</span>
        </span>
        {active ? <Check size={15} className="text-brand shrink-0 mt-1.5" /> : null}
      </button>
    );
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-card/85 backdrop-blur-sm"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="gt-card rounded-2xl w-full max-w-md max-h-[88vh] flex flex-col overflow-hidden"
            initial={still ? false : { opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex items-start justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-bold text-[15px]">{t("Qué quieres saber de cada negocio")}</h2>
                <p className="text-xs text-muted mt-0.5">{t("Se llena sobre todas las filas de la lista.")}</p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-3">
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
              {enrichers.map((e) => (
                <Option
                  key={e.id}
                  id={e.id}
                  icon={ICONS[e.id] ?? Globe}
                  title={e.label}
                  hint={
                    e.id === "correo_sirve"
                      ? t("Comprueba que exista antes de mandarle. Córrelo SIEMPRE antes de la primera tanda.")
                      : e.id === "correo_del_sitio"
                      ? t("Lo busca en su sitio web. Va directo a la columna Correo.")
                      : e.id === "sitio_vivo"
                        ? t("Entra al sitio y comprueba que responda.")
                        : t("Sale de los datos que ya tienes. Instantáneo.")
                  }
                />
              ))}

              <div className="h-px bg-border my-1" />

              <Option
                id="__ai__"
                icon={Sparkles}
                title={t("Que lo escriba el agente")}
                hint={t("Redacta por fila usando las demás columnas. Cada fila es un turno: cuesta.")}
              />
              <Option
                id="__manual__"
                icon={PenLine}
                title={t("Una columna en blanco")}
                hint={t("Para llenarla tú o pegar desde Excel.")}
              />

              <AnimatePresence>
                {isAi ? (
                  <motion.div
                    initial={still ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted mt-3 mb-1.5">
                      {t("Qué le pides por cada fila")}
                    </label>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={3}
                      autoFocus
                      placeholder={t("Escribe una primera línea para este negocio, mencionando su giro.")}
                      className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand resize-none"
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {/* El nombre va AL FINAL y ya viene puesto: se cambia si se quiere, no se pide. */}
              <AnimatePresence>
                {choice ? (
                  <motion.div
                    initial={still ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted mt-3 mb-1.5">
                      {t("Nombre de la columna")}
                    </label>
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      className="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand"
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <footer className="shrink-0 flex justify-end gap-2 px-5 py-4 border-t border-border">
              <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-muted hover:bg-surface-3">
                {t("Cancelar")}
              </button>
              <button
                onClick={create}
                disabled={!canCreate || saving}
                className="bg-brand text-brand-fg font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 disabled:opacity-50"
              >
                {saving ? t("Creando…") : t("Agregar columna")}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
