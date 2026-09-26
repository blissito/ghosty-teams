// Una campaña que YA está en Meta (en pausa o activa), en el panel lateral. Se ve lo que hoy
// tiene en Meta (`campaign_detail`) y se edita como CAMBIOS PENDIENTES: segmentación, fecha
// de fin, ubicaciones y un anuncio nuevo. Nada se guarda en Meta hasta [Aplicar en Meta], que
// pica una persona con confirmación. También: la revisión de Meta, la pestaña «Ubicaciones» y
// [Archivar campaña] con el nombre escrito.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import {
  adsApplyPendingFn,
  adsArchiveFn,
  adsDiscardPendingFn,
  adsLiveCampaignFn,
  adsPlacementsFn,
  adsSetPendingFn,
} from "../../server/apps/ads";
import {
  CTA_DEFAULT,
  CTA_LABELS,
  CTA_TYPES,
  endTimeFromDate,
  isCta,
  mxn,
  PLATFORM_LABELS,
  PUBLISHER_PLATFORMS,
  REVIEW_LABELS,
  type PublisherPlatform,
  type Targeting,
} from "../../server/apps/ads-proposal";
import ConfirmModal from "../ConfirmModal";
import { TargetingChips } from "./AdsProposalCard";
import { useAdsCard } from "./useAdsCard";

type Live = NonNullable<Awaited<ReturnType<typeof adsLiveCampaignFn>>>;

const btn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

const REVIEW_CLS: Record<string, string> = {
  approved: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  in_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
  with_issues: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

const dateInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) : "";
};

