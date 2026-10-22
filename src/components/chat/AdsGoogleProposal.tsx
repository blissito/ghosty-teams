// Propuesta de campaña de BÚSQUEDA de Google Ads (la misma tarjeta `gt-ads-proposal`, rama de
// Google). Enseña el anuncio como sale en el buscador (rota los títulos con ‹ ›, igual que Google
// combina los que le das), y deja editar en línea títulos, descripciones, palabras clave con su
// volumen, negativas, ubicaciones, teléfono (medición) y presupuesto. Cada cambio es una versión
// nueva. [Crear en pausa] primero pide a Google una revisión en seco (validateOnly): si un título
// viola una política se marca aquí, antes de confirmar. Lo pica una PERSONA.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useT } from "../../i18n";
import { adsActionFn, adsEditGoogleProposalFn, adsGoogleLocationSearchFn, adsGoogleValidateFn, adsUseVersionFn } from "../../server/apps/ads";
import { adsStatusLabel } from "../../server/apps/ads-flow";
import { mxn } from "../../server/apps/ads-proposal";
import {
  displayUrl,
  GOOGLE_LIMITS,
  googleMaxTotal,
  type GoogleKeyword,
  type GooglePolicyIssue,
  type GoogleProposal,
  type GoogleProposalEdit,
} from "../../server/apps/ads-google-proposal";
import ConfirmModal from "../ConfirmModal";
import { adsBtn as btn, EditableText } from "./AdsEditableText";
import type { AdsProposalState } from "./AdsProposalCard";

type GoogleData = NonNullable<AdsProposalState["googleData"]>;
type OldVersion = GoogleData["googleVersions"][number];

const chip = "inline-flex items-center gap-1 rounded-full bg-surface-3 py-0.5 pl-2 pr-1 text-[11px] text-ink";
const addChip = "rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted hover:text-ink";

/** 1900 → «1.9k», 880 → «880». */
const fmtVol = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));

const fmtDay = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  return Number.isFinite(x.getTime()) ? x.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : d;
};

