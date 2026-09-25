// «Equipo en este repo»: qué agente y qué modelo hace cada rol de la fábrica en ESTE repo, y de
// dónde sale cada cosa (el archivo `.ghosty/factory.md` del repo o el equipo del espacio). El
// archivo se crea o edita en GitHub: vive versionado con el código, como los droids de Factory
// o los agentes de Copilot. Ver server/apps/factory-team.ts.
import { useEffect, useState } from "react";
import { ExternalLink, FileCode2, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { factoryRepoTeamFn, type RepoTeamView } from "../server/apps/factory";

function SourceChip({ source }: { source: "message" | "repo" | "space" }) {
  const t = useT();
  return source === "repo" ? (
    <span className="shrink-0 rounded-full bg-brand/12 px-2 py-0.5 text-[10px] font-semibold text-brand">{t("del repo")}</span>
  ) : (
    <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">{t("del espacio")}</span>
  );
}

export function RepoTeam({ channelId, repo }: { channelId: number; repo: string }) {
  const t = useT();
  const [team, setTeam] = useState<RepoTeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (fresh = false) => {
    setLoading(true);
    setError(null);
    factoryRepoTeamFn({ data: { channelId, repo, fresh } })
      .then(setTeam)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [channelId, repo]);

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs font-semibold text-ink">{t("Equipo en este repo")}</p>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          title={t("Volver a leer el archivo del repo")}
          aria-label={t("Volver a leer el archivo del repo")}
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
        {team && (
          <a
            href={team.fileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink hover:border-brand hover:text-brand"
          >
            <FileCode2 size={12} />
            {team.hasFile ? t("Editar .ghosty/factory.md") : t("Crear .ghosty/factory.md")}
            <ExternalLink size={11} className="text-muted" />
          </a>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!team && !error && <div className="mt-2 h-[108px] animate-pulse rounded-lg bg-surface-3/60 motion-reduce:animate-none" />}

      {team && (
        <>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {team.roles.map((r) => (
              <li key={r.handle} className="flex items-center gap-3 px-3 py-2">
                <span className="w-14 shrink-0 font-mono text-xs font-semibold text-ink">@{r.handle}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-ink">
                    {r.agent ? r.agent.name : <span className="text-muted">{t("sin agente")}</span>}
                    {r.agent && <span className="text-muted"> · {r.agent.engine}</span>}
                  </p>
                  {r.model && <p className="truncate font-mono text-[11px] text-muted">{r.model}</p>}
                  {r.problem && <p className="truncate text-[11px] text-amber-700 dark:text-amber-400">⚠ {r.problem}</p>}
                </div>
                <SourceChip source={r.agentSource === "repo" || r.modelSource === "repo" ? "repo" : "space"} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {team.hasFile
              ? t("Lo que diga el archivo del repo le gana al equipo del espacio.")
              : t("Este repo usa el equipo del espacio. Con .ghosty/factory.md le das su propio equipo y sus convenciones.")}{" "}
            {t("Para un solo pedido: «@build con opus …».")}
          </p>
        </>
      )}
    </div>
  );
}
