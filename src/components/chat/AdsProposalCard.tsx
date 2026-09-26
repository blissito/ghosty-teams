// Tarjeta de PROPUESTA de Ghosty Ads (```gt-ads-proposal```), en el hilo donde se pidió.
// UNA por campaña: cada `ads_proposal_submit` de @ads en el hilo o cada edición en línea es
// una VERSIÓN nueva de esta misma tarjeta (v2, v3…), con las anteriores en sólo lectura.
// Enseña lo que Meta va a mostrar (vista previa real), a quién (chips y audiencia estimada)
// y cuánto puede gastar como máximo. Mientras es propuesta, cualquiera que vea el room edita
// copy, título, saludo, presupuesto, fecha, botón e intereses. [Crear en pausa] lo pica una
// PERSONA; al crearse, esta misma tarjeta se vuelve la de la campaña.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useT } from "../../i18n";
import { adsActionFn, adsEditProposalFn, adsProposalCardFn, adsUseVersionFn } from "../../server/apps/ads";
import { adsStatusLabel, inMeta } from "../../server/apps/ads-flow";
import { CTA_DEFAULT, CTA_LABELS, CTA_TYPES, endTimeFromDate, isCta, maxTotal, mxn, type ProposalEdit } from "../../server/apps/ads-proposal";
import ConfirmModal from "../ConfirmModal";
import { AdsCampaignCard } from "./AdsCampaignCard";
import { useAdsCard } from "./useAdsCard";

export { useAdsCard };

type State = NonNullable<Awaited<ReturnType<typeof adsProposalCardFn>>>;
type OldVersion = State["versions"][number];

const btn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—";
};

/** YYYY-MM-DD de una fecha ISO, en la hora de la Ciudad de México (para `<input type="date">`). */
const dateInput = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) : "";
};

const fmtPeople = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));

