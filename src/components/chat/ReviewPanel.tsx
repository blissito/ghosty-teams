// Panel lateral de un pedido con el PR listo: el lugar donde se REVISA y se hace merge. La
// tarjeta del room sólo avisa. Patrones de la comunidad (ver la propuesta del 10-oct):
// estado persistente arriba (Devin), esfuerzo del 1 al 5 (CodeRabbit), caja de merge con los
// checks por nombre y «merge cuando pase» (GitHub). La estafeta a escala de tiempo es propia.
import { useState } from "react";
import { useT } from "../../i18n";
import { factoryFixCiFn, factoryMergeFn } from "../../server/apps/factory";
import { EFFORT_LABELS } from "../../lib/review-effort";
import { shortDuration, type Holder } from "../../lib/factory-relay";
import { MergeQueued, useRunState, type VerdictState } from "./VerdictCard";
import { PlanCard } from "./PlanCard";

export const HOLDER: Record<Holder, { label: string; cls: string }> = {
  plan: { label: "@plan", cls: "bg-violet-500" },
  you: { label: "tú", cls: "bg-red-500" },
  build: { label: "@build", cls: "bg-sky-500" },
  check: { label: "@check", cls: "bg-emerald-600" },
};

/** Barras del diff como las de GitHub: 5 cuadros repartidos entre altas y bajas. */
export function DiffBar({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const a = total ? Math.round((add / total) * 5) : 0;
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={`h-2 w-2 rounded-[2px] ${i < a ? "bg-emerald-600" : i < (total ? 5 : 0) ? "bg-red-500" : "bg-surface-3"}`} />
      ))}
    </span>
  );
}

const CHECK_LOOK = {
  failure: { s: "✗", cls: "text-red-600 dark:text-red-400" },
  pending: { s: "◌", cls: "text-amber-600 dark:text-amber-400" },
  success: { s: "✓", cls: "text-emerald-600 dark:text-emerald-400" },
  neutral: { s: "–", cls: "text-muted" },
} as const;

