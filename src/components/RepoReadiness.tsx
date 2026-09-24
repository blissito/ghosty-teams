// «Listo para agentes»: la calificación de un repo y el botón que lo prepara.
//
// Vive en dos lugares con el MISMO componente: el panel del repo en la cabecera del room
// (donde la gente mira su repo a diario) y Ajustes → Apps → Software Factory. El copy habla
// de resultados («las pruebas corren solas»), no de GitHub; el detalle técnico y la fuente
// de cada criterio (OpenSSF Scorecard, agents.md) van en el tooltip.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useT } from "../i18n";
import { prepareRepoFn, repoReadinessFn, savePreviewEnvFn, type ReadinessView } from "../server/apps/readiness";
import { protectMainFn } from "../server/apps/factory";
import type { ReadinessKey } from "../server/apps/readiness.server";

const LEVEL_NAMES: Record<0 | 1 | 2 | 3, string> = {
  0: "Por empezar",
  1: "Funciona",
  2: "Listo para agentes",
  3: "Seguro",
};

const CRITERIA: Record<ReadinessKey, { label: string; detail: string }> = {
  readme: { label: "Tiene README", detail: "README en la raíz del repo." },
  lockfile: { label: "Dependencias fijadas", detail: "Lockfile (package-lock, pnpm-lock o yarn.lock): la misma instalación en todas partes." },
  scripts: { label: "Se puede probar", detail: "package.json con «test» y «typecheck» o «lint». Agent Readiness (Factory): nivel Functional." },
  agents_md: { label: "Reglas para agentes", detail: "AGENTS.md — formato abierto de la Linux Foundation que leen Codex, Copilot, Cursor, goose y Factory (agents.md)." },
  ci: { label: "Las pruebas corren solas en cada cambio", detail: "Un workflow de GitHub Actions que corre en cada PR. OpenSSF Scorecard: CI-Tests." },
  codeowners: { label: "Una persona revisa los cambios al CI", detail: "CODEOWNERS que cubre .github/. OpenSSF Scorecard: Code-Review." },
  dependabot: { label: "Dependencias al día", detail: "dependabot.yml (o Renovate). OpenSSF Scorecard: Dependency-Update-Tool." },
  protected: { label: "Nada entra a main sin tu aprobación", detail: "Regla en la rama principal: PR, aprobación de una persona y CI en verde. OpenSSF Scorecard: Branch-Protection." },
  preview: { label: "Cada cambio se ve antes de mezclar", detail: "Una preview por PR: la de tu hosting si la publica (Vercel, Netlify…) o una que la fábrica levanta en su propia caja. @check prueba ahí." },
};

