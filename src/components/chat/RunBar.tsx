// Barra FIJA arriba del hilo de un pedido de la Software Factory (2026-09-30). El estado se ve
// sin scroll: etapa, a quién le toca y UNA acción principal. El detalle vive en el panel
// lateral (`kind: "run"`), que se abre con un clic en la barra. Patrón de Linear (el issue
// arriba, la conversación debajo) y del split view de Slack.
//
// El estado lo CALCULA el servidor (`viewState`); se relee con cada `refresh` del room, igual
// que RunCard.
import { useCallback, useContext, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { ChatCtx } from "./message";
import { factoryDecisionFn, factoryMergeFn, factoryRunActionFn, factoryRunCardFn, factoryRunOfThreadFn } from "../../server/apps/factory";

type State = Awaited<ReturnType<typeof factoryRunCardFn>>;

const TONE: Record<string, string> = {
  planning: "bg-sky-500",
  waiting: "bg-amber-500",
  building: "bg-brand",
  checking: "bg-violet-500",
  ready: "bg-emerald-600",
  closed: "bg-muted",
};

export function RunBar({ channelId, threadId }: { channelId: number; threadId: number }) {
  const t = useT();
  const { me, onOpenArtifact } = useContext(ChatCtx);
  const [runId, setRunId] = useState<number | null>(null);
  const [st, setSt] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    factoryRunOfThreadFn({ data: { channelId, rootMsgId: threadId } })
      .then((r) => alive && setRunId(r?.runId ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [channelId, threadId]);

  const refresh = useCallback(() => {
    if (runId == null) return;
    factoryRunCardFn({ data: { runId } }).then(setSt).catch(() => {});
  }, [runId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) {
        // Un pedido puede nacer con el hilo ya abierto (el primer plan llega después).
        if (runId == null)
          factoryRunOfThreadFn({ data: { channelId, rootMsgId: threadId } })
            .then((r) => setRunId(r?.runId ?? null))
            .catch(() => {});
        else refresh();
      } else if (ev.t === "turn" && (ev as { channelId?: number }).channelId === channelId) refresh();
    },
  });
  if (!st) return null;

  const v = st.view;
  const mine = v.whoseTurn?.kind === "person" && v.whoseTurn.sub === me?.sub;
  const who =
    v.whoseTurn?.kind === "agent" ? `@${v.whoseTurn.handle}` : v.whoseTurn?.kind === "person" ? (mine ? t("Te toca") : t("Espera a una persona")) : "";
  const openPanel = () => onOpenArtifact?.({ kind: "run", title: `${t("Pedido")} #${st.runId}`, runId: st.runId, channelId });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // UNA acción principal por estado. Las demás (pedir cambios, cancelar) viven en el panel.
  const primary =
    v.primary === "sign" && st.canSign
      ? { label: `${t("Firmar plan")} v${st.planVersion}`, run: () => factoryDecisionFn({ data: { runId: st.runId, version: st.planVersion, decision: "approve" } }) }
      : v.primary === "merge"
        ? { label: t("Merge"), run: () => factoryMergeFn({ data: { runId: st.runId } }) }
        : v.primary === "resume"
          ? { label: t("Retomar"), run: () => factoryRunActionFn({ data: { runId: st.runId, action: "resume" } }) }
          : v.primary === "stop" && st.liveTurnId
            ? { label: t("Detener"), run: () => factoryRunActionFn({ data: { runId: st.runId, action: "stop" } }) }
            : v.primary === "decide"
              ? { label: t("Decidir"), run: async () => openPanel() }
              : null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 md:px-6">
      <button type="button" onClick={openPanel} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={t("Ver el pedido")}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[v.column] ?? "bg-muted"} ${st.liveTurnId ? "animate-pulse motion-reduce:animate-none" : ""}`} />
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-muted">#{st.runId}</span>
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{st.title}</span>
        <span className="hidden shrink-0 text-xs text-muted sm:inline">· {t(v.label)}</span>
        {who && <span className={`hidden shrink-0 text-xs md:inline ${mine ? "font-semibold text-amber-700 dark:text-amber-300" : "text-muted"}`}>· {who}</span>}
        {st.currentStep && !mine && <span className="hidden min-w-0 truncate text-xs text-muted lg:inline">· {st.currentStep}</span>}
      </button>
      {err && <span className="hidden max-w-48 truncate text-xs text-red-600 md:inline" title={err}>{err}</span>}
      {primary && (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(primary.run)}
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50 ${
            v.primary === "stop" ? "border border-border text-muted hover:text-ink" : "bg-brand text-white hover:opacity-90"
          }`}
        >
          {primary.label}
        </button>
      )}
    </div>
  );
}
