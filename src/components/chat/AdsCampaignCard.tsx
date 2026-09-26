// Tarjetas VIVAS de Ghosty Ads que publica la plataforma:
//  - ```gt-ads-campaign```: una campaña que ya existe en Meta. Estado, embudo gasto →
//    mensajes → leads → calificados y el COSTO POR LEAD CALIFICADO en grande (el número que
//    nadie más reporta). [Prender], [Pausar] y [Cambiar presupuesto] los pica una persona,
//    con confirmación que dice el monto.
//  - ```gt-ads-report```: el reporte de las 9:00 y 21:00, con los números de ese momento.
// Estado leído al pintar; se refrescan con los `refresh` del room.
import { useCallback, useState } from "react";
import { useT } from "../../i18n";
import { adsActionFn, adsCampaignCardFn, adsReportCardFn } from "../../server/apps/ads";
import { adsStatusLabel } from "../../server/apps/ads-flow";
import { BUDGET_MAX, BUDGET_MIN, mxn, type Funnel } from "../../server/apps/ads-proposal";
import ConfirmModal from "../ConfirmModal";
import { useAdsCard } from "./AdsProposalCard";

type State = Awaited<ReturnType<typeof adsCampaignCardFn>>;
type Pending = { action: "activate" | "pause" | "budget"; amount?: number };

const btn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

const STATUS_BAR: Record<string, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  ended: "bg-violet-500",
};