export function AdsProposalCard({ card, channelId, msgId }: { card: { campaignId: number }; channelId: number; msgId?: number }) {
  const t = useT();
  const load = useCallback(() => adsProposalCardFn({ data: { campaignId: card.campaignId } }), [card.campaignId]);
  const { st, refresh } = useAdsCard<State | null>(load, channelId);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [viewing, setViewing] = useState<OldVersion | null>(null);
  if (!st) return null;
  // Creada en Meta: si ESTE mensaje es la tarjeta de la campaña, se vuelve la de la campaña
  // (las propuestas viejas, sin tarjeta ligada, tienen la suya aparte y se quedan como están).
  if (inMeta(st.status) && msgId != null && st.cardMsgId === msgId) return <AdsCampaignCard card={card} channelId={channelId} />;

  const shown = viewing
    ? { proposal: viewing.proposal, estimate: viewing.estimate, previewSrc: viewing.previewSrc, previewNote: viewing.previewNote, version: viewing.version }
    : { proposal: st.proposal, estimate: st.estimate, previewSrc: st.previewSrc, previewNote: st.previewNote, version: st.version };
  const p = shown.proposal;
  const total = maxTotal(p.dailyBudget, p.endTime, Date.now());
  const tg = p.targeting ?? { ageMin: 25, ageMax: 55 };
  const open = st.status === "proposal";
  const editable = open && !viewing && !busy;
  const cta = isCta(p.cta) ? p.cta : CTA_DEFAULT;

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

  /** Guarda una edición como versión nueva. Lanza para que el editor siga abierto si falla. */
  const save = async (edit: ProposalEdit) => {
    setBusy("edit");
    setErr("");
    try {
      await adsEditProposalFn({ data: { campaignId: st.campaignId, edit } });
      refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const useVersion = async (version: number) => {
    setBusy("use");
    setErr("");
    try {
      await adsUseVersionFn({ data: { campaignId: st.campaignId, version } });
      setViewing(null);
      setShowVersions(false);
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
          {st.versions.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowVersions((v) => !v)}
              aria-expanded={showVersions}
              className="text-[11px] font-semibold text-muted hover:text-ink"
            >
              v{st.version} · {t("versiones")} {showVersions ? "▴" : "▾"}
            </button>
          ) : (
            <span className="text-[11px] font-semibold text-muted">v{st.version}</span>
          )}
          {!open && <span className="text-[11px] font-semibold text-muted">· {t(adsStatusLabel(st.status))}</span>}
          {busy === "edit" && (
            <span className="flex items-center gap-1 text-[11px] text-muted">
              <Loader2 className="size-3 animate-spin" /> {t("Guardando versión…")}
            </span>
          )}
        </div>
        {showVersions && (
          <ul className="mt-1.5 divide-y divide-border rounded-md border border-border text-xs">
            <li>
              <button type="button" onClick={() => setViewing(null)} className={`w-full px-2 py-1 text-left ${!viewing ? "font-semibold text-ink" : "text-muted hover:text-ink"}`}>
                v{st.version} · {t("vigente")}
              </button>
            </li>
            {st.versions.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => setViewing(v)}
                  className={`w-full px-2 py-1 text-left ${viewing?.version === v.version ? "font-semibold text-ink" : "text-muted hover:text-ink"}`}
                >
                  v{v.version} · {v.editedBy} · {new Date(v.createdAt * 1000).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </button>
              </li>
            ))}
          </ul>
        )}
        {viewing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-xs text-muted">
            <span>{t("Viendo la v{n} (sólo lectura).").replace("{n}", String(viewing.version))}</span>
            {open && (
              <button type="button" disabled={!!busy} onClick={() => useVersion(viewing.version)} className={`${btn} border-brand text-brand hover:bg-brand/10`}>
                {busy === "use" ? t("Guardando…") : t("Usar esta versión")}
              </button>
            )}
            <button type="button" onClick={() => setViewing(null)} className="text-xs hover:text-ink">
              {t("Volver a la vigente")}
            </button>
          </div>
        )}
        <EditableText
          value={p.name}
          editable={editable}
          label={t("Título")}
          className="mt-1 text-sm font-semibold text-ink"
          onSave={(v) => save({ name: v })}
        />
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          {shown.previewSrc && /^https:\/\//.test(shown.previewSrc) ? (
            <MetaPreview src={shown.previewSrc} title={t("Vista previa del anuncio")} loadingLabel={t("Cargando la vista previa de Meta…")} />
          ) : (
            <p className="grid min-h-24 w-full shrink-0 place-items-center rounded-md border border-dashed border-border p-3 text-center text-xs text-muted sm:w-[300px]">
              {shown.previewNote ?? t("Sin vista previa de Meta todavía")}
            </p>
          )}
          <div className="min-w-0 flex-1 space-y-2 text-xs">
            <EditableText
              value={p.message}
              multiline
              editable={editable}
              label={t("Copy")}
              className="whitespace-pre-wrap text-sm leading-relaxed text-ink"
              onSave={(v) => save({ message: v })}
            />
            <EditableText
              value={p.headline ?? ""}
              editable={editable}
              label={t("Encabezado")}
              placeholder={t("+ Agregar encabezado")}
              className="font-semibold text-ink"
              onSave={(v) => save({ headline: v })}
            />
            {/* El botón del anuncio, como se ve en Meta. */}
            <span className="inline-block rounded-md bg-surface-3 px-3 py-1 text-xs font-semibold text-ink">{t(CTA_LABELS[cta])}</span>
            {(editable || p.greeting) && (
            <div className="text-muted">
              {t("Saludo en Messenger")}:{" "}
              <EditableText
                value={p.greeting ?? ""}
                inline
                editable={editable}
                label={t("Saludo en Messenger")}
                placeholder={t("+ Agregar saludo")}
                className="text-ink"
                onSave={(v) => save({ greeting: v })}
              />
            </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {editable ? (
                <select
                  value={cta}
                  aria-label={t("Botón del anuncio")}
                  onChange={(e) => void save({ cta: e.target.value }).catch(() => {})}
                  className="rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
                >
                  {CTA_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {t("Botón")}: {t(CTA_LABELS[c])}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {t("Botón")}: {t(CTA_LABELS[cta])}
                </span>
              )}
              <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-ink">
                {tg.ageMin}–{tg.ageMax} {t("años")}
              </span>
              {[...(tg.countries ?? []), ...(tg.cities ?? []).map((c) => `${c.name ?? c.key}${c.radiusKm ? ` +${c.radiusKm} km` : ""}`)].map((c) => (
                <span key={c} className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-ink">
                  {c}
                </span>
              ))}
              {(tg.interests ?? []).map((i) => (
                <span key={i.id} className="inline-flex items-center gap-0.5 rounded-full bg-surface-3 py-0.5 pl-2 pr-1 text-[11px] text-ink">
                  {i.name}
                  {editable && (
                    <button
                      type="button"
                      aria-label={t("Quitar {x}").replace("{x}", i.name)}
                      onClick={() => void save({ removeInterestIds: [i.id] }).catch(() => {})}
                      className="grid size-4 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">{t("Audiencia estimada")}</dt>
              <dd className="text-ink">{shown.estimate ? `${fmtPeople(shown.estimate.lower)} – ${fmtPeople(shown.estimate.upper)} ${t("personas")}` : "—"}</dd>
            </dl>
            {editable ? (
              <BudgetEditor dailyBudget={p.dailyBudget} endTime={p.endTime} onSave={(e) => save(e)} />
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted">{t("Presupuesto")}</dt>
                <dd className="text-ink">
                  {mxn(p.dailyBudget)} {t("al día")} · {t("hasta el")} {fmtDate(p.endTime)}
                </dd>
                <dt className="text-muted">{t("Máximo total")}</dt>
                <dd className="font-semibold text-ink">{mxn(total)} MXN</dd>
              </dl>
            )}
          </div>
        </div>
        {st.status === "error" && st.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{st.error}</p>}
        {st.approvedBy && !open && (
          <p className="mt-2 text-[11px] text-muted">
            {st.status === "cancelled" ? t("Cancelada por") : t("Decidió")}: {st.approvedBy}
          </p>
        )}
        {/* Sólo la vigente tiene botones. */}
        {!viewing && (
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
        )}
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

/** Texto que se edita con un clic: textarea (o input) con [Guardar] [Cancelar]. */
function EditableText({
  value,
  editable,
  label,
  className,
  onSave,
  multiline,
  inline,
  placeholder,
}: {
  value: string;
  editable: boolean;
  label: string;
  className?: string;
  onSave: (v: string) => Promise<void>;
  multiline?: boolean;
  inline?: boolean;
  placeholder?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  if (editing) {
    return (
      <span className={`${inline ? "inline-flex" : "flex"} w-full flex-col gap-1`}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={multiline ? 4 : 1}
          aria-label={label}
          autoFocus
          className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink"
        />
        <span className="flex gap-1.5">
          <button
            type="button"
            disabled={saving || draft.trim() === value.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draft.trim());
                setEditing(false);
              } catch {
                /* el error lo enseña la tarjeta; el editor sigue abierto */
              } finally {
                setSaving(false);
              }
            }}
            className={`${btn} border-brand text-brand hover:bg-brand/10`}
          >
            {saving ? t("Guardando…") : t("Guardar")}
          </button>
          <button type="button" disabled={saving} onClick={() => setEditing(false)} className="px-1 text-xs text-muted hover:text-ink">
            {t("Cancelar")}
          </button>
        </span>
      </span>
    );
  }
  if (!editable) return value ? <span className={`${inline ? "" : "block"} ${className ?? ""}`}>{value}</span> : null;
  return (
    <button
      type="button"
      title={t("Clic para editar")}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={`${inline ? "inline" : "block w-full"} cursor-text rounded text-left decoration-dotted underline-offset-2 hover:underline ${value ? (className ?? "") : "text-xs text-muted"}`}
    >
      {value || placeholder}
    </button>
  );
}

/** Presupuesto diario y fecha de fin, con el máximo total recalculado mientras se escribe. */
function BudgetEditor({ dailyBudget, endTime, onSave }: { dailyBudget: number; endTime: string; onSave: (e: ProposalEdit) => Promise<void> }) {
  const t = useT();
  const [budget, setBudget] = useState(String(dailyBudget));
  const [date, setDate] = useState(dateInput(endTime));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setBudget(String(dailyBudget));
    setDate(dateInput(endTime));
  }, [dailyBudget, endTime]);
  const n = Number(budget);
  const newEnd = endTimeFromDate(date);
  const dirty = n !== dailyBudget || date !== dateInput(endTime);
  const total = Number.isFinite(n) && date ? maxTotal(n, newEnd, Date.now()) : null;
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
      <label htmlFor="ads-budget" className="text-muted">
        {t("Presupuesto")}
      </label>
      <span className="flex flex-wrap items-center gap-1 text-ink">
        $
        <input
          id="ads-budget"
          type="number"
          min={1}
          step="1"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="w-20 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-ink"
        />
        {t("al día")} · {t("hasta el")}
        <input
          type="date"
          value={date}
          aria-label={t("Fecha de fin")}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-ink"
        />
      </span>
      <span className="text-muted">{t("Máximo total")}</span>
      <span className="flex items-center gap-2">
        <b className="text-ink">{total == null ? "—" : `${mxn(total)} MXN`}</b>
        {dirty && (
          <>
            <button
              type="button"
              disabled={saving || !Number.isFinite(n) || !date}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave({
                    ...(n !== dailyBudget ? { dailyBudget: n } : {}),
                    ...(date !== dateInput(endTime) ? { endTime: newEnd } : {}),
                  });
                } catch {
                  /* el error lo enseña la tarjeta */
                } finally {
                  setSaving(false);
                }
              }}
              className={`${btn} border-brand text-brand hover:bg-brand/10`}
            >
              {saving ? t("Guardando…") : t("Guardar")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setBudget(String(dailyBudget));
                setDate(dateInput(endTime));
              }}
              className="px-1 text-xs text-muted hover:text-ink"
            >
              {t("Cancelar")}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

// El iframe de Meta (`generatepreviews`) mide 335 px de ancho y trae su propio scroll: a
// 335×450 un post 4:5 no cabe y la tarjeta enseñaba medio anuncio con dos barras. Se pinta a
// su ancho real y con alto de sobra para el post completo, SIN scroll, y se escala para caber:
// se ve el anuncio entero como en el celular.
const META_W = 335;
const META_H = 630;

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
