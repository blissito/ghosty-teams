// Tareas programadas de la fábrica vistas desde UN repo del room: la revisión nocturna y la de
// dependencias con su día y hora (CDMX). Sin horario propio, el repo sigue el del espacio
// (Apps → Fábrica); al cambiar cualquier control nace el suyo, y «Usar horario del espacio» lo quita.
// Sólo la ve quien administra el espacio y sólo con la fábrica instalada.
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { Toggle } from "./Toggle";
import { factoryRepoSchedulesFn, setFactoryRepoScheduleFn } from "../server/apps/factory";
import { cronToSchedule, DEFAULT_DAY, SCHEDULE_DAYS, scheduleToCron, type ScheduleDay } from "../server/apps/factory-repo-schedule";

type Row = Awaited<ReturnType<typeof factoryRepoSchedulesFn>>["rows"][number];

const TITLE: Record<string, { icon: string; title: string }> = {
  nightly: { icon: "🌙", title: "Revisión nocturna" },
  deps: { icon: "📦", title: "Dependencias" },
};

const selectCls = "rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-ink";

export function RepoSchedules({ channelId, repo }: { channelId: number; repo: string }) {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = () =>
    factoryRepoSchedulesFn({ data: { channelId, repo } })
      .then((r) => setRows(r.installed ? r.rows : []))
      // No administra el espacio (o falló): la sección no se pinta.
      .catch(() => setRows([]));

  useEffect(() => {
    setRows(null);
    setErr("");
    void load();
  }, [channelId, repo]);

  if (!rows?.length) return null;

  const save = async (kind: Row["kind"], data: { enabled?: boolean; cron?: string; reset?: boolean }) => {
    setBusy(kind);
    setErr("");
    try {
      await setFactoryRepoScheduleFn({ data: { roomId: channelId, repo, kind, ...data } });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // La sección (con su borde) la pone el componente: sin filas no deja un borde vacío en el panel.
  return (
    <section className="border-b border-border py-1">
      <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">{t("Tareas programadas")}</p>
      {rows.map((r) => {
        const l = TITLE[r.kind];
        // Lo que se ve: el horario propio si lo hay; si no, el del espacio.
        const parsed = r.own ? cronToSchedule(r.own.cron) : { day: DEFAULT_DAY[r.kind], hour: r.space.hour };
        const enabled = r.own ? r.own.enabled : r.space.enabled;
        const off = busy !== null;
        const setWhen = (day: ScheduleDay, hour: number) => save(r.kind, { enabled, cron: scheduleToCron(day, hour) });
        return (
          <div key={r.kind} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-sm">
                {l.icon} {t(l.title)}
              </p>
              <Toggle
                on={enabled}
                disabled={off}
                label={`${t(l.title)}: ${enabled ? t("Encendida") : t("Apagada")}`}
                onChange={(v) =>
                  void save(r.kind, { enabled: v, cron: r.own?.cron ?? scheduleToCron(DEFAULT_DAY[r.kind], r.space.hour) })
                }
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {parsed ? (
                <>
                  <select
                    value={parsed.day}
                    disabled={off}
                    aria-label={t("Día")}
                    onChange={(e) => void setWhen(e.target.value as ScheduleDay, parsed.hour)}
                    className={selectCls}
                  >
                    {SCHEDULE_DAYS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {t(d.label)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={parsed.hour}
                    disabled={off}
                    aria-label={t("Hora")}
                    onChange={(e) => void setWhen(parsed.day, Number(e.target.value))}
                    className={selectCls}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-muted">{t("hora de CDMX")}</span>
                </>
              ) : (
                <code className="text-[11px] text-muted">{r.own?.cron}</code>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              {r.own ? (
                <button type="button" disabled={off} onClick={() => void save(r.kind, { reset: true })} className="underline hover:text-ink">
                  {t("Usar horario del espacio")}
                </button>
              ) : (
                t("Sigue el horario del espacio.")
              )}
            </p>
          </div>
        );
      })}
      <p className="px-3 pb-2 pt-1 text-[11px] leading-snug text-muted">
        {t("A esa hora @plan revisa este repo y, si encuentra algo, propone un plan que espera firma.")}
      </p>
      {err && <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
    </section>
  );
}
