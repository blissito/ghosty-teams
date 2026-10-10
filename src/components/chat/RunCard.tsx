// Tarjeta VIVA de una corrida de la Software Factory (```gt-run```), top-level en el room.
// Dice en qué etapa va el pedido y deja firmar el plan AQUÍ, sin abrir el hilo; el detalle
// (plan completo, hallazgos, PR) sigue en el hilo. Estado leído al pintar; se refresca con
// los `refresh` del room que publica cada transición. Con el PR listo, la tarjeta CRECE con la
// revisión de @check (qué cambia, riesgo, qué leer) y deja hacer merge aquí: antes eso sólo vivía
// en el hilo y desde el room se veía «el PR espera tu revisión» sin decir qué revisar.
import { ChatCtx } from "./message";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { type VerdictState } from "./VerdictCard";
import { FxOverlay } from "./FxOverlay";
import { DiffBar, MergeBox } from "./ReviewPanel";
import { factoryVerdictFn, factoryMergeFn, factoryRunCardFn, factoryDecisionFn, factoryRetryPreviewFn, factorySetPreviewOffFn, factoryRunActionFn, factoryRunCiFn, factoryFixCiFn } from "../../server/apps/factory";
import { prepareRepoFn } from "../../server/apps/readiness";
import type { RunCardData } from "../../lib/ebdoc";

type State = Awaited<ReturnType<typeof factoryRunCardFn>>;

/** Quién tiene la estafeta mientras la fábrica trabaja: la tarjeta lo dice con un pulso. */
const WORKING: Record<string, string> = {
  planning: "@plan está escribiendo el plan…",
  building: "@build está construyendo…",
  checking: "@check está revisando el PR…",
};


const STEPS = [
  { key: "plan", label: "Plan", statuses: ["planning"] },
  { key: "sign", label: "Aprobación", statuses: ["plan_review"] },
  { key: "build", label: "Build", statuses: ["building"] },
  { key: "check", label: "Check", statuses: ["checking", "escalated"] },
  { key: "pr", label: "PR", statuses: ["pr_review", "done"] },
] as const;

/**
 * Pedido escalado: qué pasó, en una línea. Con las vueltas agotadas lo dice con el número; si
 * no, escaló porque @build no lo puede resolver con sus herramientas (`check_blocked`).
 */
export function escalationLine(loops: number, t: (s: string) => string): string {
  return loops >= 3
    ? t("{n} vueltas sin cerrar: ¿otra vuelta o replanear?").replace("{n}", String(loops))
    : t("@build no puede resolverlo con sus herramientas: ¿otra vuelta o replanear?");
}

