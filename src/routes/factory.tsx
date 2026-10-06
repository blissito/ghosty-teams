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
import { createPortal } from "react-dom";
import { ArrowLeft, Check, ChevronDown, CircleDot, Factory, Plus, Trash2 } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import {
  factoryOverviewFn,
  factoryProposeSprintFn,
  factoryStartEvalFn,
  factoryStatusFn,
  factoryUptimeAddFn,
  factoryUptimeFn,
  factoryUptimeRemoveFn,
  type FactoryStatus,
} from "../server/apps/factory";
import { MODEL_ALIASES } from "../server/apps/factory-team";
import { formatUsd } from "../server/apps/factory-evals";
import { RepoReadiness } from "../components/RepoReadiness";
import { RepoTeam } from "../components/RepoTeam";
import { RolesEditor, SchedulesEditor, SuggestAsks } from "../components/AppsPanel";
import { AskAgentHint } from "../components/AskAgentHint";
import { Toggle } from "../components/Toggle";
import ConfirmModal from "../components/ConfirmModal";

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

/** Columnas del tablero, en orden: lo que espera a una persona arriba. Ver `viewState`. */
const COLUMNS = [
  { key: "waiting", label: "Espera a una persona" },
  { key: "ready", label: "Listo para merge" },
  { key: "planning", label: "Planeando" },
  { key: "building", label: "Construyendo" },
  { key: "checking", label: "En revisión" },
] as const;

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

// «🧪 Evaluar»: vuelve a correr un pedido mezclado con otro agente o modelo en @build. Sólo el
// dueño (gasta tokens de su llave). El juez califica en el hilo del eval y la tabla lo resume.
function EvalButton({ runId, agents, roleAgentIds, onStarted }: { runId: number; agents: FactoryStatus["candidates"]; roleAgentIds: Partial<Record<"plan" | "build" | "check", string | null>>; onStarted: () => void }) {
  const t = useT();
  // Posición fija (en pantalla) calculada del botón: la lista de pedidos recorta con overflow.
  const [open, setOpen] = useState<{ top: number; right: number } | null>(null);
  const [role, setRole] = useState<"plan" | "build" | "check">("build");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // Fijo en pantalla: al hacer scroll se cierra en vez de quedarse flotando lejos del botón.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("scroll", close, { once: true, capture: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [open]);
  // Sólo modelos del motor que va a correr (el elegido, o el del rol): uno de otro motor se rechaza.
  const engine = agents.find((a) => a.id === (agent || roleAgentIds[role]))?.engine ?? null;
  // Un renglón por MODELO (varios alias apuntan al mismo id): el más explícito, con versión.
  const models = [...new Map(Object.entries(engine ? (MODEL_ALIASES[engine] ?? {}) : {}).map(([a, id]) => [id, a] as const)).entries()].map(([id, a]) => [a, id] as const);
  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await factoryStartEvalFn({ data: { runId, role, agent: agent ? (agents.find((a) => a.id === agent)?.name ?? agent) : null, model: model || null } });
      setMsg(t("Eval #{n} en marcha: el resultado llega a su hilo.").replace("{n}", String(r.runId)));
      onStarted();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="relative z-10 shrink-0">
      <button
        type="button"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((o) => (o ? null : { top: r.bottom + 6, right: window.innerWidth - r.right }));
        }}
        title={t("Volver a correrlo con otro agente o modelo y calificarlo")} className="text-xs text-muted hover:text-ink">
        🧪
      </button>
      {open &&
        createPortal(
        <div style={{ top: open.top, right: open.right }} className="fixed z-50 w-64 rounded-lg border border-border bg-surface p-3 text-xs shadow-lg">
          <p className="font-semibold text-ink">{t("Evaluar otro agente o modelo")}</p>
          <label className="mt-2 block text-muted">
            {t("Rol")}
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value as "plan" | "build" | "check");
                setModel("");
              }}
              className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1 text-ink"
            >
              <option value="plan">{t("@plan · el plan del pedido")}</option>
              <option value="build">{t("@build · el código")}</option>
              <option value="check">{t("@check · la revisión")}</option>
            </select>
          </label>
          <label className="mt-2 block text-muted">
            {t("Agente")}
            <select value={agent} onChange={(e) => { setAgent(e.target.value); setModel(""); }} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1 text-ink">
              <option value="">{t("El del rol")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.engine}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-2 block text-muted">
            {t("Modelo")}
            <select value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface-2 px-2 py-1 text-ink">
              <option value="">{t("El del agente")}</option>
              {models.map(([alias, id]) => (
                <option key={alias} value={alias}>
                  {alias} ({id as string})
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || (!agent && !model)} onClick={run} className="mt-3 w-full rounded-md bg-brand px-2 py-1.5 font-semibold text-white disabled:opacity-50">
            {busy ? t("Arrancando…") : t("Correr eval")}
          </button>
          {msg && <p className="mt-2 text-muted">{msg}</p>}
        </div>,
          // En <body>: dentro de la fila, las ligas de las filas siguientes (z-10) lo tapaban.
          document.body,
        )}
    </span>
  );
}