export function ReviewPanel({ runId, channelId }: { runId: number; channelId: number }) {
  const t = useT();
  const { st, refresh } = useRunState(runId, channelId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  if (!st?.verdict) return null;
  const v = st.verdict;
  const e = st.effort;
  const ci = st.ci;
  const checks = ci?.checks ?? [];
  const relayTotal = st.relay.reduce((n, r) => n + r.seconds, 0) || 1;
  const waiting = st.relay.length && st.relay[st.relay.length - 1].who === "you" ? st.relay[st.relay.length - 1].seconds : 0;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Cabecera: qué es, a quién le toca y cuánto tuvo cada quien el pedido. */}
      <header className="space-y-2.5 border-b border-border px-5 pb-4 pt-1">
        <h2 className="text-base font-bold leading-snug text-ink">{st.title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/12 py-0.5 pl-2 pr-2.5 text-xs font-semibold text-red-600 dark:text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {t("Te toca revisar")}
            {waiting ? <span className="font-normal opacity-80">· {shortDuration(waiting)}</span> : null}
          </span>
          <span className="text-xs text-muted">
            {t("Pedido")} #{st.runId}
            {v.prNumber ? <> · PR <span className="font-mono">#{v.prNumber}</span></> : null}
            {st.branch ? <> · <span className="font-mono">{st.branch}</span></> : null}
          </span>
        </div>
        {st.relay.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex h-2 gap-0.5 overflow-hidden rounded" aria-hidden>
              {st.relay.map((r, i) => (
                <span key={i} className={HOLDER[r.who].cls} style={{ flex: Math.max(r.seconds / relayTotal, 0.015) }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
              {(["plan", "you", "build", "check"] as Holder[]).map((who) => {
                const sec = st.relay.filter((r) => r.who === who).reduce((n, r) => n + r.seconds, 0);
                return sec ? (
                  <span key={who} className="inline-flex items-center gap-1.5">
                    <i className={`h-2 w-2 rounded-sm ${HOLDER[who].cls}`} />
                    {t(HOLDER[who].label)} <b className="font-mono font-semibold text-ink">{shortDuration(sec)}</b>
                  </span>
                ) : null;
              })}
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 space-y-5 px-5 py-5">
        {/* El esfuerzo manda: dice cuánto tiempo apartar antes de abrir el diff. */}
        {e && (
          <section className={`grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-3 rounded-2xl p-4 ${e.score >= 4 ? "bg-amber-500/12" : e.score === 3 ? "bg-sky-500/10" : "bg-emerald-600/10"}`}>
            <div className={`text-6xl font-bold leading-[.9] tracking-tight tabular-nums ${e.score >= 4 ? "text-amber-600 dark:text-amber-400" : e.score === 3 ? "text-sky-700 dark:text-sky-300" : "text-emerald-700 dark:text-emerald-400"}`}>
              {e.score}
              <span className="text-xl font-medium tracking-normal text-muted">/5</span>
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-[15px] font-semibold text-ink">
                {e.score >= 4 ? t("Revísalo con calma") : e.score === 3 ? t("Revisión con atención") : t("Revisión rápida")} · ~{e.minutes} min
              </p>
              <div className="grid grid-cols-5 gap-1" aria-hidden>
                {EFFORT_LABELS.map((_, i) => (
                  <i key={i} className={`h-2.5 rounded-[3px] ${i < e.score ? (e.score >= 4 ? "bg-amber-500" : e.score === 3 ? "bg-sky-500" : "bg-emerald-600") : "bg-surface-3"}`} />
                ))}
              </div>
              <div className="grid grid-cols-5 gap-1 text-[10px] uppercase tracking-wide text-muted">
                {EFFORT_LABELS.map((l, i) => (
                  <span key={l} className={i === e.score - 1 ? "font-bold text-ink" : ""}>{t(l)}</span>
                ))}
              </div>
            </div>
            <div className="col-span-2 flex flex-wrap gap-1.5">
              {e.reasons.map((r) => (
                <span key={r} className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-ink">{r}</span>
              ))}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs">
                <DiffBar add={v.additions} del={v.deletions} />
                <span className="font-mono text-emerald-600">+{v.additions}</span>
                <span className="font-mono text-red-500">−{v.deletions}</span>
              </span>
              <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                ✓ @check {v.loops ? `${t("tras")} ${v.loops} ${v.loops === 1 ? t("vuelta") : t("vueltas")}` : t("a la primera")}
              </span>
            </div>
          </section>
        )}

        {v.summary ? <p className="text-[15px] leading-relaxed text-ink">{v.summary}</p> : null}
        {v.tryIt ? (
          <p className="text-sm text-ink">
            <span className="font-semibold">{t("Pruébalo")}:</span> <span className="text-muted">{v.tryIt}</span>
          </p>
        ) : null}

        {!!v.readFirst?.length && (
          <section>
            <h3 className="mb-2 flex justify-between text-[11px] uppercase tracking-wider text-muted">
              <span>{t("Lee primero")}</span>
              <span>{v.readFirst.length} {t("de")} {v.files}</span>
            </h3>
            <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {v.readFirst.map((r, i) => {
                const slash = r.file.lastIndexOf("/");
                return (
                  <li key={i}>
                    <a href={r.href ?? (st.prUrl ? `${st.prUrl}/files` : undefined)} target="_blank" rel="noreferrer" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2.5 hover:bg-surface-2">
                      <span className="truncate font-mono text-[12.5px] font-medium text-ink" title={r.file}>
                        <span className="text-muted">{slash >= 0 ? r.file.slice(0, slash + 1) : ""}</span>
                        {r.file.slice(slash + 1)}
                      </span>
                      <span className="font-mono text-[11.5px] text-muted">{r.lines}</span>
                      {r.why ? <span className="col-span-2 text-[12.5px] text-muted">{r.why}</span> : null}
                    </a>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* El plan firmado, en una línea: antes era una pestaña «Plan v2» que no decía nada. */}
        <section className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-muted">{t("Lo que pediste")}</span>
            <span className="min-w-0 flex-1 text-ink">
              «{st.title}»
              {st.approvedAt ? <span className="text-muted"> · {t("firmado")} {new Date(st.approvedAt * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> : null}
            </span>
            {v.planVersion ? (
              <button type="button" onClick={() => setShowPlan((s) => !s)} className="whitespace-nowrap text-xs font-semibold text-brand hover:underline">
                {showPlan ? t("Ocultar plan") : t("Ver plan")} {showPlan ? "▴" : "→"}
              </button>
            ) : null}
          </div>
          {showPlan && v.planVersion ? (
            <div className="mt-2">
              <PlanCard card={{ runId, version: v.planVersion }} channelId={channelId} expanded />
            </div>
          ) : null}
        </section>

        {(st.shots.length > 0 || (st.preview.state === "ready" && st.preview.url)) && (
          <section>
            <h3 className="mb-2 flex justify-between gap-3 text-[11px] uppercase tracking-wider text-muted">
              <span>{t("Preview")}</span>
              {st.preview.url ? (
                <a href={st.preview.url} target="_blank" rel="noreferrer" className="truncate font-mono normal-case tracking-normal text-brand hover:underline">
                  {st.preview.url.replace(/^https?:\/\//, "")} ↗
                </a>
              ) : null}
            </h3>
            {st.shots.length > 0 && (
              <div className="flex items-start gap-2.5">
                {st.shots.map((s) => (
                  <a key={s.label} href={s.url} target="_blank" rel="noreferrer" className={`block overflow-hidden rounded-lg border border-border hover:border-brand ${s.label === "mobile" ? "w-20 shrink-0" : "min-w-0 flex-1"}`}>
                    <img src={s.url} alt={s.label === "mobile" ? t("Preview en móvil") : t("Preview en escritorio")} loading="lazy" className="h-40 w-full object-cover object-top" />
                  </a>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Caja de merge pegada abajo: los checks por nombre (rojos arriba) y UNA acción. */}
      <footer className="sticky bottom-0 space-y-2.5 border-t border-border bg-surface-2 px-5 py-3">
        {checks.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {checks.map((c) => {
              const look = CHECK_LOOK[c.state];
              const body = (
                <>
                  <span className={`font-sans font-bold ${look.cls}`}>{look.s}</span>
                  {c.name}
                  {c.seconds != null ? <span className="text-muted">{shortDuration(c.seconds)}</span> : null}
                </>
              );
              return c.url ? (
                <a key={c.name} href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-[11.5px] text-ink hover:border-brand">{body}</a>
              ) : (
                <span key={c.name} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-[11.5px] text-ink">{body}</span>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-[12rem] flex-1 text-[12.5px] text-muted">
            {ci?.state === "pending" ? (
              <><b className="text-ink">{t("CI corriendo")}: {checks.filter((c) => c.state !== "pending").length} {t("de")} {checks.length} {t("listos")}.</b> {t("Si picas, entra solo al pasar; si sale en rojo, te avisa.")}</>
            ) : ci?.state === "failure" ? (
              <b className="text-red-600 dark:text-red-400">{t("El CI falló: así no entra.")}</b>
            ) : ci?.state === "none" ? (
              t("Este PR no tiene CI: nadie corrió las pruebas fuera de la caja de los agentes.")
            ) : (
              <b className="text-ink">{t("CI en verde: listo para merge.")}</b>
            )}
          </p>
          {st.prUrl && (
            <a href={st.prUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] font-semibold text-ink hover:bg-surface-3">
              {t("Ver PR")} ↗
            </a>
          )}
          {st.mergeQueued ? (
            <MergeQueued />
          ) : ci?.state === "failure" ? (
            <button type="button" disabled={busy} onClick={() => run(() => factoryFixCiFn({ data: { runId } }))} className="rounded-lg bg-red-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-50">
              {t("Pedir arreglo a @build")}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => run(() => factoryMergeFn({ data: { runId } }))} className="rounded-lg bg-emerald-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              {busy ? t("Haciendo merge…") : ci?.state === "pending" ? t("Merge cuando pase el CI") : t("Merge")}
            </button>
          )}
        </div>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      </footer>
    </div>
  );
}

/**
 * La caja de merge que la tarjeta del room despliega al picar «Merge» (mutación temporal, como
 * la de GitHub): quién aprobó, los checks con su avance, si choca con la base y el botón. Se
 * queda abierta mientras el merge espera al CI y se pliega sola al entrar.
 */
export function MergeBox({ st, busy, onMerge, onClose }: { st: VerdictState; busy: boolean; onMerge: () => void; onClose: () => void }) {
  const t = useT();
  if (!st?.verdict) return null;
  const checks = st.ci?.checks ?? [];
  const running = checks.filter((c) => c.state === "pending");
  const failed = checks.filter((c) => c.state === "failure");
  const ok = checks.filter((c) => c.state === "success" || c.state === "neutral");
  const ci = st.ci?.state ?? st.verdict.ci;
  const pct = checks.length ? ok.length / checks.length : ci === "success" ? 1 : 0;
  const row = "flex items-start gap-3 px-3.5 py-3";
  const dot = (cls: string, s: string) => <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold text-white ${cls}`}>{s}</span>;
  const group = (label: string, items: typeof checks) =>
    items.length ? (
      <div>
        <p className="px-3.5 pb-1 pt-2 text-[11.5px] text-muted">{label}</p>
        <ul>
          {items.map((c) => (
            <li key={c.name} className="flex items-center gap-2.5 px-3.5 py-1 text-[12.5px]">
              <span className={`font-bold ${CHECK_LOOK[c.state].cls}`}>{CHECK_LOOK[c.state].s}</span>
              {c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:underline">{c.name}</a> : <span className="font-medium text-ink">{c.name}</span>}
              <span className="truncate text-muted">
                {c.state === "pending" ? `${t("Empezó hace")} ${c.seconds != null ? shortDuration(c.seconds) : "…"}` : c.state === "failure" ? t("Falló") : `${t("Exitoso en")} ${c.seconds != null ? shortDuration(c.seconds) : "—"}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="mx-3.5 mb-3 mt-1 overflow-hidden rounded-xl border border-border bg-surface-2 motion-safe:animate-[gt-grow_.25s_ease-out]">
      <div className={row}>
        {dot("bg-emerald-600", "✓")}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink">{t("@check aprobó el PR")}</p>
          <p className="text-xs text-muted">{st.verdict.loops ? `${t("tras")} ${st.verdict.loops} ${st.verdict.loops === 1 ? t("vuelta") : t("vueltas")}` : t("a la primera")} · {t("cumple el plan")} v{st.verdict.planVersion}</p>
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label={t("Cerrar")}>×</button>
      </div>
      <div className="border-t border-border">
        <div className={row}>
          {ci === "failure" ? (
            dot("bg-red-500", "✗")
          ) : ci === "pending" ? (
            <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full text-amber-500" style={{ background: `conic-gradient(currentColor 0 ${pct * 360}deg, var(--color-surface-3) 0)` }} aria-hidden>
              <span className="absolute inset-[4px] rounded-full bg-surface-2" />
            </span>
          ) : ci === "none" ? (
            dot("bg-amber-500", "!")
          ) : (
            dot("bg-emerald-600", "✓")
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-ink">
              {ci === "failure" ? t("Algunos checks fallaron") : ci === "pending" ? t("Algunos checks no han terminado") : ci === "none" ? t("Este PR no tiene CI") : t("Todos los checks pasaron")}
            </p>
            <p className="text-xs text-muted">
              {[running.length ? `${running.length} ${t("corriendo")}` : "", failed.length ? `${failed.length} ${t("fallaron")}` : "", ok.length ? `${ok.length} ${t("exitosos")}` : ""].filter(Boolean).join(", ")}
            </p>
          </div>
        </div>
        {group(t("Fallaron"), failed)}
        {group(t("Corriendo"), running)}
        {group(t("Exitosos"), ok)}
        <div className="h-2" />
      </div>
      <div className={`${row} border-t border-border`}>
        {st.mergeable?.clean === false ? dot("bg-red-500", "✗") : st.mergeable?.clean ? dot("bg-emerald-600", "✓") : dot("bg-surface-3", "…")}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink">
            {st.mergeable?.clean === false
              ? t("Choca con {base}").replace("{base}", st.mergeable.base ?? "main")
              : st.mergeable?.clean
                ? t("Sin conflictos con {base}").replace("{base}", st.mergeable.base ?? "main")
                : t("GitHub está revisando si choca con la base")}
          </p>
          <p className="text-xs text-muted">{st.mergeable?.clean === false ? t("Al picar Merge se lo regreso a @build para resolverlo.") : t("Se puede mezclar automáticamente.")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface px-3.5 py-2.5">
        {st.mergeQueued ? (
          <MergeQueued />
        ) : (
          <button type="button" disabled={busy || ci === "failure"} onClick={onMerge} className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? t("Haciendo merge…") : ci === "pending" ? t("Merge cuando pase el CI") : t("Merge")}
          </button>
        )}
        <span className="text-xs text-muted">{ci === "pending" ? t("Entra solo al pasar; si sale en rojo, te avisa.") : ci === "failure" ? t("Con el CI en rojo no entra: pídele el arreglo a @build en el panel.") : ""}</span>
      </div>
    </div>
  );
}
