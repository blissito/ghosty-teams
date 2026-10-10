// Tarjeta VIVA de una corrida de la Software Factory (```gt-run```), top-level en el room.
// Dice en qué etapa va el pedido y deja firmar el plan AQUÍ, sin abrir el hilo; el detalle
// (plan completo, hallazgos, PR) sigue en el hilo. Estado leído al pintar; se refresca con
// los `refresh` del room que publica cada transición. Con el PR listo, la tarjeta CRECE con la
// revisión de @check (qué cambia, riesgo, qué leer) y deja hacer merge aquí: antes eso sólo vivía
// en el hilo y desde el room se veía «el PR espera tu revisión» sin decir qué revisar.
import { ChatCtx } from "./message";
import { Fragment, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { MergeQueued, ReviewBody, type VerdictState } from "./VerdictCard";
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

// Un pedido cerrado se pinta en UN solo tono: morado «merged» de GitHub al terminar, gris al
// cancelar. El verde de «paso hecho» junto al morado chocaba (#15 y #17, 7-oct).
const DONE_CLS = "bg-violet-600/15 text-violet-700 dark:text-violet-300";
const CANCELLED_DONE_CLS = "bg-surface-3 text-ink/70";

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

  const refresh = useCallback(() => {
    factoryRunCardFn({ data: { runId: card.runId } })
      .then((s) => {
        setSt(s);
        // La revisión sólo se pide con el PR en manos de la persona.
        if (s?.status === "pr_review") factoryVerdictFn({ data: { runId: card.runId } }).then(setReview).catch(() => {});
        else setReview(null);
      })
      .catch(() => {});
  }, [card.runId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // Los pasos del turno (`turn`) también: así se ve desde el room qué hace el rol AHORA. Con
  // varias tarjetas en el room, como mucho una consulta cada 3 s por tarjeta.
  const lastTurnRefresh = useRef(0);
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
  const merge = async () => {
    setBusy(true);
    setErr("");
    try {
      await factoryMergeFn({ data: { runId: st.runId } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
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
            const done = st.status === "done" || (current >= 0 && i < current);
            const now = !closed && i === current;
            const stopped = st.status === "cancelled" && i === cancelledAt;
            // PR cerrado sin merge en GitHub: el paso PR lo dice, no sólo el pie.
            const prClosed = s.key === "pr" && st.status === "cancelled" && !!st.cancelled?.prClosed;
            // Escalado: el paso actual ya no es de @check sino de la persona, en ámbar.
            const deciding = now && (st.status === "escalated" || boxWaiting);
            return (
              <Fragment key={s.key}>
              <li className="flex flex-1 items-center gap-1">
                <span
                  className={`flex-1 whitespace-nowrap rounded-full px-1.5 py-1 text-center text-[11px] font-semibold ${
                    // Mezclado = el morado «merged» de GitHub; en curso, verde por paso hecho.
                    prClosed
                      ? "bg-red-600/10 text-red-700/80 dark:text-red-400/80"
                      : deciding
                      ? "bg-amber-500 text-white"
                      : now
                        ? "bg-brand text-white"
                        : stopped
                          ? "border border-dashed border-border text-muted"
                          : done
                          ? st.status === "done"
                            ? DONE_CLS
                            : st.status === "cancelled"
                              ? CANCELLED_DONE_CLS
                              : "bg-emerald-600/15 text-emerald-700"
                          : "bg-surface-3 text-muted"
                  }`}
                >
                  {prClosed ? `✕ ${t("PR cerrado")}` : (
                    <>
                      {done ? "✓ " : stopped ? "⊘ " : ""}
                      {deciding ? t("Te toca decidir") : t(s.label)}
                    </>
                  )}
                </span>
              </li>
              {/* El CI es una etapa del camino: estado en vivo del PR; si el repo ya tiene CI y
                  este PR no lo ha corrido, el paso mismo lo dispara (MailMask #10, 4-oct). */}
              {s.key === "build" && <CiStep ci={st.ci} status={st.status} busy={busy} onRun={runCi} t={t} />}
              {s.key === "pr" && st.prod && <ProdStep prod={st.prod} t={t} />}
              </Fragment>
            );
          })}
        </ol>
        {st.status === "done" && (
          <p className="mt-2 rounded-md bg-violet-600/10 px-2.5 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
            🎉 {st.prod?.state === "success" ? t("Terminado: en producción.") : t("Terminado: PR merged.")}
          </p>
        )}
        {stalled && !waiting && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300" role="status">
            {t("Sin avanzar: nadie está trabajando en este pedido.")}
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
        {waiting && (
          <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300" role="status">
            💬 {t("@{rol} te hizo una pregunta en el hilo: contéstale ahí.").replace("{rol}", String(st.waitingOn))}
          </p>
        )}
        {boxWaiting && (
          <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300" role="status">
            ⏳ {t("En espera de lugar: los lugares de tu plan están ocupados por otros pedidos. Arranca solo en cuanto se libere uno.")}
          </p>
        )}
        {WORKING[st.status] && !stalled && !waiting && !boxWaiting && (
          <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-ink" role="status">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
            {/* Sin turno vivo todavía: el relevo va en camino (pasa unos segundos tras firmar). */}
            {st.liveTurnId ? t(WORKING[st.status]) : t("Arrancando a @{rol}…").replace("{rol}", st.status === "planning" ? "plan" : st.status === "building" ? "build" : "check")}
            {st.loops ? <span className="text-muted">· {t("Vueltas de check")}: {st.loops}</span> : null}
            {/* Lo que narra el rol AHORA (mismo dato que la barra del hilo): desde el room se ve que avanza. */}
            {st.currentStep ? <span className="min-w-0 truncate text-muted">· {st.currentStep}</span> : null}
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
        {reviewing && review && (
          <div className="mt-2.5 border-t border-border pt-2.5">
            <p className="text-sm font-semibold text-ink">
              {t("✅ Listo para tu revisión")}
              {review.verdict!.prNumber ? <span className="ml-1.5 font-mono text-xs font-normal text-muted">PR #{review.verdict!.prNumber}</span> : null}
            </p>
            <ReviewBody st={review} />
          </div>
        )}
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
          {reviewing && st.mergeQueued && <MergeQueued />}
          {reviewing && !st.mergeQueued && st.ci?.state !== "failure" && (
            <button
              type="button"
              disabled={busy}
              onClick={merge}
              className="rounded-full border border-emerald-600 bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? t("Haciendo merge…") : t("Merge")}
            </button>
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

/** El paso «Prod» después del PR: lo que vio el vigilante post-merge en producción. */
function ProdStep({ prod, t }: { prod: { state: string; url?: string | null }; t: (s: string) => string }) {
  const base = "flex-1 whitespace-nowrap rounded-full px-1.5 py-1 text-center text-[11px] font-semibold inline-flex items-center justify-center gap-1.5";
  const look =
    prod.state === "success"
      ? { cls: DONE_CLS, txt: `✓ ${t("Prod")}` }
      : prod.state === "pending"
        ? { cls: "bg-brand text-white", txt: t("Desplegando"), spin: true }
        : prod.state === "failure"
          ? { cls: "bg-red-600/15 text-red-700 dark:text-red-400", txt: `✗ ${t("Prod")}` }
          : prod.state === "timeout"
            ? { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300", txt: t("Deploy lento") }
            : { cls: "bg-surface-3 text-muted", txt: t("Sin deploy") };
  const title =
    prod.state === "none" ? t("El repo no despliega con cada merge a la rama principal.") : prod.state === "failure" ? t("Ver el log del deploy") : prod.url ?? undefined;
  const body = (
    <>
      {"spin" in look && look.spin && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" aria-hidden />
      )}
      {look.txt}
    </>
  );
  return (
    <li className="flex flex-1 items-center gap-1">
      {prod.url ? (
        <a href={prod.url} target="_blank" rel="noreferrer" title={title} className={`${base} ${look.cls} hover:underline`}>
          {body}
        </a>
      ) : (
        <span title={title} className={`${base} ${look.cls}`}>{body}</span>
      )}
    </li>
  );
}

/** El paso «CI» entre Build y Check: lo que dice GitHub del PR, no lo que declaró un rol. */
function CiStep({ ci, status, busy, onRun, t }: {
  ci: { state: string; repoHasCi: boolean } | null | undefined;
  status: string;
  busy: boolean;
  onRun: () => void;
  t: (s: string) => string;
}) {
  const base = "flex-1 whitespace-nowrap rounded-full px-1.5 py-1 text-center text-[11px] font-semibold";
  const closed = status === "done" || status === "cancelled";
  if (!closed && ci?.state === "none" && ci.repoHasCi)
    return (
      <li className="flex flex-1 items-center gap-1">
        <button type="button" disabled={busy} onClick={onRun} className={`${base} border border-amber-600 text-amber-700 hover:bg-amber-600/10 disabled:opacity-50 dark:text-amber-300`}>
          ▶ {t("Correr CI")}
        </button>
      </li>
    );
  const look =
    // Merged = el CI pasó; cancelado = como quedó (un CI que seguía corriendo ya no corre).
    status === "done"
      ? { cls: DONE_CLS, txt: `✓ ${t("CI")}` }
      : ci?.state === "success"
      ? { cls: status === "cancelled" ? CANCELLED_DONE_CLS : "bg-emerald-600/15 text-emerald-700", txt: `✓ ${t("CI")}` }
      : ci?.state === "pending"
        ? closed
          ? { cls: "border border-dashed border-border text-muted", txt: `⊘ ${t("CI")}` }
          : { cls: "bg-brand text-white", txt: t("CI corriendo"), spin: true }
        : ci?.state === "failure"
          ? { cls: "bg-red-600/15 text-red-700 dark:text-red-400", txt: `✗ ${t("CI")}` }
          : ci?.state === "none"
            ? { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300", txt: t("Sin CI") }
            : { cls: "bg-surface-3 text-muted", txt: t("CI") };
  return (
    <li className="flex flex-1 items-center gap-1">
      <span className={`${base} ${look.cls} inline-flex items-center justify-center gap-1.5`}>
        {"spin" in look && look.spin && (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" aria-hidden />
        )}
        {look.txt}
      </span>
    </li>
  );
}
