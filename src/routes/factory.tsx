// «Fábrica»: la Software Factory del espacio en un solo lugar (antes, en Ajustes → Apps).
//  - Pedidos: los números del espacio (cuántos se concretan, vueltas, tiempo al PR) y la
//    lista con liga al hilo y al PR. Hoy se MIDE; con esto se fijarán los límites por plan.
//  - Repos: «Listo para agentes» de cada repo del room de la fábrica (preparar, proteger,
//    variables de la preview). `?repo=` abre las Variables de ése.
//  - Equipo y Automático: sólo el dueño (roles de @plan/@build/@check y tareas programadas).
// Misma forma que /forms: el loader sólo resuelve auth; los datos llegan por server fns.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Factory } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { factoryOverviewFn, factoryStatusFn, type FactoryStatus } from "../server/apps/factory";
import { RepoReadiness } from "../components/RepoReadiness";
import { RolesEditor, SchedulesEditor, SuggestAsks } from "../components/AppsPanel";

type Overview = Awaited<ReturnType<typeof factoryOverviewFn>>;
let cache: Overview | null = null;

export const Route = createFileRoute("/factory")({
  validateSearch: (s: Record<string, unknown>) => ({ repo: typeof s.repo === "string" ? s.repo : undefined }),
  loader: async () => ({ user: await me() }),
  component: FactoryPage,
});

const STAGE: Record<string, string> = {
  planning: "Plan",
  plan_review: "Firma",
  building: "Build",
  checking: "Check",
  pr_review: "PR",
  escalated: "Necesita decisión",
  done: "Mezclado",
  cancelled: "Cancelado",
};

function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

function FactoryPage() {
  const t = useT();
  const locale = useLocale();
  const { repo: focusRepo } = Route.useSearch();
  const [data, setData] = useState<Overview | null>(cache);
  const [owner, setOwner] = useState<FactoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"live" | "all">("live");

  const load = () =>
    factoryOverviewFn()
      .then((d) => {
        cache = d;
        setData(d);
        if (d.isOwner) factoryStatusFn().then(setOwner).catch(() => {});
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  const runs = useMemo(
    () => (data?.runs ?? []).filter((r) => filter === "all" || !["done", "cancelled"].includes(r.status)),
    [data, filter],
  );
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString(intlLocale(locale), { day: "numeric", month: "short" });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        <ArrowLeft size={14} /> {t("Volver")}
      </Link>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-brand/12 text-brand">
          <Factory className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("Fábrica Agéntica")}</h1>
          <p className="text-sm text-muted">
            {data?.room ? (
              <>
                {t("Trabaja en")} <a href={`/c/${data.room.slug}`} className="text-brand hover:underline">#{data.room.slug}</a>
              </>
            ) : (
              t("@plan planea, @build construye, @check revisa. Tú firmas y mezclas.")
            )}
          </p>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data && !error && <div className="mt-6 h-24 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />}
      {data && !data.installed && (
        <p className="mt-6 rounded-xl border border-border bg-surface-2 p-4 text-sm text-muted">
          {t("La Software Factory no está instalada en este espacio.")}{" "}
          {data.isOwner && t("Instálala en Ajustes → Apps.")}
        </p>
      )}

      {data?.installed && (
        <>
          {/* Pedidos: números y lista. */}
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-ink">{t("Pedidos")}</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [t("Pedidos"), String(data.stats.total)],
                [t("Se concretan"), data.stats.successRate == null ? "—" : `${Math.round(data.stats.successRate * 100)}%`],
                [t("Vueltas de check"), data.stats.avgLoops == null ? "—" : data.stats.avgLoops.toFixed(1)],
                [t("Del pedido al PR"), duration(data.stats.medianToPrSeconds)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                  <p className="text-[11px] text-muted">{k}</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">{v}</p>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              {t("{a} mezclados · {b} cancelados · {c} abiertos · {d} necesitan decisión")
                .replace("{a}", String(data.stats.merged))
                .replace("{b}", String(data.stats.cancelled))
                .replace("{c}", String(data.stats.open))
                .replace("{d}", String(data.stats.escalated))}
            </p>

            <div className="mt-3 flex gap-1" role="tablist">
              {(["live", "all"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? "bg-ink text-surface" : "text-muted hover:text-ink"}`}
                >
                  {f === "live" ? t("Vivos") : t("Todos")}
                </button>
              ))}
            </div>
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
              {runs.length === 0 && <li className="px-3 py-4 text-sm text-muted">{filter === "live" ? t("Nadie está trabajando en un pedido ahora.") : t("Todavía no hay pedidos.")}</li>}
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="w-10 shrink-0 font-mono text-xs text-muted">#{r.id}</span>
                  <div className="min-w-0 flex-1">
                    <a href={r.threadUrl ?? "#"} className="block truncate text-sm font-medium text-ink hover:underline">
                      {r.title}
                    </a>
                    <p className="truncate text-[11px] text-muted">
                      {r.repo ?? "—"} · {fmt(r.createdAt)}
                      {r.loops ? ` · ${r.loops} ${r.loops === 1 ? t("vuelta") : t("vueltas")}` : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      r.status === "done"
                        ? "bg-emerald-600/12 text-emerald-700 dark:text-emerald-400"
                        : r.status === "cancelled"
                          ? "bg-surface-3 text-muted"
                          : r.status === "escalated"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-brand/12 text-brand"
                    }`}
                  >
                    {t(STAGE[r.status] ?? r.status)}
                  </span>
                  {r.prUrl && (
                    <a href={r.prUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted hover:text-ink">
                      PR ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* Repos del room de la fábrica. */}
          {data.room && data.repos.length > 0 && (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink">{t("Repos")}</h2>
              <div className="mt-2 space-y-2">
                {data.repos.map((repo) => (
                  <div key={repo} id={`repo-${repo}`} className="rounded-xl border border-border bg-surface-2 p-3">
                    <p className="mb-2 font-mono text-xs text-muted">{repo}</p>
                    <RepoReadiness channelId={data.room!.id} repo={repo} autoOpenEnv={focusRepo === repo} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Lo del dueño. */}
          {owner && (
            <>
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-ink">{t("Equipo")}</h2>
                <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3 text-sm">
                  <RolesEditor status={owner} onChange={() => void load()} />
                </div>
              </section>
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-ink">{t("Automático")}</h2>
                <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3 text-sm">
                  <SuggestAsks roomSlug={owner.room?.slug ?? null} />
                  <SchedulesEditor />
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