/** Embudo en una fila: gasto → mensajes → leads → calificados. */
export function FunnelRow({ f }: { f: Funnel }) {
  const t = useT();
  const steps: [string, string][] = [
    [t("Gasto"), mxn(f.spend)],
    [t("Mensajes"), String(f.conversations)],
    [t("Leads"), String(f.leads)],
    [t("Calificados"), String(f.qualified)],
  ];
  return (
    <ol className="flex flex-wrap items-stretch gap-1 text-xs">
      {steps.map(([k, v], i) => (
        <li key={k} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted" aria-hidden="true">→</span>}
          <span className="rounded-md bg-surface-3 px-2 py-1">
            <span className="block text-[10px] text-muted">{k}</span>
            <span className="font-semibold tabular-nums text-ink">{v}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AdsCampaignCard({ card, channelId }: { card: { campaignId: number }; channelId: number }) {
  const t = useT();
  const load = useCallback(() => adsCampaignCardFn({ data: { campaignId: card.campaignId } }), [card.campaignId]);
  const { st, refresh } = useAdsCard<State>(load, channelId);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState("");
  if (!st) return null;
  const f = st.funnel;
  const canTouch = st.status === "active" || st.status === "paused";

  const run = async (p: Pending) => {
    setBusy(true);
    setErr("");
    try {
      await adsActionFn({ data: { campaignId: st.campaignId, action: p.action, ...(p.amount != null ? { dailyBudget: p.amount } : {}) } });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const confirmText = (p: Pending) =>
    p.action === "activate"
      ? {
          title: t("¿Prender la campaña #{n}?").replace("{n}", String(st.campaignId)),
          body: t("Empieza a gastar hasta {d} al día en Meta, hasta que alguien la pause o llegue su fecha de fin.").replace("{d}", mxn(st.dailyBudget)),
          label: t("Prender"),
        }
      : p.action === "pause"
        ? { title: t("¿Pausar la campaña #{n}?").replace("{n}", String(st.campaignId)), body: t("Deja de gastar y de salir en Meta. La puedes prender otra vez."), label: t("Pausar") }
        : {
            title: t("¿Cambiar el presupuesto de la campaña #{n}?").replace("{n}", String(st.campaignId)),
            body: t("Pasa de {a} a {b} al día.").replace("{a}", mxn(st.dailyBudget)).replace("{b}", mxn(p.amount ?? 0)),
            label: t("Cambiar presupuesto"),
          };

  return (
    <div className="mt-0.5 flex max-w-xl overflow-hidden rounded-lg gt-card">
      <div className={`w-1 shrink-0 ${STATUS_BAR[st.status] ?? "bg-brand"}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">{t("Campaña")} #{st.campaignId}</span>
          <span className={`text-[11px] font-semibold ${st.status === "active" ? "text-emerald-600" : "text-muted"}`}>{t(adsStatusLabel(st.status))}</span>
          {st.imported && <span className="text-[11px] text-muted">· {t("importada")}</span>}
        </div>
        <p className="mt-1 text-sm font-semibold text-ink">{st.title}</p>
        <p className="text-[11px] text-muted">
          {st.dailyBudget ? `${mxn(st.dailyBudget)} ${t("al día")}` : "—"}
          {st.endTime ? ` · ${t("hasta el")} ${new Date(st.endTime).toLocaleDateString("es-MX", { day: "numeric", month: "short" })}` : ""}
        </p>
        {f ? (
          <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
            <FunnelRow f={f} />
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted">{t("Costo por lead calificado")}</p>
              <p className="text-2xl font-bold tabular-nums text-ink">{f.costPerQualified == null ? "—" : mxn(f.costPerQualified)}</p>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">{st.funnelError ?? t("Sin números todavía.")}</p>
        )}
        {st.funnelError && f && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{st.funnelError}</p>}
        {canTouch && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {st.status === "paused" ? (
              <button type="button" disabled={busy} onClick={() => setPending({ action: "activate" })} className={`${btn} border-emerald-600 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400`}>
                {t("Prender")}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setPending({ action: "pause" })} className={`${btn} border-amber-600 text-amber-700 hover:bg-amber-600/10 dark:text-amber-400`}>
                {t("Pausar")}
              </button>
            )}
            {editing ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(amount);
                  if (!Number.isFinite(n) || n < BUDGET_MIN || n > BUDGET_MAX) {
                    setErr(t("El presupuesto diario va de {a} a {b}.").replace("{a}", mxn(BUDGET_MIN)).replace("{b}", mxn(BUDGET_MAX)));
                    return;
                  }
                  setPending({ action: "budget", amount: n });
                }}
              >
                <span className="text-xs text-muted">$</span>
                <input
                  type="number"
                  min={BUDGET_MIN}
                  max={BUDGET_MAX}
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label={t("Presupuesto diario en pesos")}
                  className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink"
                  autoFocus
                />
                <button type="submit" disabled={busy || !amount} className={`${btn} border-brand text-brand hover:bg-brand/10`}>
                  {t("Guardar")}
                </button>
                <button type="button" onClick={() => setEditing(false)} className="px-1 text-xs text-muted hover:text-ink">
                  {t("Cancelar")}
                </button>
              </form>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAmount(st.dailyBudget ? String(st.dailyBudget) : "");
                  setEditing(true);
                }}
                className={`${btn} border-border text-ink hover:bg-surface-3`}
              >
                {t("Cambiar presupuesto")}
              </button>
            )}
            {st.adsManagerUrl && (
              <a href={st.adsManagerUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-muted hover:text-ink">
                Ads Manager ↗
              </a>
            )}
          </div>
        )}
        {st.approvedBy && <p className="mt-1.5 text-[11px] text-muted">{t("Último cambio")}: {st.approvedBy}</p>}
        {err && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
      {pending && (
        <ConfirmModal
          title={confirmText(pending).title}
          body={confirmText(pending).body}
          confirmLabel={confirmText(pending).label}
          danger={pending.action !== "pause"}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const p = pending;
            setPending(null);
            await run(p);
          }}
        />
      )}
    </div>
  );
}

type Report = Awaited<ReturnType<typeof adsReportCardFn>>;

export function AdsReportCard({ card, channelId }: { card: { reportId: number }; channelId: number }) {
  const t = useT();
  const load = useCallback(() => adsReportCardFn({ data: { reportId: card.reportId } }), [card.reportId]);
  const { st } = useAdsCard<Report>(load, channelId);
  if (!st) return null;
  const when = new Date(st.at * 1000).toLocaleString("es-MX", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="mt-0.5 max-w-xl overflow-hidden rounded-lg p-3 gt-card">
      <p className="text-sm font-semibold text-ink">
        📊 {t("Reporte de anuncios")} <span className="font-normal text-muted">· {when}</span>
      </p>
      <ul className="mt-2 divide-y divide-border">
        {st.items.map((i) => (
          <li key={i.id} className="py-2">
            <div className="flex items-baseline justify-between gap-2">
              <a href={i.threadUrl ?? "#"} className="truncate text-xs font-semibold text-ink hover:underline">
                #{i.id} {i.title}
              </a>
              <span className="shrink-0 text-xs text-muted">
                {t("por calificado")}: <b className="text-ink">{i.funnel.costPerQualified == null ? "—" : mxn(i.funnel.costPerQualified)}</b>
              </span>
            </div>
            <div className="mt-1">
              <FunnelRow f={i.funnel} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
