import { Link } from "@tanstack/react-router"; // Link: CTA "conecta EasyBits" / setup
import { useEffect, useRef, useState } from "react";
import { Bot, Plus, Trash2, X, Bell, Smile, Loader2, Pencil, Mail, ExternalLink } from "lucide-react";
import { FleetAgentControls } from "./FleetAgentControls";
import { currentPushState, enablePush, disablePush } from "../utils/push-subscribe";
import { me, cachedMe, peekMe, logout, clearMeCache } from "../server/auth";
import { getSetup } from "../server/setup";
import { updateMyProfileFn, getNotifyPrefsFn, setEmailNotifsFn } from "../server/chat";
import { createInvite, getInvite, refreshInvite, revokeInvite } from "../server/invites";
import {
  listManagedAgentsFn,
  createAgentFn,
  createManagedAgentFn,
  updateAgentFn,
  deleteAgentFn,
  agentAccessFn,
  listAgentCollaboratorsFn,
  addAgentCollaboratorFn,
  removeAgentCollaboratorFn,
} from "../server/agents";
import { listEmojisFn, addEmojiFn, removeEmojiFn } from "../server/emojis";
import { bumpEmojis } from "../utils/emojis-bus";
import { bumpUsers } from "../utils/users-bus";
import type { CustomEmoji } from "../db.server";
import { useT, useLocale, useSetLocale, type Locale } from "../i18n";
import { Monitor, Sun, Moon, Check, SlidersHorizontal, Palette, Github, Plug, Users, Calendar, CalendarClock, Link2, RefreshCw } from "lucide-react";
import { listMyConnectorsFn, disconnectConnectorFn } from "../server/connectors";
import {
  PRESETS,
  getTheme,
  setThemePartial,
  subscribeTheme,
  type ThemeScheme,
  type TextSize,
  type FontChoice,
} from "../utils/theme";
import { useSyncExternalStore } from "react";
import { bumpMentions } from "../utils/mentions-bus";
import { registerModalEsc } from "../utils/modal-esc";
import {
  getSoundPrefs,
  setSoundPref,
  SOUND_CATEGORIES,
  playNotificationSound,
  type SoundPrefs,
} from "../utils/notificationSound";

// Panel de flota de Studio (gs): dónde se crean+configuran los agentes gestionados.
// Los agentes NO se crean inline en Teams; se dan de alta aquí y aparecen solos.
const STUDIO_AGENTS_URL = "https://ghosty.studio/app/agents";

// Datos que Ajustes necesita (identidad + setup + acceso a agentes). Se cargan una vez
// y se cachean a nivel módulo → reabrir Preferencias (modal) pinta al instante y revalida
// en background (mismo patrón stale-while-revalidate que agentsCache/emojiCache).
export type SettingsData = {
  user: Awaited<ReturnType<typeof me>>;
  setup: Awaited<ReturnType<typeof getSetup>> | null;
  agentAccess: { canManage: boolean };
};
let settingsDataCache: SettingsData | null = null;

export async function loadSettingsData(): Promise<SettingsData> {
  const user = await cachedMe(); // reusa la identidad ya caliente en el cliente
  const setup = user?.isOwner ? await getSetup() : null;
  const agentAccess = user ? await agentAccessFn() : { canManage: false };
  const data = { user, setup, agentAccess };
  settingsDataCache = data;
  return data;
}

/**
 * Estado inicial SÍNCRONO para pintar sin flash de "Cargando…":
 * 1) la cache completa (2ª apertura) → todo instantáneo;
 * 2) si no, la identidad ya cacheada (`peekMe`) → pinta la General completa al
 *    instante (avatar/nombre/Owner correctos); `setup`/`agentAccess` los rellena
 *    la revalidación en background (solo afectan tabs Agentes/Emojis del rail).
 * Solo cae a `null` (spinner) en frío real (identidad aún sin resolver).
 */
function seedSettingsData(): SettingsData | null {
  if (settingsDataCache) return settingsDataCache;
  const peeked = peekMe();
  if (peeked === undefined) return null;
  return { user: peeked, setup: null, agentAccess: { canManage: false } };
}

/**
 * Contenido de Ajustes/Preferencias — compartido por la ruta `/settings` (deep-link,
 * SSR) y el modal in-panel `PreferencesModal` (SPA, snappy). Sin padding externo:
 * el contenedor (ruta o Modal) lo aporta.
 * @param initial datos precargados por el loader de la ruta (evita flash en SSR).
 * @param onClose si viene → modo modal (header con X). Si no → modo ruta (link "volver").
 */
type TabId = "general" | "notifications" | "appearance" | "integraciones" | "agentes" | "emojis";

