// Tarjetas de la Software Factory que publica la PLATAFORMA en el hilo del pedido:
//  - ```gt-verdict```: @check pasó el PR. Diff y CI salen de GitHub; lo que dijo @check va
//    plegado en «Detalle». «Mezclar» usa el GitHub de quien pica.
//  - ```gt-preview-error```: la preview no arrancó. Paso, causa, qué hacer y el log plegado
//    (el patrón de Vercel/Render), con el mismo lenguaje visual que la tarjeta de alertas.
// Las dos leen su estado de la fila del pedido y se refrescan con los `refresh` del room.
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { factoryMergeFn, factoryRetryPreviewFn, factoryVerdictFn } from "../../server/apps/factory";
import { diagnosePreview, STEP_LABEL } from "../../lib/preview-errors";

type State = Awaited<ReturnType<typeof factoryVerdictFn>>;

function useRunState(runId: number, channelId: number) {
  const [st, setSt] = useState<State>(null);
  const refresh = useCallback(() => {
    factoryVerdictFn({ data: { runId } }).then(setSt).catch(() => {});
  }, [runId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresh();
    },
  });
  return { st, refresh };
}

const btn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

export function VerdictCard({ card, channelId }: { card: { runId: number }; channelId: number }) {
  const t = useT();
  const { st, refresh } = useRunState(card.runId, channelId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  if (!st?.verdict) return null;
  const v = st.verdict;
  const merged = st.status === "done";

  const merge = async () => {
    setBusy(true);
    setErr("");
    try {
      await factoryMergeFn({ data: { runId: st.runId } });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ci =
    v.ci === "success" ? { txt: t("✓ en verde"), cls: "text-emerald-600" } : v.ci === "none" ? { txt: t("sin CI en el repo"), cls: "text-amber-600" } : { txt: v.ci, cls: "text-muted" };
  const rows: [string, React.ReactNode][] = [
    [t("Cambios"), <span className="font-mono">{v.files} {v.files === 1 ? t("archivo") : t("archivos")} · <span className="text-emerald-600">+{v.additions}</span> <span className="text-red-500">−{v.deletions}</span></span>],
    ["CI", <span className={ci.cls}>{ci.txt}</span>],
    [t("Revisión"), <span>{t("contra el plan")} v{v.planVersion}{v.loops ? ` · ${v.loops} ${v.loops === 1 ? t("vuelta") : t("vueltas")}` : ""}</span>],
  ];

  return (
    <div className="mt-0.5 flex max-w-xl overflow-hidden rounded-lg gt-card">
      <div className={`w-1 shrink-0 ${merged ? "bg-violet-500" : "bg-emerald-500"}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <p className="text-sm font-semibold text-ink">
          {merged ? t("✅ Mezclado") : t("✅ Listo para tu revisión")}
          {v.prNumber ? <span className="ml-1.5 font-mono text-xs font-normal text-muted">PR #{v.prNumber}</span> : null}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {rows.map(([k, val]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {st.preview.state === "ready" && st.preview.url && (
            <a href={st.preview.url} target="_blank" rel="noreferrer" className={`${btn} border-brand text-brand hover:bg-brand/10`}>
              {t("Ver preview")} ↗
            </a>
          )}
          {st.prUrl && (
            <a href={st.prUrl} target="_blank" rel="noreferrer" className={`${btn} border-border text-ink hover:bg-surface-3`}>
              {t("Ver PR")} ↗
            </a>
          )}
          {!merged && st.status === "pr_review" && (
            <button type="button" disabled={busy} onClick={merge} className={`${btn} border-emerald-600 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400`}>
              {busy ? t("Mezclando…") : t("Mezclar")}
            </button>
          )}
          {v.findings && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ml-auto text-xs text-muted hover:text-ink">
              {open ? t("Ocultar detalle") : t("Detalle")} {open ? "▴" : "▾"}
            </button>
          )}
        </div>
        {err && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
        {open && v.findings && <p className="mt-2 whitespace-pre-wrap border-t border-border pt-2 text-xs leading-relaxed text-muted">{v.findings}</p>}
      </div>
    </div>
  );
}

export function PreviewErrorCard({ card, channelId }: { card: { runId: number }; channelId: number }) {
  const t = useT();
  const { st, refresh } = useRunState(card.runId, channelId);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (!st) return null;
  // Ya se reintentó (o se arregló): la tarjeta queda como constancia, sin botones.
  const current = st.preview.state === "failed";
  const d = diagnosePreview(st.preview.error);
  if (!current && !st.preview.error) {
    return (
      <p className="mt-0.5 text-xs text-muted">
        {st.preview.state === "ready" ? t("✓ La preview ya arrancó.") : t("↻ Reintentando la preview…")}
      </p>
    );
  }

  const retry = async () => {
    setBusy(true);
    await factoryRetryPreviewFn({ data: { runId: st.runId } }).catch(() => {});
    setBusy(false);
    refresh();
  };

  return (
    <div className="mt-0.5 flex max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="w-1 shrink-0 bg-red-500" aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className="rounded border border-current px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-500">{t("Error")}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
            {t("Preview")} · {t(STEP_LABEL[d.step])}
          </span>
        </div>
        <p className="text-sm font-semibold leading-snug text-ink">{t(d.cause)}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{t(d.hint)}</p>
        {d.summary && <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={d.summary}>{d.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={busy} onClick={retry} className={`${btn} border-brand text-brand hover:bg-brand/10`}>
            {busy ? t("Reintentando…") : t("Reintentar")}
          </button>
          {d.envRelated && st.repo && (
            <a href={`/factory?repo=${encodeURIComponent(st.repo)}`} className={`${btn} border-border text-ink hover:bg-surface-3`}>
              {t("Variables")}
            </a>
          )}
          {st.prUrl && (
            <a href={st.prUrl} target="_blank" rel="noreferrer" className={`${btn} border-border text-ink hover:bg-surface-3`}>
              {t("Ver PR")} ↗
            </a>
          )}
          {d.log && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ml-auto text-xs text-muted hover:text-ink">
              {open ? t("Ocultar log") : t("Ver log")} {open ? "▴" : "▾"}
            </button>
          )}
        </div>
        {open && d.log && (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-3 p-2 font-mono text-[11px] leading-relaxed text-ink">
            {d.log}
          </pre>
        )}
      </div>
    </div>
  );
}
