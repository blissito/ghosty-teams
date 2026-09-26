import { Link } from "@tanstack/react-router";
// Ajustes → Apps → Ghosty Ads (server/apps/ads.ts). Instalar pide dónde vive (room) y qué
// agente de Studio hace de @ads; la app no crea agentes. Instalada: «Conectar Meta» (el OAuth
// vive en gs y se abre en otra pestaña), la cuenta y la página conectadas, el selector si hay
// varias, el agente de @ads y desinstalar.
import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Megaphone } from "lucide-react";
import { useT } from "../i18n";
import { adsConnectUrlFn, adsSelectFn, adsStatusFn, installAdsFn, setAdsAgentFn, uninstallAdsFn, type AdsAppStatus } from "../server/apps/ads";
import { listChannelsFn } from "../server/chat";
import ConfirmModal from "./ConfirmModal";

type Room = { id: number; slug: string };

const field = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ink";

export function AdsAppPanel() {
  const t = useT();
  const [status, setStatus] = useState<AdsAppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    adsStatusFn()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
    // Al volver de la pestaña de Meta, el estado de la conexión ya cambió.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
          <Megaphone className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-ink">Ghosty Ads</h3>
            <span className="rounded-md bg-brand/12 px-1.5 text-[10px] font-semibold uppercase text-brand">beta</span>
            {status?.installed && (
              <span className="rounded-md bg-emerald-600/12 px-1.5 text-[10px] font-semibold uppercase text-emerald-600">{t("Instalada")}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {t("Campañas de Meta que llevan a Messenger. @ads las propone con vista previa y segmentación real; tú las creas, prendes y pausas desde su tarjeta. Mide el costo por lead calificado.")}
          </p>
        </div>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !status ? (
          <p className="text-sm text-muted">{t("Cargando…")}</p>
        ) : status.installed ? (
          <Installed status={status} onChange={load} />
        ) : (
          <Installer status={status} onDone={load} />
        )}
      </div>
    </div>
  );
}

function AgentSelect({ status, value, onChange }: { status: AdsAppStatus; value: string; onChange: (v: string) => void }) {
  const t = useT();
  if (!status.candidates.length)
    return (
      <p className="mt-1 text-muted">
        {t("Todavía no hay agentes con Claude, DeepSeek o Codex.")}{" "}
        <a href={status.studioAgentsUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
          {t("Crea uno en Studio")} ↗
        </a>
      </p>
    );
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      <option value="">{t("Elige un agente")}</option>
      {status.candidates.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {a.engine} · {a.model}
        </option>
      ))}
    </select>
  );
}