export function GoogleProposalView({
  st,
  data,
  refresh,
  layout,
  initialVersion,
}: {
  st: AdsProposalState;
  data: GoogleData;
  refresh: () => void;
  layout: "card" | "panel";
  initialVersion?: number;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  // Lo que dijo la revisión en seco; si no hubo, lo que guardó el último intento fallido.
  const [checked, setChecked] = useState<GooglePolicyIssue[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [viewing, setViewing] = useState<OldVersion | null>(null);
  const appliedVersion = useRef<number | null>(null);
  useEffect(() => {
    if (initialVersion == null || appliedVersion.current === initialVersion) return;
    appliedVersion.current = initialVersion;
    const old = data.googleVersions.find((v) => v.version === initialVersion) ?? null;
    setViewing(old);
    if (old) setShowVersions(true);
  }, [data, initialVersion]);
  // Una versión nueva limpia la revisión anterior (se vuelve a pedir al crear).
  useEffect(() => setChecked(null), [st.version]);

  const p: GoogleProposal = viewing?.proposal ?? data.google;
  const policy = viewing ? [] : (checked ?? data.google.policy ?? []);
  const open = st.status === "proposal";
  const editable = open && !viewing && !busy;
  const cur = data.currency ?? "MXN";
  const money = (n: number) => `${mxn(n)} ${cur}`;
  const max = googleMaxTotal(p.dailyBudget, p.endDate, Date.now());

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

  const save = async (edit: GoogleProposalEdit) => {
    setBusy("edit");
    setErr("");
    try {
      await adsEditGoogleProposalFn({ data: { campaignId: st.campaignId, edit } });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };
  /** Igual que `save`, pero sin lanzar (para chips y selects). */
  const quiet = (edit: GoogleProposalEdit) => void save(edit).catch(() => {});

  /** «Crear en pausa»: primero la revisión en seco de Google; si pasa, la confirmación. */
  const startCreate = async () => {
    setBusy("validate");
    setErr("");
    try {
      const r = await adsGoogleValidateFn({ data: { campaignId: st.campaignId } });
      setChecked(r.policy);
      if (r.ok) setConfirm(true);
      else setErr(r.error ?? t("Google no aceptó la propuesta."));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  const flagged = (field: GooglePolicyIssue["field"]) => new Map(policy.filter((x) => x.field === field).map((x) => [x.index, x.reason]));

  const footer = (
    <>
      {(st.status === "error" || policy.length > 0) && (st.error || policy.length > 0) && (
        <div role="alert" className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-red-700 dark:text-red-300">
          {st.status === "error" && st.error && <p className="font-semibold">{st.error}</p>}
          {policy.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {policy.map((x, i) => (
                <li key={i}>
                  {t(x.field === "headlines" ? "Título" : x.field === "descriptions" ? "Descripción" : "Palabra clave")} {x.index + 1} «{x.text}»: {x.reason}
                </li>
              ))}
            </ul>
          )}
          {st.status === "error" && <p className="mt-1 text-[11px]">{t("Dale «Reintentar», corrige lo marcado y vuelve a crearla. No se gastó nada.")}</p>}
        </div>
      )}
      {st.approvedBy && !open && (
        <p className="mt-2 text-[11px] text-muted">
          {st.status === "cancelled" ? t("Cancelada por") : t("Decidió")}: {st.approvedBy}
        </p>
      )}
      {!viewing && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {open && (
            <>
              <button type="button" disabled={!!busy} onClick={() => void startCreate()} className={`${btn} border-emerald-600 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400`}>
                {busy === "create" || busy === "validate" ? <Loader2 className="inline size-3.5 animate-spin" /> : null}{" "}
                {busy === "create" ? t("Creando en Google…") : busy === "validate" ? t("Revisando con Google…") : t("Crear en pausa")}
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
          {data.googleUrl && (
            <a href={data.googleUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-muted hover:text-ink">
              {t("Abrir en Google Ads")} ↗
            </a>
          )}
        </div>
      )}
      {data.googleEditedBy && !viewing && (
        <p className="mt-1.5 text-[11px] text-muted">
          {t("Versión {n} · editada por {who}").replace("{n}", String(st.version)).replace("{who}", data.googleEditedBy)}
        </p>
      )}
      {err && err !== st.error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
    </>
  );

  return (
    <div className={layout === "panel" ? "@container/ads flex overflow-hidden rounded-lg gt-card" : "mt-0.5 flex max-w-2xl overflow-hidden rounded-lg gt-card"}>
      <div className={`w-1 shrink-0 ${st.status === "error" ? "bg-red-500" : open ? "bg-amber-500" : "bg-brand"}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
            {t("Propuesta")} #{st.campaignId}
          </span>
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{t("Google · Búsqueda")}</span>
          {data.googleVersions.length > 0 ? (
            <button type="button" onClick={() => setShowVersions((v) => !v)} aria-expanded={showVersions} className="text-[11px] font-semibold text-muted hover:text-ink">
              v{st.version} · {t("versiones")} {showVersions ? "▴" : "▾"}
            </button>
          ) : (
            <span className="text-[11px] font-semibold text-muted">v{st.version}</span>
          )}
          {!open && <span className="text-[11px] font-semibold text-muted">· {t(adsStatusLabel(st.status, "google"))}</span>}
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
            {data.googleVersions.map((v) => (
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
        <EditableText value={p.name} editable={editable} label={t("Nombre de la campaña")} className="mt-1 text-sm font-semibold text-ink" onSave={(v) => save({ name: v })} />

        <div className={`mt-2 flex flex-col gap-3 ${layout === "panel" ? "@min-[640px]/ads:flex-row @min-[640px]/ads:items-start" : "sm:flex-row"}`}>
          <div className={`w-full shrink-0 space-y-2 ${layout === "panel" ? "@min-[640px]/ads:w-[320px]" : "sm:w-[300px]"}`}>
            <SerpPreview p={p} />
            <div className="space-y-0.5 text-xs text-muted">
              <div className="flex flex-wrap items-baseline gap-1">
                {t("Lleva a")}:
                <EditableText value={p.finalUrl} inline editable={editable} label={t("Página de destino")} className="break-all text-ink" onSave={(v) => save({ finalUrl: v })} />
              </div>
              {(editable || p.path1 || p.path2) && (
              <div className="flex flex-wrap items-baseline gap-1">
                {t("Ruta visible")}: /
                <EditableText value={p.path1 ?? ""} inline editable={editable} label={t("Ruta visible 1")} placeholder="ruta1" className="text-ink" onSave={(v) => save({ path1: v })} />/
                <EditableText value={p.path2 ?? ""} inline editable={editable} label={t("Ruta visible 2")} placeholder="ruta2" className="text-ink" onSave={(v) => save({ path2: v })} />
              </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-3 text-xs">
            <TextList
              title={t("Títulos")}
              items={p.headlines}
              maxLen={GOOGLE_LIMITS.headline}
              min={GOOGLE_LIMITS.headlinesMin}
              max={GOOGLE_LIMITS.headlinesMax}
              flagged={flagged("headlines")}
              editable={editable}
              addLabel={t("+ título")}
              onSave={(headlines) => save({ headlines })}
            />
            <TextList
              title={t("Descripciones")}
              items={p.descriptions}
              maxLen={GOOGLE_LIMITS.description}
              min={GOOGLE_LIMITS.descriptionsMin}
              max={GOOGLE_LIMITS.descriptionsMax}
              flagged={flagged("descriptions")}
              editable={editable}
              addLabel={t("+ descripción")}
              block
              onSave={(descriptions) => save({ descriptions })}
            />
            <Keywords keywords={p.keywords} editable={editable} flagged={flagged("keywords")} onSave={(keywords) => quiet({ keywords })} />
            <Negatives negatives={p.negatives} editable={editable} onSave={(negatives) => quiet({ negatives })} />
            <Locations p={p} editable={editable} campaignId={st.campaignId} onSave={quiet} />

            <div>
              <p className="font-semibold text-ink">{t("Medición")}</p>
              {p.phone ? (
                <p className="mt-0.5 flex flex-wrap items-baseline gap-1 text-emerald-700 dark:text-emerald-400">
                  ✓ {t("Llamadas desde el anuncio")} (
                  <EditableText value={p.phone} inline editable={editable} label={t("Teléfono")} className="text-ink" onSave={(v) => save({ phone: v || null })} />)
                </p>
              ) : (
                <p className="mt-0.5 flex flex-wrap items-baseline gap-1 text-amber-700 dark:text-amber-400">
                  ⚠️ {t("Sin medición: agrega un teléfono")}
                  {editable && <EditableText value="" inline editable label={t("Teléfono")} placeholder={t("+ teléfono")} onSave={(v) => save({ phone: v })} />}
                </p>
              )}
            </div>

            <GoogleBudget p={p} editable={editable} money={money} onSave={save} />
            <p className="text-muted">
              {t("Puja")}: <span className="text-ink">{t("Maximizar clics")}</span>
              {p.maxCpc ? ` (${t("tope por clic")} ${money(p.maxCpc)})` : ""}
            </p>
            {!viewing && (
              <p className="text-[11px] text-muted">{t("Sólo red de Búsqueda de Google · ubicación por presencia · frase o exacta.")}</p>
            )}
            {layout === "panel" && footer}
          </div>
        </div>
        {layout === "card" && footer}
      </div>
      {confirm && (
        <ConfirmModal
          title={t("¿Crear la campaña en pausa en Google Ads?")}
          body={t("{d} al día, máx. ~{m} en {n} días. No gasta hasta que la prendas.")
            .replace("{d}", money(p.dailyBudget))
            .replace("{m}", money(max.total))
            .replace("{n}", String(max.days))}
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

/** El anuncio como sale en Google: «Patrocinado», URL visible, 3 títulos y 2 descripciones. */
function SerpPreview({ p }: { p: GoogleProposal }) {
  const t = useT();
  const [i, setI] = useState(0);
  const n = p.headlines.length;
  const title = n ? [0, 1, 2].map((k) => p.headlines[(i + k) % n]).filter((h, k, a) => a.indexOf(h) === k).join(" | ") : "";
  const d = p.descriptions.length;
  const desc = d ? [p.descriptions[i % d], d > 1 ? p.descriptions[(i + 1) % d] : ""].filter(Boolean).join(" ") : "";
  const url = displayUrl(p);
  const host = url.split("/")[0];
  const nav = "grid size-6 place-items-center rounded-full border border-border text-muted hover:text-ink disabled:opacity-40";
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{t("Vista previa (como sale en Google)")}</span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label={t("Combinación anterior")} disabled={n < 2} onClick={() => setI((x) => (x - 1 + n) % n)} className={nav}>
            <ChevronLeft className="size-3.5" />
          </button>
          <button type="button" aria-label={t("Combinación siguiente")} disabled={n < 2} onClick={() => setI((x) => (x + 1) % n)} className={nav}>
            <ChevronRight className="size-3.5" />
          </button>
        </span>
      </div>
      <p className="text-[12px] font-bold text-ink">{t("Patrocinado")}</p>
      <div className="mt-1 flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-bold uppercase text-muted" aria-hidden="true">
          {host.slice(0, 1)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-ink">{host}</span>
          <span className="block truncate text-[11px] text-muted">{url}</span>
        </span>
      </div>
      <p className="mt-1 text-[16px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{title}</p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{desc}</p>
      {p.phone && <p className="mt-1 text-[12px] text-[#1a0dab] dark:text-[#8ab4f8]">📞 {p.phone}</p>}
    </div>
  );
}

/** Títulos o descripciones: cada uno editable con su contador (ámbar al pasarse), «×» y «+». */
function TextList({
  title,
  items,
  maxLen,
  min,
  max,
  flagged,
  editable,
  addLabel,
  block,
  onSave,
}: {
  title: string;
  items: string[];
  maxLen: number;
  min: number;
  max: number;
  flagged: Map<number, string>;
  editable: boolean;
  addLabel: string;
  block?: boolean;
  onSave: (next: string[]) => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const commit = async (next: string[]) => {
    setSaving(true);
    try {
      await onSave(next);
      setEditing(null);
    } catch {
      /* el error lo enseña la tarjeta; el editor sigue abierto */
    } finally {
      setSaving(false);
    }
  };
  const over = draft.trim().length > maxLen;
  const editor = (idx: number) => (
    <span className={`${block ? "flex w-full" : "inline-flex"} items-center gap-1 rounded-md border border-brand/50 bg-surface px-1.5 py-0.5`}>
      <input
        value={draft}
        autoFocus
        aria-label={title}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(null);
          if (e.key === "Enter" && draft.trim() && !over) {
            e.preventDefault();
            const next = idx === items.length ? [...items, draft.trim()] : items.map((x, k) => (k === idx ? draft.trim() : x));
            void commit(next);
          }
        }}
        className={`min-w-0 bg-transparent text-xs text-ink outline-none ${block ? "flex-1" : "w-48"}`}
      />
      <span className={`shrink-0 tabular-nums text-[10px] ${over ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted"}`}>
        {draft.trim().length}/{maxLen}
      </span>
      <button
        type="button"
        disabled={saving || !draft.trim() || over}
        onClick={() => void commit(idx === items.length ? [...items, draft.trim()] : items.map((x, k) => (k === idx ? draft.trim() : x)))}
        className="text-[11px] font-semibold text-brand disabled:opacity-40"
      >
        {saving ? <Loader2 className="size-3 animate-spin" /> : t("Guardar")}
      </button>
      <button type="button" disabled={saving} onClick={() => setEditing(null)} className="text-[11px] text-muted hover:text-ink">
        {t("Cancelar")}
      </button>
    </span>
  );
  return (
    <div>
      <p className="font-semibold text-ink">
        {title} <span className="font-normal text-muted">({items.length}/{max})</span>
      </p>
      <div className={`mt-1 ${block ? "space-y-1" : "flex flex-wrap gap-1"}`}>
        {items.map((h, idx) => {
          const why = flagged.get(idx);
          if (editing === idx) return <span key={idx}>{editor(idx)}</span>;
          return (
            <span
              key={idx}
              title={why}
              className={`${block ? "flex w-full items-start" : "inline-flex items-center"} gap-1 rounded-md px-2 py-0.5 ${
                why ? "bg-red-500/10 text-red-700 ring-1 ring-red-500/60 dark:text-red-300" : "bg-surface-3 text-ink"
              }`}
            >
              {editable ? (
                <button
                  type="button"
                  title={why ?? t("Clic para editar")}
                  onClick={() => {
                    setDraft(h);
                    setEditing(idx);
                  }}
                  className={`text-left decoration-dotted hover:underline ${block ? "flex-1" : ""}`}
                >
                  {h}
                </button>
              ) : (
                <span className={block ? "flex-1" : ""}>{h}</span>
              )}
              <span className={`shrink-0 tabular-nums text-[10px] ${h.length > maxLen ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted"}`}>
                {h.length}/{maxLen}
              </span>
              {editable && items.length > min && (
                <button
                  type="button"
                  aria-label={t("Quitar {x}").replace("{x}", h)}
                  onClick={() => void commit(items.filter((_, k) => k !== idx))}
                  className="grid size-4 shrink-0 place-items-center rounded-full text-muted hover:bg-red-500/20 hover:text-red-600"
                >
                  <X className="size-3" strokeWidth={2.5} />
                </button>
              )}
            </span>
          );
        })}
        {editing === items.length ? (
          editor(items.length)
        ) : (
          editable &&
          items.length < max && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setEditing(items.length);
              }}
              className={addChip}
            >
              {addLabel}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Palabras clave con su volumen al mes y la concordancia (frase o exacta; nunca amplia). */
function Keywords({ keywords, editable, flagged, onSave }: { keywords: GoogleKeyword[]; editable: boolean; flagged: Map<number, string>; onSave: (k: GoogleKeyword[]) => void }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim().toLocaleLowerCase("es-MX");
    if (!text) return;
    setAdding(false);
    setDraft("");
    onSave([...keywords, { text, match: "phrase" }]);
  };
  return (
    <div>
      <p className="font-semibold text-ink">
        {t("Palabras clave")} <span className="font-normal text-muted">({keywords.length})</span>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {keywords.map((k, idx) => (
          <span key={`${k.text}:${k.match}`} title={flagged.get(idx)} className={`${chip} ${flagged.has(idx) ? "ring-1 ring-red-500/60" : ""}`}>
            <span className="font-medium">{k.match === "exact" ? `[${k.text}]` : `"${k.text}"`}</span>
            {k.volume != null && (
              <span className="text-[10px] text-muted">
                {fmtVol(k.volume)}
                {t("/mes")}
              </span>
            )}
            {editable ? (
              <select
                value={k.match}
                aria-label={t("Concordancia de {x}").replace("{x}", k.text)}
                onChange={(e) => onSave(keywords.map((x, i) => (i === idx ? { ...x, match: e.target.value === "exact" ? "exact" : "phrase" } : x)))}
                className="bg-transparent text-[10px] text-muted"
              >
                <option value="phrase">{t("frase")}</option>
                <option value="exact">{t("exacta")}</option>
              </select>
            ) : (
              <span className="text-[10px] text-muted">{k.match === "exact" ? t("exacta") : t("frase")}</span>
            )}
            {editable && keywords.length > 1 && (
              <button
                type="button"
                aria-label={t("Quitar {x}").replace("{x}", k.text)}
                onClick={() => onSave(keywords.filter((_, i) => i !== idx))}
                className="grid size-4 place-items-center rounded-full bg-ink/10 text-ink hover:bg-red-500/20 hover:text-red-600"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            )}
          </span>
        ))}
        {editable &&
          (adding ? (
            <InlineAdd value={draft} onChange={setDraft} onAdd={add} onClose={() => setAdding(false)} label={t("Palabra clave")} />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className={addChip}>
              {t("+ palabra")}
            </button>
          ))}
      </div>
    </div>
  );
}

/** Negativas: las base vienen puestas; el dueño las ve y las quita. */
function Negatives({ negatives, editable, onSave }: { negatives: string[]; editable: boolean; onSave: (n: string[]) => void }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div>
      <p className="font-semibold text-ink">
        {t("Negativas")} <span className="font-normal text-muted">· {t("búsquedas donde NO sale")}</span>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {!negatives.length && <span className="text-[11px] text-muted">{t("Ninguna.")}</span>}
        {negatives.map((n) => (
          <span key={n} className={chip}>
            {n}
            {editable && (
              <button
                type="button"
                aria-label={t("Quitar {x}").replace("{x}", n)}
                onClick={() => onSave(negatives.filter((x) => x !== n))}
                className="grid size-4 place-items-center rounded-full bg-ink/10 text-ink hover:bg-red-500/20 hover:text-red-600"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            )}
          </span>
        ))}
        {editable &&
          (adding ? (
            <InlineAdd
              value={draft}
              onChange={setDraft}
              onAdd={() => {
                const v = draft.trim().toLocaleLowerCase("es-MX");
                setAdding(false);
                setDraft("");
                if (v) onSave([...negatives, v]);
              }}
              onClose={() => setAdding(false)}
              label={t("Negativa")}
            />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className={addChip}>
              {t("+ negativa")}
            </button>
          ))}
      </div>
    </div>
  );
}

function InlineAdd({ value, onChange, onAdd, onClose, label }: { value: string; onChange: (v: string) => void; onAdd: () => void; onClose: () => void; label: string }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
      <input
        value={value}
        autoFocus
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
          if (e.key === "Escape") onClose();
        }}
        className="w-36 bg-transparent text-[11px] text-ink outline-none"
      />
      <button type="button" onClick={onAdd} className="text-[11px] font-semibold text-brand">
        {t("Agregar")}
      </button>
      <button type="button" onClick={onClose} aria-label={t("Cerrar")} className="text-muted hover:text-ink">
        <X className="size-3" />
      </button>
    </span>
  );
}

type GeoHit = Awaited<ReturnType<typeof adsGoogleLocationSearchFn>>[number];

/** Dónde sale: ubicaciones de Google (y el radio, si @ads lo puso), con buscador. */
function Locations({ p, editable, campaignId, onSave }: { p: GoogleProposal; editable: boolean; campaignId: number; onSave: (e: GoogleProposalEdit) => void }) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GeoHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!searching || q.trim().length < 2) {
      setHits(null);
      return;
    }
    let alive = true;
    const id = setTimeout(() => {
      setLoading(true);
      setErr("");
      adsGoogleLocationSearchFn({ data: { campaignId, q } })
        .then((r) => alive && setHits(r))
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => alive && setLoading(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, searching, campaignId]);
  const total = p.locations.length + (p.radius ? 1 : 0);
  const removeBtn = (label: string, onClick: () => void) =>
    editable && total > 1 ? (
      <button
        type="button"
        aria-label={t("Quitar {x}").replace("{x}", label)}
        onClick={onClick}
        className="grid size-4 place-items-center rounded-full bg-ink/10 text-ink hover:bg-red-500/20 hover:text-red-600"
      >
        <X className="size-3" strokeWidth={2.5} />
      </button>
    ) : null;
  return (
    <div>
      <p className="font-semibold text-ink">
        {t("Dónde")} <span className="font-normal text-muted">· {t("sólo gente que está ahí")}</span>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {p.locations.map((l) => (
          <span key={l.id} className={chip}>
            {l.name}
            {removeBtn(l.name, () => onSave({ locations: p.locations.filter((x) => x.id !== l.id) }))}
          </span>
        ))}
        {p.radius && (
          <span className={chip}>
            {p.radius.km} km · {p.radius.label}
            {removeBtn(p.radius.label, () => onSave({ radius: null }))}
          </span>
        )}
        {editable && !searching && (
          <button type="button" onClick={() => setSearching(true)} className={addChip}>
            {t("+ ubicación")}
          </button>
        )}
      </div>
      {editable && searching && (
        <div className="mt-1 rounded-md border border-border bg-surface p-1.5">
          <div className="flex items-center gap-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder={t("Busca ciudad, municipio o estado…")}
              aria-label={t("Buscar ubicación")}
              onKeyDown={(e) => e.key === "Escape" && setSearching(false)}
              className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink"
            />
            {loading && <Loader2 className="size-3.5 animate-spin text-muted" />}
            <button type="button" onClick={() => setSearching(false)} aria-label={t("Cerrar")} className="grid size-5 place-items-center text-muted hover:text-ink">
              <X className="size-3.5" />
            </button>
          </div>
          {err && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>}
          {hits && !hits.length && !loading && <p className="mt-1 px-1 text-[11px] text-muted">{t("Sin resultados.")}</p>}
          {!!hits?.length && (
            <ul className="mt-1 max-h-48 overflow-y-auto text-xs">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSearching(false);
                      setQ("");
                      // Elegir una ciudad cuando sólo estaba México (el default) la reemplaza.
                      const base = p.locations.length === 1 && p.locations[0].id === "2484" && h.id !== "2484" ? [] : p.locations;
                      onSave({ locations: [...base.filter((x) => x.id !== h.id), { id: h.id, name: h.name }] });
                    }}
                    className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-3"
                  >
                    <span className="text-ink">{h.name}</span>
                    <span className="truncate text-[10px] text-muted">
                      {h.type} · {h.canonicalName || h.countryCode}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Presupuesto diario, fecha de fin (opcional) y tope por clic, con el máximo en 30 días. */
function GoogleBudget({ p, editable, money, onSave }: { p: GoogleProposal; editable: boolean; money: (n: number) => string; onSave: (e: GoogleProposalEdit) => Promise<void> }) {
  const t = useT();
  const [budget, setBudget] = useState(String(p.dailyBudget));
  const [end, setEnd] = useState(p.endDate ?? "");
  const [cpc, setCpc] = useState(p.maxCpc != null ? String(p.maxCpc) : "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setBudget(String(p.dailyBudget));
    setEnd(p.endDate ?? "");
    setCpc(p.maxCpc != null ? String(p.maxCpc) : "");
  }, [p.dailyBudget, p.endDate, p.maxCpc]);
  const n = Number(budget);
  const m = Number.isFinite(n) ? googleMaxTotal(n, end || undefined, Date.now()) : null;
  const cpcN = cpc.trim() ? Number(cpc) : null;
  const dirty = n !== p.dailyBudget || end !== (p.endDate ?? "") || cpcN !== (p.maxCpc ?? null);
  const maxLine = m ? t("máx. ~{m} en {n} días").replace("{m}", money(m.total)).replace("{n}", String(m.days)) : "—";
  if (!editable)
    return (
      <p className="text-muted">
        {t("Presupuesto")}: <b className="text-ink">{money(p.dailyBudget)}</b> {t("al día")} · {maxLine}
        {p.endDate ? ` · ${t("Fin")}: ${fmtDay(p.endDate)}` : ` · ${t("sin fecha de fin")}`}
      </p>
    );
  const input = "rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-ink";
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
      <label htmlFor="gads-budget" className="text-muted">
        {t("Presupuesto")}
      </label>
      <span className="flex flex-wrap items-center gap-1 text-ink">
        $
        <input id="gads-budget" type="number" min={GOOGLE_LIMITS.budgetMin} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} className={`w-20 ${input}`} />
        {t("al día")} · <b>{maxLine}</b>
      </span>
      <label htmlFor="gads-end" className="text-muted">
        {t("Fin")}
      </label>
      <span className="flex flex-wrap items-center gap-1">
        <input id="gads-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={input} />
        {end ? (
          <button type="button" onClick={() => setEnd("")} className="text-[11px] text-muted hover:text-ink">
            {t("Sin fecha de fin")}
          </button>
        ) : (
          <span className="text-[11px] text-muted">{t("sin fecha de fin")}</span>
        )}
      </span>
      <label htmlFor="gads-cpc" className="text-muted">
        {t("Tope por clic")}
      </label>
      <span className="flex flex-wrap items-center gap-1 text-ink">
        $
        <input id="gads-cpc" type="number" min={0} step="0.5" value={cpc} placeholder={t("opcional")} onChange={(e) => setCpc(e.target.value)} className={`w-20 ${input}`} />
        {dirty && (
          <>
            <button
              type="button"
              disabled={saving || !Number.isFinite(n) || (cpcN != null && !Number.isFinite(cpcN))}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave({
                    ...(n !== p.dailyBudget ? { dailyBudget: n } : {}),
                    ...(end !== (p.endDate ?? "") ? { endDate: end || null } : {}),
                    ...(cpcN !== (p.maxCpc ?? null) ? { maxCpc: cpcN } : {}),
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
                setBudget(String(p.dailyBudget));
                setEnd(p.endDate ?? "");
                setCpc(p.maxCpc != null ? String(p.maxCpc) : "");
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