export function RunCard({ card, channelId, inPanel }: { card: RunCardData; channelId: number; inPanel?: boolean }) {
  const { onOpenArtifact } = useContext(ChatCtx);
  const t = useT();
  const [st, setSt] = useState<State>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [prepUrl, setPrepUrl] = useState("");
  // Escalado: aprobar pide un 2º clic con los puntos a la vista (no se aprueba a ciegas).
  const [confirming, setConfirming] = useState(false);
  const [allPoints, setAllPoints] = useState(false);

  const [review, setReview] = useState<VerdictState>(null);
  // Confeti en el ROOM cuando el pedido se mezcla con la tarjeta a la vista. El del hilo
  // (```gt-fx``` de `mergedMessage`) sólo lo veía quien tenía el hilo abierto. Sólo en la
  // TRANSICIÓN: un pedido que ya llegó terminado al pintar no celebra (es efímero, como FxOverlay).
  const prevStatus = useRef<string | null>(null);
  // «Merge» en la tarjeta: se despliega la caja de merge (mutación temporal) hasta que entra.
  const [merging, setMerging] = useState(false);
  const [party, setParty] = useState(false);

  // Regresa la promesa de las DOS consultas (tarjeta + revisión): quien espera a que el estado
  // quede al día (el merge) no suelta su «busy» con la mitad vieja todavía pintada.
  const refresh = useCallback(
    () =>
      factoryRunCardFn({ data: { runId: card.runId } })
        .then(async (s) => {
          if (s?.status === "done" && prevStatus.current && prevStatus.current !== "done") setParty(true);
          if (s?.status !== "pr_review") setMerging(false);
          prevStatus.current = s?.status ?? null;
          setSt(s);
          // La revisión sólo se pide con el PR en manos de la persona.
          if (s?.status === "pr_review") await factoryVerdictFn({ data: { runId: card.runId } }).then(setReview).catch(() => {});
          else setReview(null);
        })
        .catch(() => {}),
    [card.runId],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);
  // Los pasos del turno (`turn`) también: así se ve desde el room qué hace el rol AHORA. Con
  // varias tarjetas en el room, como mucho una consulta cada 3 s por tarjeta.
  const lastTurnRefresh = useRef(0);
  // Caja de merge abierta con el CI corriendo: el avance de los checks no publica eventos en el
  // room, así que se pregunta cada 15 s mientras la caja está a la vista.
  const watchMerge = merging || !!st?.mergeQueued;
  useEffect(() => {
    if (!watchMerge || st?.status !== "pr_review") return;
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [watchMerge, st?.status, refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
      else if (ev.t === "turn" && (ev as { channelId?: number }).channelId === channelId && Date.now() - lastTurnRefresh.current > 3000) {
        lastTurnRefresh.current = Date.now();
        refresh();
      }
    },
  });
  if (!st) return null;
  const mergeBoxOpen = st.status === "pr_review" && !inPanel && (merging || !!st.mergeQueued);

  // Cancelado: se pinta la etapa en la que iba (bitácora), no ninguna; lo hecho conserva su ✓.
  const cancelledAt = st.status === "cancelled" && st.cancelled?.from
    ? STEPS.findIndex((s) => (s.statuses as readonly string[]).includes(st.cancelled!.from!))
    : -1;
  const current = cancelledAt >= 0 ? cancelledAt : STEPS.findIndex((s) => (s.statuses as readonly string[]).includes(st.status));
  // «Construyendo…» sólo si alguien trabaja de verdad. Parado = se dice y se ofrece «Retomar»
  // aquí mismo: la persona no tiene por qué saber que existe la barra del hilo (MailMask, 4-oct).
  const stalled = !!WORKING[st.status] && !st.liveTurnId && st.view.stale;
  // Un rol le preguntó algo a la persona: ni «construyendo…» ni «Sin avanzar».
  const waiting = !!WORKING[st.status] && !st.liveTurnId && !!st.waitingOn;
  // Firmado pero sin caja: el tier tiene todos sus lugares ocupados por otros pedidos.
  const boxWaiting = !!st.boxWaiting;
  const closed = st.status === "done" || st.status === "cancelled";
  const reviewing = st.status === "pr_review" && !!review?.verdict;

  const runCi = async () => {
    setBusy(true);
    setErr("");
    try {
      await factoryRunCiFn({ data: { runId: st.runId } });
      setTimeout(refresh, 8000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setPreviewOff = async (off: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await factorySetPreviewOffFn({ data: { runId: st.runId, off } });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  // ── Encabezado común (todos los estados): anillo de avance, título, UNA línea de estado y la
  // barra de pasos. Antes el pedido en curso y el de PR listo se veían como dos tarjetas
  // distintas (10-oct): ahora sólo cambia lo de abajo.
  const yourTurn = st.status === "plan_review" || st.status === "escalated" || st.status === "pr_review" || boxWaiting || waiting || (stalled && !waiting);
  const ciNow = st.status === "pr_review" ? (review?.ci?.state ?? st.ci?.state) : st.ci?.state;
  const ciChecks = review?.ci?.checks ?? [];
  const effort = review?.effort;
  const tone: "you" | "work" | "done" | "off" | "bad" =
    st.status === "done" ? "done" : st.status === "cancelled" ? (st.cancelled?.prClosed ? "bad" : "off") : st.status === "pr_review" && ciNow === "failure" ? "bad" : yourTurn ? "you" : "work";
  const statusText =
    st.status === "done"
      ? st.prod?.state === "success"
        ? t("Terminado: en producción")
        : st.prod?.state === "pending"
          ? t("PR merged: desplegando a producción…")
          : st.prod?.state === "failure"
            ? t("PR merged, pero el deploy falló")
            : st.prod?.state === "timeout"
              ? t("PR merged: el deploy no terminó en 30 min")
              : t("Terminado: PR merged")
      : st.status === "cancelled"
        ? st.cancelled?.prClosed ? t("Cancelado: el PR se cerró sin merge") : t("Cancelado")
        : waiting
          ? t("@{rol} te preguntó algo en el hilo").replace("{rol}", String(st.waitingOn))
          : boxWaiting
            ? t("En espera de lugar")
            : stalled
              ? t("Sin avanzar: nadie está trabajando")
              : WORKING[st.status]
                ? st.liveTurnId ? t(WORKING[st.status]) : t("Arrancando a @{rol}…").replace("{rol}", st.status === "planning" ? "plan" : st.status === "building" ? "build" : "check")
                : st.status === "plan_review"
                  ? `${t("Te toca firmar el plan")} v${st.planVersion}`
                  : st.status === "escalated"
                    ? t("Te toca decidir")
                    : st.status === "pr_review"
                      ? st.mergeQueued ? t("Merge en cola: entra solo cuando pase el CI") : ciNow === "failure" ? t("El CI falló en este PR") : t("Te toca revisar")
                      : "";
  const statusExtra =
    st.status === "pr_review"
      ? [ciNow === "pending" && ciChecks.length ? `CI ${ciChecks.filter((c) => c.state !== "pending").length}/${ciChecks.length}` : "", effort ? `${t("esfuerzo")} ${effort.score}/5 · ~${effort.minutes} min` : ""].filter(Boolean).join(" · ")
      : WORKING[st.status] && !stalled && !waiting && !boxWaiting
        ? [st.loops ? `${t("Vueltas de check")}: ${st.loops}` : "", st.currentStep ?? ""].filter(Boolean).join(" · ")
        : "";
  const TONE = {
    // Te toca: en ROJO, el mismo rojo de los cuadros del diff (10-oct).
    you: { ring: "text-red-500", text: "text-red-600 dark:text-red-400", seg: "bg-red-500" },
    work: { ring: "text-brand", text: "text-brand", seg: "bg-brand" },
    done: { ring: "text-violet-500", text: "text-violet-700 dark:text-violet-300", seg: "bg-violet-500" },
    off: { ring: "text-muted", text: "text-muted", seg: "bg-surface-3" },
    bad: { ring: "text-red-500", text: "text-red-600 dark:text-red-400", seg: "bg-red-500" },
  }[tone];
  // La barra: Plan · Firma · Build · CI · Check · PR (+ Prod tras el merge). El CI es un paso del
  // camino con su estado EN VIVO, como antes en las pastillas.
  const TRACK = [
    { key: "plan", label: "Plan", at: 0 },
    { key: "sign", label: "Firma", at: 1 },
    { key: "build", label: "Build", at: 2 },
    { key: "ci", label: "CI", at: 2.5 },
    { key: "check", label: "Check", at: 3 },
    { key: "pr", label: "PR", at: 4 },
    ...(st.prod ? [{ key: "prod", label: "Prod", at: 5 }] : []),
  ];
  const segCls = (seg: (typeof TRACK)[number]) => {
    if (st.status === "done") return seg.key === "prod" && st.prod?.state === "failure" ? "bg-red-500" : seg.key === "prod" && st.prod?.state === "pending" ? "bg-brand animate-pulse" : "bg-violet-500";
    if (seg.key === "ci") {
      if (ciNow === "failure") return "bg-red-500";
      if (ciNow === "pending") return closed ? "bg-surface-3" : "bg-brand animate-pulse motion-reduce:animate-none";
      if (ciNow === "success") return st.status === "cancelled" ? "bg-ink/25" : "bg-emerald-600";
      return current > 2 ? "bg-amber-400/60" : "bg-surface-3"; // sin CI
    }
    if (seg.key === "pr" && st.status === "cancelled" && st.cancelled?.prClosed) return "bg-red-500";
    if (current < 0) return "bg-surface-3";
    if (seg.at < current) return st.status === "cancelled" ? "bg-ink/25" : "bg-emerald-600";
    if (seg.at === current) return st.status === "cancelled" ? "border border-dashed border-border" : TONE.seg;
    return "bg-surface-3";
  };
  const progress = st.status === "done" ? 1 : current < 0 ? 0 : (current + (closed ? 0 : 0.5)) / 5;
  const header = (
    <>
      <div className="flex items-center gap-3 px-3.5 pb-2.5 pt-3">
        <span
          className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full ${TONE.ring}`}
          style={{ background: `conic-gradient(currentColor ${progress * 360}deg, var(--color-surface-3) 0)` }}
          aria-hidden
        >
          <span className="absolute inset-[4px] rounded-full bg-surface" />
          <span className="relative text-[11px] font-bold">{st.status === "done" ? "✓" : tone === "bad" || st.status === "cancelled" ? "✕" : `${Math.max(1, Math.min(5, current + 1))}/5`}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            #{st.runId} · {st.title}
          </p>
        </div>
      </div>
      <div className="px-3.5">
        <div className="flex gap-[3px]" aria-hidden>
          {TRACK.map((seg) => (
            <i key={seg.key} className={`h-1 flex-1 rounded-full ${segCls(seg)}`} />
          ))}
        </div>
        <div className="mt-1 flex gap-[3px] text-[10px] text-muted">
          {TRACK.map((seg) => (
            <span key={seg.key} className="flex-1 truncate">{t(seg.label)}</span>
          ))}
        </div>
        <p className={`mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold ${TONE.text}`} role="status">
          {tone === "work" && !closed && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
          )}
          <span className="shrink-0">{statusText}</span>
          {statusExtra ? <span className="min-w-0 truncate font-normal">· {statusExtra}</span> : null}
        </p>
      </div>
    </>
  );

  // PR listo, en el room: la tarjeta AVISA (a quién le toca, cuánto esfuerzo, qué cambia) y
  // «Revisar» abre el panel, donde está la revisión y el merge. Antes cargaba la revisión
  // completa y se sentía abrumadora (propuesta del 10-oct).
  if (reviewing && review?.verdict && !inPanel) {
    const v = review.verdict;
    const doMerge = async () => {
      setBusy(true);
      setErr("");
      try {
        const r = await factoryMergeFn({ data: { runId: st.runId } });
        // Quedó en cola: se pinta ya, sin esperar la vuelta al servidor (el botón no reaparece).
        if (r?.queued) setReview((cur) => (cur ? { ...cur, mergeQueued: true } : cur));
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    const openPanel = () => onOpenArtifact?.({ kind: "run", title: `${t("Pedido")} #${st.runId}`, runId: st.runId, channelId });
    return (
      <div className="mt-1.5 max-w-xl overflow-hidden rounded-xl gt-card">
        {header}
        {v.summary ? <p className="px-3.5 pt-2.5 text-[13.5px] leading-snug text-ink">{v.summary}</p> : null}
        {mergeBoxOpen && <div className="pt-2.5"><MergeBox st={review} busy={busy} onMerge={doMerge} onClose={() => setMerging(false)} /></div>}
        {err && <p className="px-3.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
        <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pt-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <DiffBar add={v.additions} del={v.deletions} />
            <span className="font-mono">+{v.additions} −{v.deletions}</span>
            {v.prNumber ? <span>· PR #{v.prNumber}</span> : null}
          </span>
          <a href={st.threadUrl} className="ml-auto text-xs font-semibold text-muted hover:text-ink">
            {t("Hilo")} →
          </a>
          {!mergeBoxOpen && (
            <button type="button" onClick={() => setMerging(true)} className="rounded-full border border-emerald-600 px-3.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400">
              {t("Merge")}
            </button>
          )}
          <button type="button" onClick={openPanel} className="rounded-full bg-ink px-3.5 py-1 text-xs font-bold text-surface hover:opacity-90">
            {t("Revisar")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      {/* Id negativo: el «ya celebró» de FxOverlay es por mensaje y éste no es uno. */}
      {party && !inPanel && <FxOverlay messageId={-st.runId} fx="confetti" />}
      {header}
      <div className="px-3.5 pb-3">
        {/* «Correr CI»: el repo tiene CI y este PR no lo ha corrido (antes vivía en la pastilla CI). */}
        {!closed && st.ci?.state === "none" && st.ci.repoHasCi && (
          <button type="button" disabled={busy} onClick={runCi} className="mt-2 rounded-full border border-amber-600 px-3 py-1 text-xs font-bold text-amber-700 hover:bg-amber-600/10 disabled:opacity-50 dark:text-amber-300">
            ▶ {t("Correr CI")}
          </button>
        )}
        {stalled && !waiting && (
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  await factoryRunActionFn({ data: { runId: st.runId, action: "resume" } });
                  refresh();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-full border border-amber-600 px-3 py-1 text-xs font-bold text-amber-700 hover:bg-amber-600/10 disabled:opacity-50 dark:text-amber-300"
            >
              {t("Retomar")}
            </button>
          </p>
        )}
        <p className={`mt-2 text-xs empty:hidden ${st.status === "escalated" ? "font-semibold text-amber-700 dark:text-amber-300" : "text-muted"}`}>
          {WORKING[st.status]
            ? ""
            : st.status === "escalated"
            ? escalationLine(st.loops, t)
            : st.status === "cancelled"
              ? st.cancelled?.prClosed
                ? t("Cancelado: el PR se cerró en GitHub sin merge.")
                : st.cancelled?.actor
                  ? t("Cancelado por {nombre}.").replace("{nombre}", st.cancelled.actor)
                  : t("Cancelado.")
              : st.status === "done"
                ? ""
                : st.status === "pr_review"
                  ? st.ci?.state === "failure"
                    ? ""
                    : st.ci?.state === "pending"
                    ? t("⏳ El CI está corriendo en este PR. Cuando termine, el PR queda para tu revisión.")
                    : st.preview?.state === "pending"
                    ? t("🏁 La fábrica terminó su parte. Se está construyendo la preview del PR para que lo revises.")
                    : reviewing
                    ? ""
                    : t("🏁 La fábrica terminó su parte: el PR espera tu revisión. Nadie está trabajando en este pedido.")
                : st.loops
                  ? `${t("Vueltas de check")}: ${st.loops}`
                  : ""}
        </p>
        {st.status === "escalated" && st.escalation?.points.length ? (
          <div className="mt-2 rounded-lg border border-amber-600/40 bg-amber-500/5 px-3 py-2 text-xs" role="note">
            <p className="font-semibold text-ink">{t("Lo que @check pide decidir:")}</p>
            <ol className="mt-1 list-decimal space-y-1 pl-4 text-ink">
              {(allPoints || confirming ? st.escalation.points : st.escalation.points.slice(0, 3)).map((p, i) => (
                <li key={i} className="break-words">{allPoints || confirming || p.length <= 240 ? p : `${p.slice(0, 240)}…`}</li>
              ))}
            </ol>
            {st.escalation.points.length > 3 && !allPoints && !confirming && (
              <button type="button" onClick={() => setAllPoints(true)} className="mt-1 text-xs font-semibold text-brand hover:underline">
                {t("Ver los {n} puntos").replace("{n}", String(st.escalation.points.length))}
              </button>
            )}
          </div>
        ) : null}
        {st.ci?.state === "failure" && st.status === "pr_review" && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-red-600 dark:text-red-400" role="status">
            {t("El CI falló en este PR.")}
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  await factoryFixCiFn({ data: { runId: st.runId } });
                  refresh();
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-full border border-red-600 px-3 py-1 text-xs font-bold hover:bg-red-600/10 disabled:opacity-50"
            >
              {t("Pedir arreglo a @build")}
            </button>
          </p>
        )}
        {st.ci?.state === "none" && !st.ci.repoHasCi && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300" role="status">
            {t("Sin CI: nadie corrió las pruebas fuera de la caja de los agentes. Prepara el repo antes del merge.")}
            {prepUrl ? (
              <a href={prepUrl} className="rounded-full border border-amber-600 px-3 py-1 text-xs font-bold hover:bg-amber-600/10">
                {t("Ver preparación")} →
              </a>
            ) : st.canPrep && st.repo ? (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr("");
                  try {
                    const r = await prepareRepoFn({ data: { repo: st.repo!, channelId } });
                    setPrepUrl(r.threadUrl || st.threadUrl);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-full border border-amber-600 px-3 py-1 text-xs font-bold hover:bg-amber-600/10 disabled:opacity-50"
              >
                {t("Preparar repo")}
              </button>
            ) : null}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {st.canSign && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  // Escalado con puntos: el 1er clic los despliega todos y pide confirmar.
                  if (st.status === "escalated" && st.escalation?.points.length && !confirming) return setConfirming(true);
                  decide("approve");
                }}
                className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-bold text-emerald-600 hover:bg-emerald-600/10 disabled:opacity-50"
              >
                {st.status === "escalated"
                  ? confirming
                    ? t("Leí los {n} puntos: otra vuelta").replace("{n}", String(st.escalation?.points.length ?? 0))
                    : t("Otra vuelta")
                  : `${t("Aprobar plan")} v${st.planVersion}`}
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
          {/* El plan se lee en el panel lateral del pedido (plan, firma y bitácora), no dentro de la
              tarjeta: desplegado ahí no se podía leer (8-oct). Dentro del panel ya está abajo. */}
          {st.planMd && !inPanel && onOpenArtifact && (
            <button
              type="button"
              onClick={() => onOpenArtifact({ kind: "run", title: `${t("Pedido")} #${st.runId}`, runId: st.runId, channelId })}
              className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-3"
            >
              {t("Ver plan")} v{st.planVersion}
            </button>
          )}
          {st.preview?.state === "ready" && st.preview.url && (
            <a
              href={st.preview.url}
              target="_blank"
              rel="noreferrer"
              title={st.preview.provider ?? undefined}
              className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400"
            >
              {t("Ver preview")} ↗
            </a>
          )}
          {st.preview?.state === "pending" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1 text-xs text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500 motion-reduce:animate-none" />
              {t("Preview en camino…")}
            </span>
          )}
          {st.preview?.state === "needs_env" && st.repo && (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-500/15 py-1 pl-3 pr-1 text-xs">
              <a href={`/factory?repo=${encodeURIComponent(st.repo)}`} className="font-semibold text-amber-700 hover:underline dark:text-amber-400">
                🔑 {t("Faltan variables")}
              </a>
              <button type="button" disabled={busy} onClick={() => setPreviewOff(true)} className="rounded-full bg-surface px-2 py-0.5 font-semibold text-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50">
                {t("Sin preview")}
              </button>
            </span>
          )}
          {st.preview?.state === "off" && (
            <span className="inline-flex items-center gap-2 rounded-full bg-surface-3 py-1 pl-3 pr-1 text-xs text-muted" title={t("Apagada para todo el repo")}>
              {t("Preview apagada")}
              <button type="button" disabled={busy} onClick={() => setPreviewOff(false)} className="rounded-full bg-surface px-2 py-0.5 font-semibold text-ink hover:bg-surface-3 disabled:opacity-50">
                {t("Encender")}
              </button>
            </span>
          )}
          {st.preview?.state === "failed" && (
            <span className="inline-flex items-center gap-2 rounded-full bg-red-600/10 py-1 pl-3 pr-1 text-xs text-red-700 dark:text-red-400" title={st.preview.error ?? undefined}>
              {t("La preview falló")}
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await factoryRetryPreviewFn({ data: { runId: st.runId } }).catch(() => {});
                  setBusy(false);
                  refresh();
                }}
                className="rounded-full bg-surface px-2 py-0.5 font-semibold text-ink hover:bg-surface-3 disabled:opacity-50"
              >
                {t("Reintentar")}
              </button>
              <button type="button" disabled={busy} onClick={() => setPreviewOff(true)} className="rounded-full bg-surface px-2 py-0.5 font-semibold text-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50">
                {t("Sin preview")}
              </button>
            </span>
          )}
          {st.prUrl && (
            <a href={st.prUrl} target="_blank" rel="noreferrer" className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink hover:bg-surface-3">
              {t("Ver PR")} ↗
            </a>
          )}
          {st.status === "done" && st.prod?.url && (
            // El paso «Prod» con su liga: el run de Actions mientras corre o si tronó, el sitio si quedó.
            <a
              href={st.prod.url}
              target="_blank"
              rel="noreferrer"
              className={`rounded-full border px-3 py-1 text-xs font-semibold hover:bg-surface-3 ${st.prod.state === "failure" ? "border-red-500 text-red-600 dark:text-red-400" : "border-border text-ink"}`}
            >
              {st.prod.state === "success" ? t("Abrir sitio") : st.prod.state === "failure" ? t("Ver el log") : `${t("Ver deploy")}${st.prod.name ? ` · ${st.prod.name}` : ""}`} ↗
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
