// «Anuncios»: Ghosty Ads del espacio en un solo lugar.
//  - Campañas #N de los rooms que ves, con estado, gasto, calificados y costo por lead
//    calificado (el embudo sale de Meta y del tablero de Ventas, por gs).
//  - «Nueva campaña» lleva al room de @ads; «Importar campaña existente» trae una de la
//    cuenta de Meta sin tocarla (sólo el dueño).
//  - Automático (dueño): el reporte de las 9:00 y 21:00, con «Correr ahora».
// Misma forma que /factory: el loader sólo resuelve auth; los datos llegan por server fns.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Megaphone } from "lucide-react";
import { useT } from "../i18n";
import { me } from "../server/auth";
import { adsImportableFn, adsImportFn, adsOverviewFn, adsRunReportFn, adsScheduleFn, setAdsScheduleFn } from "../server/apps/ads";
import { adsStatusLabel } from "../server/apps/ads-flow";
import { mxn } from "../server/apps/ads-proposal";
import { Toggle } from "../components/Toggle";

type Overview = Awaited<ReturnType<typeof adsOverviewFn>>;
type Importable = Awaited<ReturnType<typeof adsImportableFn>>;
type Schedule = Awaited<ReturnType<typeof adsScheduleFn>>;

export const Route = createFileRoute("/ads")({
  loader: async () => ({ user: await me() }),
  component: AdsPage,
});