// Qué significa cada número (tooltip).
const HINT: Record<string, string> = {
  "Se concretan": "Merged entre los pedidos ya cerrados (merged + cancelados).",
  "Correcciones de @check": "Cuántas veces, en promedio, @check le regresó el PR a @build para corregir algo antes de aprobarlo.",
  "Pasan a la primera": "De los PRs que ya revisó una persona, cuántos aprobó sin pedir cambios (o hizo merge directo). Es la métrica que importa: un PR que regresa cuesta más que uno que tarda.",
  "Tiempo de revisión": "Mediana desde que @check deja el PR listo hasta la primera revisión humana (o el merge).",
  "Del pedido al PR": "Mediana del tiempo desde que se pide hasta que @check deja el PR listo para tu revisión.",
};

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

type UptimeRow = Awaited<ReturnType<typeof factoryUptimeFn>>[number];

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
};

// «Producción»: las URLs que el room vigila cada 60 s (uptime propio, sin terceros). Lo mismo
// que las tools `uptime_*`: si se cae, 🔴 en el room y @plan investiga; al volver, 🟢.
function ProductionSection({ channelId }: { channelId: number }) {
  const t = useT();
  const locale = useLocale();
  const [rows, setRows] = useState<UptimeRow[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState<UptimeRow | null>(null);
  useEffect(() => {
    setRows(null);
    const load = () => factoryUptimeFn({ data: { channelId } }).then(setRows).catch(() => setRows([]));
    void load();
    // Se refresca solo: el chequeo corre cada minuto en el servidor.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [channelId]);
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      setRows(await factoryUptimeAddFn({ data: { channelId, url } }));
      setUrl("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const since = (ts: number) => new Date(ts * 1000).toLocaleString(intlLocale(locale), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-ink">{t("Producción")}</h2>
      <p className="text-[11px] text-muted">{t("URLs que este room vigila cada minuto. Si una se cae, se avisa aquí y @plan investiga.")}</p>
      <div className="mt-2 overflow-hidden rounded-xl border border-border bg-surface-2">
        {rows === null && <div className="h-10 animate-pulse bg-surface-2 motion-reduce:animate-none" />}
        {rows && rows.length === 0 && <p className="px-3 py-2.5 text-xs text-muted">{t("Todavía no vigila ninguna URL.")}</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const pending = r.lastCheckAt == null;
              return (
                <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${pending ? "bg-muted" : r.state === "down" ? "bg-red-500" : "bg-emerald-500"}`}
                    aria-label={pending ? t("Sin revisar") : r.state === "down" ? t("Caída") : t("Arriba")}
                  />
                  <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-ink hover:underline">
                    {hostOf(r.url)}
                  </a>
                  <span className="shrink-0 text-muted">
                    {pending
                      ? t("Sin revisar")
                      : [r.lastStatus != null ? `HTTP ${r.lastStatus}` : t("sin respuesta"), r.lastMs != null ? `${r.lastMs} ms` : null].filter(Boolean).join(" · ")}
                  </span>
                  {r.state === "down" && r.downSince != null && (
                    <span className="shrink-0 text-red-600 dark:text-red-400">{t("caída desde {d}").replace("{d}", since(r.downSince))}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setRemoving(r)}
                    aria-label={t("Dejar de vigilar")}
                    title={t("Dejar de vigilar")}
                    className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="flex items-center gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("https://tu-sitio.com/ruta")}
            aria-label={t("URL a vigilar")}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink"
          />
          <button
            type="submit"
            disabled={!url.trim() || busy || (rows?.length ?? 0) >= 10}
            aria-label={t("Vigilar")}
            title={t("Vigilar")}
            className="shrink-0 rounded-md bg-brand p-1.5 text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </form>
        {err && <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
      {removing && (
        <ConfirmModal
          title={t("¿Dejar de vigilar esta URL?")}
          body={t("Ya no se revisará ni se avisará si se cae. Puedes volver a agregarla cuando quieras.")}
          confirmLabel={t("Dejar de vigilar")}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            setRows(await factoryUptimeRemoveFn({ data: { channelId, id: removing.id } }));
            setRemoving(null);
          }}
        />
      )}
    </section>
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
  const [onlyMine, setOnlyMine] = useState(false);

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
    () =>
      (data?.runs ?? [])
        .filter((r) => ["done", "cancelled"].includes(r.status) === (filter === "closed"))
        .filter((r) => filter === "closed" || !onlyMine || r.turnSub === data?.meSub),
    [data, filter, onlyMine],
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
              t("@plan planea, @build construye, @check revisa. Tú firmas y haces merge.")
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
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {/* Sólo lo que ya tiene datos: un «—» es una métrica que no mide nada. */}
              {(
                [
                  [t("Pedidos"), String(data.stats.total)],
                  [t("Pasan a la primera"), data.stats.firstPassRate == null ? null : `${Math.round(data.stats.firstPassRate * 100)}%`],
                  [t("Tiempo de revisión"), data.stats.medianReviewSeconds == null ? null : duration(data.stats.medianReviewSeconds)],
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
            {filter === "open" && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="text-xs text-muted">{t("Me toca")}</span>
                <Toggle on={onlyMine} onChange={setOnlyMine} label={t("Me toca")} />
              </div>
            )}
            {runs.length === 0 && <p className="px-3 py-4 text-sm text-muted">{filter === "open" ? t("Nadie está trabajando en un pedido ahora.") : t("Todavía no hay pedidos cerrados.")}</p>}
            {/* Abiertos: agrupados por columna (la vista de lista agrupada de Linear). La columna
                la calcula el servidor; lo que espera a una persona va primero. */}
            {(filter === "open" ? COLUMNS.map((c) => ({ ...c, rows: runs.filter((r) => r.column === c.key) })).filter((g) => g.rows.length) : [{ key: "closed", label: "", rows: runs }]).map((g) => (
              <div key={g.key}>
                {g.label && (
                  <h3 className="border-b border-border bg-surface-2/60 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-muted">
                    {t(g.label)} · {g.rows.length}
                  </h3>
                )}
                <ul className="divide-y divide-border">
                  {g.rows.map((r) => (
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
                    {t(r.label ?? STAGE[r.status] ?? r.status)}
                  </span>
                  {r.prUrl && (
                    <a href={r.prUrl} target="_blank" rel="noreferrer" className="relative z-10 shrink-0 text-xs text-muted hover:text-ink">
                      PR ↗
                    </a>
                  )}
                  {owner && r.status === "done" && r.prUrl && <EvalButton runId={r.id} agents={owner.candidates} roleAgentIds={Object.fromEntries(owner.roles.map((x) => [x.handle, x.agentId]))} onStarted={() => void load()} />}
                  <span className="shrink-0 text-xs font-semibold text-brand group-hover:underline">{t("Hilo")} →</span>
                </li>
                  ))}
                </ul>
              </div>
            ))}
            </div>
          </section>

          {/* Evals: el mismo pedido con otro @build, calificado por el juez contra el PR real. */}
          {data.evals.length > 0 && (
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-ink">{t("Evals")}</h2>
              <p className="mt-0.5 text-[11px] text-muted">{t("Se vuelve a correr un rol de un pedido con merge; el juez califica del 1 al 5 contra lo que se hizo de verdad. Costo y tiempo: la mediana del rol evaluado.")}</p>
              <div className="mt-2 overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2 text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("Rol y agente")}</th>
                      <th className="px-3 py-2 font-medium">{t("Calificación")}</th>
                      <th className="px-3 py-2 font-medium">{t("Contra el original")}</th>
                      <th className="px-3 py-2 font-medium">{t("Tiempo")}</th>
                      <th className="px-3 py-2 font-medium">{t("Costo")}</th>
                      <th className="px-3 py-2 font-medium">{t("Juez")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.evals.map((e) => (
                      <tr key={e.label}>
                        <td className="px-3 py-2 font-mono text-ink">{e.label}</td>
                        <td className="px-3 py-2 tabular-nums text-ink">
                          {e.avg == null ? t("calificando…") : `${e.avg}/5`}
                          <span className="ml-1 text-muted">({e.scored}/{e.runs})</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted">
                          <span className="text-emerald-600">↑{e.better}</span> ={e.same} <span className="text-red-500">↓{e.worse}</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted">{duration(e.medianSeconds)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">{e.medianCostUsd == null ? "—" : formatUsd(e.medianCostUsd)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">{e.medianJudgeCostUsd == null ? "—" : formatUsd(e.medianJudgeCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

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

          {/* Producción: el uptime del room. */}
          {data.room && <ProductionSection key={data.room.id} channelId={data.room.id} />}

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
