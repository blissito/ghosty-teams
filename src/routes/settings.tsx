import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Bot, Plus, Trash2, X, Bell, Smile, Loader2 } from "lucide-react";
import { currentPushState, enablePush, disablePush } from "../utils/push-subscribe";
import { me, logout } from "../server/auth";
import { getSetup } from "../server/setup";
import { createInvite } from "../server/invites";
import {
  listManagedAgentsFn,
  listFleetAgentsFn,
  createAgentFn,
  updateAgentFn,
  deleteAgentFn,
} from "../server/agents";
import { listEmojisFn, addEmojiFn, removeEmojiFn } from "../server/emojis";
import type { CustomEmoji } from "../db.server";
import { useT } from "../i18n";

export const Route = createFileRoute("/settings")({
  loader: async () => {
    const user = await me();
    const setup = user?.isOwner ? await getSetup() : null;
    return { user, setup };
  },
  component: Settings,
});

function Settings() {
  const t = useT();
  const { user, setup } = Route.useLoaderData();
  const router = useRouter();
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function genInvite() {
    setBusy(true);
    const r = await createInvite();
    setInvite(r.url);
    setBusy(false);
  }
  async function copy() {
    if (invite) {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  async function doLogout() {
    await logout();
    router.navigate({ to: "/login" });
  }

  // Pestañas: General siempre; Agentes/Emojis solo para el owner (tienen mucho que
  // configurar → sección propia). El estado de pestaña vive en la URL-menos (cliente).
  const isOwner = !!user?.isOwner;
  const tabs = [
    { id: "general" as const, label: t("General") },
    ...(isOwner
      ? [
          { id: "agentes" as const, label: t("Agentes") },
          { id: "emojis" as const, label: t("Emojis") },
        ]
      : []),
  ];
  const [tab, setTab] = useState<"general" | "agentes" | "emojis">("general");

  return (
    <div className="mx-auto max-w-lg p-6 text-ink">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("Ajustes")}</h1>
        <Link to="/c/$slug" params={{ slug: "general" }} className="text-sm text-brand hover:underline">
          ← {t("Volver al chat")}
        </Link>
      </div>

      {/* Barra de pestañas */}
      <div className="mb-5 flex gap-1 border-b border-border">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === tb.id
                ? "border-brand text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <>
          {/* Identidad */}
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-4">
            {user?.avatar ? (
              <img src={user.avatar} alt="" className="h-10 w-10 rounded-full" />
            ) : (
              <div className="grid h-10 w-10 place-items-center rounded-full bg-surface-3 text-sm font-semibold">
                {user?.name?.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{user?.name}</p>
              <p className="truncate text-xs text-muted">{user?.email}</p>
            </div>
            <span className="rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand">
              {isOwner ? t("Owner") : t("Miembro")}
            </span>
          </div>

          <NotificationsCard />

          {isOwner && (
            <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
              <h2 className="mb-1 text-sm font-semibold">{t("Invitar miembros")}</h2>
              <p className="mb-3 text-sm text-muted">
                {t("Genera un link. Quien lo abra entra con Formmy y se une a tu chat.")}
              </p>
              {!invite ? (
                <button
                  onClick={genInvite}
                  disabled={busy}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
                >
                  {busy ? t("Generando…") : t("Generar link de invitación")}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={invite}
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink"
                  />
                  <button
                    onClick={copy}
                    className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-brand-fg"
                  >
                    {copied ? "✓" : t("Copiar")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Cerrar sesión: discreto, en rojo y apartado — solo en General. */}
          <div className="mt-10 border-t border-border pt-4 text-right">
            <button
              onClick={doLogout}
              className="text-xs font-medium text-red-500/80 transition hover:text-red-500"
            >
              {t("Cerrar sesión")}
            </button>
          </div>
        </>
      )}

      {tab === "agentes" && isOwner && (
        <>
          {/* Conexión EasyBits (la fuente de la flota de agentes) */}
          <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
            <h2 className="mb-1 text-sm font-semibold">EasyBits</h2>
            <p className="text-sm text-muted">
              {setup?.hasAgent ? (
                <>{t("Agente conectado:")} <span className="text-ink">{setup.fleetName}</span></>
              ) : (
                t("Sin agente conectado.")
              )}
            </p>
            <Link
              to="/setup"
              className="mt-3 inline-block rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand"
            >
              {setup?.hasAgent ? t("Reconfigurar") : t("Conectar EasyBits")}
            </Link>
          </div>
          <AgentsManager />
        </>
      )}

      {tab === "emojis" && isOwner && <EmojiManager />}
    </div>
  );
}

/* ── Notificaciones push: avisa cuando te taggean (@tu-handle) ── */
function NotificationsCard() {
  const t = useT();
  const [state, setState] = useState<"loading" | "unsupported" | "denied" | "on" | "off">("loading");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    currentPushState().then(setState);
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      if (state === "on") {
        await disablePush();
        setState("off");
      } else {
        setState(await enablePush());
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Bell size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("Notificaciones")}</h2>
          <p className="text-xs text-muted">
            {state === "unsupported"
              ? t("Tu navegador no soporta notificaciones push.")
              : state === "denied"
                ? t("Bloqueadas en el navegador. Actívalas desde los permisos del sitio.")
                : t("Recibe un aviso cuando alguien te tagea (@tu-handle), aunque tengas la app cerrada.")}
          </p>
        </div>
        {state !== "unsupported" && state !== "denied" && state !== "loading" && (
          <button
            onClick={toggle}
            disabled={busy}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
              state === "on"
                ? "border border-border text-muted hover:text-ink"
                : "bg-brand text-brand-fg hover:brightness-110"
            }`}
          >
            {busy ? "…" : state === "on" ? t("Desactivar") : t("Activar")}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Emojis custom del workspace: imagen (o GIF) → :name: reaccionable ── */
// Cache de módulo (el `emojisCache` del chat es privado a c.$slug.tsx): reabrir la
// pestaña pinta al instante desde aquí y revalida en background (stale-while-revalidate).
let emojiCache: CustomEmoji[] | null = null;

function EmojiManager() {
  const t = useT();
  const [emojis, setEmojis] = useState<CustomEmoji[]>(() => emojiCache ?? []);
  const [loading, setLoading] = useState(emojiCache === null); // spinner solo en la 1ª carga
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = (es: CustomEmoji[]) => {
    emojiCache = es;
    setEmojis(es);
  };

  useEffect(() => {
    listEmojisFn()
      .then((es) => save(es))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function onFile(file: File) {
    const clean = name.trim() || file.name.replace(/\.[^.]+$/, "");
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(t("no se pudo subir la imagen"));
      const up = (await res.json()) as { fileId: string };
      const { name: saved } = await addEmojiFn({ data: { name: clean, fileId: up.fileId } });
      save(
        [...emojis.filter((e) => e.name !== saved), { name: saved, file_id: up.fileId }].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(nm: string) {
    save(emojis.filter((e) => e.name !== nm));
    await removeEmojiFn({ data: { name: nm } }).catch(() => {});
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Smile size={16} className="text-brand" />
        <h2 className="text-sm font-semibold">{t("Emojis custom")}</h2>
      </div>
      <p className="mb-3 text-sm text-muted">
        {t("Sube una imagen o GIF. Se usa como reacción y en el picker escribiendo :nombre:.")}
      </p>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t(":nombre:")}
          className="w-32 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          {t("Subir emoji")}
        </button>
      </div>
      {err && <p className="mb-2 text-sm text-red-400">{err}</p>}
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" /> {t("Cargando emojis…")}
        </div>
      ) : emojis.length === 0 ? (
        <p className="py-1 text-sm text-muted">{t("Aún no hay emojis custom.")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {emojis.map((e) => (
            <div
              key={e.name}
              className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1"
            >
              <img
                src={`/api/attachment/${encodeURIComponent(e.file_id)}`}
                alt={e.name}
                className="h-5 w-5 object-contain"
              />
              <span className="text-xs text-muted">:{e.name}:</span>
              <button
                onClick={() => remove(e.name)}
                title={t("Eliminar")}
                className="text-muted hover:text-red-400"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Agentes: el @ghosty del wizard + agentes/bots extra (fleet o webhook) ── */
type ManagedAgent = {
  id: number;
  handle: string;
  name: string;
  kind: "fleet" | "webhook";
  fleet_id: string | null;
  webhook_url: string | null;
  enabled: number;
};

// Cache de módulo → reabrir la pestaña Agentes pinta al instante y revalida en background.
let agentsCache: ManagedAgent[] | null = null;

function AgentsManager() {
  const t = useT();
  const [agents, setAgents] = useState<ManagedAgent[] | null>(agentsCache);
  const [adding, setAdding] = useState(false);
  const reload = () =>
    listManagedAgentsFn().then((a) => {
      agentsCache = a as ManagedAgent[];
      setAgents(agentsCache);
    });
  useEffect(() => {
    reload();
  }, []);

  async function toggle(a: ManagedAgent) {
    setAgents((xs) => xs?.map((x) => (x.id === a.id ? { ...x, enabled: x.enabled ? 0 : 1 } : x)) ?? xs);
    await updateAgentFn({ data: { id: a.id, enabled: !a.enabled } }).catch(reload);
  }
  async function remove(a: ManagedAgent) {
    if (!confirm(t("¿Quitar @{handle}?", { handle: a.handle }))) return;
    setAgents((xs) => xs?.filter((x) => x.id !== a.id) ?? xs);
    await deleteAgentFn({ data: { id: a.id } }).catch(reload);
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Agentes")}</h2>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition hover:border-brand hover:text-ink"
          >
            <Plus size={14} /> {t("Agregar")}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">
        <span className="text-brand">@ghosty</span> {t("(el del wizard) siempre está. Agrega más agentes de tu flota o bots externos por webhook; cada uno se tagea por su")} <span className="text-brand">@handle</span>.
      </p>

      {agents === null ? (
        <p className="text-sm text-muted">{t("Cargando…")}</p>
      ) : agents.length === 0 && !adding ? (
        <p className="text-sm text-muted">{t("Sin agentes extra. Solo @ghosty por ahora.")}</p>
      ) : (
        <div className="space-y-1">
          {agents?.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
                <Bot size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {a.name} <span className="text-xs font-normal text-muted">@{a.handle}</span>
                </p>
                <p className="truncate text-xs text-muted">
                  {a.kind === "fleet" ? t("Flota EasyBits") : t("Webhook externo")}
                </p>
              </div>
              <button
                onClick={() => toggle(a)}
                title={a.enabled ? t("Deshabilitar") : t("Habilitar")}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  a.enabled ? "bg-brand/15 text-brand" : "bg-surface-3 text-muted"
                }`}
              >
                {a.enabled ? t("activo") : t("off")}
              </button>
              <button onClick={() => remove(a)} className="p-1 text-muted hover:text-brand" title={t("Quitar")}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AddAgentForm
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function AddAgentForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"fleet" | "webhook">("fleet");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [fleetId, setFleetId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [fleet, setFleet] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listFleetAgentsFn().then(setFleet).catch(() => setFleet([]));
  }, []);

  async function create() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createAgentFn({
        data: {
          handle: handle.trim(),
          name: name.trim(),
          kind,
          fleetId: kind === "fleet" ? fleetId : undefined,
          webhookUrl: kind === "webhook" ? webhookUrl.trim() : undefined,
        },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand";
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted">{t("Nuevo agente")}</p>
        <button onClick={onClose} className="text-muted hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="mb-2 flex gap-1">
        {(["fleet", "webhook"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ${
              kind === k ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted hover:text-ink"
            }`}
          >
            {k === "fleet" ? t("De mi flota") : t("Webhook externo")}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {kind === "fleet" ? (
          <select value={fleetId} onChange={(e) => setFleetId(e.target.value)} className={input}>
            <option value="">
              {fleet === null ? t("Cargando flota…") : fleet.length ? t("Elige un agente…") : t("Sin agentes en tu flota")}
            </option>
            {fleet?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={t("https://tu-bot.com/webhook")}
            className={input}
          />
        )}
        <div className="flex gap-2">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())}
            placeholder={t("handle (ej. soporte)")}
            className={input}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("nombre visible")}
            className={input}
          />
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            {t("Cancelar")}
          </button>
          <button
            onClick={create}
            disabled={busy || !handle.trim() || (kind === "fleet" ? !fleetId : !webhookUrl.trim())}
            className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50"
          >
            {busy ? t("Agregando…") : t("Agregar")}
          </button>
        </div>
      </div>
    </div>
  );
}
