// «La computadora del agente» en el panel lateral (`ArtifactPanel` kind "computer"): lo que el
// agente hace, paso por paso, con su resultado. Port de Sitios de EasyBits
// (`~/easybits/app/components/sitios/AgentComputer.tsx`): encabezado con la herramienta en uso,
// franja del plan palomeado, una vista por herramienta (patrón de Suna) y barra de tiempo con
// «en vivo» y replay. Sin navegador en vivo ni «Tomar el control» todavía
// (ghosty-studio `docs/claude/computadora-del-agente-teams.md`, fase 4).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileCode, Globe, ListChecks, Pause, Play, Search, Terminal, Wrench } from "lucide-react";
import { useT } from "../../i18n";
import { KIND_LABEL, currentPlan, isPlumbing, stepVerb, type AgentStep, type StepKind, type StepTodo } from "../../lib/agent-steps";
import { useComputerSteps } from "../../lib/computer-store";

const ICON: Record<StepKind, typeof Globe> = { browser: Globe, terminal: Terminal, editor: FileCode, search: Search, other: Wrench };

/** Ritmo del replay: un paso cada tanto, como el «play» de Manus. */
const PLAY_MS = 1600;

export function AgentComputerPanel({ messageId, agentName }: { messageId: number; agentName?: string }) {
  const { steps, loaded } = useComputerSteps(messageId);
  // En vivo mientras algún paso de trabajo siga corriendo.
  const live = steps.some((s) => s.status === "running" && !isPlumbing(s.tool));
  if (!loaded) return <div className="grid h-full place-items-center text-sm text-muted">…</div>;
  return <AgentComputer steps={steps} live={live} agentName={agentName} />;
}

export function AgentComputer({ steps: allSteps, live, agentName }: { steps: AgentStep[]; live: boolean; agentName?: string }) {
  const t = useT();
  const owner = agentName ? t("de {name}", { name: agentName }) : t("del agente");
  // El plan no es un paso que se mire: va en su franja, arriba.
  const steps = useMemo(() => allSteps.filter((s) => !isPlumbing(s.tool)), [allSteps]);
  // null = seguir en vivo (el último paso). Un número = la persona retrocedió a ese paso.
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const last = steps.length - 1;
  const idx = pinned === null ? last : Math.min(pinned, last);
  const step = steps[idx];
  const following = pinned === null;

  // Si regresa al último paso con la barra, vuelve a seguir en vivo.
  const go = (i: number) => setPinned(i >= last ? null : Math.max(0, i));

  useEffect(() => {
    if (!playing) return;
    if (pinned === null) {
      setPlaying(false);
      return;
    }
    const tm = setTimeout(() => go(pinned + 1), PLAY_MS);
    return () => clearTimeout(tm);
  }, [playing, pinned]);

  // ← → recorren los pasos (sólo si el foco no está escribiendo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        setPlaying(false);
        go(idx - 1);
      }
      if (e.key === "ArrowRight") {
        setPlaying(false);
        go(idx + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // El reloj del paso en curso avanza solo.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [live]);

  if (!step) return <EmptyComputer owner={owner} live={live} />;

  const Icon = ICON[step.kind];
  const running = live && following && step.status === "running";
  const plan = currentPlan(allSteps.filter((s) => s.startedAt <= step.startedAt));
  const View = VIEWS[step.kind] ?? GenericView;
  const repeats = repeatCount(steps, idx);
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Encabezado: qué herramienta usa y qué hace con ella. */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted">
            {t("La computadora {owner} · usa {tool}", { owner, tool: t(KIND_LABEL[step.kind]) })}
          </p>
          {/* Lo que el agente dijo que iba a hacer; el comando ya se ve abajo, en la terminal. */}
          <p className="text-sm leading-snug text-ink">
            <span className="font-bold">{step.intent ?? t(stepVerb(step))}</span>
            {step.detail && step.kind !== "terminal" && <span className="ml-1.5 font-mono text-xs text-muted">{step.detail}</span>}
          </p>
        </div>
      </div>

      {plan && <PlanStrip todos={plan} live={live && following} />}

      {/* La vista de la herramienta. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={`${step.kind}-${step.kind === "terminal" ? "t" : step.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0"
          >
            <View steps={steps} idx={idx} step={step} running={running} />
          </motion.div>
        </AnimatePresence>

        {!following && (
          <button
            type="button"
            onClick={() => setPinned(null)}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-bold text-ink shadow-md hover:bg-surface-2"
          >
            <Play className="size-3.5" /> {live ? t("Volver a en vivo") : t("Ir al final")}
          </button>
        )}
      </div>

      {/* Barra de tiempo. */}
      <div className="border-t border-border px-3 py-2">
        <div className="flex items-center gap-2 text-ink">
          {!live && (
            <button
              type="button"
              aria-label={playing ? t("Pausar") : t("Reproducir")}
              onClick={() => {
                if (!playing && pinned === null) setPinned(0);
                setPlaying((p) => !p);
              }}
              className="rounded-md border border-border p-1 hover:bg-surface-2"
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>
          )}
          <button type="button" aria-label={t("Paso anterior")} disabled={idx <= 0} onClick={() => go(idx - 1)} className="rounded-md p-1 hover:bg-surface-2 disabled:opacity-30">
            <ChevronLeft className="size-4" />
          </button>
          <button type="button" aria-label={t("Paso siguiente")} disabled={idx >= last} onClick={() => go(idx + 1)} className="rounded-md p-1 hover:bg-surface-2 disabled:opacity-30">
            <ChevronRight className="size-4" />
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(last, 0)}
            value={idx}
            onChange={(e) => {
              setPlaying(false);
              go(Number(e.target.value));
            }}
            aria-label={t("Recorrer los pasos")}
            className="hidden h-1.5 flex-1 cursor-pointer accent-[var(--color-brand)] sm:block"
          />
          <span className="flex-1 text-center font-mono text-xs text-muted sm:hidden">
            {t("{i} de {n}", { i: idx + 1, n: steps.length })}
          </span>
          {live ? (
            <span className={`flex items-center gap-1.5 text-xs font-bold ${following ? "text-green-600" : "text-faint"}`}>
              <span className={`size-2 rounded-full ${following ? "animate-pulse bg-green-500" : "bg-faint"}`} /> {t("en vivo")}
            </span>
          ) : (
            <span className="text-xs font-bold text-faint">{t("replay")}</span>
          )}
        </div>
        {/* Tarjeta del paso actual. */}
        <div className="mt-1.5 flex items-center gap-2 text-xs text-ink">
          <StatusDot status={step.status} running={running} />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-bold">{t(stepVerb(step))}</span>
            {step.detail && step.kind !== "terminal" && <span className="text-muted"> · {step.detail}</span>}
            {repeats > 1 && <span className="ml-1 rounded-full bg-surface-2 px-1.5 font-mono text-muted">×{repeats}</span>}
          </span>
          <span className="shrink-0 font-mono text-faint">
            {secondsOf(step, running)} · {idx + 1}/{steps.length}
          </span>
        </div>
      </div>
    </div>
  );
}

