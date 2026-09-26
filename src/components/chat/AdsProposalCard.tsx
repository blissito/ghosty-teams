// Tarjeta de PROPUESTA de Ghosty Ads (```gt-ads-proposal```), en el hilo donde se pidió.
// La publica la plataforma cuando @ads llama `ads_proposal_submit`. Enseña lo que Meta va a
// mostrar (vista previa real), a quién (chips y audiencia estimada) y cuánto puede gastar
// como máximo. [Crear en pausa] lo pica una PERSONA: nace en PAUSED y no gasta hasta que
// alguien la prenda desde la tarjeta de la campaña.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import { useRtSubscribe } from "../../utils/rt-bus";
import { adsActionFn, adsProposalCardFn } from "../../server/apps/ads";
import { adsStatusLabel } from "../../server/apps/ads-flow";
import { maxTotal, mxn } from "../../server/apps/ads-proposal";
import ConfirmModal from "../ConfirmModal";

type State = Awaited<ReturnType<typeof adsProposalCardFn>>;

const btn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

export function useAdsCard<T>(load: () => Promise<T>, channelId: number) {
  const [st, setSt] = useState<T | null>(null);
  const refresh = useCallback(() => {
    load().then(setSt).catch(() => {});
  }, [load]);
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

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—";
};

const fmtPeople = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));

export function AdsProposalCard({ card, channelId }: { card: { campaignId: number }; channelId: number }) {
  const t = useT();
  const load = useCallback(() => adsProposalCardFn({ data: { campaignId: card.campaignId } }), [card.campaignId]);
  const { st, refresh } = useAdsCard<State>(load, channelId);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  if (!st) return null;
  const p = st.proposal;
  const total = maxTotal(p.dailyBudget, p.endTime, Date.now());
  const tg = p.targeting ?? { ageMin: 25, ageMax: 55 };
  const chips = [
    `${tg.ageMin}–${tg.ageMax} ${t("años")}`,
    ...(tg.countries ?? []),
    ...(tg.cities ?? []).map((c) => `${c.name ?? c.key}${c.radiusKm ? ` +${c.radiusKm} km` : ""}`),
    ...(tg.interests ?? []).map((i) => i.name),
  ];
  const open = st.status === "proposal";

  const act = async (action: "create" | "cancel" | "retry") => {
    setBusy(action);
    setErr("");
    try {
      await adsActionFn({ data: { campaignId: st.campaignId, action } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="mt-0.5 flex max-w-2xl overflow-hidden rounded-lg gt-card">
      <div className={`w-1 shrink-0 ${st.status === "error" ? "bg-red-500" : open ? "bg-amber-500" : "bg-brand"}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">{t("Propuesta")} #{st.campaignId}</span>
          {!open && <span className="text-[11px] font-semibold text-muted">{t(adsStatusLabel(st.status))}</span>}
        </div>
        <p className="mt-1 text-sm font-semibold text-ink">{p.name}</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          {st.previewSrc && /^https:\/\//.test(st.previewSrc) ? (
            <MetaPreview src={st.previewSrc} title={t("Vista previa del anuncio")} loadingLabel={t("Cargando la vista previa de Meta…")} />
          ) : (
            <p className="grid min-h-24 w-full shrink-0 place-items-center rounded-md border border-dashed border-border p-3 text-center text-xs text-muted sm:w-[300px]">
              {st.previewNote ?? t("Sin vista previa de Meta todavía")}
            </p>
          )}
          <div className="min-w-0 flex-1 space-y-2 text-xs">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{p.message}</p>
            {p.headline && <p className="font-semibold text-ink">{p.headline}</p>}
            {p.greeting && (
              <p className="text-muted">
                {t("Saludo en Messenger")}: <span className="text-ink">{p.greeting}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              {chips.map((c) => (
                <span key={c} className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-ink">
                  {c}
                </span>
              ))}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">{t("Audiencia estimada")}</dt>
              <dd className="text-ink">{st.estimate ? `${fmtPeople(st.estimate.lower)} – ${fmtPeople(st.estimate.upper)} ${t("personas")}` : "—"}</dd>
              <dt className="text-muted">{t("Presupuesto")}</dt>
              <dd className="text-ink">
                {mxn(p.dailyBudget)} {t("al día")} · {t("hasta el")} {fmtDate(p.endTime)}
              </dd>
              <dt className="text-muted">{t("Máximo total")}</dt>
              <dd className="font-semibold text-ink">{mxn(total)} MXN</dd>
            </dl>
          </div>
        </div>
        {st.status === "error" && st.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{st.error}</p>}
        {st.approvedBy && !open && (
          <p className="mt-2 text-[11px] text-muted">
            {st.status === "cancelled" ? t("Cancelada por") : t("Decidió")}: {st.approvedBy}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {open && (
            <>
              <button type="button" disabled={!!busy} onClick={() => setConfirm(true)} className={`${btn} border-emerald-600 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400`}>
                {busy === "create" ? <Loader2 className="inline size-3.5 animate-spin" /> : null} {busy === "create" ? t("Creando en Meta…") : t("Crear en pausa")}
              </button>
              <button type="button" disabled={!!busy} onClick={() => act("cancel")} className={`${btn} border-border text-muted hover:text-ink`}>
                {t("Cancelar")}
              </button>
            </>
          )}
          {st.status === "error" && (
            <>
              <button type="button" disabled={!!busy} onClick={() => act("retry")} className={`${btn} border-brand text-brand hover:bg-brand/10`}>
                {t("Reintentar")}
              </button>
              <button type="button" disabled={!!busy} onClick={() => act("cancel")} className={`${btn} border-border text-muted hover:text-ink`}>
                {t("Cancelar")}
              </button>
            </>
          )}
        </div>
        {err && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
      {confirm && (
        <ConfirmModal
          title={t("¿Crear la campaña en pausa?")}
          body={t("Se crea en Meta en PAUSA: no gasta nada hasta que alguien la prenda. Al prenderla gastará hasta {d} al día, {m} como máximo en total.")
            .replace("{d}", mxn(p.dailyBudget))
            .replace("{m}", mxn(total))}
          confirmLabel={t("Crear en pausa")}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            await act("create");
          }}
        />
      )}
    </div>
  );
}

// El iframe de Meta (`generatepreviews`) mide 335 px de ancho y trae su propio scroll: a
// 335×450 un post 4:5 no cabe y la tarjeta enseñaba medio anuncio con dos barras. Se pinta a
// su ancho real y con alto de sobra para el post completo, SIN scroll, y se escala para caber:
// se ve el anuncio entero como en el celular.
const META_W = 335;
const META_H = 700;

function MetaPreview({ src, title, loadingLabel }: { src: string; title: string; loadingLabel: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(300 / META_W);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / META_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setLoaded(false), [src]);
  return (
    <div
      ref={box}
      className="relative w-full shrink-0 overflow-hidden rounded-md border border-border bg-white sm:w-[300px]"
      style={{ height: Math.round(META_H * scale) }}
    >
      <iframe
        title={title}
        src={src}
        scrolling="no"
        onLoad={() => setLoaded(true)}
        sandbox="allow-scripts allow-same-origin allow-popups"
        style={{ width: META_W, height: META_H, transform: `scale(${scale})`, transformOrigin: "top left", border: 0 }}
      />
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center bg-white">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> {loadingLabel}
          </span>
        </div>
      )}
    </div>
  );
}
