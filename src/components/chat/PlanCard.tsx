// Tarjeta de PLAN de la Software Factory (```gt-plan```). Gemela de TaskCard/PrCard, con sus
// dos reglas: el estado se lee al pintar (el mensaje diría «esperando firma» para siempre) y
// los botones firman con la sesión de QUIEN HACE CLIC, sin mandar texto al chat.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { Markdown } from "../Markdown";
import { factoryPlanCardFn, factoryDecisionFn } from "../../server/apps/factory";
import type { PlanCardData } from "../../lib/ebdoc";

type State = Awaited<ReturnType<typeof factoryPlanCardFn>>;

export function PlanCard({ card, channelId }: { card: PlanCardData; channelId: number }) {
  const t = useT();
  const [st, setSt] = useState<State>(null);
  const [busy, setBusy] = useState<"" | "approve" | "changes">("");
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    factoryPlanCardFn({ data: { runId: card.runId, version: card.version } })
      .then(setSt)
      .catch(() => {});
  }, [card.runId, card.version]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if ((ev.t === "refresh" && ev.channelId === channelId) || ev.t === "message:new") refresh();
    },
  });

  if (!st) return null;

  const decide = async (decision: "approve" | "changes") => {
    if (busy) return;
    setBusy(decision);
    setErr("");
    try {
      await factoryDecisionFn({ data: { runId: card.runId, version: card.version, decision, note: decision === "changes" ? note : undefined } });
      setAsking(false);
      setNote("");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const superseded = st.version < st.current;
  // Se firma la versión vigente mientras la corrida espera firma (o tras escalar).
  const canSign = !superseded && !st.decision && (st.status === "plan_review" || st.status === "escalated");

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink">✋ {t("Plan")} v{st.version}</span>
        <span className="truncate text-[11px] text-muted">#{st.runId} · {st.title}</span>
      </div>
      <div className="p-3">
        <div className={`relative text-sm ${open ? "" : "max-h-40 overflow-hidden"}`}>
          <Markdown body={st.planMd} />
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-semibold text-brand hover:underline">
            {t("Ver el plan completo")}
          </button>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {superseded ? (
            <span className="text-xs text-muted">{t("Reemplazado por la versión")} v{st.current}</span>
          ) : st.decision === "approve" ? (
            <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
              ✅ {t("Aprobado por")} {st.decidedBy}
            </span>
          ) : st.decision === "changes" ? (
            <span className="rounded-full border border-border px-3 py-1 text-xs font-bold text-ink">
              ↩ {st.decidedBy} {t("pidió cambios")}: «{st.note}»
            </span>
          ) : canSign ? (
            <>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => decide("approve")}
                className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-bold text-emerald-600 hover:bg-emerald-600/10 disabled:opacity-50"
              >
                {busy === "approve" ? t("Firmando…") : t("Aprobar")}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setAsking((v) => !v)}
                className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted hover:text-ink disabled:opacity-50"
              >
                {t("Pedir cambios")}
              </button>
              <span className="text-[11px] text-muted">{t("o contesta «✅» / «cambios: …» en el hilo")}</span>
            </>
          ) : (
            <span className="text-xs text-muted">{t("Esperando al plan")}</span>
          )}
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
              disabled={!note.trim() || !!busy}
              onClick={() => decide("changes")}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy === "changes" ? t("Enviando…") : t("Enviar")}
            </button>
          </div>
        )}
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      </div>
    </div>
  );
}