export function SettingsContent({
  initialTab,
  onClose,
}: {
  initialTab?: TabId;
  onClose?: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<SettingsData | null>(seedSettingsData);
  const [invite, setInvite] = useState<string | null>(null); // null = sin link activo
  const [inviteLoaded, setInviteLoaded] = useState(false); // ya resolvimos el estado inicial
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // Revalida en background siempre (aunque haya cache/initial): datos frescos sin bloquear.
  useEffect(() => {
    loadSettingsData().then(setData).catch(() => {});
  }, []);

  // Lee el link permanente activo (per-usuario; Slack default: cualquier member invita).
  useEffect(() => {
    if (data?.user && !inviteLoaded) {
      getInvite()
        .then((r) => setInvite(r.url))
        .catch(() => {})
        .finally(() => setInviteLoaded(true));
    }
  }, [data?.user, inviteLoaded]);

  async function makeInvite() {
    setBusy(true);
    try { setInvite((await createInvite()).url); } finally { setBusy(false); }
  }
  async function regenInvite() {
    setBusy(true);
    try { setInvite((await refreshInvite()).url); } finally { setBusy(false); }
  }
  async function cancelInvite() {
    setBusy(true);
    try { await revokeInvite(); setInvite(null); } finally { setBusy(false); }
  }
  async function copy() {
    if (invite) {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  async function doLogout() {
    const r = await logout();
    clearMeCache(); // invalida la identidad cacheada o el guard vería al user viejo
    // Top-level a gs /logout: cierra también la sesión del IdP (single-logout) y
    // aterriza en el landing de Ghosty.studio. Evita el auto-re-login silencioso.
    window.location.href = r.next;
  }

  const user = data?.user ?? null;
  const isOwner = !!user?.isOwner;
  const canManageAgents = !!data?.agentAccess?.canManage;
  const tabs: { id: TabId; label: string; icon: typeof Bell }[] = [
    { id: "general", label: t("General"), icon: SlidersHorizontal },
    { id: "notifications", label: t("Notificaciones"), icon: Bell },
    { id: "appearance", label: t("Apariencia"), icon: Palette },
    { id: "integraciones", label: t("Integraciones"), icon: Plug },
    ...(canManageAgents ? [{ id: "agentes" as const, label: t("Agentes"), icon: Bot }] : []),
    // Emojis: visible para TODOS los members (Slack default — cualquiera agrega; borrar
    // queda restringido al owner o al creador, gateado en EmojiManager).
    { id: "emojis" as const, label: t("Emojis"), icon: Smile },
  ];
  const [tab, setTab] = useState<TabId>(initialTab ?? "general");
  // Recuerda la última pestaña abierta (localStorage). Si viene `initialTab` explícita
  // (ej. picker → "emojis"), esa manda: no restaurar. `restored` evita pisar un cambio
  // manual del usuario. Depende de disponibilidad (Agentes/Emojis cargan async).
  const restored = useRef(!!initialTab);
  useEffect(() => {
    if (restored.current) return;
    try {
      const saved = localStorage.getItem("settings.tab") as TabId | null;
      if (!saved || saved === "general") { restored.current = true; return; }
      if (tabs.some((tb) => tb.id === saved)) { setTab(saved); restored.current = true; }
    } catch { restored.current = true; }
  }, [canManageAgents, isOwner]);
  const selectTab = (id: TabId) => {
    restored.current = true;
    setTab(id);
    try { localStorage.setItem("settings.tab", id); } catch {}
  };
  const activeLabel = tabs.find((tb) => tb.id === tab)?.label ?? t("Ajustes");

  return (
    // Altura FIJA (estándar Slack/Linear/Notion) + rail vertical: no cambia de tamaño
    // al cambiar de pestaña. El cuerpo derecho scrollea por dentro.
    <div className="flex h-[85dvh] max-h-[620px] text-ink">
      {/* Rail de navegación (fijo) */}
      <div className="flex w-16 shrink-0 flex-col gap-1 border-r border-border bg-surface p-2 sm:w-52 sm:p-3">
        <p className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">{t("Preferencias")}</p>
        {tabs.map((tb) => {
          const Icon = tb.icon;
          return (
            <button
              key={tb.id}
              onClick={() => selectTab(tb.id)}
              title={tb.label}
              className={`flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition sm:justify-start sm:px-3 ${
                tab === tb.id ? "bg-brand/12 text-brand" : "text-muted hover:bg-surface-3 hover:text-ink"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="hidden sm:inline">{tb.label}</span>
            </button>
          );
        })}
      </div>

      {/* Panel derecho */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-6 pb-3 pt-5">
          <h2 className="text-lg font-semibold">{activeLabel}</h2>
          {onClose && (
            <button onClick={onClose} className="text-muted hover:text-ink" title={t("Cerrar")}>
              <X size={18} />
            </button>
          )}
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto px-6 pb-6">
          {/* Solo mostramos "Cargando…" en frío REAL (identidad aún sin resolver, sin
              cache ni `peekMe`). Con la identidad ya caliente, la General pinta al
              instante — el badge Owner/Miembro es correcto desde el arranque, y el link
              de invitación tiene su propio placeholder ("Generando link…"). */}
          {tab === "general" && !user && (
            <div className="flex items-center gap-2 py-10 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" /> {t("Cargando…")}
            </div>
          )}
          {tab === "general" && user && (
            <>
              {/* Identidad (editable: nombre + avatar) */}
              <ProfileCard user={user} isOwner={isOwner} />

              {/* Invitar: Slack default → cualquier member puede invitar (link propio). */}
              {user && (
                <div className="mb-4 rounded-2xl border border-border bg-surface-2 p-5">
                  <h2 className="mb-1 text-sm font-semibold">{t("Invitar miembros")}</h2>
                  <p className="mb-4 text-sm text-muted">
                    {t("Comparte este link con tu equipo. Quien lo abra entra con Ghosty y se une como miembro.")}
                  </p>

                  {!inviteLoaded ? (
                    // Estado inicial (resolviendo si hay link activo).
                    <div className="flex items-center gap-2 py-1 text-sm text-muted">
                      <Loader2 size={16} className="animate-spin" /> {t("Cargando…")}
                    </div>
                  ) : invite ? (
                    // Con link permanente activo.
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={invite}
                          onFocus={(e) => e.currentTarget.select()}
                          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-ink"
                        />
                        <button
                          onClick={copy}
                          disabled={busy}
                          className="shrink-0 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                        >
                          {copied ? t("¡Copiado!") : t("Copiar")}
                        </button>
                      </div>
                      <div className="mt-3 flex items-center gap-4">
                        <button
                          onClick={regenInvite}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition hover:text-ink disabled:opacity-50"
                          title={t("Genera un link nuevo; el actual deja de funcionar.")}
                        >
                          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          {t("Refrescar")}
                        </button>
                        <button
                          onClick={cancelInvite}
                          disabled={busy}
                          className="text-xs font-medium text-red-500/80 transition hover:text-red-500 disabled:opacity-50"
                          title={t("Desactiva el link; nadie más podrá unirse.")}
                        >
                          {t("Cancelar link")}
                        </button>
                        <span className="ml-auto text-[11px] text-muted">{t("Todos entran como miembro")}</span>
                      </div>
                    </>
                  ) : (
                    // Sin link (cancelado o nunca creado) → CTA.
                    <button
                      onClick={makeInvite}
                      disabled={busy}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                      {t("Crear link de invitación")}
                    </button>
                  )}
                </div>
              )}

              {/* Cerrar sesión: discreto, en rojo y apartado. */}
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

          {tab === "notifications" && <NotificationsCard />}

          {tab === "appearance" && <AppearancePanel />}

          {tab === "integraciones" && <IntegrationsPanel />}

          {tab === "agentes" && canManageAgents && (
            <AgentsManager isOwner={isOwner} hasAgent={!!data?.setup?.hasAgent} />
          )}

          {tab === "emojis" && <EmojiManager isOwner={isOwner} mySub={user?.sub ?? null} />}
        </div>
      </div>
    </div>
  );
}

/* ── Integraciones: conectores externos PER-USER (modelo Cowork). Lista tipo tabla
   (estilo claude.ai → Conectores): Conector · Tipo · Estado, con filtros. Cada usuario
   conecta SU cuenta; @ghosty actúa con la del que lo invoca. Data-driven sobre el
   registro server (connectors/registry.ts). ── */
type ConnItem = {
  id: string; name: string; blurb: string; icon: string; type: string;
  custom: boolean; status: "available" | "soon"; connected: boolean;
};

function connIcon(icon: string) {
  switch (icon) {
    case "calendly": return CalendarClock;
    case "github": return Github;
    case "hubspot": return Users;
    case "google-calendar": return Calendar;
    default: return Plug;
  }
}

function IntegrationsPanel() {
  const t = useT();
  const [items, setItems] = useState<ConnItem[] | null>(null);
  const [filter, setFilter] = useState<"all" | "connected" | "disconnected">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { listMyConnectorsFn().then(setItems).catch(() => setItems([])); };
  useEffect(() => { load(); }, []);

  async function disconnect(id: string) {
    setBusy(id);
    // catch explícito: si la desconexión falla (p.ej. DB caída) NO dejar el estado colgado;
    // recargamos igual para reflejar la verdad del server (antes sin catch el throw se
    // tragaba el load → el UI seguía "Conectado" sin feedback).
    try { await disconnectConnectorFn({ data: { provider: id } }); }
    catch (e) { console.error("[connectors] disconnect failed", e); }
    finally { load(); setBusy(null); }
  }

  const list = (items ?? []).filter((c) =>
    filter === "all" ? true : filter === "connected" ? c.connected : !c.connected
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t("Conecta herramientas externas para que @ghosty trabaje con tu contexto.")}
      </p>

      {/* Filtros (segmento), estilo claude.ai */}
      <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5 text-sm">
        {([["all", "Todo"], ["connected", "Conectado"], ["disconnected", "No conectado"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`rounded-md px-3 py-1 font-medium transition ${filter === k ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"}`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* Tabla: Conector · Tipo · Estado */}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border bg-surface-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <span>{t("Conector")}</span>
          <span>{t("Tipo")}</span>
          <span className="text-right">{t("Estado")}</span>
        </div>
        {items == null ? (
          <div className="px-4 py-6 text-center text-muted"><Loader2 size={16} className="mx-auto animate-spin" /></div>
        ) : list.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">{t("Nada por aquí.")}</div>
        ) : (
          list.map((c) => {
            const Icon = connIcon(c.icon);
            return (
              <div key={c.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink">
                    <Icon size={18} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">{c.name}</p>{/* nombre propio, no se traduce */}
                      {c.custom && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted">
                          {t("Personalizado")}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted">{t(c.blurb)}</p>
                  </div>
                </div>
                <span className="text-xs text-muted">{c.type}</span>
                <div className="flex items-center justify-end">
                  {c.status === "soon" ? (
                    <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted">
                      {t("Próximamente")}
                    </span>
                  ) : c.connected ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
                        <Check size={14} />{t("Conectado")}
                      </span>
                      <button
                        onClick={() => disconnect(c.id)}
                        disabled={busy === c.id}
                        className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
                      >
                        {busy === c.id ? "…" : t("Desconectar")}
                      </button>
                    </div>
                  ) : (
                    <a
                      href={`/setup/${c.id}/connect`}
                      // Navegación full-page (loader → OAuth authorize). Marcamos busy al
                      // click para dar feedback mientras redirige (antes: sin estado).
                      onClick={() => setBusy(c.id)}
                      aria-disabled={busy === c.id}
                      className={`rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:brightness-110 ${
                        busy === c.id ? "pointer-events-none opacity-60" : ""
                      }`}
                    >
                      {busy === c.id ? t("Conectando…") : t("Conectar")}
                    </a>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── Apariencia: modo (claro/oscuro/sistema) + dark sidebar + estilos + tamaño +
   fuente + reducir movimiento. Todo instantáneo y persistente (theme.ts). ── */
function useThemeStore() {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

function AppearancePanel() {
  const t = useT();
  const s = useThemeStore();
  const locale = useLocale();
  const setLocale = useSetLocale();

  const Segmented = <T extends string>({
    value,
    options,
    onChange,
  }: {
    value: T;
    options: { id: T; label: string; icon?: typeof Sun }[];
    onChange: (v: T) => void;
  }) => (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              value === o.id ? "bg-brand text-brand-fg" : "text-muted hover:text-ink"
            }`}
          >
            {Icon && <Icon size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-7">
      {/* Idioma */}
      <Row title={t("Idioma")}>
        <Segmented<Locale>
          value={locale}
          onChange={setLocale}
          options={[
            { id: "es", label: "Español" },
            { id: "en", label: "English" },
          ]}
        />
      </Row>

      {/* Modo */}
      <Row title={t("Modo")}>
        <Segmented<ThemeScheme>
          value={s.scheme}
          onChange={(scheme) => setThemePartial({ scheme })}
          options={[
            { id: "system", label: t("Sistema"), icon: Monitor },
            { id: "light", label: t("Claro"), icon: Sun },
            { id: "dark", label: t("Oscuro"), icon: Moon },
          ]}
        />
      </Row>

      {/* Dark sidebar */}
      <Row
        title={t("Sidebar oscuro")}
        desc={t("Mantén el rail izquierdo oscuro en todos los modos — aunque el resto esté claro.")}
      >
        <Toggle on={s.darkSidebar} onChange={(darkSidebar) => setThemePartial({ darkSidebar })} />
      </Row>

      {/* Estilos */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">{t("Estilo")}</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setThemePartial({ preset: p.id })}
              className={`rounded-xl border p-2 text-left transition ${
                s.preset === p.id ? "border-brand ring-1 ring-brand" : "border-border hover:border-brand/60"
              }`}
            >
              <div className="mb-1.5 flex gap-1.5">
                <PresetSwatch pal={p.light} />
                <PresetSwatch pal={p.dark} />
              </div>
              <div className="flex items-center justify-between px-0.5">
                <span className="text-xs font-medium">{p.label}</span>
                {s.preset === p.id && <Check size={13} className="text-brand" />}
              </div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {t("Cada estilo tiene variante clara y oscura — sigue el modo de arriba.")}
        </p>
      </div>

      {/* Tamaño de texto */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">{t("Tamaño de texto")}</h3>
        <Segmented<TextSize>
          value={s.textSize}
          onChange={(textSize) => setThemePartial({ textSize })}
          options={[
            { id: "tiny", label: t("Pequeño") },
            { id: "regular", label: t("Normal") },
            { id: "large", label: t("Grande") },
            { id: "xl", label: t("Extra") },
          ]}
        />
        <p className="mt-2 text-xs text-muted">{t("Escala toda la interfaz — texto y espaciado juntos.")}</p>
      </div>

      {/* Fuente */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">{t("Fuente")}</h3>
        <div className="grid grid-cols-3 gap-2">
          {([
            { id: "default", label: t("Default"), sample: "Ag", cls: "" },
            { id: "serif", label: t("Serif"), sample: "Ag", cls: "font-serif" },
            { id: "mono", label: t("Mono"), sample: "Ag", cls: "font-mono" },
          ] as { id: FontChoice; label: string; sample: string; cls: string }[]).map((f) => (
            <button
              key={f.id}
              onClick={() => setThemePartial({ font: f.id })}
              className={`rounded-xl border p-3 text-center transition ${
                s.font === f.id ? "border-brand ring-1 ring-brand" : "border-border hover:border-brand/60"
              }`}
            >
              <span className={`block text-2xl ${f.cls}`}>{f.sample}</span>
              <span className="mt-0.5 block text-xs text-muted">{f.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {t("Default sigue la fuente del estilo — Paper es serif; Terminal, Neon y Solarized son mono.")}
        </p>
      </div>

      {/* Reducir movimiento */}
      <Row
        title={t("Reducir movimiento")}
        desc={t("Apaga las animaciones no esenciales. También respeta la preferencia de tu sistema.")}
      >
        <Toggle on={s.reduceMotion} onChange={(reduceMotion) => setThemePartial({ reduceMotion })} />
      </Row>

      {/* Sonidos */}
      <SoundSettings />
    </div>
  );
}

/* ── Sonidos: master + por-categoría. Persistente en localStorage (notificationSound.ts).
   El master apaga todo; abajo se afinan las categorías (siguen deshabilitadas si el
   master está apagado). Un toque en cada toggle reproduce una muestra al encender. ── */
function SoundSettings() {
  const t = useT();
  const [prefs, setPrefs] = useState<SoundPrefs>(() => getSoundPrefs());
  const set = (key: "all" | (typeof SOUND_CATEGORIES)[number]["key"], on: boolean) => {
    setPrefs(setSoundPref(key, on));
    if (on) playNotificationSound(); // muestra al ENCENDER (confirma que suena)
  };
  return (
    <div>
      <Row
        title={t("Sonidos")}
        desc={t("Reproduce un sonido corto cuando llega algo nuevo. Apágalos todos o afina por tipo.")}
      >
        <Toggle on={prefs.all} onChange={(on) => set("all", on)} />
      </Row>
      <div className={`mt-3 space-y-2.5 border-l border-border pl-4 ${prefs.all ? "" : "pointer-events-none opacity-40"}`}>
        {SOUND_CATEGORIES.map((c) => (
          <div key={c.key} className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink">{t(c.label)}</span>
            <Toggle on={prefs.all && prefs[c.key]} onChange={(on) => set(c.key, on)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Preview de media paleta (Aa + 2 puntos de acento) para las tarjetas de estilo.
function PresetSwatch({ pal }: { pal: { surface: string; ink: string; brand: string; "brand-2": string } }) {
  return (
    <div
      className="flex flex-1 flex-col justify-between rounded-lg border border-black/10 p-1.5"
      style={{ background: pal.surface, color: pal.ink }}
    >
      <span className="text-xs font-semibold leading-none">Aa</span>
      <div className="mt-2 flex gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: pal.brand }} />
        <span className="h-2 w-2 rounded-full" style={{ background: pal["brand-2"] }} />
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className={`relative h-6 w-11 rounded-full transition ${on ? "bg-brand" : "bg-surface-3"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`}
      />
    </button>
  );
}

/* ── Perfil editable: nombre + avatar. El email lo ancla el IdP (read-only). El
   avatar se sube por /api/upload (→ Tigris, sin CORS) y se guarda su URL. Al guardar
   re-sella la sesión → invalidamos la cache de identidad para que el resto de la app
   lo refleje. ── */
function ProfileCard({
  user,
  isOwner,
}: {
  user: { sub: string; name: string; avatar: string; email: string };
  isOwner: boolean;
}) {
  const t = useT();
  const [name, setName] = useState(user.name ?? "");
  const [avatar, setAvatar] = useState(user.avatar ?? "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = name.trim() !== (user.name ?? "").trim() || avatar !== (user.avatar ?? "");

  async function onAvatar(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(t("No se pudo subir la imagen"));
      const up = (await res.json()) as { fileId: string };
      setAvatar(`/api/attachment/${encodeURIComponent(up.fileId)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("Error"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await updateMyProfileFn({ data: { name: name.trim() || undefined, avatar } });
      // La sesión cambió server-side → invalida la identidad cacheada para que el
      // resto de la app (rooms, header) lea el perfil nuevo en la próxima nav.
      clearMeCache();
      bumpUsers(); // directorio vivo → avatar/nombre nuevos en mensajes viejos + sidebar al instante
      window.dispatchEvent(new Event("gt:me-updated")); // revalida loader → header/sidebar/composer
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("Error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t("Cambiar foto")}
          className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-full border border-border"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center bg-surface-3 text-base font-semibold">
              {(name || user.name)?.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
            {uploading ? <Loader2 size={16} className="animate-spin text-white" /> : <Pencil size={14} className="text-white" />}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onAvatar(f);
          }}
        />
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            maxLength={60}
            placeholder={t("Tu nombre")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink"
          />
          <p className="mt-1 truncate px-1 text-xs text-muted">{user.email}</p>
        </div>
        <span className="self-start rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand">
          {isOwner ? t("Owner") : t("Miembro")}
        </span>
      </div>
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
      <div className="mt-3 flex justify-end">
        <button
          onClick={save}
          disabled={!dirty || saving || uploading}
          className="grid min-w-[92px] place-items-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? t("Guardado") : t("Guardar")}
        </button>
      </div>
    </div>
  );
}

/* ── Notificaciones push: avisa cuando te taggean (@tu-handle) ── */
function NotificationsCard() {
  const t = useT();
  const [state, setState] = useState<"loading" | "unsupported" | "denied" | "on" | "off">("loading");
  const [busy, setBusy] = useState(false);
  const [emailOn, setEmailOn] = useState<boolean | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  useEffect(() => {
    currentPushState().then(setState);
    getNotifyPrefsFn().then((p) => setEmailOn(p.emailNotifs)).catch(() => setEmailOn(false));
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
  async function toggleEmail() {
    if (emailOn == null || emailBusy) return;
    const next = !emailOn;
    setEmailOn(next);
    setEmailBusy(true);
    try { await setEmailNotifsFn({ data: { on: next } }); }
    catch { setEmailOn(!next); }
    finally { setEmailBusy(false); }
  }

  return (
    <>
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

    {/* Notificaciones por correo (opt-out). Solo se manda a offline; aquí lo apagas del todo. */}
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Mail size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("Notificaciones por correo")}</h2>
          <p className="text-xs text-muted">{t("Recibe un correo cuando te mencionan o te escriben por DM y no estás conectado.")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!!emailOn}
          disabled={emailOn == null || emailBusy}
          onClick={toggleEmail}
          title={emailOn ? t("Desactivar") : t("Activar")}
          className="shrink-0 disabled:opacity-50"
        >
          {/* Mismo patrón/geometría que <Toggle> (left explícito, no translate desde
              absolute sin left → evita el thumb chueco/desbordado entre browsers). */}
          <span className={`relative block h-6 w-11 rounded-full transition-colors ${emailOn ? "bg-brand" : "bg-surface-3"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${emailOn ? "left-[22px]" : "left-0.5"}`} />
          </span>
        </button>
      </div>
    </div>
    </>
  );
}

/* ── Emojis custom del workspace: imagen (o GIF) → :name: reaccionable ── */
// Cache de módulo (el `emojisCache` del chat es privado a c.$slug.tsx): reabrir la
// pestaña pinta al instante desde aquí y revalida en background (stale-while-revalidate).
let emojiCache: CustomEmoji[] | null = null;

function EmojiManager({ isOwner, mySub }: { isOwner: boolean; mySub: string | null }) {
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
        [...emojis.filter((e) => e.name !== saved), { name: saved, file_id: up.fileId, created_by: mySub }].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      bumpEmojis(); // picker + render de mensajes resuelven :saved: al instante (sin recargar)
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
    bumpEmojis();
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
                loading="lazy"
                decoding="async"
                className="h-5 w-5 object-contain"
              />
              <span className="text-xs text-muted">:{e.name}:</span>
              {/* Borrar: solo el owner o quien lo creó (emojis legacy sin creador → solo owner). */}
              {(isOwner || (!!mySub && e.created_by === mySub)) && (
                <button
                  onClick={() => remove(e.name)}
                  title={t("Eliminar")}
                  className="text-muted hover:text-red-400"
                >
                  <X size={13} />
                </button>
              )}
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
  avatar: string | null;
  system_prompt: string | null;
  enabled: number;
};

// Cache de módulo → reabrir la pestaña Agentes pinta al instante y revalida en background.
let agentsCache: ManagedAgent[] | null = null;

function AgentsManager({ isOwner, hasAgent }: { isOwner: boolean; hasAgent: boolean }) {
  const t = useT();
  const [agents, setAgents] = useState<ManagedAgent[] | null>(agentsCache);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null); // id del agente en edición
  const reload = () =>
    listManagedAgentsFn().then((a) => {
      agentsCache = a as ManagedAgent[];
      setAgents(agentsCache);
      bumpMentions(); // el picker del composer re-fetchea (sin agente fantasma)
    });
  useEffect(() => {
    reload();
  }, []);

  async function toggle(a: ManagedAgent) {
    setAgents((xs) => xs?.map((x) => (x.id === a.id ? { ...x, enabled: x.enabled ? 0 : 1 } : x)) ?? xs);
    await updateAgentFn({ data: { id: a.id, enabled: !a.enabled } }).then(() => bumpMentions()).catch(reload);
  }
  async function remove(a: ManagedAgent) {
    if (!confirm(t("¿Quitar @{handle}?", { handle: a.handle }))) return;
    setAgents((xs) => xs?.filter((x) => x.id !== a.id) ?? xs);
    await deleteAgentFn({ data: { id: a.id } }).then(() => bumpMentions()).catch(reload);
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Agentes")}</h2>
        {isOwner && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition hover:border-brand hover:text-ink"
          >
            <Plus size={14} /> {t("Agregar")}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">
        {isOwner
          ? t("Todos tus agentes en un solo lugar. Cada uno se tagea por su @handle. Crea y configura agentes gestionados en Studio, o conecta bots externos por webhook.")
          : t("Agentes que te compartieron para configurar. Se tagean por su @handle.")}
      </p>

      <div className="space-y-1">
        {/* @ghosty se migró a fila gc_agents (listManagedAgentsFn) → se renderiza en el
            mismo map con el MISMO card + panel que el resto. Aquí solo queda el CTA de
            conectar EasyBits cuando aún no hay agente del wizard. */}
        {isOwner && !hasAgent && (
          <Link
            to="/setup"
            className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2 py-3 text-sm text-muted hover:border-brand hover:text-ink"
          >
            <Bot size={17} className="shrink-0" /> {t("Conecta tu cuenta para tener a @ghosty")}
          </Link>
        )}

        {agents === null ? (
          <p className="px-2 py-1 text-sm text-muted">{t("Cargando…")}</p>
        ) : (
          agents.map((a) =>
            editing === a.id ? (
              <EditAgentForm
                key={a.id}
                agent={a}
                isOwner={isOwner}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  reload();
                }}
              />
            ) : (
              <div key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-3">
                {a.avatar ? (
                  <img src={a.avatar} alt="" loading="lazy" decoding="async" className="h-8 w-8 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
                    <Bot size={17} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {a.name} <span className="text-xs font-normal text-muted">@{a.handle}</span>
                  </p>
                  <p className="truncate text-xs text-muted">
                    {a.system_prompt
                      ? a.system_prompt
                      : a.kind === "fleet"
                        ? t("Agente gestionado · sin persona")
                        : t("Webhook externo · sin persona")}
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
                <button onClick={() => setEditing(a.id)} className="p-1 text-muted hover:text-brand" title={t("Configurar")}>
                  <Pencil size={15} />
                </button>
                {/* TODOS los agentes son manejables, incluido @ghosty. Borrar @ghosty
                    limpia también su config (server) para que no se re-materialice. */}
                {isOwner && (
                  <button onClick={() => remove(a)} className="p-1 text-muted hover:text-brand" title={t("Quitar")}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            )
          )
        )}
      </div>

      {adding && (
        <AddAgentForm
          connected={new Set((agents ?? []).map((a) => a.fleet_id).filter((x): x is string => !!x))}
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

function AddAgentForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void; connected: Set<string> }) {
  const t = useT();
  // "create" = agente nuevo (nace con su propio agente de cómputo, invisible) ·
  // "webhook" = bot externo · "formmy" = importar (próximamente, deshabilitado).
  const [tab, setTab] = useState<"create" | "webhook">("create");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [engine] = useState<"claude">("claude"); // hoy solo Claude; el alta real vive en Studio
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (tab === "create") {
        await createManagedAgentFn({ data: { handle: handle.trim(), name: name.trim(), engine } });
      } else {
        await createAgentFn({
          data: { handle: handle.trim(), name: name.trim(), kind: "webhook", webhookUrl: webhookUrl.trim() },
        });
      }
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
        {(["create", "webhook"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ${
              tab === k ? "bg-brand text-brand-fg" : "bg-surface-2 text-muted hover:text-ink"
            }`}
          >
            {k === "create" ? t("Crear agente") : t("Webhook externo")}
          </button>
        ))}
        {/* Importar desde Formmy — próximamente (deshabilitado). */}
        <button
          disabled
          title={t("Próximamente")}
          className="flex-1 cursor-not-allowed rounded-lg bg-surface-2 px-2 py-1.5 text-xs font-medium text-muted opacity-50"
        >
          {t("Importar de Formmy")}
        </button>
      </div>
      <div className="space-y-2">
        {tab === "create" ? (
          /* Los agentes gestionados se CREAN y configuran (prompt, modelo, canales) en
             Studio (gs), no inline en Teams. Redirige al panel de flota. */
          <div className="rounded-lg border border-border bg-surface-2 p-4 text-center">
            <p className="mb-3 text-xs text-muted">
              {t("Crea y configura agentes gestionados (prompt, modelo, canales) en Studio. Aparecen aquí automáticamente para @taguearlos.")}
            </p>
            <a
              href={STUDIO_AGENTS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-fg"
            >
              {t("Crear en Studio")} <ExternalLink size={14} />
            </a>
          </div>
        ) : (
          <>
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={t("https://tu-bot.com/webhook")}
              className={input}
            />
            <div className="flex gap-2">
              <div className="flex flex-1 min-w-0 items-center rounded-lg border border-border bg-surface pl-3 text-sm focus-within:border-brand">
                <span className="select-none text-muted">@</span>
                <input
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase())}
                  placeholder={t("handle (ej. soporte)")}
                  className="w-full min-w-0 bg-transparent py-2 pr-3 pl-1 outline-none"
                />
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("nombre visible")}
                className={`${input} flex-1 min-w-0`}
              />
            </div>
            {err && <p className="text-sm text-red-400">{err}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
                {t("Cancelar")}
              </button>
              <button
                onClick={create}
                disabled={busy || !handle.trim() || !webhookUrl.trim()}
                className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50"
              >
                {busy ? t("Agregando…") : t("Agregar")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Configurar un agente: persona (system prompt), avatar y nombre ── */
function EditAgentForm({
  agent,
  isOwner,
  onClose,
  onSaved,
}: {
  agent: ManagedAgent;
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(agent.name);
  const [handle, setHandle] = useState(agent.handle);
  const [persona, setPersona] = useState(agent.system_prompt ?? "");
  const [avatar, setAvatar] = useState(agent.avatar ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Colaboradores (solo owner los gestiona): pueden editar la config de este agente.
  const [collabs, setCollabs] = useState<{ sub: string; name: string; email: string }[]>([]);
  const [collabEmail, setCollabEmail] = useState("");
  const [collabBusy, setCollabBusy] = useState(false);
  useEffect(() => {
    if (isOwner) listAgentCollaboratorsFn({ data: { id: agent.id } }).then(setCollabs).catch(() => {});
  }, [isOwner, agent.id]);
  async function addCollab() {
    if (!collabEmail.trim() || collabBusy) return;
    setCollabBusy(true);
    setErr(null);
    try {
      await addAgentCollaboratorFn({ data: { id: agent.id, email: collabEmail.trim() } });
      setCollabEmail("");
      setCollabs(await listAgentCollaboratorsFn({ data: { id: agent.id } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
    } finally {
      setCollabBusy(false);
    }
  }
  async function removeCollab(sub: string) {
    setCollabs((cs) => cs.filter((c) => c.sub !== sub));
    await removeAgentCollaboratorFn({ data: { id: agent.id, sub } }).catch(() => {});
  }

  async function onAvatar(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(t("no se pudo subir la imagen"));
      const up = (await res.json()) as { fileId: string };
      setAvatar(`/api/attachment/${encodeURIComponent(up.fileId)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const cleanHandle = handle.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      await updateAgentFn({
        data: {
          id: agent.id,
          name: name.trim() || agent.name,
          handle: cleanHandle && cleanHandle !== agent.handle ? cleanHandle : undefined,
          systemPrompt: persona.trim() || null,
          avatar: avatar || null,
        },
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
      setBusy(false);
    }
  }

  // ESC cierra SOLO el modal superior (stack compartido) → editar agente sobre Ajustes
  // no cierra también Ajustes. Ver utils/modal-esc.
  useEffect(() => registerModalEsc(onClose), [onClose]);

  const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-5" onMouseDown={onClose}>
      <div
        className="flex h-full max-h-[94vh] w-full max-w-[min(1200px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <p className="text-sm font-semibold">
            {t("Configurar")} <span className="text-brand">@{handle || agent.handle}</span>
            <span className="ml-2 text-[11px] font-normal text-muted">
              {agent.kind === "fleet" ? t("Agente gestionado") : t("Webhook externo")}
            </span>
          </p>
          <button onClick={onClose} className="text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        {/* Cuerpo: izq (1/3) = identidad + persona local + colaboradores; der (2/3) =
            capacidades de flota. Full-width para aprovechar la pantalla. */}
        <div className="thin-scroll grid flex-1 grid-cols-1 gap-6 overflow-y-auto p-5 sm:p-6 lg:grid-cols-3">
          {/* ── Columna izquierda: identidad + persona local + colaboradores ── */}
          <div className="space-y-4 lg:col-span-1">
            <div className="flex items-center gap-3">
              {avatar ? (
                <img src={avatar} alt="" loading="lazy" decoding="async" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
              ) : (
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
                  <Bot size={24} />
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onAvatar(f); }} />
              <div className="flex flex-col gap-1">
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:border-brand hover:text-ink disabled:opacity-50">
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t("Imagen")}
                </button>
                {avatar && <button onClick={() => setAvatar("")} className="text-left text-xs text-muted hover:text-red-400">{t("Quitar imagen")}</button>}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Nombre visible")}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("nombre visible")} className={input} />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Handle (para @taguear)")}</label>
              <div className="flex items-center rounded-lg border border-border bg-surface focus-within:border-brand">
                <span className="pl-3 text-sm text-muted">@</span>
                <input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} placeholder="soporte" className="flex-1 bg-transparent px-1 py-2 text-sm outline-none" />
              </div>
              <p className="mt-1 text-[11px] text-muted">{t("Así lo mencionas en el chat: @{handle}", { handle: handle || "handle" })}</p>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Personalidad en este espacio")}</label>
              <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={8} placeholder={t("Tono, rol y reglas SOLO para este espacio (ej. más formal, cita la fuente, ofrece el siguiente paso)…")} className={`${input} thin-scroll resize-y`} />
              <p className="mt-1 text-[11px] text-muted">
                {agent.kind === "fleet"
                  ? t("Capa que se suma a la base SOLO en este espacio. No cambia quién es el agente; su identidad y el prompt base (todos los canales) van a la derecha. Déjala vacía para usar solo la base.")
                  : t("Se envía a tu webhook como systemPrompt junto al mensaje.")}
              </p>
            </div>

            {isOwner && (
              <div className="rounded-lg border border-border bg-surface-2 p-2.5">
                <p className="mb-1.5 text-xs font-semibold text-muted">{t("Colaboradores")}</p>
                {collabs.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {collabs.map((c) => (
                      <div key={c.sub} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">{c.name} <span className="text-muted">{c.email}</span></span>
                        <button onClick={() => removeCollab(c.sub)} className="text-muted hover:text-red-400" title={t("Quitar")}><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input value={collabEmail} onChange={(e) => setCollabEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCollab()} placeholder={t("email de un miembro")} className="flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
                  <button onClick={addCollab} disabled={collabBusy || !collabEmail.trim()} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50">{t("Agregar")}</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Columna derecha (2/3): capacidades de flota (o nota webhook) ── */}
          <div className="lg:col-span-2 lg:border-l lg:border-border lg:pl-6">
            {agent.kind === "fleet" ? (
              <FleetAgentControls agentId={agent.id} />
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted">
                {t("Los bots por webhook no tienen capacidades de flota. Su comportamiento lo controla tu servidor.")}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
          <span className="text-xs text-red-400">{err}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">{t("Cerrar")}</button>
            <button onClick={save} disabled={busy || uploading} className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50">
              {busy ? t("Guardando…") : t("Guardar")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