/** El chip de la revisión de Meta, con sus motivos. */
export function ReviewChip({ review }: { review: Live["review"] }) {
  const t = useT();
  if (!review) return null;
  return (
    <div className="space-y-0.5">
      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${REVIEW_CLS[review.state] ?? "bg-surface-3 text-muted"}`}>
        {t("Meta")}: {t(REVIEW_LABELS[review.state])}
      </span>
      {review.reasons.length > 0 && (
        <ul className="list-disc pl-4 text-[11px] text-muted">
          {review.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AdsLiveEditor({ campaignId, channelId }: { campaignId: number; channelId: number }) {
  const t = useT();
  const load = useCallback(() => adsLiveCampaignFn({ data: { campaignId } }), [campaignId]);
  const { st, refresh } = useAdsCard<Live | null>(load, channelId);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [adOpen, setAdOpen] = useState(false);
  if (!st) return <div className="h-24 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />;
  const editable = (st.status === "paused" || st.status === "active") && !busy;
  const targeting = (st.pending?.targeting ?? st.current.targeting ?? { ageMin: 25, ageMax: 55 }) as Targeting;
  const endTime = st.pending?.endTime ?? st.current.endTime;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const setPending = (change: Parameters<typeof adsSetPendingFn>[0]["data"]["change"]) =>
    run("pending", () => adsSetPendingFn({ data: { campaignId, change } }));

  return (
    <div className="space-y-3 rounded-lg p-3 text-xs gt-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <ReviewChip review={st.review} />
        {!st.metaReachable && <span className="text-[11px] text-amber-700 dark:text-amber-400">{t("Meta no contestó: se muestra lo último guardado.")}</span>}
      </div>

      {/* Lo pendiente va ARRIBA: es lo único que espera una decisión. Al fondo nadie lo encontraba. */}
      <PendingChanges st={st} campaignId={campaignId} onChanged={refresh} />

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t("Segmentación")}</h3>
        <TargetingChips targeting={targeting} editable={editable} campaignId={campaignId} onSave={(tg) => setPending({ targeting: tg })} />
        <label className="flex items-center gap-2">
          <span className="text-muted">{t("Fecha de fin")}</span>
          <input
            type="date"
            disabled={!editable}
            value={dateInput(endTime)}
            onChange={(e) => e.target.value && void setPending({ endTime: endTimeFromDate(e.target.value) }).catch(() => {})}
            className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-ink"
          />
        </label>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t("Anuncio")}</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{st.current.message || "—"}</p>
        {st.current.headline && <p className="font-semibold text-ink">{st.current.headline}</p>}
        <span className="inline-block rounded-md bg-surface-3 px-3 py-1 font-semibold text-ink">
          {t(CTA_LABELS[isCta(st.current.cta) ? st.current.cta : CTA_DEFAULT])}
        </span>
        {!adOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!editable} onClick={() => setAdOpen(true)} className={`${btn} border-border text-ink hover:bg-surface-3`}>
              {t("Cambiar anuncio")}
            </button>
            <span className="text-[11px] text-muted">{t("Se crea un anuncio nuevo y el viejo se pausa; Meta lo revisa de nuevo.")}</span>
          </div>
        ) : (
          <AdForm
            initial={{
              message: st.pending?.ad?.message ?? st.current.message ?? "",
              headline: st.pending?.ad?.headline ?? st.current.headline ?? "",
              cta: st.pending?.ad?.cta ?? (isCta(st.current.cta) ? st.current.cta : CTA_DEFAULT),
              mediaUrl: st.pending?.ad?.mediaUrl ?? "",
            }}
            busy={busy === "pending"}
            onCancel={() => setAdOpen(false)}
            onSave={async (ad) => {
              await setPending({ ad });
              setAdOpen(false);
            }}
          />
        )}
      </section>

      {err && <p className="text-red-600 dark:text-red-400">{err}</p>}
      <ArchiveBox name={st.archiveName} campaignId={campaignId} onDone={refresh} />

    </div>
  );
}

/**
 * Cambios pendientes con [Aplicar en Meta] y [Descartar]. Lo usan el panel lateral y la
 * tarjeta del hilo (`gt-ads-pending`): el botón tiene que estar donde se lee el aviso.
 */
export function PendingChanges({ st, campaignId, onChanged }: { st: Live; campaignId: number; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [err, setErr] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  if (!st.pending) return null;
  const run = async (key: "apply" | "discard", fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  return (
    <section className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
        {t("Cambios pendientes")} · {st.pendingBy}
      </h3>
      <ul className="list-disc pl-4 text-ink">
        {(st.diff.length ? st.diff : [t("Sin diferencias con lo que hoy tiene Meta.")]).map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!!busy || !st.diff.length}
          onClick={() => setConfirmApply(true)}
          className={`${btn} border-emerald-600 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400`}
        >
          {busy === "apply" ? <Loader2 className="inline size-3.5 animate-spin" /> : null} {busy === "apply" ? t("Aplicando…") : t("Aplicar en Meta")}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void run("discard", () => adsDiscardPendingFn({ data: { campaignId } }))}
          className={`${btn} border-border text-muted hover:text-ink`}
        >
          {t("Descartar")}
        </button>
      </div>
      {err && <p className="text-red-600 dark:text-red-400">{err}</p>}
      {confirmApply && (
        <ConfirmModal
          title={t("¿Aplicar los cambios en Meta?")}
          body={
            [
              st.diff.join(" · "),
              st.pending?.targeting || st.pending?.publisherPlatforms
                ? t("Meta reinicia la fase de aprendizaje al cambiar el público; puede subir el costo unos días.")
                : null,
              st.pending?.ad ? t("Se crea un anuncio nuevo y el viejo se pausa; Meta lo revisa de nuevo.") : null,
            ]
              .filter(Boolean)
              .join("\n\n")
          }
          confirmLabel={t("Aplicar en Meta")}
          danger
          onCancel={() => setConfirmApply(false)}
          onConfirm={async () => {
            setConfirmApply(false);
            await run("apply", () => adsApplyPendingFn({ data: { campaignId } }));
          }}
        />
      )}
    </section>
  );
}

/**
 * ```gt-ads-pending```: el cambio que propuso @ads, en el HILO donde se pidió, con el botón
 * para aplicarlo ahí mismo. Antes el aviso era texto con un link que abría otra pestaña y el
 * botón vivía al fondo del panel lateral: nadie lo encontraba (26-sep).
 */
export function AdsPendingCard({
  card,
  channelId,
  onOpen,
}: {
  card: { campaignId: number };
  channelId: number;
  onOpen?: (campaignId: number, title: string) => void;
}) {
  const t = useT();
  const load = useCallback(() => adsLiveCampaignFn({ data: { campaignId: card.campaignId } }), [card.campaignId]);
  const { st, refresh } = useAdsCard<Live | null>(load, channelId);
  if (!st) return null;
  const open = onOpen ? (
    <button type="button" onClick={() => onOpen(st.campaignId, st.title)} className={`${btn} border-brand text-brand hover:bg-brand/10`}>
      {t("Ver campaña")}
    </button>
  ) : null;
  return (
    <div className="mt-0.5 max-w-xl space-y-2 rounded-lg p-3 text-xs gt-card">
      <p className="text-sm font-semibold text-ink">
        📝 {t("Campaña")} #{st.campaignId} <span className="font-normal text-muted">· {st.title}</span>
      </p>
      {st.pending ? (
        <PendingChanges st={st} campaignId={st.campaignId} onChanged={refresh} />
      ) : (
        <p className="text-muted">✅ {t("Sin cambios pendientes: ya se aplicaron o se descartaron.")}</p>
      )}
      {open}
    </div>
  );
}

/** El anuncio nuevo: copy, título, botón y creativo (obligatorio: el anuncio viejo no se edita). */
function AdForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: { message: string; headline: string; cta: string; mediaUrl: string };
  busy: boolean;
  onSave: (ad: { message: string; headline?: string; cta: string; mediaUrl: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [f, setF] = useState(initial);
  const field = "w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink";
  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <textarea rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} aria-label={t("Copy")} className={field} />
      <input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} placeholder={t("Encabezado")} aria-label={t("Encabezado")} className={field} />
      <select value={f.cta} onChange={(e) => setF({ ...f, cta: e.target.value })} aria-label={t("Botón del anuncio")} className={field}>
        {CTA_TYPES.map((c) => (
          <option key={c} value={c}>
            {t(CTA_LABELS[c])}
          </option>
        ))}
      </select>
      <input
        value={f.mediaUrl}
        onChange={(e) => setF({ ...f, mediaUrl: e.target.value })}
        placeholder={t("Creativo: URL https o adjunto del room (/api/attachment/…)")}
        aria-label={t("Creativo")}
        className={field}
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || f.message.trim().length < 10 || !f.mediaUrl.trim()}
          onClick={() => void onSave({ message: f.message.trim(), headline: f.headline.trim() || undefined, cta: f.cta, mediaUrl: f.mediaUrl.trim() }).catch(() => {})}
          className={`${btn} border-brand text-brand hover:bg-brand/10`}
        >
          {busy ? t("Guardando…") : t("Dejar como pendiente")}
        </button>
        <button type="button" onClick={onCancel} className="px-1 text-xs text-muted hover:text-ink">
          {t("Cancelar")}
        </button>
      </div>
    </div>
  );
}

/** [Archivar campaña]: la segunda confirmación es escribir su nombre. */
function ArchiveBox({ name, campaignId, onDone }: { name: string; campaignId: number; onDone: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-muted hover:text-red-600">
        {t("Archivar campaña")}…
      </button>
    );
  return (
    <div className="space-y-1.5 rounded-md border border-red-500/40 bg-red-500/5 p-2">
      <p className="text-ink">{t("Archivar la saca de Meta para siempre: deja de correr y no se puede volver a prender. Sus números se conservan.")}</p>
      <p className="text-muted">
        {t("Escribe el nombre para confirmar:")} <b className="text-ink">{name}</b>
      </p>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("Nombre de la campaña")} className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink" />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || typed.trim() !== name.trim()}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              await adsArchiveFn({ data: { campaignId, confirmName: typed } });
              setOpen(false);
              onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className={`${btn} border-red-600 text-red-600 hover:bg-red-600/10`}
        >
          {busy ? t("Archivando…") : t("Archivar campaña")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-1 text-xs text-muted hover:text-ink">
          {t("Cancelar")}
        </button>
      </div>
      {err && <p className="text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}

type PlacementsState = Awaited<ReturnType<typeof adsPlacementsFn>>;

/** Pestaña «Ubicaciones»: tabla por plataforma y posición, e interruptores que dejan pendiente. */
export function AdsPlacements({ campaignId, channelId }: { campaignId: number; channelId: number }) {
  const t = useT();
  const load = useCallback(() => adsLiveCampaignFn({ data: { campaignId } }), [campaignId]);
  const { st: live, refresh } = useAdsCard<Live | null>(load, channelId);
  const [rows, setRows] = useState<PlacementsState>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    adsPlacementsFn({ data: { campaignId } })
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [campaignId]);
  // Sin lista (o vacía) Meta elige dónde sale: todas cuentan como encendidas.
  const chosen = live?.pending?.publisherPlatforms ?? live?.publisherPlatforms;
  const active: PublisherPlatform[] = (chosen?.length ? chosen : [...PUBLISHER_PLATFORMS]) as PublisherPlatform[];
  const toggle = async (p: PublisherPlatform) => {
    const next = active.includes(p) ? active.filter((x) => x !== p) : [...active, p];
    if (!next.length) return setErr(t("Deja al menos una plataforma."));
    setBusy(true);
    setErr("");
    try {
      await adsSetPendingFn({ data: { campaignId, change: { publisherPlatforms: next } } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const editable = live?.status === "paused" || live?.status === "active";
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap gap-2">
        {PUBLISHER_PLATFORMS.map((p) => (
          <label key={p} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
            <input type="checkbox" checked={active.includes(p)} disabled={!editable || busy} onChange={() => void toggle(p)} />
            {PLATFORM_LABELS[p]}
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted">{t("Los cambios quedan pendientes: se aplican con [Aplicar en Meta] en la pestaña Campaña.")}</p>
      {err && <p className="text-red-600 dark:text-red-400">{err}</p>}
      {rows === null && !err ? (
        <div className="h-24 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />
      ) : rows && rows.rows.length ? (
        <table className="w-full text-left">
          <thead className="text-[11px] text-muted">
            <tr>
              <th className="py-1 font-medium">{t("Plataforma")}</th>
              <th className="py-1 font-medium">{t("Posición")}</th>
              <th className="py-1 text-right font-medium">{t("Gasto")}</th>
              <th className="py-1 text-right font-medium">{t("Impresiones")}</th>
              <th className="py-1 text-right font-medium">{t("Conversaciones")}</th>
              <th className="py-1 text-right font-medium">{t("Costo por conversación")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {[...rows.rows]
              .sort((a, b) => b.spend - a.spend)
              .map((r) => (
                <tr key={`${r.platform}:${r.position}`}>
                  <td className="py-1 text-ink">{PLATFORM_LABELS[r.platform as PublisherPlatform] ?? r.platform}</td>
                  <td className="py-1 text-muted">{r.position}</td>
                  <td className="py-1 text-right text-ink">{mxn(r.spend)}</td>
                  <td className="py-1 text-right text-ink">{r.impressions.toLocaleString("es-MX")}</td>
                  <td className="py-1 text-right text-ink">{r.conversations}</td>
                  <td className="py-1 text-right text-ink">{r.conversations ? mxn(Math.round((r.spend / r.conversations) * 100) / 100) : "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        !err && <p className="text-muted">{t("Todavía no hay entrega por ubicación.")}</p>
      )}
    </div>
  );
}
