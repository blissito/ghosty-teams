import { Phone, PhoneOff } from "lucide-react";
import { useT } from "../i18n";
import { Avatar } from "./Avatar";
import type { Incoming } from "../lib/call-store";

// Aviso de llamada entrante. Se monta en la RAÍZ (CallLayer): antes vivía en la ruta del
// chat, así que estando en /forms o en un documento no te enterabas de que te llamaban.
export function IncomingCallStack({
  calls,
  onJoin,
  onDismiss,
  anchor = "top-3",
}: {
  calls: Incoming[];
  onJoin: (c: Incoming) => void;
  onDismiss: (c: Incoming) => void;
  /** El dock de la llamada también nace arriba-derecha: cuando está abierto, este aviso
   *  baja para no quedar encima de él. */
  anchor?: "top-3" | "bottom-3";
}) {
  const t = useT();
  if (!calls.length) return null;
  return (
    <div className={`fixed right-3 ${anchor} z-[60] flex w-[min(92vw,20rem)] flex-col gap-2`}>
      {calls.map((c) => (
        <div
          key={`${c.scope}:${c.scopeId}`}
          className="flex items-center gap-3 rounded-2xl border border-brand/40 bg-surface-2 p-3 shadow-2xl ring-1 ring-black/5"
        >
          <span className="relative grid shrink-0 place-items-center">
            <span className="absolute inline-flex size-11 animate-ping rounded-full bg-brand/30" />
            <Avatar name={c.host.name} avatar={c.host.avatar} className="relative h-10 w-10" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Phone size={13} className="shrink-0 text-brand" />
              <span className="truncate text-sm font-semibold text-ink">
                {c.scope === "dm" ? t("{name} te está llamando", { name: c.host.name }) : t("{name} inició una llamada", { name: c.host.name })}
              </span>
            </div>
            {c.scope === "room" && <span className="mt-0.5 block truncate text-xs text-muted">{c.label}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => onDismiss(c)}
              title={t("Descartar")}
              aria-label={t("Descartar")}
              className="grid size-9 place-items-center rounded-full border border-border text-muted transition hover:bg-surface-3 hover:text-ink"
            >
              <PhoneOff size={16} />
            </button>
            <button
              onClick={() => onJoin(c)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-3.5 text-xs font-semibold text-brand-fg transition hover:opacity-90 active:scale-95"
            >
              <Phone size={15} /> {t("Unirse")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
