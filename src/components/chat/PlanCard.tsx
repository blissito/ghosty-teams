// Tarjeta de PLAN de la Software Factory (```gt-plan```). Gemela de TaskCard/PrCard, con sus
// dos reglas: el estado se lee al pintar (el mensaje diría «esperando firma» para siempre) y
// los botones firman con la sesión de QUIEN HACE CLIC, sin mandar texto al chat.
import { useCallback, useContext, useEffect, useState } from "react";
import { ChatCtx } from "./message";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { Markdown } from "../Markdown";
import { splitPlan, planStats } from "../../lib/plan-md";
import { factoryPlanCardFn, factoryDecisionFn } from "../../server/apps/factory";
import type { PlanCardData } from "../../lib/ebdoc";

type State = Awaited<ReturnType<typeof factoryPlanCardFn>>;

/**
 * En el hilo va COMPACTA (encabezado + firma + «Ver plan»): el plan completo vive en el panel
 * del pedido, para no empujar la conversación. `expanded` = dentro del panel, completo.
 */
export function PlanCard({ card, channelId, expanded = false }: { card: PlanCardData; channelId: number; expanded?: boolean }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  const [st, setSt] = useState<State>(null);
  const [busy, setBusy] = useState<"" | "approve" | "changes">("");
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  // Aprobar sin leer no tiene sentido: el botón fuerte es «Leer el plan» hasta que se abre.
  const [read, setRead] = useState(false);

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
      // Sólo lo de ESTE room: con cualquier mensaje de cualquier room cada tarjeta visible
      // pedía su estado al servidor.
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
      else if (ev.t === "message:new" && (ev as any).msg?.channel_id === channelId) refresh();
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
  // Tras escalar se vuelve a decidir sobre el plan vigente aunque ya tenga firma.
  const canSign = !superseded && ((st.status === "plan_review" && !st.decision) || st.status === "escalated");

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink">✋ {t("Plan")} v{st.version}</span>
        <span className="truncate text-[11px] text-muted">#{st.runId} · {st.title}</span>
      </div>
      <div className="p-3">
        {expanded || open ? (
          <PlanBody planMd={st.planMd} t={t} />
        ) : (
          <PlanSummary
            planMd={st.planMd}
            t={t}
            onRead={() => {
              setRead(true);
              if (onOpenArtifact) onOpenArtifact({ kind: "run", title: `${t("Pedido")} #${st.runId}`, runId: st.runId, channelId });
              else setOpen(true);
            }}
          />
        )}
        {/* Pidió cambios / aprobó y el rol todavía no contesta: que se vea que ya va. */}
        {!superseded && !canSign && st.decision && (st.status === "planning" || st.status === "building") && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted" role="status">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
            {st.status === "planning" ? t("@plan está rehaciendo el plan…") : t("@build arrancó con el plan aprobado…")}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canSign && st.status === "escalated" ? (
            <span className="w-full text-xs font-semibold text-ink">⚠️ {t("@check no pudo cerrarlo en 3 vueltas: ¿otra vuelta o replanear?")}</span>
          ) : null}
          {superseded ? (
            <span className="text-xs text-muted">{t("Reemplazado por la versión")} v{st.current}</span>
          ) : st.decision === "approve" && !canSign ? (
            <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
              ✅ {t("Aprobado por")} {st.decidedBy}
            </span>
          ) : st.decision === "changes" && !canSign ? (
            <span className="rounded-full border border-border px-3 py-1 text-xs font-bold text-ink">
              ↩ {st.decidedBy} {t("pidió cambios")}: «{st.note}»
            </span>
          ) : canSign ? (
            <>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => decide("approve")}
                className={
                  read || expanded || open
                    ? "rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    : "rounded-full px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-600/10 disabled:opacity-50 dark:text-emerald-300"
                }
              >
                {busy === "approve" ? t("Firmando…") : t("Aprobar")}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setAsking((v) => !v)}
                className="rounded-full px-2 py-1 text-xs font-semibold text-muted hover:text-ink disabled:opacity-50"
              >
                {t("Pedir cambios")}
              </button>
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

/** El plan para leerse: sin el título repetido, «Listo cuando» arriba y estilos de tarjeta (`.gt-plan`). */
function PlanBody({ planMd, t }: { planMd: string; t: (s: string) => string }) {
  const { done, body } = splitPlan(planMd);
  return (
    <div className="relative text-sm">
      {done && (
        <div className="gt-plan-done mb-3 rounded-md bg-emerald-600/10 px-3 py-2 text-emerald-900 dark:text-emerald-200">
          <span className="font-semibold">{t("Listo cuando")}: </span>
          <span className="gt-plan inline [&_p]:inline">
            <Markdown body={done} />
          </span>
        </div>
      )}
      <div className="gt-plan">
        <Markdown body={body} />
      </div>
    </div>
  );
}

/** El plan cerrado: qué entrega («Listo cuando»), de qué tamaño es y el botón para leerlo. */
function PlanSummary({ planMd, t, onRead }: { planMd: string; t: (s: string) => string; onRead: () => void }) {
  const { done, body } = splitPlan(planMd);
  const { criteria, steps } = planStats(body);
  const size = [criteria ? `${criteria} ${t(criteria === 1 ? "criterio" : "criterios")}` : "", steps ? `${steps} ${t(steps === 1 ? "paso" : "pasos")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="text-sm">
      {done && (
        <div className="gt-plan mb-2 text-ink [&_p]:inline">
          <span className="font-semibold">{t("Listo cuando")}: </span>
          <Markdown body={done} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onRead} className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-surface hover:opacity-90">
          {t("Leer el plan")}
        </button>
        {size && <span className="text-xs text-muted">{size}</span>}
      </div>
    </div>
  );
}

