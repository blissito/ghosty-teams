// Panel lateral del pedido (`ArtifactPanel` kind "run"): TODO el detalle en un lugar, sin
// empujar la conversación del hilo. Reusa las tarjetas que ya existen (etapas y firma, plan,
// veredicto) y suma la bitácora inmutable y las acciones de una persona.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { RunCard } from "./RunCard";
import { PlanCard } from "./PlanCard";
import { VerdictCard } from "./VerdictCard";
import { factoryRunActionFn, factoryRunCardFn, factoryRunDetailFn } from "../../server/apps/factory";

type Card = Awaited<ReturnType<typeof factoryRunCardFn>>;
type Detail = Awaited<ReturnType<typeof factoryRunDetailFn>>;

// Cómo se lee cada renglón de la bitácora. Lo que no está aquí sale con su tipo crudo.
const EVENT_LABEL: Record<string, string> = {
  plan_submitted: "entregó el plan",
  approve: "firmó",
  changes: "pidió cambios",
  build_done: "abrió el PR",
  check_pass: "aprobó la revisión",
  check_fail: "regresó hallazgos",
  check_blocked: "escaló: falta algo que Build no puede hacer",
  close: "cerró",
  merged: "mezclado",
  conflict: "PR con choques: lo pone al día",
  rework: "pidieron más sobre el PR: vuelve a construir",
  cancel: "canceló",
  stale: "sin avanzar 30 min",
  auto_resumed: "lo retomó la plataforma",
  ci_red: "CI en rojo: se lo regresó a Build",
  ci_red_help: "CI sigue en rojo: necesita una persona",
  ci_requested: "pidió correr el CI",
  stopped: "detuvo el turno",
  resumed: "pidió retomar",
};

function when(at: number): string {
  try {
    return new Date(at * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function RunPanel({ runId, channelId }: { runId: number; channelId: number }) {
  const t = useT();
  const [card, setCard] = useState<Card>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    factoryRunCardFn({ data: { runId } }).then(setCard).catch(() => {});
    factoryRunDetailFn({ data: { runId } }).then(setDetail).catch(() => {});
  }, [runId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });

  const act = async (action: "stop" | "resume" | "cancel") => {
    setBusy(true);
    setErr("");
    try {
      await factoryRunActionFn({ data: { runId, action } });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!card) return <div className="p-6 text-sm text-muted">{t("Cargando…")}</div>;
  const open = card.view.column !== "closed";

  return (
    <div className="flex flex-col gap-4 p-4">
      <RunCard card={{ runId }} channelId={channelId} />

      {card.currentStep && (
        <p className="text-xs text-muted">
          {t("Ahora")}: <span className="text-ink">{card.currentStep}</span>
        </p>
      )}

      {open && (
        <div className="flex flex-wrap items-center gap-2">
          {card.view.primary === "resume" && (
            <button type="button" disabled={busy} onClick={() => act("resume")} className="rounded-full bg-brand px-3 py-1 text-xs font-bold text-white disabled:opacity-50">
              {t("Retomar")}
            </button>
          )}
          {card.liveTurnId && (
            <button type="button" disabled={busy} onClick={() => act("stop")} className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted hover:text-ink disabled:opacity-50">
              {t("Detener")}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => act("cancel")} className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted hover:text-red-600 disabled:opacity-50">
            {t("Cancelar pedido")}
          </button>
          {err && <span className="w-full text-xs text-red-600">{err}</span>}
        </div>
      )}

      {detail?.planVersion ? <PlanCard card={{ runId, version: detail.planVersion }} channelId={channelId} expanded /> : null}
      {detail?.verdictJson ? <VerdictCard card={{ runId }} channelId={channelId} /> : null}

      {!!detail?.events.length && (
        <section>
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">{t("Bitácora")}</h3>
          <ol className="space-y-1.5">
            {detail.events.map((e) => {
              let data: Record<string, unknown> = {};
              try {
                data = e.dataJson ? JSON.parse(e.dataJson) : {};
              } catch {
                data = {};
              }
              const extra = typeof data.note === "string" ? `«${data.note}»` : typeof data.findings === "string" ? data.findings : typeof data.pr === "string" ? data.pr : "";
              return (
                <li key={e.id} className="flex gap-2 text-xs">
                  <span className="w-24 shrink-0 text-muted">{when(e.at)}</span>
                  <span className="min-w-0 text-ink">
                    {e.actor ? <b>{/^(plan|build|check)$/.test(e.actor) ? `@${e.actor}` : e.actor}</b> : null} {t(EVENT_LABEL[e.type] ?? e.type)}
                    {extra ? <span className="block truncate text-muted" title={String(extra)}>{String(extra)}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
