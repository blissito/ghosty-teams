// «Fábrica»: la Software Factory del espacio en un solo lugar (antes, en Ajustes → Apps).
//  - Pedidos: los números del espacio (cuántos se concretan, vueltas, tiempo al PR) y la
//    lista con liga al hilo y al PR. Hoy se MIDE; con esto se fijarán los límites por plan.
//  - Rooms: todo room con repos es una fábrica; la página trabaja uno a la vez (`?room=`, y
//    sin él el de la instalación). Tablero, sprints, pedidos y repos son de ése.
//  - Repos: «Listo para agentes» de cada repo del room (preparar, proteger, variables de la
//    preview) y su equipo (`.ghosty/factory.md`). `?repo=` abre las Variables de ése.
//  - Equipo del espacio y Automático: sólo el dueño (el equipo por defecto y tareas programadas).
// Misma forma que /forms: el loader sólo resuelve auth; los datos llegan por server fns.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, CircleDot, Factory } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { factoryEnsureBoardFn, factoryOverviewFn, factoryProposeSprintFn, factoryStatusFn, type FactoryStatus } from "../server/apps/factory";
import { RepoReadiness } from "../components/RepoReadiness";
import { RepoTeam } from "../components/RepoTeam";
import { RolesEditor, SchedulesEditor, SuggestAsks } from "../components/AppsPanel";
import { AskAgentHint } from "../components/AskAgentHint";

type Overview = Awaited<ReturnType<typeof factoryOverviewFn>>;
// Por room: cambiar de room y volver pinta al instante lo último que se vio.
const cache = new Map<number | "default", Overview>();

export const Route = createFileRoute("/factory")({
  validateSearch: (s: Record<string, unknown>) => ({
    repo: typeof s.repo === "string" ? s.repo : undefined,
    room: Number(s.room) > 0 ? Number(s.room) : undefined,
  }),
  loader: async () => ({ user: await me() }),
  component: FactoryPage,
});

const STAGE: Record<string, string> = {
  planning: "Plan",
  plan_review: "Esperando aprobación",
  building: "Build",
  checking: "Check",
  pr_review: "PR",
  escalated: "Necesita decisión",
  done: "Merged",
  cancelled: "Cancelado",
};

function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

// Qué significa cada número (tooltip).
const HINT: Record<string, string> = {
  "Se concretan": "Merged entre los pedidos ya cerrados (merged + cancelados).",
  "Correcciones de @check": "Cuántas veces, en promedio, @check le regresó el PR a @build para corregir algo antes de aprobarlo.",
  "Del pedido al PR": "Mediana del tiempo desde que se pide hasta que @check deja el PR listo para tu revisión.",
};