function secondsOf(s: AgentStep, running: boolean) {
  const end = s.endedAt ?? (running ? Date.now() : s.startedAt);
  const secs = Math.max(0, Math.round((end - s.startedAt) / 1000));
  return secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function StatusDot({ status, running }: { status: AgentStep["status"]; running: boolean }) {
  if (running) return <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-brand" />;
  return <span className={`size-2.5 shrink-0 rounded-full ${status === "error" ? "bg-red-500" : "bg-green-500"}`} />;
}

/** Nombre de la herramienta sin el prefijo del MCP: `db_query`, no `mcp__ghosty__db_query`. */
const toolName = (tool: string) => tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

/** Lo que recibe cada vista del registro: todos los pasos, el elegido y si sigue corriendo. */
type ViewProps = { steps: AgentStep[]; idx: number; step: AgentStep; running: boolean };

/** Una vista por herramienta (patrón de Suna); lo que no tenga la suya cae en GenericView. */
const VIEWS: Partial<Record<StepKind, (p: ViewProps) => React.ReactElement>> = {
  terminal: TerminalView,
  editor: EditorView,
  search: SearchView,
};

/** Cuántas veces seguidas se repitió el mismo paso hasta aquí («Ejecutó ×4»). */
function repeatCount(steps: AgentStep[], idx: number): number {
  const key = (s: AgentStep) => `${s.tool}|${s.detail ?? ""}|${s.command ?? ""}`;
  let n = 1;
  while (idx - n >= 0 && key(steps[idx - n]) === key(steps[idx])) n++;
  return n;
}

/** El plan del agente palomeándose: hecho, en curso, pendiente. */
function PlanStrip({ todos, live }: { todos: StepTodo[]; live: boolean }) {
  const t = useT();
  const done = todos.filter((x) => x.status === "completed").length;
  const current = todos.find((x) => x.status === "in_progress");
  return (
    <details open className="group border-b border-border bg-card px-4 py-2 text-xs text-ink">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-bold">
        <ListChecks className="size-4 text-brand" />
        <span className="min-w-0 flex-1 truncate">
          {t("Plan · {done} de {n}", { done, n: todos.length })}
          {current && <span className="font-normal text-muted"> · {current.activeForm ?? current.content}</span>}
        </span>
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-auto">
        {todos.map((x, i) => (
          <li key={i} className={`flex items-start gap-2 ${x.status === "completed" ? "text-faint line-through" : ""}`}>
            <span className="mt-0.5 w-3 shrink-0 text-center">
              {x.status === "completed" ? "✓" : x.status === "in_progress" ? <span className={`inline-block size-2 rounded-full bg-brand ${live ? "animate-pulse" : ""}`} /> : "○"}
            </span>
            <span className={x.status === "in_progress" ? "font-bold" : ""}>{x.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Terminal: la terminal cruda es lo que más se odia de estos paneles («cognitive overload»,
 * investigación de EasyBits 23-oct). Por default se ve la frase del paso y cómo salió; los
 * comandos con su salida quedan detrás de «Ver detalle técnico».
 */
function TerminalView(p: ViewProps) {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const { step, running } = p;
  if (raw) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <RawTerminal {...p} />
        </div>
        <button type="button" onClick={() => setRaw(false)} className="border-t border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink">
          {t("Ocultar detalle técnico")}
        </button>
      </div>
    );
  }
  const failed = step.status === "error" || (step.result?.exitCode ?? 0) !== 0;
  // De la salida sólo la última línea con letras: «3 passed», «Deployed to …».
  const gist = step.result?.summary?.split("\n").map((l) => l.trim()).filter((l) => /[\p{L}\p{N}]/u.test(l)).pop();
  return (
    <div className="grid h-full place-items-center overflow-auto p-6 text-center">
      <div className="min-w-0 max-w-md">
        <Terminal className={`mx-auto size-10 text-brand ${running ? "animate-pulse" : ""}`} />
        <p className="mt-3 text-sm font-bold text-ink">{step.intent ?? t(stepVerb(step))}</p>
        <p className={`mt-1 text-xs ${failed ? "text-red-500" : "text-muted"}`}>
          {running ? t("Trabajando…") : failed ? t("No salió bien") : t("Listo")}
          {!running && gist && <span className="text-muted"> · {gist.length > 140 ? gist.slice(0, 139) + "…" : gist}</span>}
        </p>
        <button type="button" onClick={() => setRaw(true)} className="mt-4 rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted hover:border-brand/50 hover:text-ink">
          {t("Ver detalle técnico")}
        </button>
      </div>
    </div>
  );
}

/** Los comandos del turno hasta el paso elegido, con su salida; el actual resaltado. */
function RawTerminal({ steps, idx, running }: ViewProps) {
  const t = useT();
  const lines = useMemo(() => steps.slice(0, idx + 1).map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "terminal"), [steps, idx]);
  const end = useRef<HTMLDivElement>(null);
  // Al último comando, sin mover la página entera (scrollIntoView arrastraba al documento).
  useEffect(() => {
    const box = end.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);
  return (
    <div className="h-full overflow-auto bg-[#0e1317] p-4 font-mono text-[12px] leading-5 text-gray-200">
      {lines.map(({ s, i }) => (
        <div key={s.id} className={`mb-2 ${i === idx ? "" : "opacity-60"}`}>
          <div className="break-all">
            <span className="text-[#85DDCB]">$ </span>
            {s.command || s.detail || toolName(s.tool)}
          </div>
          {s.result?.summary && (
            <pre className={`mt-1 whitespace-pre-wrap break-all text-gray-400 ${i === idx ? "max-h-80 overflow-auto" : "line-clamp-3"}`}>{s.result.summary}</pre>
          )}
          <div className={s.status === "error" || (s.result?.exitCode ?? 0) !== 0 ? "text-red-400" : "text-gray-500"}>
            {i === idx && running ? (
              <span className="animate-pulse">▍</span>
            ) : (s.result?.exitCode ?? 0) !== 0 ? (
              t("✗ salió con código {code}", { code: s.result!.exitCode! })
            ) : s.status === "error" ? (
              t("✗ terminó con error")
            ) : s.status === "running" ? (
              <span className="animate-pulse">▍</span>
            ) : (
              t("✓ listo")
            )}
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

/** Editor: los archivos que tocó el turno (lista plana) y el cambio del actual. */
function EditorView({ steps, idx }: ViewProps) {
  const t = useT();
  const cur = steps[idx];
  const files = useMemo(() => {
    const seen = new Map<string, AgentStep>();
    for (const s of steps.slice(0, idx + 1)) if (s.kind === "editor" && s.detail) seen.set(s.detail, s);
    return [...seen.values()];
  }, [steps, idx]);
  return (
    <div className="flex h-full">
      <div className="hidden w-40 shrink-0 overflow-auto border-r border-border bg-card py-2 text-xs sm:block">
        <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-faint">{t("Archivos")}</p>
        {files.map((s) => (
          <p key={s.detail} className={`truncate px-3 py-1 font-mono ${s.detail === cur.detail ? "bg-brand/15 font-bold text-ink" : "text-muted"}`}>
            {s.detail}
          </p>
        ))}
      </div>
      {cur.result?.diff ? (
        <div className="min-w-0 flex-1 overflow-auto bg-card font-mono text-[12px] leading-5">
          <p className="sticky top-0 border-b border-border bg-surface-2 px-3 py-1 font-bold text-ink">
            {cur.result.diff.file ?? cur.detail} <span className="font-normal text-muted">· {t(stepVerb(cur))}</span>
          </p>
          {cur.result.diff.removed.map((l, i) => (
            <div key={`r${i}`} className="whitespace-pre-wrap break-all bg-red-500/10 px-3 text-red-700 dark:text-red-300">
              <span className="select-none text-red-400">− </span>
              {l}
            </div>
          ))}
          {cur.result.diff.added.map((l, i) => (
            <div key={`a${i}`} className="whitespace-pre-wrap break-all bg-green-500/10 px-3 text-green-700 dark:text-green-300">
              <span className="select-none text-green-500">+ </span>
              {l}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center p-6 text-center">
          <div>
            <FileCode className="mx-auto size-10 text-brand" />
            <p className="mt-3 font-mono text-sm font-bold text-ink">{cur.detail ?? toolName(cur.tool)}</p>
            <p className="mt-1 text-xs text-muted">
              {t(stepVerb(cur))}
              {cur.result?.summary && ` · ${cur.result.summary}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Búsqueda: la consulta arriba y lo que encontró, como lista de resultados. */
function SearchView(p: ViewProps) {
  const t = useT();
  const items = p.step.result?.items;
  if (!items?.length) return <GenericView {...p} />;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-ink shadow-sm">
        <Search className="size-4 shrink-0 text-brand" />
        <span className="min-w-0 truncate font-bold">{p.step.detail ?? t(stepVerb(p.step))}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((it, i) => (
          <motion.li
            key={it.url ?? it.path ?? i}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="rounded-lg border border-border bg-card px-3 py-2"
          >
            {it.url ? (
              <a href={it.url} target="_blank" rel="noreferrer noopener" className="block min-w-0 hover:underline">
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <img src={`https://icons.duckduckgo.com/ip3/${hostOf(it.url)}.ico`} alt="" className="size-3.5" loading="lazy" />
                  {hostOf(it.url)}
                </span>
                <span className="mt-0.5 block truncate text-sm font-bold text-ink">{it.title}</span>
              </a>
            ) : (
              <span className="block truncate font-mono text-xs text-ink">{it.path}</span>
            )}
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function GenericView({ step, running }: ViewProps) {
  const t = useT();
  const Icon = ICON[step.kind];
  return (
    <div className="grid h-full place-items-center overflow-auto p-6 text-center">
      <div className="min-w-0 max-w-full">
        <Icon className={`mx-auto size-10 text-brand ${running ? "animate-pulse" : ""}`} />
        <p className="mt-3 text-sm font-bold text-ink">{t(stepVerb(step))}</p>
        {step.detail && <p className="mx-auto mt-1 max-w-xs break-words font-mono text-xs text-muted">{step.detail}</p>}
        {step.result?.summary && (
          <pre className="mx-auto mt-3 max-h-64 max-w-md overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 text-left font-mono text-[11px] text-ink">
            {step.result.summary}
          </pre>
        )}
      </div>
    </div>
  );
}

function EmptyComputer({ owner, live }: { owner: string; live: boolean }) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center bg-card p-6 text-center">
      <div>
        <Terminal className={`mx-auto size-10 text-brand ${live ? "animate-pulse" : ""}`} />
        <p className="mt-3 text-sm font-bold text-ink">{t("La computadora {owner}", { owner })}</p>
        <p className="mt-1 text-xs text-muted">{live ? t("En cuanto use una herramienta la verás aquí.") : t("Este turno no usó herramientas.")}</p>
      </div>
    </div>
  );
}
