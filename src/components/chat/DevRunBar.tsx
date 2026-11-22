// Tarjeta FIJA arriba del hilo de un pedido que corre en el motor de gs (una sola fábrica, 22-nov). Etapa, «Te toca
// decidir» cuando el escritor necesita a una persona y UNA acción (Mezclar). Lo que la persona escribe en el hilo le
// llega al escritor; esta barra sólo muestra el estado y la decisión.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { devThreadActionFn, devThreadCardFn, type DevRunView } from "../../server/apps/dev-threads";

const TONE: Record<string, string> = {
  queued: "bg-muted",
  working: "bg-brand",
  waiting_ci: "bg-sky-500",
  reviewing: "bg-violet-500",
  needs_person: "bg-amber-500",
  merging: "bg-emerald-600",
  merged: "bg-emerald-600",
};

export function DevRunBar({ channelId, threadId }: { channelId: number; threadId: number }) {
  const t = useT();
  const [st, setSt] = useState<DevRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    devThreadCardFn({ data: { channelId, rootMsgId: threadId } })
      .then(setSt)
      .catch(() => {});
  }, [channelId, threadId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });
  if (!st) return null;

  const act = async (action: "merge" | "stop") => {
    setBusy(true);
    setErr("");
    try {
      await devThreadActionFn({ data: { channelId, rootMsgId: threadId, action } });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`border-b border-border px-3 py-2 md:px-6 ${st.needsPerson ? "bg-amber-50 dark:bg-amber-950/30" : "bg-surface-2"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[st.phase] ?? "bg-muted"} ${st.phase === "working" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
        {st.issue && <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-muted">#{st.issue}</span>}
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{st.title}</span>
        <span className="hidden shrink-0 text-xs text-muted sm:inline">· {t(st.label)}</span>
        <span className="flex-1" />
        {err && <span className="hidden max-w-48 truncate text-xs text-red-600 md:inline" title={err}>{err}</span>}
        {st.prUrl && (
          <a href={st.prUrl} target="_blank" rel="noreferrer" className="hidden shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline sm:inline">
            {t("Ver PR")}
          </a>
        )}
        {st.canMerge ? (
          <button type="button" disabled={busy} onClick={() => act("merge")} className="shrink-0 rounded-full bg-brand px-3 py-1 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">
            {t("Mezclar")}
          </button>
        ) : st.live && st.phase !== "merging" ? (
          <button type="button" disabled={busy} onClick={() => act("stop")} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-bold text-muted hover:text-ink disabled:opacity-50">
            {t("Detener")}
          </button>
        ) : null}
      </div>
      {st.needsPerson && (
        <p className="mt-1 text-xs font-semibold text-amber-800 dark:text-amber-200">
          {t("Te toca decidir: contesta en este hilo y le llega al escritor.")}
        </p>
      )}
    </div>
  );
}
