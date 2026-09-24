// Tarjeta VIVA de una corrida de la Software Factory (```gt-run```), top-level en el room.
// Dice en qué etapa va el pedido y deja firmar el plan AQUÍ, sin abrir el hilo; el detalle
// (plan completo, hallazgos, PR) sigue en el hilo. Estado leído al pintar; se refresca con
// los `refresh` del room que publica cada transición.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { factoryRunCardFn, factoryDecisionFn } from "../../server/apps/factory";
import type { RunCardData } from "../../lib/ebdoc";

type State = Awaited<ReturnType<typeof factoryRunCardFn>>;

const STEPS = [
  { key: "plan", label: "Plan", statuses: ["planning"] },
  { key: "sign", label: "Firma", statuses: ["plan_review"] },
  { key: "build", label: "Build", statuses: ["building"] },
  { key: "check", label: "Check", statuses: ["checking", "escalated"] },
  { key: "pr", label: "PR", statuses: ["pr_review", "done"] },
] as const;

export function RunCard({ card, channelId }: { card: RunCardData; channelId: number }) {
  const t = useT();
  const [st, setSt] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    factoryRunCardFn({ data: { runId: card.runId } }).then(setSt).catch(() => {});
  }, [card.runId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });
  if (!st) return null;

  const current = STEPS.findIndex((s) => (s.statuses as readonly string[]).includes(st.status));
  const closed = st.status === "done" || st.status === "cancelled";

  const decide = async (decision: "approve" | "changes") => {
    setBusy(true);
    setErr("");
    try {
      await factoryDecisionFn({ data: { runId: st.runId, version: st.planVersion, decision, note: decision === "changes" ? note : undefined } });
      setAsking(false);
      setNote("");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink">🏭 {t("Pedido")} #{st.runId}</span>
        <span className="truncate text-sm font-semibold text-ink">{st.title}</span>
      </div>
      <div className="p-3">
        {/* Los pasos: el actual resaltado; los hechos, llenos. */}
        <ol className="flex items-center gap-1">
          {STEPS.map((s, i) => {
            const done = closed ? st.status === "done" : i < current;
            const now = !closed && i === current;
            return (
              <li key={s.key} className="flex flex-1 items-center gap-1">
                <span
                  className={`flex-1 rounded-full px-2 py-1 text-center text-[11px] font-semibold ${
                    now ? "bg-brand text-white" : done ? "bg-emerald-600/15 text-emerald-700" : "bg-surface-3 text-muted"
                  }`}
                >
                  {done ? "✓ " : ""}
                  {t(s.label)}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-muted">
          {st.status === "escalated"
            ? t("@check no pudo cerrarlo en 3 vueltas: decide si otra vuelta o replanear.")
            : st.status === "cancelled"
              ? t("Cancelado.")
              : st.status === "done"
                ? t("Terminado.")
                : st.loops
                  ? `${t("Vueltas de check")}: ${st.loops}`
                  : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {st.canSign && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide("approve")}
                className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-bold text-emerald-600 hover:bg-emerald-600/10 disabled:opacity-50"
              >
                {st.status === "escalated" ? t("Otra vuelta") : `${t("Aprobar plan")} v${st.planVersion}`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAsking((v) => !v)}
                className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted hover:text-ink disabled:opacity-50"
              >
                {st.status === "escalated" ? t("Replanear") : t("Pedir cambios")}
              </button>
            </>
          )}
          {st.prUrl && (
            <a href={st.prUrl} target="_blank" rel="noreferrer" className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-3">
              {t("Ver PR")} ↗
            </a>
          )}
          <a href={st.threadUrl} className="ml-auto text-xs font-semibold text-brand hover:underline">
            {t("Ver hilo")} →
          </a>
        </div>
        {asking && (
          <div className="mt-2 flex gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && note.trim() && decide("changes")}
              placeholder={t("¿Qué cambiarías?")}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink"
              autoFocus
            />
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => decide("changes")}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {t("Enviar")}
            </button>
          </div>
        )}
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      </div>
    </div>
  );
}