function MissingBoard({ roomId, onDone }: { roomId: number | null; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <span className="min-w-0 flex-1">{t("Este room no tiene tablero en Tasks: sus pedidos no pueden crear tareas.")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await factoryEnsureBoardFn({ data: { roomId } });
            onDone();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-md border border-current px-2 py-1 font-semibold disabled:opacity-50"
      >
        {busy ? t("Creando…") : t("Crear tablero")}
      </button>
      {err && <span className="w-full text-red-600 dark:text-red-400">{err}</span>}
    </div>
  );
}

/** «¿Qué quieres lograr?» → @plan propone el sprint como borrador en el room de la fábrica. */
function NewSprint({ roomId, roomSlug, repos }: { roomId: number | null; roomSlug: string | null; repos: string[] }) {
  const t = useT();
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [err, setErr] = useState("");
  const send = async () => {
    setState("busy");
    setErr("");
    try {
      await factoryProposeSprintFn({ data: { goal, ...(repo ? { repo } : {}), ...(roomId ? { roomId } : {}) } });
      setState("sent");
      setGoal("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };
  return (
    <section className="mt-6 rounded-xl border border-border bg-surface-2 p-3">
      <label htmlFor="sprint-goal" className="text-sm font-semibold text-ink">
        {t("¿Qué quieres lograr?")}
      </label>
      <p className="text-[11px] text-muted">{t("@plan lo parte en un sprint de 3 a 8 tickets en orden. Lo revisas y lo apruebas una sola vez.")}</p>
      <textarea
        id="sprint-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
        placeholder={t("Ej.: que los clientes puedan exportar sus citas a CSV")}
        className="mt-2 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {repos.length > 1 && (
          <select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label={t("Repo")} className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink">
            {repos.map((r) => (
              <option key={r} value={r}>
                {r.split("/")[1] ?? r}
              </option>
            ))}
          </select>
        )}
        <span className="min-w-0 flex-1 text-xs text-muted">
          {state === "sent" && roomSlug ? (
            <>
              {t("@plan está armando el sprint; llega a")} <a href={`/c/${roomSlug}`} className="text-brand hover:underline">#{roomSlug}</a>
            </>
          ) : null}
          {err && <span className="text-red-600 dark:text-red-400">{err}</span>}
        </span>
        <button
          type="button"
          disabled={goal.trim().length < 8 || state === "busy"}
          onClick={() => void send()}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {state === "busy" ? t("Enviando…") : t("Proponer sprint")}
        </button>
      </div>
    </section>
  );
}

function RepoRow({ repo, channelId, initiallyOpen, focus }: { repo: string; channelId: number; initiallyOpen: boolean; focus: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [level, setLevel] = useState<number | null>(null);
  return (
    <div id={`repo-${repo}`} className="rounded-xl border border-border bg-surface-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{repo}</span>
        {level != null && (
          <span className={`h-2 w-2 shrink-0 rounded-full ${level >= 3 ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
        )}
        {level != null && <span className="shrink-0 text-[11px] text-muted">{level}/3</span>}
        <span className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {/* Montado siempre (así el renglón contraído sabe su nivel); sólo se oculta. */}
      <div className={open ? "border-t border-border p-3" : "hidden"}>
        <RepoReadiness channelId={channelId} repo={repo} autoOpenEnv={focus} onLevel={setLevel} />
        {/* El equipo se pide al abrir: lee un archivo de GitHub y no hace falta contraído. */}
        {open && <RepoTeam channelId={channelId} repo={repo} />}
      </div>
    </div>
  );
}

type RoomOption = Overview["rooms"][number];

/** «Trabaja en #room ▾»: cada room con repos es una fábrica; aquí se elige cuál se ve. */
function RoomSwitcher({ rooms, current, onPick }: { rooms: RoomOption[]; current: RoomOption; onPick: (id: number) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (rooms.length < 2) {
    return (
      <a href={`/c/${current.slug}`} className="text-brand hover:underline">
        #{current.slug}
      </a>
    );
  }
  return (
    <span ref={box} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 font-medium text-ink hover:border-brand"
      >
        #{current.slug}
        <ChevronDown size={13} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("Rooms de la fábrica")}
          className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          {rooms.map((r) => (
            <li key={r.id} role="option" aria-selected={r.id === current.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (r.id !== current.id) onPick(r.id);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 ${r.id === current.id ? "font-semibold text-ink" : "text-ink"}`}
              >
                <span className="min-w-0 flex-1 truncate">#{r.slug}</span>
                {r.isDefault && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">{t("principal")}</span>}
                <span className="shrink-0 text-[11px] text-muted">
                  {r.repos} {r.repos === 1 ? t("repo") : t("repos")}
                </span>
                {r.id === current.id && <Check size={14} className="shrink-0 text-brand" />}
              </button>
            </li>
          ))}
          <li className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted">
            {t("Todo room con un repo conectado trabaja como fábrica. Conecta uno desde el ícono de GitHub del room.")}
          </li>
        </ul>
      )}
    </span>
  );
}

function FactoryPage() {
  const t = useT();
  const locale = useLocale();
  const { repo: focusRepo, room: roomParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [data, setData] = useState<Overview | null>(cache.get(roomParam ?? "default") ?? null);
  const [owner, setOwner] = useState<FactoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "closed">("open");

  const load = () =>
    factoryOverviewFn({ data: roomParam ? { roomId: roomParam } : {} })
      .then((d) => {
        cache.set(roomParam ?? "default", d);
        setData(d);
        if (d.isOwner) factoryStatusFn().then(setOwner).catch(() => {});
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    const hit = cache.get(roomParam ?? "default");
    if (hit) setData(hit);
    void load();
  }, [roomParam]);
  const currentRoom = data?.room ? (data.rooms.find((r) => r.id === data.room!.id) ?? { ...data.room, repos: data.repos.length, isDefault: false }) : null;

  const runs = useMemo(
    () => (data?.runs ?? []).filter((r) => ["done", "cancelled"].includes(r.status) === (filter === "closed")),
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
            {data?.room && currentRoom ? (
              <>
                {t("Trabaja en")}{" "}
                <RoomSwitcher rooms={data.rooms} current={currentRoom} onPick={(id) => void navigate({ search: { room: id, repo: undefined } })} />
              </>
            ) : (
              t("@plan planea, @build construye, @check revisa. Tú firmas y mezclas.")
            )}{" "}
            <AskAgentHint roomSlug={data?.room?.slug ?? null} handle="plan" question={t("¿cómo funciona la Fábrica Agéntica y cómo te pido algo?")} label={t("¿Cómo funciona?")} />
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
          {/* Sin tablero en Tasks los pedidos no tienen tarea: se dice y se arregla aquí. */}
          {!data.board && data.isOwner && data.room && <MissingBoard roomId={data.room.id} onDone={() => void load()} />}
          {data.board?.url && (
            <p className="mt-2 text-xs text-muted">
              {t("Tablero")}:{" "}
              <a href={data.board.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                {data.board.name} ↗
              </a>
            </p>
          )}

          {/* Sprint: el objetivo entra aquí; @plan lo parte en tickets (borrador en el room). */}
          <NewSprint key={data.room?.id ?? 0} roomId={data.room?.id ?? null} roomSlug={data.room?.slug ?? null} repos={data.repos} />
          {data.sprints.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold text-ink">{t("Sprints")}</h2>
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
                {data.sprints.map((sp) => (
                  <li key={sp.id} className={`group relative flex items-center gap-3 px-3 py-2.5 ${sp.status === "done" ? "bg-violet-600/10" : "hover:bg-surface-2"}`}>
                    <span className="shrink-0">🧩</span>
                    <div className="min-w-0 flex-1">
                      <a href={sp.url ?? "#"} className="block truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-['']">
                        {sp.title}
                      </a>
                      <p className="truncate text-[11px] text-muted">
                        {sp.repo ?? "—"} · {sp.merged}/{sp.total} {t("con merge")}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${sp.status === "draft" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : sp.status === "done" ? "bg-violet-600/15 text-violet-700 dark:text-violet-300" : "bg-brand/12 text-brand"}`}>
                      {sp.status === "draft" ? t("Borrador") : sp.status === "done" ? t("Terminado") : t("En curso")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Pedidos: números y lista. */}
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-ink">{t("Pedidos")}</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {/* Sólo lo que ya tiene datos: un «—» es una métrica que no mide nada. */}
              {(
                [
                  [t("Pedidos"), String(data.stats.total)],
                  [t("Se concretan"), data.stats.successRate == null ? null : `${Math.round(data.stats.successRate * 100)}%`],
                  [t("Correcciones de @check"), data.stats.avgLoops == null ? null : data.stats.avgLoops.toFixed(1)],
                  [t("Del pedido al PR"), data.stats.medianToPrSeconds == null ? null : duration(data.stats.medianToPrSeconds)],
                ].filter(([, v]) => v != null) as [string, string][]
              ).map(([k, v]) => (
                <div key={k} title={HINT[k] ? t(HINT[k]) : undefined} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                  <p className="text-[11px] text-muted">{k}</p>
                  <p className="text-lg font-semibold tabular-nums text-ink">{v}</p>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              {t("{a} merged · {b} cancelados · {c} abiertos · {d} necesitan decisión")
                .replace("{a}", String(data.stats.merged))
                .replace("{b}", String(data.stats.cancelled))
                .replace("{c}", String(data.stats.open))
                .replace("{d}", String(data.stats.escalated))}
            </p>

            {/* Como la lista de issues/PRs de GitHub: «N Pendientes · N Cerrados» en la cabecera. */}
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <div className="flex gap-4 border-b border-border bg-surface-2 px-3 py-2" role="tablist">
                {(["open", "closed"] as const).map((f) => {
                  const n = (data.runs ?? []).filter((r) => ["done", "cancelled"].includes(r.status) === (f === "closed")).length;
                  const Icon = f === "open" ? CircleDot : Check;
                  return (
                    <button
                      key={f}
                      type="button"
                      role="tab"
                      aria-selected={filter === f}
                      onClick={() => setFilter(f)}
                      className={`inline-flex items-center gap-1.5 text-sm ${filter === f ? "font-semibold text-ink" : "text-muted hover:text-ink"}`}
                    >
                      <Icon size={15} className="shrink-0" />
                      {n} {f === "open" ? t("Pendientes") : t("Cerrados")}
                    </button>
                  );
                })}
              </div>
            <ul className="divide-y divide-border">
              {runs.length === 0 && <li className="px-3 py-4 text-sm text-muted">{filter === "open" ? t("Nadie está trabajando en un pedido ahora.") : t("Todavía no hay pedidos cerrados.")}</li>}
              {runs.map((r) => (
                <li
                  key={r.id}
                  className={`group relative flex items-center gap-3 px-3 py-2.5 ${
                    r.status === "done" ? "bg-violet-600/10 hover:bg-violet-600/15" : "hover:bg-surface-2"
                  }`}
                >
                  <span className="w-10 shrink-0 font-mono text-xs text-muted">#{r.id}</span>
                  <div className="min-w-0 flex-1">
                    {/* Toda la fila abre el hilo del pedido (la liga se estira sobre la fila). */}
                    <a href={r.threadUrl ?? "#"} className="block truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-['']">
                      {r.title}
                    </a>
                    <p className="truncate text-[11px] text-muted">
                      {r.repo ?? "—"} · {fmt(r.createdAt)}
                      {r.loops ? ` · ${r.loops} ${r.loops === 1 ? t("corrección") : t("correcciones")}` : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      r.status === "done"
                        ? "bg-violet-600/15 text-violet-700 dark:text-violet-300"
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
                    <a href={r.prUrl} target="_blank" rel="noreferrer" className="relative z-10 shrink-0 text-xs text-muted hover:text-ink">
                      PR ↗
                    </a>
                  )}
                  {r.taskUrl && (
                    <a href={r.taskUrl} target="_blank" rel="noreferrer" className="relative z-10 shrink-0 text-xs text-muted hover:text-ink">
                      {t("Tarea")} ↗
                    </a>
                  )}
                  <span className="shrink-0 text-xs font-semibold text-brand group-hover:underline">{t("Hilo")} →</span>
                </li>
              ))}
            </ul>
            </div>
          </section>

          {/* Repos del room: su «Listo para agentes» y su equipo. */}
          {data.room && data.repos.length > 0 && (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink">{t("Repos")}</h2>
              <div className="mt-2 space-y-2">
                {data.repos.map((repo) => (
                  <RepoRow
                    key={repo}
                    repo={repo}
                    channelId={data.room!.id}
                    // Con uno solo (o si llegas desde una liga a ése) se ve abierto; con varios, contraídos.
                    initiallyOpen={data.repos.length === 1 || focusRepo === repo}
                    focus={focusRepo === repo}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Lo del dueño. */}
          {owner && (
            <>
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-ink">{t("Equipo del espacio")}</h2>
                <p className="text-[11px] text-muted">{t("Lo usan todos los repos, salvo lo que cambie el .ghosty/factory.md de cada uno.")}</p>
                <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3 text-sm">
                  <RolesEditor status={owner} onChange={() => void load()} />
                </div>
              </section>
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-ink">{t("Automático")}</h2>
                <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3 text-sm">
                  <SuggestAsks key={data.room?.id ?? 0} roomSlug={data.room?.slug ?? null} roomId={data.room?.id ?? null} repos={data.repos} />
                  <SchedulesEditor roomSlug={data.room?.slug ?? null} />
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