export function RepoReadiness({ channelId, repo, compact = false, onLevel, autoOpenEnv = false }: {
  channelId: number;
  repo: string;
  /** En el popover del room: sin título grande y con menos aire. */
  compact?: boolean;
  onLevel?: (level: number | null) => void;
  /** Abre «Variables» al cargar (la liga «Guardar variables» del hilo cae aquí). */
  autoOpenEnv?: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<ReadinessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"prep" | "protect" | "env" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ threadUrl: string | null } | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [envText, setEnvText] = useState("");

  // En un ref: el padre suele pasar una flecha nueva en cada render y, como dependencia,
  // recargaría la revisión en bucle.
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  const load = useCallback(
    (fresh = false) => {
      setLoading(true);
      return repoReadinessFn({ data: { channelId, repo, fresh } })
        .then((v) => {
          setView(v);
          onLevelRef.current?.(v.readiness?.level ?? null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [channelId, repo],
  );
  useEffect(() => {
    setView(null);
    setDone(null);
    setError(null);
    void load();
  }, [load]);

  const r = view?.readiness ?? null;

  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpenEnv || autoOpened.current || !r || !view?.isOwner) return;
    autoOpened.current = true;
    setEnvText(r.facts.envExampleKeys.map((k) => `${k}=`).join("\n"));
    setEnvOpen(true);
  }, [autoOpenEnv, r, view?.isOwner]);

  if (!view && loading) {
    return (
      <div className={compact ? "px-3 py-2" : ""} aria-busy="true">
        <div className="h-4 w-40 animate-pulse rounded bg-surface-3 motion-reduce:animate-none" />
        <div className="mt-2 flex gap-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-1.5 flex-1 animate-pulse rounded-full bg-surface-3 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    );
  }

  if (!r) {
    return (
      <p className={`text-xs text-muted ${compact ? "px-3 py-2" : ""}`}>
        {t("No pude revisar el repo")}
        {view?.error || error ? `: ${view?.error ?? error}` : "."}
      </p>
    );
  }

  const fixable = r.checks.filter((c) => !c.ok && c.fixable).length;
  const protectedOk = r.checks.find((c) => c.key === "protected")?.ok ?? false;
  const levelName = t(LEVEL_NAMES[r.level]);

  const prepare = async () => {
    setBusy("prep");
    setError(null);
    try {
      const out = await prepareRepoFn({ data: { repo } });
      setDone({ threadUrl: out.threadUrl });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openEnv = () => {
    // Las claves del .env.example ya puestas: el dueño sólo llena valores.
    setEnvText(r.facts.envExampleKeys.map((k) => `${k}=`).join("\n"));
    setEnvOpen(true);
  };

  const saveEnv = async () => {
    setBusy("env");
    setError(null);
    try {
      await savePreviewEnvFn({ data: { channelId, repo, dotenv: envText } });
      setEnvOpen(false);
      setEnvText("");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const protect = async () => {
    setBusy("protect");
    setError(null);
    try {
      await protectMainFn({ data: { repo } });
      await load(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/permiso|permission|403/i.test(msg) ? t("Tienes que ser admin del repo y aceptar el permiso de Ghosty en GitHub.") : msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? "px-3 py-2" : ""}>
      {/* Encabezado: nivel en palabras + barra segmentada, un segmento por criterio. */}
      <div className="flex items-baseline gap-2">
        <p className={`${compact ? "text-xs" : "text-sm"} font-semibold text-ink`}>{t("Listo para agentes")}</p>
        <span className="text-xs text-muted">
          {r.level === 3 ? `✓ ${levelName}` : t("Nivel {n} de 3 · {name}").replace("{n}", String(r.level)).replace("{name}", levelName)}
        </span>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={t("Volver a revisar")}
          title={t("Volver a revisar")}
          className="ml-auto rounded p-1 text-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
      </div>
      <div className="mt-1.5 flex gap-1" role="img" aria-label={t("{a} de {b} criterios").replace("{a}", String(r.passed)).replace("{b}", String(r.total))}>
        {r.checks.map((c) => (
          <div
            key={c.key}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${c.ok ? "bg-emerald-500" : "bg-surface-3"}`}
          />
        ))}
      </div>

      {/* Criterios por nivel. */}
      <div className="mt-2 space-y-2">
        {([1, 2, 3] as const).map((level) => {
          const items = r.checks.filter((c) => c.level === level);
          const all = items.every((c) => c.ok);
          return (
            <div key={level}>
              <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted">
                {t(LEVEL_NAMES[level])}
                {all && <Check size={11} className="text-emerald-600" aria-label={t("completo")} />}
              </p>
              <ul className="mt-0.5">
                {items.map((c) => (
                  <li key={c.key} className="flex items-center gap-2 py-0.5 text-[13px]" title={t(CRITERIA[c.key].detail)}>
                    {c.ok ? (
                      <Check size={14} className="shrink-0 text-emerald-600" aria-label={t("hecho")} />
                    ) : (
                      <Circle size={14} className="shrink-0 text-faint" aria-label={t("falta")} />
                    )}
                    <span className={`min-w-0 flex-1 leading-snug ${c.ok ? "text-muted" : "text-ink"}`}>{t(CRITERIA[c.key].label)}</span>
                    {!c.ok && c.key === "protected" && view!.canPrepare && (
                      <button
                        type="button"
                        onClick={protect}
                        disabled={!!busy}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50"
                      >
                        {busy === "protect" ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
                        {t("Activar")}
                      </button>
                    )}
                    {c.key === "preview" && !r.facts.previewHosting && r.facts.previewRunnable && view!.isOwner && (r.facts.envExampleKeys.length > 0 || r.facts.envSavedKeys) && (
                      <button
                        type="button"
                        onClick={() => (envOpen ? setEnvOpen(false) : openEnv())}
                        disabled={!!busy}
                        title={r.facts.envSavedKeys ? `${t("Guardadas")}: ${r.facts.envSavedKeys.join(", ")}` : undefined}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50"
                      >
                        <KeyRound size={11} />
                        {r.facts.envSavedKeys ? t("Reemplazar") : t("Variables")}
                      </button>
                    )}
                    {!c.ok && c.key === "preview" && !r.facts.previewRunnable && (
                      <span className="shrink-0 text-[11px] text-muted">{t("sin cómo arrancar")}</span>
                    )}
                    {!c.ok && c.key === "scripts" && (
                      <span className="shrink-0 text-[11px] text-muted">{r.facts.missingScripts.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {envOpen && (
        <div className="mt-2 rounded-lg border border-border p-2">
          <p className="text-[11px] font-semibold text-ink">{t("Variables de la preview")}</p>
          <p className="mt-0.5 text-[11px] text-muted">{t("Usa datos de prueba, nunca los de producción: el código del PR corre con ellas.")}</p>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={Math.min(10, Math.max(4, envText.split("\n").length))}
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px] text-ink"
            placeholder="DATABASE_URL=…"
            autoFocus
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" onClick={() => setEnvOpen(false)} className="rounded-md px-2 py-1 text-[11px] text-muted hover:text-ink">
              {t("Cancelar")}
            </button>
            <button
              type="button"
              onClick={saveEnv}
              disabled={!envText.trim() || !!busy}
              className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[11px] font-semibold text-brand-fg disabled:opacity-50"
            >
              {busy === "env" && <Loader2 size={11} className="animate-spin" />}
              {t("Guardar variables")}
            </button>
          </div>
        </div>
      )}

      {/* La acción principal. */}
      <div className="mt-3">
        {done ? (
          <div className="rounded-lg bg-emerald-600/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
            {t("Listo: el plan espera tu firma.")}{" "}
            {done.threadUrl && (
              <a href={done.threadUrl} className="font-semibold underline">
                {t("Aprobar el plan")} →
              </a>
            )}
          </div>
        ) : view!.activePrep ? (
          <a
            href={view!.activePrep.threadUrl ?? "#"}
            className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs text-ink hover:bg-surface-2"
          >
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin text-brand motion-reduce:animate-none" />
              {t("Preparación en curso")}
            </span>
            <span className="font-semibold text-brand">{t("Ver pedido")} →</span>
          </a>
        ) : fixable > 0 && view!.canPrepare ? (
          <>
            <button
              type="button"
              onClick={prepare}
              disabled={!!busy}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60"
            >
              {busy === "prep" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {t("Preparar repo")}
              <span className="font-normal opacity-80">· {t("arregla {n}").replace("{n}", String(fixable))}</span>
            </button>
            <p className="mt-1 text-center text-[11px] text-muted">{t("Un solo PR que firmas antes de que se construya.")}</p>
          </>
        ) : fixable > 0 && !view!.factoryInstalled ? (
          <p className="text-xs text-muted">{t("Instala la Software Factory (Ajustes → Apps) para prepararlo en un clic.")}</p>
        ) : fixable > 0 && !view!.isOwner ? (
          <p className="text-xs text-muted">{t("El dueño del espacio puede prepararlo en un clic.")}</p>
        ) : fixable > 0 ? (
          <p className="text-xs text-muted">{t("Se prepara desde el room de la Software Factory.")}</p>
        ) : !protectedOk ? (
          <p className="text-xs text-muted">{t("Sólo falta proteger la rama principal.")}</p>
        ) : null}
        {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <p className="mt-2 flex items-center gap-1 text-[10px] text-faint">
        {t("Criterios de")}
        <a href="https://scorecard.dev" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-muted hover:underline">
          OpenSSF Scorecard <ExternalLink size={9} />
        </a>
        ·
        <a href="https://agents.md" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-muted hover:underline">
          agents.md <ExternalLink size={9} />
        </a>
      </p>
    </div>
  );
}
