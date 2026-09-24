// Ajustes → Apps: lo que se INSTALA en el espacio. La primera es la Software Factory
// (server/apps/factory.ts). Instalar pide dónde vive (room), sobre qué repo trabaja y qué
// agente de Studio hace cada rol — la fábrica no crea agentes: motor y modelo se afinan en
// /app/agents, como siempre.
import { useEffect, useState } from "react";
import { Factory, Loader2, ExternalLink } from "lucide-react";
import { useT } from "../i18n";
import { createFactoryAgentFn, factorySchedulesFn, factorySuggestFn, setFactoryScheduleFn, factoryStatusFn, installFactoryFn, setFactoryRolesFn, uninstallFactoryFn, type FactoryStatus } from "../server/apps/factory";
import { githubInstallationReposFn } from "../server/room-repos";
import { listChannelsFn } from "../server/chat";
import ConfirmModal from "./ConfirmModal";
import { Toggle } from "./Toggle";

type Repos = Awaited<ReturnType<typeof githubInstallationReposFn>>;
type Room = { id: number; name: string; slug: string };

export function AppsPanel() {
  const t = useT();
  const [status, setStatus] = useState<FactoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    factoryStatusFn()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);

  if (error) return <div className="text-sm text-danger">{error}</div>;
  if (!status) return <div className="text-sm text-muted">{t("Cargando…")}</div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t("Apps que se instalan en este espacio. Sólo el dueño las instala o las quita.")}</p>
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
            <Factory className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-ink">Software Factory</h3>
              <span className="rounded-md bg-brand/12 px-1.5 text-[10px] font-semibold uppercase text-brand">beta</span>
              {status.installed && (
                <span className="rounded-md bg-emerald-600/12 px-1.5 text-[10px] font-semibold uppercase text-emerald-600">
                  {t("Instalada")}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {t("Tres roles que asignas a tus agentes de Studio: @plan escribe el plan y te pide firma, @build construye y abre el PR, @check lo revisa y nunca edita.")}
            </p>
            <a
              href="https://factory.ghosty.studio"
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              {t("Cómo funciona")} <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
        <div className="mt-4 border-t border-border pt-4">
          {status.installed ? <Installed status={status} onChange={load} /> : <Installer status={status} onDone={load} />}
        </div>
      </div>
    </div>
  );
}

