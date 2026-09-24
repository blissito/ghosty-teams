// Ajustes → Apps: lo que se INSTALA en el espacio. La primera es la Software Factory
// (server/apps/factory.ts). Instalar pide dos cosas —dónde vive (room) y sobre qué repo
// trabaja— y deja los tres handles, el tablero y las tools listos.
import { useEffect, useState } from "react";
import { Factory, Loader2, ExternalLink } from "lucide-react";
import { useT } from "../i18n";
import { factoryStatusFn, installFactoryFn, uninstallFactoryFn, type FactoryStatus } from "../server/apps/factory";
import { githubInstallationReposFn } from "../server/room-repos";
import { listChannelsFn } from "../server/chat";
import ConfirmModal from "./ConfirmModal";

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
              {t("Tres agentes en una caja: @plan escribe el plan y te pide firma, @build construye y abre el PR, @check lo revisa y nunca edita.")}
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
          {status.installed ? <Installed status={status} onChange={load} /> : <Installer onDone={load} />}
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
      <p className="text-muted">
        {t("Handles activos")}: {status.handles.length ? status.handles.map((h) => `@${h}`).join(", ") : "—"}
      </p>
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
          body={t("Los handles @plan, @build y @check dejan de contestar y sus tools desaparecen. El room, el tablero y las corridas se conservan; puedes volver a instalarla.")}
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

function Installer({ onDone }: { onDone: () => void }) {
  const t = useT();
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
      {error && <p className="text-danger">{error}</p>}
      <button
        type="button"
        disabled={busy || !repo}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await installFactoryFn({ data: { roomId: roomId || null, repo } });
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
        3. {busy ? t("Instalando…") : t("Instalar")}
      </button>
    </div>
  );
}