const STATUS_CLS: Record<string, string> = {
  active: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  proposal: "bg-brand/12 text-brand",
  ended: "bg-violet-600/15 text-violet-700 dark:text-violet-300",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function AdsPage() {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    adsOverviewFn()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  const spend = data?.campaigns.reduce((a, c) => a + (c.spend ?? 0), 0) ?? 0;
  const qualified = data?.campaigns.reduce((a, c) => a + (c.qualified ?? 0), 0) ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        <ArrowLeft size={14} /> {t("Volver")}
      </Link>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand">
          <Megaphone className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink">{t("Ghosty Ads")}</h1>
          <p className="truncate text-sm text-muted">
            {data?.meta.connected
              ? `${data.meta.adAccount?.name ?? t("Cuenta sin elegir")} · ${data.meta.page?.name ?? t("página sin elegir")}`
              : t("@ads propone; tú creas, prendes y pausas desde la tarjeta.")}
          </p>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data && !error && <div className="mt-6 h-24 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />}
      {data && !data.installed && (
        <p className="mt-6 rounded-xl border border-border bg-surface-2 p-4 text-sm text-muted">
          {t("Ghosty Ads no está instalada en este espacio.")} {data.isOwner && t("Instálala en Ajustes → Apps.")}
        </p>
      )}

      {data?.installed && (
        <>
          {!data.meta.connected && (
            <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              {data.meta.error ?? t("Meta no está conectado.")} {data.isOwner ? t("Conéctalo en Ajustes → Apps → Ghosty Ads.") : t("Pídeselo al dueño del espacio.")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {data.room && (
              // Link del router y no <a href>: una carga completa de /c/<room> abre Inicio.
              <Link to="/c/$slug" params={{ slug: data.room.slug }} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                {t("Nueva campaña")} → #{data.room.slug}
              </Link>
            )}
          </div>

          <section className="mt-6">
            <h2 className="text-sm font-semibold text-ink">{t("Campañas")}</h2>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  [t("Gasto"), mxn(spend)],
                  [t("Calificados"), String(qualified)],
                  [t("Costo por lead calificado"), qualified ? mxn(Math.round((spend / qualified) * 100) / 100) : "—"],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                  <p className="text-[11px] text-muted">{k}</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">{v}</p>
                </div>
              ))}
            </div>
            {data.funnelError && <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">{data.funnelError}</p>}
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
              {data.campaigns.length === 0 && (
                <li className="px-3 py-4 text-sm text-muted">{t("Todavía no hay campañas. Pídele una a @ads en el room, o importa una que ya exista.")}</li>
              )}
              {data.campaigns.map((c) => (
                <li key={c.id} className="group relative flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
                  <span className="w-10 shrink-0 font-mono text-xs text-muted">#{c.id}</span>
                  <div className="min-w-0 flex-1">
                    <a href={c.threadUrl ?? "#"} className="block truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-['']">
                      {c.title}
                    </a>
                    <p className="truncate text-[11px] text-muted">
                      {c.dailyBudget ? `${mxn(c.dailyBudget)} ${t("al día")}` : "—"}
                      {c.spend != null ? ` · ${t("gasto")} ${mxn(c.spend)}` : ""}
                      {c.qualified != null ? ` · ${c.qualified} ${t("calificados")}` : ""}
                      {c.imported ? ` · ${t("importada")}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-right text-xs">
                    <span className="block text-[10px] text-muted">{t("por calificado")}</span>
                    <b className="tabular-nums text-ink">{c.costPerQualified == null ? "—" : mxn(c.costPerQualified)}</b>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLS[c.status] ?? "bg-surface-3 text-muted"}`}>
                    {t(adsStatusLabel(c.status))}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {data.isOwner && data.meta.connected && <ImportCampaign onDone={() => void load()} />}
          {data.isOwner && <ReportSchedule />}
        </>
      )}
    </div>
  );
}

/** «Importar campaña existente»: trae una campaña de la cuenta sin tocarla en Meta. */
function ImportCampaign({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [items, setItems] = useState<Importable | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const show = async () => {
    setOpen(true);
    setErr("");
    try {
      setItems(await adsImportableFn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  };
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-ink">{t("Importar campaña existente")}</h2>
      <p className="text-[11px] text-muted">{t("Trae una campaña que ya está en tu cuenta de Meta para medir su costo por lead calificado. No se cambia nada en Meta.")}</p>
      {!open ? (
        <button type="button" onClick={show} className="mt-2 rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/10">
          {t("Ver campañas de la cuenta")}
        </button>
      ) : items === null ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t("Buscando…")}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
          {items.length === 0 && <li className="px-3 py-3 text-sm text-muted">{t("No hay campañas por importar.")}</li>}
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{i.name}</p>
                <p className="text-[11px] text-muted">
                  {i.status} {i.dailyBudget ? `· ${mxn(i.dailyBudget)} ${t("al día")}` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(i.id);
                  setErr("");
                  try {
                    await adsImportFn({ data: { metaCampaignId: i.id } });
                    setItems((xs) => (xs ?? []).filter((x) => x.id !== i.id));
                    onDone();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
                className="shrink-0 rounded-md border border-brand px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50"
              >
                {busy === i.id ? t("Importando…") : t("Importar")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{err}</p>}
    </section>
  );
}

/** El reporte automático: encendido, a qué horas y «Correr ahora». */
function ReportSchedule() {
  const t = useT();
  const [s, setS] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => adsScheduleFn().then(setS).catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  if (!s) return null;
  const save = async (patch: Partial<Pick<Schedule, "enabled" | "hours">>) => {
    setBusy(true);
    try {
      await setAdsScheduleFn({ data: { enabled: patch.enabled ?? s.enabled, hours: patch.hours ?? s.hours } });
      await load();
    } finally {
      setBusy(false);
    }
  };
  const [h1, h2] = [s.hours[0] ?? 9, s.hours[1] ?? 21];
  const hourSelect = (value: number, onPick: (h: number) => void, label: string) => (
    <select value={value} disabled={busy} aria-label={label} onChange={(e) => onPick(Number(e.target.value))} className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-ink">
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, "0")}:00
        </option>
      ))}
    </select>
  );
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-ink">{t("Automático")}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 p-3 text-sm">
        <span>📊</span>
        <span className="font-semibold text-ink">{t("Reporte de anuncios")}</span>
        {hourSelect(h1, (h) => void save({ hours: [h, h2] }), t("Primera hora"))}
        <span className="text-xs text-muted">{t("y")}</span>
        {hourSelect(h2, (h) => void save({ hours: [h1, h] }), t("Segunda hora"))}
        <span className="text-xs text-muted">{s.tz}</span>
        <div className="ml-auto">
          <Toggle on={s.enabled} disabled={busy} label={`${t("Reporte de anuncios")}: ${s.enabled ? t("Encendida") : t("Apagada")}`} onChange={(on) => void save({ enabled: on })} />
        </div>
        <p className="order-last w-full text-xs leading-relaxed text-muted">
          {t("Publica en el room el embudo de cada campaña activa y te avisa. Si nada cambió desde el último, no publica.")}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg("");
              try {
                const r = await adsRunReportFn();
                setMsg(r.posted ? t("Publicado en el room.") : (r.reason ?? ""));
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            className="font-semibold text-brand hover:underline disabled:opacity-50"
          >
            {t("Correr ahora")}
          </button>
          {msg && <span className="ml-1">· {msg}</span>}
        </p>
      </div>
    </section>
  );
}