function Installed({ status, onChange }: { status: FactoryStatus; onChange: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-ink">
        {t("Room")}: <b>#{status.room?.slug ?? "—"}</b> · {t("Repos")}: {status.repos.length ? status.repos.join(", ") : "—"}
      </p>
      <RolesEditor status={status} onChange={onChange} />
      <SuggestAsks roomSlug={status.room?.slug ?? null} />
      <SchedulesEditor />
      <div className="flex gap-2 pt-1">
        {status.room && (
          <a href={`/c/${status.room.slug}`} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
            {t("Ir al room")}
          </a>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirm(true)}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-danger"
        >
          {t("Desinstalar")}
        </button>
      </div>
      {confirm && (
        <ConfirmModal
          title={t("¿Desinstalar la Software Factory?")}
          body={t("Los handles @plan, @build y @check dejan de contestar y sus tools desaparecen. El room, el tablero y los pedidos se conservan; puedes volver a instalarla.")}
          confirmLabel={t("Desinstalar")}
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setBusy(true);
            await uninstallFactoryFn().catch(() => {});
            setBusy(false);
            setConfirm(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function Installer({ status, onDone }: { status: FactoryStatus; onDone: () => void }) {
  const t = useT();
  const [roles, setRoles] = useState<Record<string, string>>(() => defaultRoles(status));
  const [rooms, setRooms] = useState<Room[]>([]);
  const [repos, setRepos] = useState<Repos | null>(null);
  const [roomId, setRoomId] = useState<number>(0);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listChannelsFn()
      .then((cs) => setRooms(cs.map((c) => ({ id: c.id, name: c.name, slug: c.slug }))))
      .catch(() => {});
    githubInstallationReposFn()
      .then(setRepos)
      .catch(() => setRepos({ repos: [], installUrl: null, connected: false } as unknown as Repos));
  }, []);

  const noRepos = repos && repos.repos.length === 0;
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs font-semibold text-muted">1. {t("Room donde vive la fábrica")}</span>
        <select
          value={roomId}
          onChange={(e) => setRoomId(Number(e.target.value))}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ink"
        >
          <option value={0}>{t("Crear #fabrica")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-semibold text-muted">2. {t("Repositorio de GitHub")}</span>
        {repos === null ? (
          <div className="mt-1 flex items-center gap-2 text-muted">
            <Loader2 className="size-4 animate-spin" /> {t("Buscando tus repos…")}
          </div>
        ) : noRepos ? (
          <p className="mt-1 text-muted">
            {t("No encontramos repos de tu GitHub.")}{" "}
            {repos.installUrl ? (
              <a href={repos.installUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                {t("Conecta o elige repos en GitHub")}
              </a>
            ) : (
              t("Conecta GitHub en Integraciones.")
            )}
          </p>
        ) : (
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ink"
          >
            <option value="">{t("Elige un repo")}</option>
            {repos.repos.map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo}
              </option>
            ))}
          </select>
        )}
      </label>
      <div>
        <span className="text-xs font-semibold text-muted">3. {t("Qué agente hace cada rol")}</span>
        <RolePickers status={status} value={roles} onChange={setRoles} />
      </div>
      {error && <p className="text-danger">{error}</p>}
      <button
        type="button"
        disabled={busy || !repo || HANDLES_UI.some((h) => !roles[h])}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await installFactoryFn({ data: { roomId: roomId || null, repo, roles } });
            onDone();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {busy ? t("Instalando…") : t("Instalar")}
      </button>
    </div>
  );
}

// Los roles: cada handle apunta a un agente de Studio. Se rotula con su motor y modelo reales
// (los que dice Studio) y enlaza a su página para afinarlos; la fábrica no guarda modelos.
const HANDLES_UI = ["plan", "build", "check"] as const;
const ROLE_LABEL: Record<string, string> = { plan: "Planea", build: "Construye", check: "Revisa" };

const ENGINE_LABEL: Record<string, string> = { claude: "Claude", deepseek: "DeepSeek", codex: "Codex" };

/** «Blue · DeepSeek · deepseek-v4-flash»: el mismo rótulo que las tarjetas de /app/agents. */
function agentLabel(a: FactoryStatus["candidates"][number]): string {
  return `${a.name} · ${ENGINE_LABEL[a.engine] ?? a.engine} · ${a.model}`;
}

/** Defaults sugeridos: plan y build en el primer Claude; check en otro motor si hay. */
function defaultRoles(status: FactoryStatus): Record<string, string> {
  const c = status.candidates;
  const claude = c.find((a) => a.engine === "claude") ?? c[0];
  const other = c.find((a) => a.engine !== (claude?.engine ?? "")) ?? claude;
  return { plan: claude?.id ?? "", build: claude?.id ?? "", check: other?.id ?? "" };
}

function RolePickers({
  status,
  value,
  onChange,
}: {
  status: FactoryStatus;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const t = useT();
  if (!status.candidates.length) {
    return (
      <div className="mt-1">
        <p className="mb-2 text-muted">{t("Todavía no hay agentes con Claude, DeepSeek o Codex: crea uno para cada rol aquí mismo.")}</p>
        <RolePickersList status={status} value={value} onChange={onChange} />
      </div>
    );
  }
  return <RolePickersList status={status} value={value} onChange={onChange} />;
}

const NEW_AGENT = "__new__";
const DEFAULT_NAME: Record<string, string> = { plan: "Planeador", build: "Constructor", check: "Revisor" };

/**
 * Crear un agente para un rol SIN salir de aquí: nombre + motor. Nace como agente normal de
 * Studio (se afina en /app/agents) y queda elegido para el rol. @check sugiere otro motor.
 */
function NewAgentForm({
  handle,
  onCancel,
  onCreated,
}: {
  handle: string;
  onCancel: () => void;
  onCreated: (a: FactoryStatus["candidates"][number]) => void;
}) {
  const t = useT();
  const [name, setName] = useState(DEFAULT_NAME[handle] ?? "");
  const [engine, setEngine] = useState(handle === "check" ? "deepseek" : "claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 flex w-full flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("Nombre del agente")}
        className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-ink"
        autoFocus
      />
      <select value={engine} onChange={(e) => setEngine(e.target.value)} className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-ink">
        <option value="claude">Claude</option>
        <option value="deepseek">DeepSeek</option>
        <option value="codex">Codex</option>
      </select>
      <button
        type="button"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onCreated(await createFactoryAgentFn({ data: { name, engine } }));
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy && <Loader2 className="size-3 animate-spin" />}
        {busy ? t("Creando…") : t("Crear")}
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-ink">
        {t("Cancelar")}
      </button>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  );
}

function RolePickersList({
  status,
  value,
  onChange,
}: {
  status: FactoryStatus;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const t = useT();
  // Los que se crean aquí mismo se suman a la lista sin recargar el panel.
  const [created, setCreated] = useState<FactoryStatus["candidates"]>([]);
  const candidates = [...status.candidates, ...created.filter((c) => !status.candidates.some((x) => x.id === c.id))];
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  status = { ...status, candidates };
  const engines = new Set(HANDLES_UI.map((h) => status.candidates.find((a) => a.id === value[h])?.engine));
  const checkEngine = status.candidates.find((a) => a.id === value.check)?.engine;
  const buildEngine = status.candidates.find((a) => a.id === value.build)?.engine;
  return (
    <div className="mt-1 space-y-2">
      <div className="divide-y divide-border rounded-lg border border-border bg-surface">
        {HANDLES_UI.map((h) => (
          <div key={h} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="w-16 font-mono text-sm font-semibold text-ink">@{h}</span>
            <span className="w-20 text-xs text-muted">{t(ROLE_LABEL[h])}</span>
            <select
              value={value[h] ?? ""}
              onChange={(e) => {
                if (e.target.value === NEW_AGENT) setCreatingFor(h);
                else onChange({ ...value, [h]: e.target.value });
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-ink"
            >
              <option value="">{t("Elige un agente")}</option>
              {status.candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a)}
                </option>
              ))}
              <option value={NEW_AGENT}>{t("+ Crear agente nuevo…")}</option>
            </select>
            {value[h] && (
              <a
                href={`${status.studioAgentsUrl}/${value[h]}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                {t("Afinar en Studio")} <ExternalLink className="size-3" />
              </a>
            )}
            {creatingFor === h && (
              <NewAgentForm
                handle={h}
                onCancel={() => setCreatingFor(null)}
                onCreated={(a) => {
                  setCreated((prev) => [...prev, a]);
                  onChange({ ...value, [h]: a.id });
                  setCreatingFor(null);
                }}
              />
            )}
          </div>
        ))}
      </div>
      {engines.size === 1 || checkEngine === buildEngine ? (
        <p className="text-xs text-muted">{t("Consejo: @check con un agente de otro motor revisa mejor; el mismo modelo comparte los puntos ciegos de quien construyó.")}</p>
      ) : null}
    </div>
  );
}

function RolesEditor({ status, onChange }: { status: FactoryStatus; onChange: () => void }) {
  const t = useT();
  const current = Object.fromEntries(status.roles.map((r) => [r.handle, r.agentId ?? ""]));
  const [draft, setDraft] = useState<Record<string, string>>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = HANDLES_UI.some((h) => draft[h] !== current[h]);
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs font-semibold text-muted">{t("Qué agente hace cada rol")}</p>
      <RolePickers status={status} value={draft} onChange={setDraft} />
      {error && <p className="text-xs text-danger">{error}</p>}
      {dirty && (
        <button
          type="button"
          disabled={busy || HANDLES_UI.some((h) => !draft[h])}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await setFactoryRolesFn({ data: { roles: draft } });
              onChange();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {busy ? t("Aplicando…") : t("Guardar roles")}
        </button>
      )}
    </div>
  );
}

// «Sugerir pedidos»: @plan lee el repo y deja en el room una tarjeta con pedidos listos para
// mandar (un botón «Pedir» cada uno). Es el arranque cuando nadie sabe qué pedir primero.
function SuggestAsks({ roomSlug }: { roomSlug: string | null }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const run = async () => {
    setState("busy");
    try {
      await factorySuggestFn();
      setState("sent");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <span className="min-w-0 flex-1 text-xs text-muted">
        {state === "sent"
          ? `${t("@plan está leyendo el repo; las sugerencias llegan a")} #${roomSlug ?? "—"}.`
          : state === "error"
            ? t("No pude despertar a @plan. Intenta otra vez.")
            : t("¿No sabes qué pedir primero? @plan lee el repo y te propone pedidos listos para mandar.")}
      </span>
      <button
        type="button"
        disabled={state === "busy" || state === "sent"}
        onClick={run}
        className="shrink-0 rounded-full border border-brand px-3 py-1 text-xs font-bold text-brand hover:bg-brand/10 disabled:opacity-50"
      >
        {t("Sugerir pedidos")}
      </button>
    </div>
  );
}

// Tareas programadas (planes Equipo y Agencia): a su hora @plan revisa y, si hay algo,
// PROPONE un plan que espera firma. Sin nada que atender no deja mensaje.
type Sched = Awaited<ReturnType<typeof factorySchedulesFn>>[number];
const SCHED_LABEL: Record<string, { icon: string; title: string; when: string }> = {
  nightly: { icon: "🌙", title: "Revisión nocturna", when: "L–V a las" },
  deps: { icon: "📦", title: "Dependencias", when: "lunes a las" },
};

function SchedulesEditor() {
  const t = useT();
  const [rows, setRows] = useState<Sched[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => factorySchedulesFn().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    void load();
  }, []);
  if (!rows) return null;
  const save = async (r: Sched, patch: Partial<Sched>) => {
    setBusy(r.kind);
    try {
      await setFactoryScheduleFn({ data: { kind: r.kind, enabled: patch.enabled ?? r.enabled, hour: patch.hour ?? r.hour } });
      await load();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-semibold text-muted">
        {t("Tareas programadas")} <span className="font-normal">· {t("incluidas en Equipo y Agencia")}</span>
      </p>
      <div className="divide-y divide-border rounded-lg border border-border bg-surface">
        {rows.map((r) => {
          const l = SCHED_LABEL[r.kind];
          return (
            <div key={r.kind} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span>{l.icon}</span>
              <span className="font-semibold text-ink">{t(l.title)}</span>
              <span className="text-xs text-muted">{t(l.when)}</span>
              <select
                value={r.hour}
                disabled={busy === r.kind}
                onChange={(e) => save(r, { hour: Number(e.target.value) })}
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-ink"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
              <div className="ml-auto">
                <Toggle
                  on={r.enabled}
                  disabled={busy === r.kind}
                  label={`${t(l.title)}: ${r.enabled ? t("Encendida") : t("Apagada")}`}
                  onChange={(on) => void save(r, { enabled: on })}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">{t("@plan revisa a esa hora y, si encuentra algo, propone un plan que espera tu firma. Si no hay nada, no deja mensaje.")}</p>
    </div>
  );
}
