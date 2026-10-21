// La tarjeta «Lugar» dentro de la del pedido en fila (cortesía de lugar de gs, 21-oct): quién ocupa
// cada lugar, «Liberar» al que ya sólo espera, y «Agregar 1 lugar» (dueño/admin) o «Avisar al
// admin» (los demás, uno cada 14 días). Lo decide gs por el correo de quien mira; si gs no
// contesta, no se pinta nada (la nota del hilo ya dice lo mismo en texto).
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { factorySlotActFn, factorySlotFn, type SlotNote } from "../../server/apps/factory";

const nextDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" }).replace(".", "") : "");

export function RunSlot({ runId, onChanged }: { runId: number; onChanged: () => void }) {
  const t = useT();
  const [note, setNote] = useState<SlotNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    factorySlotFn({ data: { runId } }).then(setNote).catch(() => setNote(null));
  }, [runId]);
  useEffect(load, [load]);

  const act = async (op: "release" | "notify_admin", target?: { run?: number; pr?: number; repo?: string }) => {
    setBusy(true);
    setErr("");
    try {
      const r = await factorySlotActFn({ data: { runId, op, ...(target ? { target } : {}) } });
      setMsg(r.message);
      load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!note) return null;
  const pill = "rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50";
  return (
    <div className="mt-2 rounded-lg border border-amber-600/40 bg-amber-500/5 px-3 py-2 text-xs" role="note">
      <p className="flex items-center gap-2 font-semibold text-ink">
        {note.kind === "queued" ? "⏳" : "🎁"} {note.title}
        {note.position ? <span className="font-normal text-muted">· {t("va {n} en la fila").replace("{n}", String(note.position))}</span> : null}
        {note.chip ? <span className="ml-auto rounded-full bg-surface-3 px-2 py-0.5 font-medium text-muted">{note.chip}</span> : null}
      </p>
      {note.occupants.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {note.occupants.map((o) => (
            <li key={o.label} className="flex items-center gap-2">
              <span className="font-bold tabular-nums text-ink">{o.label}</span>
              <span className="text-muted">{o.detail}</span>
              {o.releasable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act("release", o.run ? { run: o.run } : { pr: o.pr ?? undefined, repo: o.repo ?? undefined })}
                  className="ml-auto font-bold text-brand hover:underline disabled:opacity-50"
                >
                  {t("Liberar")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-2">
        {note.canAddSlot ? (
          <a href={note.addSlotUrl} target="_blank" rel="noreferrer" className={`${pill} bg-brand text-white`}>
            + {t("Agregar 1 lugar")}
          </a>
        ) : note.notifyAdmin?.available !== false ? (
          <button type="button" disabled={busy} onClick={() => act("notify_admin")} className={`${pill} bg-brand text-white`}>
            🔔 {t("Avisar al admin")}
          </button>
        ) : (
          <span className={`${pill} bg-surface-3 text-muted`}>
            ✓ {t("Avisado · otra vez el {fecha}").replace("{fecha}", nextDate(note.notifyAdmin.nextAt))}
          </span>
        )}
        <a href={note.plansUrl} target="_blank" rel="noreferrer" className={`${pill} border border-brand text-brand`}>
          {note.suggestUpgrade ? t("Subir de plan") : t("Ver planes")}
        </a>
      </p>
      {msg && <p className="mt-1.5 text-emerald-700 dark:text-emerald-300">{msg}</p>}
      {err && <p className="mt-1.5 text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}
