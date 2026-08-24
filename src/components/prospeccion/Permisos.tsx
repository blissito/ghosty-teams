import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { concederFn, listPermisosFn } from "../../server/prospeccion";

type Datos = Extract<Awaited<ReturnType<typeof listPermisosFn>>, { ok: true }>;

/**
 * Quién puede mandar y quién puede borrar para siempre.
 *
 * Sólo DOS acciones, y las dos por la misma razón: no tienen vuelta atrás. Todo lo demás
 * —filtrar, importar, enriquecer, escribir columnas, archivar— lo hace cualquier miembro,
 * porque es el trabajo diario y es reversible. Poner puerta a eso sólo estorbaría.
 *
 * Con `listId`, el permiso se acota a ESA lista y lo reparte quien la creó. Sin él es
 * global sobre todas, y sólo lo da el dueño del espacio.
 *
 * ⚠️ El dueño del espacio y el creador de la lista salen siempre marcados y no se pueden
 * desmarcar: si el permiso dependiera sólo de la concesión, un workspace podría quedarse
 * sin nadie que pudiera mandar NI conceder el permiso, y no habría salida desde la
 * interfaz. Y quitarle a alguien el permiso sobre la lista que él mismo armó no significa
 * nada.
 */
export function Permisos({
  open,
  onClose,
  listId,
  listName,
  creadorSub,
}: {
  open: boolean;
  onClose: () => void;
  /** Acota los permisos a esta lista. Sin él, valen sobre todas. */
  listId?: number;
  listName?: string;
  /** Quién creó la lista: sale marcado y no se desmarca. */
  creadorSub?: string;
}) {
  const t = useT();
  const still = useReducedMotion();
  const [d, setD] = useState<Datos | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setD(null); return; }
    listPermisosFn({ data: { listId } }).then((r) => { if (r.ok) setD(r); }).catch(() => {});
  }, [open, listId]);

  const toggle = async (sub: string, accion: "mandar" | "purgar", dar: boolean) => {
    setGuardando(`${sub}:${accion}`);
    const r = await concederFn({ data: { sub, accion, dar, listId } }).catch(() => ({ ok: false as const }));
    setGuardando(null);
    // Se repinta con lo que DEVOLVIÓ el servidor, no con lo que se pidió: así la pantalla
    // no puede quedar enseñando algo distinto de lo que se guardó.
    if (r.ok && "concesiones" in r && r.concesiones && d) setD({ ...d, concesiones: r.concesiones });
  };

  /** Quien no se puede desmarcar: el dueño del espacio y quien creó la lista. */
  const fijo = (sub: string, esDueno: boolean) => esDueno || sub === creadorSub;

  const Casilla = ({ sub, accion, esDueno }: { sub: string; accion: "mandar" | "purgar"; esDueno: boolean }) => {
    const global = (d?.concesiones[accion] ?? []).includes(sub);
    const deLaLista =
      listId != null &&
      ((d?.concesiones.porLista?.[String(listId)]?.[accion] ?? []) as string[]).includes(sub);
    const dado = fijo(sub, esDueno) || global || deLaLista;
    const cargando = guardando === `${sub}:${accion}`;
    return (
      <button
        onClick={() => !fijo(sub, esDueno) && toggle(sub, accion, !dado)}
        disabled={fijo(sub, esDueno) || cargando}
        title={
          esDueno
            ? t("El dueño del espacio siempre puede")
            : sub === creadorSub
              ? t("Creó esta lista, así que manda sobre ella")
              : global && listId != null
                ? t("Puede en todas las listas")
                : undefined
        }
        className={`w-6 h-6 rounded-md grid place-items-center transition-colors ${
          dado ? "bg-brand text-brand-fg" : "bg-surface-3 text-muted hover:bg-border"
        } ${fijo(sub, esDueno) ? "opacity-60 cursor-default" : ""} ${cargando ? "animate-pulse" : ""}`}
      >
        {dado ? <Check size={13} /> : null}
      </button>
    );
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/25 backdrop-blur-sm"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="gt-card rounded-2xl w-full max-w-md max-h-[88vh] flex flex-col overflow-hidden shadow-2xl"
            initial={still ? false : { opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex items-start justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-bold text-[15px]">{t("Quién puede qué")}</h2>
                <p className="text-xs text-muted mt-0.5">
                  {listName
                    ? `${t("En")} ${listName}. ${t("Todo el equipo la ve y puede trabajarla; esto es sólo lo que no tiene vuelta atrás.")}`
                    : t("Todo el equipo ve las listas y puede trabajarlas. Esto es sólo lo que no tiene vuelta atrás.")}
                </p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-3">
                <X size={16} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="flex items-center gap-3 pb-2 mb-1 border-b border-border text-[11px] uppercase tracking-wide text-muted">
                <span className="flex-1">{t("Quién")}</span>
                <span className="w-6 text-center" title={t("Mandar correo a prospectos")}><Send size={12} className="mx-auto" /></span>
                <span className="w-6 text-center" title={t("Borrar una lista para siempre")}><Trash2 size={12} className="mx-auto" /></span>
              </div>

              {!d ? (
                <div className="animate-pulse text-sm text-muted py-6 text-center">{t("Cargando…")}</div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {d.gente.map((g) => (
                    <li key={g.sub} className="flex items-center gap-3 py-1.5">
                      <span className="flex-1 min-w-0 truncate text-sm">
                        {g.name}
                        {g.isOwner ? (
                          <span className="text-[11px] text-muted ml-1.5">{t("dueño")}</span>
                        ) : g.sub === creadorSub ? (
                          <span className="text-[11px] text-muted ml-1.5">{t("creó esta lista")}</span>
                        ) : null}
                      </span>
                      <Casilla sub={g.sub} accion="mandar" esDueno={g.isOwner} />
                      <Casilla sub={g.sub} accion="purgar" esDueno={g.isOwner} />
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-[11px] text-muted mt-4 flex items-start gap-1.5">
                <ShieldCheck size={13} className="shrink-0 mt-0.5" />
                {t("Mandar sale a clientes reales con tu dominio y no se deshace. Borrar para siempre tira el trabajo de enriquecer las filas; archivar sí lo hace cualquiera y se recupera 30 días.")}
              </p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