function Installer({ status, onDone }: { status: AdsAppStatus; onDone: () => void }) {
  const t = useT();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState(0);
  const [agentId, setAgentId] = useState(status.candidates.find((a) => a.engine === "claude")?.id ?? status.candidates[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listChannelsFn()
      .then((cs) => setRooms(cs.map((c) => ({ id: c.id, slug: c.slug }))))
      .catch(() => {});
  }, []);
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs font-semibold text-muted">1. {t("Room donde vive @ads")}</span>
        <select value={roomId} onChange={(e) => setRoomId(Number(e.target.value))} className={field}>
          <option value={0}>{t("Crear #anuncios")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.slug}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-semibold text-muted">2. {t("Qué agente hace de @ads")}</span>
        <AgentSelect status={status} value={agentId} onChange={setAgentId} />
      </label>
      {error && <p className="text-danger">{error}</p>}
      <button
        type="button"
        disabled={busy || !agentId}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await installAdsFn({ data: { roomId: roomId || null, agentId } });
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

function Installed({ status, onChange }: { status: AdsAppStatus; onChange: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = status.meta;
  const [account, setAccount] = useState(meta.adAccount?.id ?? "");
  const [page, setPage] = useState(meta.page?.id ?? "");
  const [agentId, setAgentId] = useState(status.agent?.id ?? "");

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    // La pestaña se abre ANTES del await: abrirla después la bloquea el navegador.
    const w = window.open("about:blank", "_blank");
    setBusy("connect");
    setError(null);
    try {
      const { url } = await adsConnectUrlFn();
      if (w) w.location.href = url;
      else window.location.href = url;
    } catch (e) {
      w?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const multi = status.assets && (status.assets.adAccounts.length > 1 || status.assets.pages.length > 1);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink">
        {t("Room")}: <b>#{status.room?.slug ?? "—"}</b>
      </p>

      <div className="rounded-lg border border-border bg-surface p-3">
        <p className="text-xs font-semibold text-muted">{t("Meta")}</p>
        {meta.connected ? (
          <p className="mt-1 text-ink">
            ✓ {t("Cuenta")}: <b>{meta.adAccount?.name ?? t("sin elegir")}</b>
            {meta.adAccount?.currency ? <span className="text-muted"> · {meta.adAccount.currency}</span> : null} · {t("Página")}:{" "}
            <b>{meta.page?.name ?? t("sin elegir")}</b>
            {meta.expiresAt && (
              <span className="block text-xs text-muted">
                {t("La conexión vence el {d}; reconéctala antes.").replace("{d}", new Date(meta.expiresAt).toLocaleDateString("es-MX", { day: "numeric", month: "long" }))}
              </span>
            )}
          </p>
        ) : (
          <p className="mt-1 text-muted">{meta.error ?? t("Sin conectar. Conecta la cuenta de anuncios y la página que atiende Messenger.")}</p>
        )}
        {multi && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select value={account} onChange={(e) => setAccount(e.target.value)} className={field} aria-label={t("Cuenta de anuncios")}>
              <option value="">{t("Cuenta de anuncios")}</option>
              {status.assets!.adAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </select>
            <select value={page} onChange={(e) => setPage(e.target.value)} className={field} aria-label={t("Página")}>
              <option value="">{t("Página")}</option>
              {status.assets!.pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!!busy || !account || !page || (account === meta.adAccount?.id && page === meta.page?.id)}
              onClick={() => run("select", () => adsSelectFn({ data: { adAccountId: account, pageId: page } }))}
              className="rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50 sm:col-span-2 sm:justify-self-start"
            >
              {busy === "select" ? t("Guardando…") : t("Usar esta cuenta y página")}
            </button>
          </div>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={connect}
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy === "connect" && <Loader2 className="size-3.5 animate-spin" />}
          {meta.connected ? t("Reconectar Meta") : t("Conectar Meta")} <ExternalLink className="size-3" />
        </button>
      </div>

      <label className="block">
        <span className="text-xs font-semibold text-muted">{t("Agente de @ads")}</span>
        <div className="flex items-center gap-2">
          <AgentSelect status={status} value={agentId} onChange={setAgentId} />
          {agentId && agentId !== status.agent?.id && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("agent", () => setAdsAgentFn({ data: { agentId } }))}
              className="mt-1 shrink-0 rounded-lg border border-brand px-3 py-2 text-xs font-semibold text-brand hover:bg-brand/10"
            >
              {t("Guardar")}
            </button>
          )}
        </div>
        {status.agent?.studioUrl && (
          <a href={status.agent.studioUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline">
            {t("Afinar en Studio")} <ExternalLink className="size-3" />
          </a>
        )}
      </label>

      {error && <p className="text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <a href="/ads" className="rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/10">
          {t("Abrir Ghosty Ads")} →
        </a>
        {status.room && (
          <Link to="/c/$slug" params={{ slug: status.room.slug }} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
            {t("Ir al room")}
          </Link>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setConfirm(true)}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-danger"
        >
          {t("Desinstalar")}
        </button>
      </div>
      {confirm && (
        <ConfirmModal
          title={t("¿Desinstalar Ghosty Ads?")}
          body={t("@ads deja de contestar y sus tools desaparecen. Las campañas siguen en Meta tal como están (activas o en pausa) y el historial se conserva; puedes volver a instalarla.")}
          confirmLabel={t("Desinstalar")}
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            await uninstallAdsFn().catch(() => {});
            setConfirm(false);
            onChange();
          }}
        />
      )}
    </div>
  );
}
