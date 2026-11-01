// «Transmisión en vivo» dentro de Ajustes del room → Evento (modo webinar). A dónde sale el evento
// (YouTube y una página de Facebook, conectados por OAuth en gs) y «Preparar transmisión», que crea
// el evento en cada destino y carga sus llaves en la caja de eventos. Nada de llaves a mano.
// Dos modales cortos: Conectar y Preparar. Ficha de gs: docs/claude/transmitir-en-vivo.md
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, Loader2, Radio, X } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { Toggle } from "./Toggle";
import { liveConnectUrlFn, livePrepareFn, liveStatusFn, liveUnlinkFn } from "../server/events/live";

type Provider = "youtube" | "facebook";
type Dest = { provider: Provider; account: string; lastWatchUrl: string | null; lastPreparedAt: string | null };
type Status = { configured: Record<Provider, boolean>; destinations: Dest[]; box: { targets: string[]; ready: boolean } | null };
type Prepared = Awaited<ReturnType<typeof livePrepareFn>>;

const NAME: Record<Provider, string> = { youtube: "YouTube", facebook: "Facebook" };
const PROVIDERS: Provider[] = ["youtube", "facebook"];

function ProviderMark({ p }: { p: Provider }) {
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white ${p === "youtube" ? "bg-[#ff0033]" : "bg-[#0866ff]"}`} aria-hidden>
      {p === "youtube" ? "▶" : "f"}
    </span>
  );
}

/** Shell de modal del repo (como ConfirmModal): portal, fondo oscuro, Esc cierra. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-surface-2" aria-label={t("Cerrar")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function LiveDestinations({ slug, defaultTitle, startsAt }: { slug: string; defaultTitle: string; startsAt: string }) {
  const t = useT();
  const locale = useLocale();
  const [st, setSt] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(() => {
    liveStatusFn({ data: { slug } })
      .then((r) => {
        setSt(r as Status);
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  // Conectar abre otra pestaña: al volver a esta, se refresca el estado.
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const dest = (p: Provider) => st?.destinations.find((d) => d.provider === p) ?? null;
  const connected = PROVIDERS.filter((p) => dest(p));

  return (
    <div className="mb-3 rounded-xl border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <Radio className="h-4 w-4 text-brand" />
        <span className="text-xs font-semibold">{t("Transmisión en vivo")}</span>
      </div>
      <p className="mb-3 text-xs text-muted">{t("Al grabar con «En vivo» marcado, el evento sale también en tu canal de YouTube y tu página de Facebook.")}</p>

      {loadErr && <p className="mb-2 text-xs text-red-400">{loadErr}</p>}
      {!st && !loadErr && <Loader2 className="mb-2 h-4 w-4 animate-spin text-muted" />}

      {st && (
        <>
          <div className="mb-3 divide-y divide-border rounded-lg border border-border">
            {PROVIDERS.map((p) => {
              const d = dest(p);
              return (
                <div key={p} className="flex items-center gap-3 px-3 py-2">
                  <ProviderMark p={p} />
                  <div className="min-w-0 flex-1 text-xs">
                    <div className="font-medium">{NAME[p]}</div>
                    <div className="truncate text-muted">{d ? d.account : st.configured[p] ? t("Sin conectar") : t("No disponible todavía")}</div>
                  </div>
                  {st.configured[p] && (
                    <button onClick={() => setConnecting(p)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-surface-2">
                      {d ? t("Cambiar") : t("Conectar")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setPreparing(true)}
              disabled={!connected.length}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {t("Preparar transmisión")}
            </button>
            <span className="text-xs text-muted">
              {st.box?.ready && st.box.targets.length
                ? t("Lista para transmitir a {where}", { where: st.box.targets.join(" + ") })
                : connected.length
                  ? t("Sin preparar")
                  : t("Conecta un destino primero")}
            </span>
          </div>
        </>
      )}

      {connecting && (
        <ConnectModal
          slug={slug}
          provider={connecting}
          locale={locale}
          current={dest(connecting)?.account ?? null}
          onClose={() => setConnecting(null)}
          onUnlinked={() => {
            setConnecting(null);
            load();
          }}
        />
      )}
      {preparing && st && (
        <PrepareModal
          slug={slug}
          defaultTitle={defaultTitle}
          startsAt={startsAt}
          connected={connected.map((p) => ({ provider: p, account: dest(p)!.account }))}
          onClose={() => {
            setPreparing(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectModal({ slug, provider, locale, current, onClose, onUnlinked }: { slug: string; provider: Provider; locale: string; current: string | null; onClose: () => void; onUnlinked: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<"go" | "unlink" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  const go = async () => {
    // La pestaña se abre ANTES del await: abrirla después la bloquea el navegador.
    const w = window.open("about:blank", "_blank");
    setBusy("go");
    setErr(null);
    try {
      const { url } = await liveConnectUrlFn({ data: { slug, provider, locale } });
      if (w) w.location.href = url;
      else window.location.href = url;
      setOpened(true);
    } catch (e) {
      w?.close();
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const unlink = async () => {
    setBusy("unlink");
    setErr(null);
    try {
      await liveUnlinkFn({ data: { slug, provider } });
      onUnlinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <Modal title={t("Conectar {name}", { name: NAME[provider] })} onClose={onClose}>
      <p className="mb-4 text-sm text-muted">
        {provider === "youtube"
          ? t("Inicia sesión con Google y elige el canal. Ghosty sólo crea las transmisiones de tus eventos; no toca tus videos.")
          : t("Inicia sesión con Facebook y elige la página. Ghosty sólo crea las transmisiones en vivo de tus eventos en esa página.")}
      </p>
      {current && (
        <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-xs">
          {t("Conectado ahora:")} <span className="font-semibold">{current}</span>
        </p>
      )}
      {opened && <p className="mb-3 text-xs text-muted">{t("Termina en la otra pestaña; al volver aquí se actualiza solo.")}</p>}
      {err && <p className="mb-3 text-xs text-red-400">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={go} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "go" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          {provider === "youtube" ? t("Continuar con Google") : t("Continuar con Facebook")}
        </button>
        {current && (
          <button onClick={unlink} disabled={!!busy} className="ml-auto rounded-lg px-3 py-2 text-sm font-semibold text-red-400 hover:bg-red-400/10 disabled:opacity-50">
            {busy === "unlink" ? t("Desconectando…") : t("Desconectar")}
          </button>
        )}
      </div>
    </Modal>
  );
}

function PrepareModal({ slug, defaultTitle, startsAt, connected, onClose }: { slug: string; defaultTitle: string; startsAt: string; connected: { provider: Provider; account: string }[]; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(defaultTitle);
  const [privacy, setPrivacy] = useState<"unlisted" | "public" | "private">("unlisted");
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(connected.map((c) => [c.provider, true])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Prepared | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const only = connected.filter((c) => on[c.provider]).map((c) => c.provider);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await livePrepareFn({ data: { slug, title, privacy, only, startsAt: startsAt ? new Date(startsAt).toISOString() : null } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* sin permiso: la liga está a la vista */
    }
  };

  if (res) {
    return (
      <Modal title={t("Transmisión preparada")} onClose={onClose}>
        <div className="mb-4 space-y-2">
          {res.prepared.map((p) => (
            <div key={p.provider} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
              <ProviderMark p={p.provider} />
              <a href={p.watchUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs text-brand hover:underline">
                {p.watchUrl}
              </a>
              <button onClick={() => copy(p.watchUrl)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label={t("Copiar liga")}>
                {copied === p.watchUrl ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          ))}
          {res.failed.map((f) => (
            <div key={f.provider} className="flex items-start gap-3 rounded-lg border border-red-400/40 px-3 py-2 text-xs">
              <ProviderMark p={f.provider} />
              <span className="text-red-400">{f.error}</span>
            </div>
          ))}
        </div>
        <p className="mb-4 text-xs text-muted">
          {res.box?.ready
            ? t("Listo. En el room, el anfitrión aprieta Grabar con «En vivo» marcado y sale al aire solo.")
            : t("Los eventos se crearon, pero la sala no confirmó los destinos. Revisa el estado en un minuto.")}
        </p>
        <button onClick={onClose} className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white">
          {t("Listo")}
        </button>
      </Modal>
    );
  }

  const PRIV: { v: typeof privacy; label: string }[] = [
    { v: "unlisted", label: t("Oculto") },
    { v: "public", label: t("Público") },
    { v: "private", label: t("Privado") },
  ];

  return (
    <Modal title={t("Preparar transmisión")} onClose={onClose}>
      <label className="mb-1 block text-xs font-medium">{t("Título")}</label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={100}
        className="mb-4 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />

      <span className="mb-1 block text-xs font-medium">{t("Quién lo ve en YouTube")}</span>
      <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg border border-border p-1">
        {PRIV.map((o) => (
          <button
            key={o.v}
            onClick={() => setPrivacy(o.v)}
            className={`rounded-md px-2 py-1.5 text-xs font-semibold ${privacy === o.v ? "bg-brand text-white" : "text-muted hover:bg-surface-2"}`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="mb-4 space-y-2">
        {connected.map((c) => (
          <div key={c.provider} className="flex items-center gap-3 text-xs">
            <ProviderMark p={c.provider} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{NAME[c.provider]}</span> <span className="text-muted">· {c.account}</span>
            </span>
            <Toggle on={!!on[c.provider]} onChange={(v) => setOn((s) => ({ ...s, [c.provider]: v }))} label={NAME[c.provider]} />
          </div>
        ))}
      </div>

      <p className="mb-4 text-xs text-muted">{t("Prepáralo con la sala vacía: reinicia la sala de eventos. Facebook sale público en la página.")}</p>
      {err && <p className="mb-3 text-xs text-red-400">{err}</p>}
      <button
        onClick={run}
        disabled={busy || !title.trim() || !only.length}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? t("Preparando… (hasta 1 min)") : t("Preparar")}
      </button>
    </Modal>
  );
}
