import { forwardRef, Fragment, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from "react";
import { IDLE_MS } from "../lib/presence";
import { shouldChime } from "../lib/chime";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { Markdown as MarkdownExt } from "tiptap-markdown";
import { motion, AnimatePresence } from "motion/react";
import {
  Hash,
  Lock,
  Plus,
  Settings,
  Trash2,
  MessageSquare,
  Megaphone,
  Rocket,
  Wrench,
  Target,
  Lightbulb,
  Flame,
  BarChart3,
  Palette,
  Bug,
  CheckCircle2,
  Coffee,
  Waves,
  Users,
  Bot,
  Ghost,
  Flag,
  Pin,

  Star,
  MoreHorizontal,
  Link2,
  Bell,
  BellOff,
  Search,


  X,
  Menu,
  Paperclip,
  FileText,
  FolderOpen,
  Download,
  Loader2,
  Archive,
  Radio,
  ChevronDown,
  Headphones,

  Check,
  ChevronRight,
  Layers,


  ImagePlus,
  Home as HomeIcon,




  Github,
  GitPullRequest,
  ExternalLink,
  Brain,
} from "lucide-react";
import { searchMessagesFn } from "../server/search";
import {
  roomReposFn,
  githubInstallationReposFn,
  githubOpenPrsFn,
  addRoomRepoFn,
  removeRoomRepoFn,
  workspaceRoomReposFn,
} from "../server/room-repos";
import ConfirmModal from "../components/ConfirmModal";
import { createFileRoute, notFound, Link, useRouter } from "@tanstack/react-router";
import type { Channel, Message, DmConversation, RoomHit, ViewHit, CustomEmoji } from "../db.server";
import { listEmojisFn } from "../server/emojis";
import { recentViewFn, mentionsViewFn, starredViewFn } from "../server/views";
import { openDmFn, listDmsFn, getDmFlowFn, postDmMessageFn, askDmAgentFn, clearDmAgentFn, escalateDmAgentFn, deescalateDmAgentFn, dmEscalationFn } from "../server/dm";
import { startCallFn, joinCallFn, getActiveCallFn } from "../server/quick-calls";
// La llamada (dock, Room de LiveKit y avisos de entrante) vive en el store GLOBAL y se
// pinta desde la raíz: esta ruta ya no la posee, sólo la opera. Ver lib/call-store.ts.
import { openCall as openCallGlobal, leaveCall, refreshCallMutes, useMyCallKey, type CallTarget } from "../lib/call-store";
// Descriptor para unirse a una call desde una tarjeta del timeline.
import { listAgentsFn } from "../server/agents";
import { unreadCountsFn, markReadFn, lastReadFn } from "../server/reads";
import { unreadAnnouncementsFn, markAnnouncementSeenFn, type Announcement } from "../server/announcements";
import { toggleStarFn, togglePinFn, getPinsFn, toggleMuteFn, listMutesFn } from "../server/stars";
import { listMyWorkspacesFn } from "../server/workspaces";
import {
  getChannelView,
  getChannelFlow,
  getLiveTurnsFn,
  getThread,
  getChannelThreads,
  postMessage,
  askAgent,
  warmAgentFn,
  deleteMessageFn,
  listMentionsFn,
  pingTypingFn,
  toggleReactionFn,
  editMessageFn,
  listUsersFn,
  searchUsersFn,
  updateMyProfileFn,
  expelMemberFn,
  stopTurnFn,
} from "../server/chat";
import { SmilePlus, Pencil, ArrowLeft, RotateCcw, Send, Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Type, Reply, Square, Zap } from "lucide-react";
import { getDeferredPrompt, onInstallable, clearDeferredPrompt, type BeforeInstallPromptEvent } from "../utils/pwa-install";
import { useRtSubscribe } from "../utils/rt-bus";
import type { RtEvent } from "../server/bus.server";
import { Markdown } from "../components/Markdown";
import { Avatar } from "../components/Avatar";
import { SettingsContent, loadSettingsData } from "../components/SettingsContent";
import { Toggle } from "../components/Toggle";
import { getTheme, subscribeTheme, resolveDark, presetById, paletteVars } from "../utils/theme";
import { subscribeMentions } from "../utils/mentions-bus";
import { subscribeEmojis } from "../utils/emojis-bus";
import { subscribeUsers, bumpUsers } from "../utils/users-bus";
import { clearMeCache } from "../server/auth";
import ArtifactPanel, { type ArtifactView} from "../components/ArtifactPanel";
import { belongsToOpenConversation } from "../lib/conversation-scope";
import { extractEbDoc, extractEbPatches, draftTitle} from "../lib/ebdoc";
import { showSystemNotification } from "../utils/system-notification";
import { marcarCierre, limpiarCierre } from "../lib/panel-cerrando";
import { playNotificationSound, playGhostySound, playSelfSound, playMentionSound, playDmSound, playReadySound, playDeleteSound, playArtifactOpen, playArtifactClose, playArtifactReady } from "../utils/notificationSound";

// Menciones que cuentan como "a ti": tu @handle o una grupal (@all/@channel/…).
import { useT } from "../i18n";

type Mention = { handle: string; name: string; avatar: string; kind: "agent" | "user" | "group"; sub?: string | null };
import { me } from "../server/auth";
import {
  createChannelFn,
  updateChannelFn,
  setChannelEventFn,
  listEventRegistrationsFn,
  deleteChannelFn,
  getChannelMembersFn,
  addChannelMemberFn,
  removeChannelMemberFn,
  listWorkspaceUsersFn,
  listRoomMembersFn,
} from "../server/channels";

// Las piezas del chat viven en `components/chat/message.tsx` desde que los rooms
// abiertos también las pintan. Ver la cabecera de ese archivo.
import {



  ArtifactBoundary,




  ChatCtx,





  EmojiPicker,
  EmojiText,









  MessageRow,
  Modal,


















  artifactToView,









  plainExcerpt,






  ForwardModal,
} from "../components/chat/message";
import type {
  Attach,

  CallJoin,

  Optimistic,
  ProfileTarget,
  ReplyTarget,
  SessionUser,
  WsUser,
} from "../components/chat/message";

// `usersCache` se queda AQUÍ: es un `let` al que este archivo ASIGNA, y a un binding
// importado no se le puede asignar.
let usersCache: Map<string, WsUser> | null = null;


// Cache CLIENTE del shell (rooms + user). Navegar a un room que YA está en el
// sidebar resuelve el loader al instante (sin round-trip) → cambio de pantalla
// inmediato; el flujo sigue cargando client-side con su skeleton. SOLO cliente:
// en SSR cada request es de otro usuario → jamás cachear ahí (fuga cross-user).
let shellCache: { channels: Channel[]; user: Awaited<ReturnType<typeof me>> } | null = null;

export const Route = createFileRoute("/c/$slug")({
  /**
   * Foco del centro en la URL: `/c/<room>?thread=123` o `?dm=45`.
   *
   * Va aquí y no leyendo `location.search` a mano porque es lo que da tipos, validación y
   * `useSearch()` reactivo — el router ya resuelve el problema entero.
   *
   * ⚠️ El search llega PARSEADO como JSON, así que un `?thread=123` es NÚMERO y un
   * `?thread=abc` es string: por eso se normaliza con `Number()` y se descarta lo que no sea
   * un id positivo, en vez de exigir un tipo concreto. Un validador estricto tiraría el
   * parámetro y el router redirigiría a la URL sin él — el mismo tropiezo que costó el `?v=`
   * de los artefactos.
   */
  validateSearch: (search: Record<string, unknown>): { thread?: number; dm?: number } => {
    const id = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const thread = id(search.thread);
    const dm = id(search.dm);
    // Mutuamente excluyentes: el centro enseña una cosa a la vez.
    return thread != null ? { thread } : dm != null ? { dm } : {};
  },
  // El hilo y el flujo NO van en el loader (se cargan client-side con cache +
  // skeleton → abrir es instantáneo). El loader solo trae rooms + meta + user.
  loader: async ({ params }) => {
    // Prefetch del flujo + hilos del room. En SSR SIEMPRE (primer paint con datos).
    // En el cliente SOLO durante la hidratación inicial (`hydrated`=false): reusa el
    // cache si existe (switch entre rooms sigue instantáneo) y si no fetchea, para
    // que el render de hidratación sea IDÉNTICO al HTML del SSR. Sin esto había un
    // hydration mismatch (SSR pinta mensajes, el cliente re-corría el loader y
    // devolvía undefined → skeleton → React descartaba el SSR → parpadeo + recarga
    // de hilos al refresh). Tras hidratar, una nav a un room nuevo devuelve undefined
    // → skeleton instantáneo, comportamiento sin cambio.
    // 2026-07-24 (perf): el SSR ya NO prefetchea el flujo. Renderizar 80+ mensajes a
    // string en la caja (2 vCPU) dominaba el TTFB del documento (~15s medidos desde el
    // cliente, con los server-fn en 60-100ms). Ahora el documento trae la cáscara y el
    // flujo entra client-side con skeleton — camino que ya existía para navegar entre
    // rooms. La hidratación no se rompe porque el cliente arranca con el MISMO skeleton.
    // ...y en la HIDRATACIÓN tampoco: si el cliente re-corriera el loader y SÍ trajera el
    // flujo, su árbol no coincidiría con el skeleton del SSR → otro mismatch. Ambos lados
    // arrancan con skeleton y el flujo entra por el fetch client-side del componente (el
    // mismo camino que ya se usa al cambiar de room).
    const prefetch = false;

    // Ruta rápida (cliente ya hidratado): el room está en el sidebar → sin red.
    if (typeof window !== "undefined" && shellCache) {
      const channel = shellCache.channels.find((c) => c.slug === params.slug);
      if (channel) {
        const user = shellCache.user;
        getChannelView({ data: { slug: params.slug } })
          .then((v) => {
            if (v) shellCache = { channels: v.channels, user };
          })
          .catch(() => {});
        return { channels: shellCache.channels, channel, user, initialFlow: undefined, initialThreads: undefined };
      }
    }
    const _tl = performance.now();
    const [view, user] = await Promise.all([
      getChannelView({ data: { slug: params.slug } }),
      me(),
    ]);
    if (typeof window === "undefined") console.log(`[ssr loader shell ${Math.round(performance.now() - _tl)}ms] ${params.slug}`);
    if (!view) throw notFound();
    if (typeof window !== "undefined") shellCache = { channels: view.channels, user };

    let initialFlow: Awaited<ReturnType<typeof getChannelFlow>> | undefined;
    let initialThreads: Awaited<ReturnType<typeof getChannelThreads>> | undefined;
    if (prefetch) {
      const cachedFlow = typeof window !== "undefined" ? flowCache.get(params.slug) : undefined;
      const cachedThreads = typeof window !== "undefined" ? threadsCache.get(params.slug) : undefined;
      const _tf = performance.now();
      [initialFlow, initialThreads] = await Promise.all([
        cachedFlow ?? getChannelFlow({ data: { slug: params.slug } }).catch(() => undefined),
        cachedThreads ?? getChannelThreads({ data: { slug: params.slug } }).catch(() => undefined),
      ]);
      if (typeof window === "undefined") console.log(`[ssr loader flow ${Math.round(performance.now() - _tf)}ms] total=${Math.round(performance.now() - _tl)}ms`);
    }
    return { ...view, user, initialFlow, initialThreads };
  },
  component: ChannelPage,
});

type OnlinePeople = Map<string, { name: string; avatar?: string; lastActiveAt: number }>;
const ROOM_ICONS: { name: string; Icon: typeof Hash }[] = [
  { name: "hash", Icon: Hash },
  { name: "message", Icon: MessageSquare },
  { name: "megaphone", Icon: Megaphone },
  { name: "rocket", Icon: Rocket },
  { name: "wrench", Icon: Wrench },
  { name: "target", Icon: Target },
  { name: "lightbulb", Icon: Lightbulb },
  { name: "flame", Icon: Flame },
  { name: "chart", Icon: BarChart3 },
  { name: "palette", Icon: Palette },
  { name: "bug", Icon: Bug },
  { name: "check", Icon: CheckCircle2 },
  { name: "coffee", Icon: Coffee },
  { name: "waves", Icon: Waves },
  { name: "users", Icon: Users },
  { name: "bot", Icon: Bot },      // robot
  { name: "ghost", Icon: Ghost },  // ghosty 👾
  { name: "flag", Icon: Flag },    // bandera negra
];
const ROOM_ICON_MAP: Record<string, typeof Hash> = Object.fromEntries(
  ROOM_ICONS.map((i) => [i.name, i.Icon])
);
function RoomIcon({ name, size = 18, className }: { name?: string | null; size?: number; className?: string }) {
  const Icon = (name && ROOM_ICON_MAP[name]) || Hash;
  return <Icon size={size} className={className} />;
}

// ── Cache client-side (módulo) ─────────────────────────────────────────────
// TanStack Router cachea el LOADER; hilos/flujo cargan client-side, así que su
// cache la llevamos aquí: reabrir un hilo o volver a un room = instantáneo
// (mostramos lo cacheado y revalidamos en background, sin skeleton ni glitch).
const flowCache = new Map<string, Message[]>();
const threadsCache = new Map<string, Message[]>();
// `hydrated` = false hasta que el primer render del cliente se monta. Ya NO gatea el
// prefetch del loader (desde 2026-07-24 el flujo SIEMPRE entra client-side), pero se
// mantiene por si algún camino necesita distinguir la hidratación inicial.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let hydrated = false;
void hydrated;
// Guard para el chime de "app lista": se resetea al recargar (módulo re-ejecuta),
// así suena una vez por carga y no en cada cambio de room dentro de la SPA.
let readyChimePlayed = false;
// `pending` = sembramos el root al instante (sin skeleton en el detonador) pero las
// RESPUESTAS aún cargan → ThreadView les muestra skeleton hasta que getThread las trae.
const threadCache = new Map<number, { root: Message | null; replies: Message[]; pending?: boolean }>();
// DMs: la lista de conversaciones (una key fija) y el flujo por conversación.
const dmListCache = new Map<string, DmConversation[]>();
const dmFlowCache = new Map<number, Message[]>();
// Mensajes fijados por room (barra en el header).
const pinsCache = new Map<string, Message[]>();
// VIEWS (recientes/menciones/destacados): resultado por nombre de vista.
const viewCache = new Map<string, ViewHit[]>();

// ── Persistencia de los caches entre refresh (sessionStorage) ──────────────
// Solo persistimos los caches que NO participan del PRIMER render (hidratación):
// el hilo/DM abierto (`thread`/`dmFlow`) monta como estado-cliente DESPUÉS de
// hidratar (restaurado de localStorage) → se reabre instantáneo, sin tocar el SSR.
//
// ⚠️ NO persistir `flow`/`threads`/`pins`: SÍ se pintan en el primer render.
// - `flow`/`threads` ya llegan del loader SSR (`initialFlow`/`initialThreads`) → el
//   refresh los tiene en el primer paint SIN sessionStorage. Pero si además los
//   restaurábamos, `useCachedQuery` devolvía el cache VIEJO (has(key) gana sobre el
//   `initial` del SSR) → el cliente pintaba N msgs ≠ los del SSR.
// - `pins` NO se siembra en SSR (SSR pinta sin PinnedBar); restaurarlo hacía que el
//   cliente SÍ pintara PinnedBar.
// En ambos casos el árbol del cliente divergía del HTML del SSR → React tiraba en
// hidratación → lo atrapaba el errorComponent ("Se nos cruzó un cable") en CADA
// refresh (sessionStorage lo volvía determinista).
const PERSISTED_CACHES: [string, Map<unknown, unknown>][] = [
  ["thread", threadCache as Map<unknown, unknown>],
  ["dmFlow", dmFlowCache as Map<unknown, unknown>],
];

// Persiste los caches al sessionStorage. Módulo-scope para que lo llamen tanto los
// listeners (pagehide/visibilitychange) COMO el error boundary al EVICTAR una entrada
// envenenada (así el refresh no la restaura). No-op fuera del browser.
function persistCaches() {
  if (typeof window === "undefined") return;
  try {
    const out: Record<string, unknown> = {};
    for (const [name, cache] of PERSISTED_CACHES) out[name] = [...cache.entries()];
    sessionStorage.setItem("gc-caches-v3", JSON.stringify(out));
  } catch {
    /* quota/serialize → mejor esfuerzo, sin romper */
  }
}

// Una entrada cacheada puede quedar PARCIAL si se recicló la caja del worker a mitad de un
// stream (o si la serialización se truncó por quota). Validamos la forma AL CARGAR y
// descartamos las corruptas → `useCachedQuery` las re-fetchea limpias del server (los datos
// en la DB están intactos). Solo checamos los campos cuyo tipo malo CRASHEA el render
// (id/created_at/kind y que replies/flow sean arrays); los opcionales ya van guardados en
// MessageRow, así que no se rechazan entradas sanas.
function isRenderableMessage(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.id === "number" &&
    typeof x.created_at === "number" &&
    (x.kind === "msg" || x.kind === "status")
  );
}
function isValidThreadEntry(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const e = v as { root?: unknown; replies?: unknown };
  if (!Array.isArray(e.replies)) return false; // ← el crash de ThreadView (replies.length/.map)
  if (e.root != null && !isRenderableMessage(e.root)) return false;
  return e.replies.every(isRenderableMessage);
}
function isValidDmEntry(v: unknown): boolean {
  return Array.isArray(v) && v.every(isRenderableMessage); // ← el crash de DmView (flow.find/.map)
}

/**
 * Restaura las caches de sessionStorage. **Se llama DESPUÉS de hidratar**, nunca al
 * cargar el módulo.
 *
 * Antes corría en module-load, y ahí está el origen del `React error #418` que salía en
 * cada carga: el servidor no tiene sessionStorage, así que renderizaba sin esos datos y
 * el primer render del cliente los tenía. Mismatch garantizado — y con cada deploy el
 * cache es de otra versión del app, así que el purge-on-error de `router.tsx` sólo
 * limpiaba el destrozo en vez de evitarlo.
 *
 * No es cosmético: un fallo de hidratación hace que React REGENERE el árbol, y un árbol
 * regenerado se monta oculto un instante. Eso se llevaba por delante cosas que se pintan
 * sobre el DOM ya montado.
 *
 * Se pierde poco: el valor de estas caches está en cambiar de canal rápido, no en el
 * primer pintado (que viene del loader SSR de todos modos).
 */
let cachesRestauradas = false;
function restaurarCaches(): void {
  if (cachesRestauradas || typeof window === "undefined") return;
  cachesRestauradas = true;
  try {
    // v3: descarta v1/v2 envenenados. Bumpear ESTA versión al cambiar la forma de
    // Message/thread invalida los viejos antes de que rompan.
    sessionStorage.removeItem("gc-caches-v1");
    sessionStorage.removeItem("gc-caches-v2");
    const saved = JSON.parse(sessionStorage.getItem("gc-caches-v3") || "{}");
    for (const [name, cache] of PERSISTED_CACHES) {
      const entries = saved[name];
      if (!Array.isArray(entries)) continue;
      const ok = name === "thread" ? isValidThreadEntry : isValidDmEntry;
      // Entrada corrupta → se DESCARTA (no se inserta) → la key queda ausente y
      // useCachedQuery la re-fetchea limpia del server en vez de crashear el render.
      for (const [k, v] of entries) if (typeof k === "number" && ok(v)) cache.set(k, v);
    }
  } catch {
    /* ausente/corrupto → arranca vacío */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistCaches);
  // pagehide no siempre dispara (algunos móviles) → respaldo al ocultar la pestaña.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCaches();
  });
}

// Nonces de mensajes que ESTA pestaña envió → para descartar su propio eco vivo
// (ya se muestra optimista). Módulo: compartido entre Composer y el handler SSE.
const sentNonces = new Set<string>();

// Quote-reply: mensaje que el composer está citando (snapshot para UI + payload).
const STATUS_PRESETS: { emoji: string; text: string }[] = [
  { emoji: "🗓️", text: "En una reunión" },
  { emoji: "🎧", text: "En foco" },
  { emoji: "🍔", text: "Almorzando" },
  { emoji: "🏠", text: "Trabajando remoto" },
  { emoji: "🤒", text: "Enfermo" },
  { emoji: "🌴", text: "De vacaciones" },
  { emoji: "🚌", text: "En camino" },
];

// Toast in-app de notificación (sonido + aviso visual). onOpen enfoca el scope de origen.
type ToastItem = { id: string; sender: string; avatar: string; preview: string; kind: "dm" | "mention" | "room"; onOpen: () => void };

// Payload de envío del Composer → outbox. La cita (quote-reply) es opcional.
type SendPayload = {
  body: string;
  attachments: Attach[];
  quotedId?: number | null;
  quotedAuthor?: string | null;
  quotedExcerpt?: string | null;
};

// Contexto de chat (usuario + slug activo) para que MessageRow acceda sin prop-drilling.
/**
 * Frases del composer. Rotan para que el cuadro no se vuelva mobiliario invisible, y
 * casi todas enseñan algo que se puede pedir — es el único sitio donde alguien que
 * acaba de entrar descubre qué sabe hacer el agente.
 *
 * La elección es DETERMINISTA (hash del scope + la hora): el server y el cliente
 * calculan la misma, así que no hay parpadeo al hidratar, y aun así cambia sola a lo
 * largo del día y es distinta en cada room.
 */
const COMPOSER_HINTS = [
  "Pídele a Ghosty",
  "Pídele un documento",
  "Pídele una hoja",
  "Pídele que investigue",
  "Pídele una app",
  "Pídele un resumen",
  "Pídele una imagen",
  "Pídele un PDF",
  "Pídele que lo narre",
  "Pídele que abra un enlace",
  "Escríbele a tu equipo",
];

function composerHint(scope: string): string {
  const seed = `${scope}·${Math.floor(Date.now() / 3_600_000)}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COMPOSER_HINTS[h % COMPOSER_HINTS.length];
}

function threadTitle(m: Message): string {
  const lineas = (m.body || "").split("\n");
  let dentroDeFence = false;
  let texto = "";
  for (const raw of lineas) {
    const l = raw.trim();
    // Una cerca abre o cierra; el contenido de en medio es código o un artefacto y nunca
    // es un buen título.
    if (/^(`{3,}|~{3,})/.test(l)) {
      dentroDeFence = !dentroDeFence;
      continue;
    }
    if (dentroDeFence || !l) continue;
    const limpia = l
      .replace(/^#{1,6}\s+/, "") // encabezado
      .replace(/^>\s?/, "") // cita
      .replace(/^([-*+]|\d+[.)])\s+/, "") // viñeta o lista numerada
      .replace(/^\[[ xX]\]\s*/, "") // casilla de tarea
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // enlace o imagen → su texto
      .replace(/(\*\*\*|\*\*|\*|___|__|_|~~|`)/g, "") // énfasis y código en línea
      .trim();
    if (limpia) {
      texto = limpia;
      break;
    }
  }
  return texto.length > 40 ? texto.slice(0, 39) + "…" : texto;
}

// Sidebar: solo los N hilos más recientes; el resto vive en el modal "Ver todos".
// En el modal se revelan de a THREAD_PAGE (carga parcial sobre el array ya cacheado).
const THREAD_PREVIEW = 5;
const THREAD_PAGE = 20;

// Nombre visible de un DM = título del grupo o los nombres de los OTROS miembros.
function dmTitle(conv: DmConversation, fallback: string): string {
  if (conv.title) return conv.title;
  const names = conv.members.map((m) => m.name || m.email).filter(Boolean);
  return names.length ? names.join(", ") : fallback;
}

// Aplica un evento de reacción sobre un mensaje (inmutable).
function applyReaction(
  m: Message,
  ev: { emoji: string; op: "add" | "remove"; count: number; userSub: string },
  mySub?: string
): Message {
  const cur = m.reactions ?? [];
  if (ev.count <= 0) return { ...m, reactions: cur.filter((r) => r.emoji !== ev.emoji) };
  const existing = cur.find((r) => r.emoji === ev.emoji);
  const mine = ev.userSub === mySub ? ev.op === "add" : existing?.mine ?? false;
  // Mantiene el set de reactores (para el tooltip "quién reaccionó").
  const prevSubs = existing?.subs ?? [];
  const subs =
    ev.op === "add"
      ? prevSubs.includes(ev.userSub) ? prevSubs : [...prevSubs, ev.userSub]
      : prevSubs.filter((s) => s !== ev.userSub);
  const updated = { emoji: ev.emoji, count: ev.count, mine, subs };
  // Emoji YA presente → actualiza EN SU LUGAR (no reordena). Antes se filtraba y se
  // re-append al final → los chips se "intercambiaban" al reaccionar. Nuevo → al final.
  return existing
    ? { ...m, reactions: cur.map((r) => (r.emoji === ev.emoji ? updated : r)) }
    : { ...m, reactions: [...cur, updated] };
}

// Menciones disponibles (agentes + usuarios) para el typeahead @. Cache módulo.
let mentionsCache: Mention[] | null = null;
function useMentions(): Mention[] {
  const [mentions, setMentions] = useState<Mention[]>(mentionsCache ?? []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listMentionsFn().then((m) => {
        mentionsCache = m as Mention[];
        if (alive) setMentions(m as Mention[]);
      });
    load();
    // Re-fetch cuando cambian los agentes (crear/borrar/editar en Ajustes) → el picker
    // no queda con un agente fantasma tras borrarlo.
    const off = subscribeMentions(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return mentions;
}

// Directorio vivo de miembros (sub→perfil). Resuelve avatars/nombres en TODOS lados
// (mensajes viejos incluidos) → al editar tu avatar se ve al instante, como Slack. Cache
// módulo, refrescado por bus (edición propia) + al reenfocar (cross-cliente).
function useUsersMap(): Map<string, WsUser> {
  const [users, setUsers] = useState<Map<string, WsUser>>(usersCache ?? new Map());
  useEffect(() => {
    let alive = true;
    const load = () =>
      listUsersFn()
        .then((list) => {
          if (list.length === 0 && (usersCache?.size ?? 0) > 0) return; // no vaciar por error transitorio
          const m = new Map(list.map((u) => [u.sub, u as WsUser]));
          usersCache = m;
          if (alive) setUsers(m);
        })
        .catch(() => {});
    load();
    const off = subscribeUsers(load);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; off(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return users;
}

// Emojis custom del workspace (para picker + render de reacciones/cuerpo). Cache módulo.
let emojisCache: CustomEmoji[] | null = null;
function useEmojis(): CustomEmoji[] {
  const [emojis, setEmojis] = useState<CustomEmoji[]>(emojisCache ?? []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listEmojisFn()
        .then((e) => {
          // NO pisar una lista poblada con un resultado VACÍO: listCustomEmojis traga sus
          // errores como [] (fetch transitorio, hiccup de sqld) → sin esta guardia un
          // refresh fallido BORRABA todos los emojis del cliente ("se perdió el emoji").
          // Conservar lo que ya teníamos es más seguro que vaciar.
          if (e.length === 0 && (emojisCache?.length ?? 0) > 0) return;
          emojisCache = e;
          if (alive) setEmojis(e);
        })
        .catch(() => {});
    load();
    // Refresca al agregar/borrar en Ajustes (mismo cliente, instantáneo) …
    const off = subscribeEmojis(load);
    // … y al reenfocar la pestaña (cross-cliente barato: si otro subió un emoji, al
    // volver a la ventana se resuelve sin recargar). Solo cuando vuelve a visible.
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      off();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return emojis;
}

// Renderiza un código de reacción: `:name:` de emoji custom → <img>; si no, texto.
// `noTitle`: dentro de un chip de reacción el `title` del <img> le GANA al del botón
// (el tooltip nativo lo pone el elemento más interno), así que salía ":party_blob:" en
// vez de quién reaccionó.
function useCachedQuery<K, T>(
  cache: Map<K, T>,
  key: K,
  fetcher: () => Promise<T>,
  rev: number,
  patch = 0,
  initial?: T
): T | null {
  // El valor mostrado se LEE DEL CACHE EN CADA RENDER (no vía useState con lag) →
  // al cambiar de room, el render ya devuelve el cache de ESA key: instantáneo si
  // ya se vio (sin skeleton, sin flash del room anterior), skeleton solo si es nueva.
  // El fetch revalida en background y fuerza re-render cuando llega.
  // `initial` = valor prefetcheado en SSR (loader). Se siembra el cache y se usa
  // como fallback en el MISMO render → SSR e hidratación pintan idéntico (sin
  // skeleton ni mismatch) sin depender del timing del Map de módulo.
  if (initial != null && !cache.has(key)) cache.set(key, initial);
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    fetcher().then((d) => {
      if (!alive) return;
      cache.set(key, d);
      force((n) => n + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rev]);
  // Live-patch: un evento realtime mutó el Map (nueva ref) → re-render para releerlo.
  useEffect(() => {
    if (patch === 0) return;
    force((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);
  return cache.get(key) ?? initial ?? null;
}

// Auto-scroll de chat "pegado al fondo": sigue mensajes nuevos Y el crecimiento de
// contenido (streaming de la respuesta del agente rellena el body de UN mensaje → el
// conteo no cambia, por eso antes no scrolleaba). El guard `stick` evita tironear si
// el usuario subió a leer historia. `onScroll` (devuelto) va en el div scrollable.
function useChatScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  msgs: { body?: string | null }[] | null,
  extra: number,
  unreadId: number | null,
  resetKey?: unknown
) {
  // Envuelve el contenido del scroller → un ResizeObserver lo vigila y re-ancla al fondo
  // ante CUALQUIER crecimiento (imágenes lazy, streaming, fuentes) mientras sigamos pegados.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const didLand = useRef(false);
  const stick = useRef(true);
  // Estado REACTIVO de "¿estoy abajo?" → gatea el botón flotante "ir al final".
  const [atBottom, setAtBottom] = useState(true);
  const count = msgs?.length ?? 0;
  const contentLen = msgs?.reduce((n, m) => n + (m.body?.length ?? 0), 0) ?? 0;
  useEffect(() => {
    didLand.current = false;
  }, [resetKey]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = near;
    setAtBottom((prev) => (prev === near ? prev : near)); // solo re-render al cambiar
  };
  // Fuerza el scroll al fondo (envío propio / botón flotante), aunque estés arriba.
  const scrollToBottom = () => {
    stick.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (!el) return;
    // En móvil, al enviar el mensaje optimista aún no está en el DOM (setState) y el
    // teclado reflowa el layout después → un solo scroll aterriza en el alto viejo y
    // el mensaje recién enviado queda tapado. Reintentamos tras el render y el reflow.
    const jump = () => el.scrollTo({ top: el.scrollHeight });
    jump();
    requestAnimationFrame(jump);
    setTimeout(jump, 80);
    setTimeout(jump, 300);
  };
  useEffect(() => {
    // Tras aterrizar, RECALCULA atBottom con la posición real → el botón "ir al final"
    // aparece de una si el landing dejó mid-history (ej. salto al no-leído). Sin esto
    // atBottom quedaba stale-true hasta el primer scroll y el botón no salía al abrir.
    const measure = () => {
      const el = scrollRef.current;
      if (!el) return;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      setAtBottom((prev) => (prev === near ? prev : near));
    };
    if (unreadId != null && !didLand.current) {
      const el = document.getElementById(`msg-${unreadId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        didLand.current = true;
        requestAnimationFrame(measure);
        return;
      }
    }
    if (stick.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    requestAnimationFrame(measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, contentLen, extra, unreadId]);
  useEffect(() => {
    // El contenido crece DESPUÉS del primer paint (imágenes que decodifican —incluidas las
    // `loading=lazy` que aparecen al hacer scroll—, streaming del agente, fuentes) y empuja
    // por debajo. Un ResizeObserver sobre el wrapper del contenido reacciona a TODO ese
    // crecimiento (más robusto que escuchar `load` sólo de imágenes): si seguíamos pegados
    // al fondo re-anclamos; si no, recalculamos atBottom para que salga el botón "ir al final".
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // Al ABRIR/CERRAR el panel de artefacto la columna del chat cambia de ANCHO: el mismo
    // contenido reflowa a otra altura y, como scrollTop se conserva, la vista salta hacia
    // arriba. Ante un cambio de ancho conservamos la DISTANCIA AL FONDO (no scrollTop), que
    // es lo que el ojo percibe como "no se movió".
    let lastW = el.clientWidth;
    let bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Conservar la distancia al fondo NO basta leyendo historial: al angostarse la columna el
    // contenido crece por ARRIBA y por abajo, así que el hueco inferior se mantiene pero los
    // mensajes visibles se corren igual. El ojo se ancla a un MENSAJE, no al fondo — así que
    // eso es lo que seguimos: el primer mensaje visible y su offset dentro del viewport.
    let anchorEl: HTMLElement | null = null;
    let anchorTop = 0;
    // Mientras re-anclamos frame a frame, nuestras propias escrituras de scrollTop disparan
    // `scroll`: no re-capturamos el ancla en pleno reflow.
    let holding = false;
    const trackAnchor = () => {
      if (holding) return;
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + Math.min(40, box.width / 2), box.top + 8);
      const msg = hit?.closest?.('[id^="msg-"]') as HTMLElement | null;
      // Fuera del scroller (panel encima, pestaña oculta) → conserva el ancla anterior.
      if (msg && el.contains(msg)) {
        anchorEl = msg;
        anchorTop = msg.getBoundingClientRect().top - box.top;
      }
    };
    const trackGap = () => {
      bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
      trackAnchor();
    };
    el.addEventListener("scroll", trackGap, { passive: true });
    trackGap();
    // Reancla a la posición del mensaje guardado. Devuelve false si el ancla ya no sirve.
    const restoreAnchor = () => {
      if (!anchorEl || !el.contains(anchorEl)) return false;
      const delta = anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) el.scrollTop += delta;
      return true;
    };
    // El panel ANIMA su ancho (~340ms): el reflow del chat ocurre en muchos frames, no en
    // uno. Un solo reajuste al detectar el cambio no basta — la vista sigue desplazándose
    // durante el resto de la animación. Mantenemos el anclaje CADA FRAME mientras dura.
    let holdUntil = 0;
    const hold = () => {
      if (performance.now() > holdUntil) { holding = false; return; }
      // Pegado al fondo el ancla es el fondo; leyendo historial, el mensaje guardado, y sólo
      // si se perdió (virtualizado, borrado) caemos al hueco inferior de antes.
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (!restoreAnchor()) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - bottomGap);
      requestAnimationFrame(hold);
    };
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastW) {
        lastW = el.clientWidth;
        holdUntil = performance.now() + 600;
        if (!holding) { holding = true; requestAnimationFrame(hold); }
        if (!stick.current) {
          if (!restoreAnchor()) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - bottomGap);
          return;
        }
      }
      if (stick.current) {
        el.scrollTo({ top: el.scrollHeight });
      } else {
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        setAtBottom((prev) => (prev === near ? prev : near));
      }
    });
    ro.observe(content);
    ro.observe(el);
    return () => { ro.disconnect(); el.removeEventListener("scroll", trackGap); };
  }, [scrollRef]);
  return { onScroll, atBottom, scrollToBottom, contentRef };
}

function ChannelPage() {
  const { channels, channel, user, initialFlow, initialThreads } = Route.useLoaderData();
  // Foco pedido por la URL (`?thread=` / `?dm=`), tipado y reactivo por el router.
  const search = Route.useSearch();
  // Marca la hidratación como completa → el loader deja de prefetchear en las
  // navegaciones siguientes (solo lo hacía para igualar el SSR en el primer render).
  // Y AQUÍ se restauran las caches de sessionStorage: en module-load el servidor no las
  // tiene y el cliente sí, que es el mismatch de hidratación que salía en cada carga.
  useEffect(() => {
    hydrated = true;
    restaurarCaches();
  }, []);
  // Hilo / DM abierto = ESTADO CLIENTE (no URL) → abre instantáneo, sin revalidar el
  // router. Igual que los hilos, un DM se enfoca en el CENTRO (referencia Zulip).
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [openDmId, setOpenDmId] = useState<number | null>(null);
  // Artefacto abierto en el panel lateral (pdf/imagen; doc en Fase 3). Estado
  // cliente puro, como openThreadId — abre instantáneo sin tocar el router.
  const [openArtifact, setOpenArtifactRaw] = useState<ArtifactView | null>(null);
  /**
   * Abrir SIEMPRE limpia la marca de cierre (`lib/panel-cerrando`): abrir un artefacto es
   * exactamente lo contrario de cerrarlo, y si la marca quedara puesta el documento nuevo
   * nacería con sus controles flotantes escondidos.
   */
  const setOpenArtifact = useCallback((a: ArtifactView | null | ((p: ArtifactView | null) => ArtifactView | null)) => {
    if (a !== null) limpiarCierre();
    setOpenArtifactRaw(a as never);
  }, []);
  const openArtifactRef = useRef<ArtifactView | null>(null);
  openArtifactRef.current = openArtifact;
  // El índice de Documentos (📂) SIGUE el room/hilo actual: al navegar (cambia el channel o
  // el hilo abierto) se re-scopea → no queda stale mostrando otro room/hilo. Solo el docindex;
  // otros artefactos (un doc/office ya abierto) se quedan como estén.
  useEffect(() => {
    setOpenArtifact((cur) =>
      cur?.kind === "docindex"
        ? { kind: "docindex", title: cur.title, channelId: channel.id, channelSlug: channel.slug, threadRootId: openThreadId ?? undefined }
        : cur
    );
  }, [channel.id, channel.slug, openThreadId]);
  // Vista Zulip enfocada en el centro (recientes/menciones/destacados) — otro modo
  // de estado-cliente, mutuamente excluyente con hilo/DM. null = flujo del room.
  const [view, setView] = useState<null | "recent" | "mentions" | "starred">(null);
  // Home: dashboard de inicio (personaje Ghosty + resumen). Mutuamente excluyente con
  // room/hilo/DM/vista. Estado cliente puro (como `view`), se resetea al cambiar de room.
  const [homeOpen, setHomeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  // Drawer del sidebar en móvil (off-canvas). En ≥md el sidebar es fijo y esto se ignora.
  const [navOpen, setNavOpen] = useState(false);
  // Con el cajón abierto, el fondo NO se mueve. Es la otra mitad del arreglo: `overscroll`
  // evita que el gesto se propague al llegar al tope de la lista, pero un arrastre que
  // empieza fuera del área scrolleable seguiría moviendo el documento.
  // Se restaura el valor ANTERIOR, no se pone "": otro overlay (modal, panel) puede tener
  // el suyo puesto y dejarlo en blanco le devolvería el scroll a destiempo.
  useEffect(() => {
    if (!navOpen) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, [navOpen]);
  // Command palette (⌘K): salto rápido a room/DM/vista.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const emojis = useEmojis();
  const users = useUsersMap();
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
  // Toasts in-app: notificación VISUAL que acompaña al sonido (antes solo sonaba → la gente
  // no lo relacionaba con una notificación). Cada uno se auto-descarta; clic → salta al scope.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const pushToast = useCallback((tst: Omit<ToastItem, "id">) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev.slice(-3), { ...tst, id }]); // máx ~4 en pantalla
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);
  const [rev, setRev] = useState(0);
  const revalidate = () => setRev((r) => r + 1);
  // Live-patch: contador que sube cuando un evento realtime ya mutó un Map de cache
  // (con ref nueva) → useCachedQuery re-lee sin red. Separado de `rev` (que sí refetch).
  const [patch, setPatch] = useState(0);
  const applyPatch = () => setPatch((p) => p + 1);
  // sub -> {nombre, última señal}. Es un Map y no un Set porque el owner puede ver
  // QUIÉNES son, no sólo cuántos. `.has()`/`.size` se comportan igual, así que el resto
  // de usos no cambia.
  const [online, setOnline] = useState<OnlinePeople>(new Map());
  // ── Quick-calls ────────────────────────────────────────────────────────────
  // Una call activa por scope (canal/DM), sembrada por el bus (quickcall:started/ended)
  // y por getActiveCallFn al entrar. Alimenta las tarjetas y el header; la llamada en la
  // que ESTOY es del store global (lib/call-store), no de esta ruta.
  const [activeCalls, setActiveCalls] = useState<
    Map<string, { callId: string; host: { sub: string; name: string; avatar: string }; label: string; startedAt: number }>
  >(new Map());
  // La llamada en la que estoy la posee el store global (sobrevive a la navegación); aquí
  // sólo se lee para pintar los headers y las tarjetas.
  const myCallKey = useMyCallKey();
  const openCall = (
    fn: (o: { data: CallTarget }) => Promise<{ token: string; wss: string; room: string; name: string }>,
    scope: "room" | "dm",
    scopeId: number,
    target: CallTarget,
    label: string
  ) =>
    // El toast de error se queda en la ruta: las llamadas sólo se inician desde aquí, y un
    // fallo silencioso se lee como "el botón no sirve" (incidente 2026-07-26).
    openCallGlobal(fn, scope, scopeId, target, label, (raw) =>
      pushToast({
        sender: t("Llamada"),
        avatar: "",
        preview: /no disponible/i.test(raw)
          ? t("Las llamadas no están configuradas en este espacio.")
          : t("No se pudo abrir la llamada. Intenta de nuevo."),
        kind: "room",
        onOpen: () => {},
      })
    );
  // Título de la llamada = dónde/con quién es. El dock flota sobre toda la app, así que
  // "Llamada" a secas no dice nada: hay que poder saber de qué hilo salió sin volver a él.
  // El label que manda el server para un DM es genérico ("Llamada") porque el nombre a
  // mostrar depende de QUIÉN mira, así que se resuelve aquí.
  const dmCallLabel = (id: number) => {
    const d = dms.find((x) => x.id === id);
    const name = d ? d.title || d.members.map((m) => m.name).join(", ") : "";
    return name || t("Mensaje directo");
  };
  // Unirse a una call desde una tarjeta del timeline (CallCard).
  const joinCallFromCard = (join: CallJoin) => {
    if (join.scope === "room") openCall(joinCallFn, "room", join.scopeId, { scope: "room", slug: join.slug }, `#${join.label}`);
    else openCall(joinCallFn, "dm", join.dmId, { scope: "dm", dmId: join.dmId }, dmCallLabel(join.dmId));
  };
  // Semilla del call activo del canal actual (por si arrancó antes de que yo entrara).
  useEffect(() => {
    let alive = true;
    getActiveCallFn({ data: { scope: "room", slug: channel.slug } })
      .then((h) => {
        if (!alive) return;
        setActiveCalls((prev) => {
          const n = new Map(prev);
          if (h) n.set(`room:${channel.id}`, { callId: h.callId, host: h.host, label: h.label, startedAt: h.startedAt });
          else n.delete(`room:${channel.id}`);
          return n;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [channel.id, channel.slug]);
  // Semilla del call activo del DM que abro.
  useEffect(() => {
    if (openDmId == null) return;
    let alive = true;
    const id = openDmId;
    getActiveCallFn({ data: { scope: "dm", dmId: id } })
      .then((h) => {
        if (alive && h) setActiveCalls((prev) => new Map(prev).set(`dm:${id}`, { callId: h.callId, host: h.host, label: h.label, startedAt: h.startedAt }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [openDmId]);
  // No-leídos (Fase 1.5): badges por room y por DM. Semilla por unreadCountsFn;
  // incrementos vivos derivados de message:new (el SSE ya trae todos los rooms
  // visibles); reconcilia con el server al recibir el evento `unread` o reconectar.
  const [unreadRooms, setUnreadRooms] = useState<Map<number, number>>(new Map());
  const [unreadDms, setUnreadDms] = useState<Map<number, number>>(new Map());
  const refreshUnread = () =>
    unreadCountsFn()
      .then((u) => {
        setUnreadRooms(new Map(u.rooms.map((r) => [r.id, r.unread])));
        setUnreadDms(new Map(u.dms.map((d) => [d.id, d.unread])));
      })
      .catch(() => {});
  const bumpUnread = (scope: "room" | "dm", id: number) =>
    (scope === "room" ? setUnreadRooms : setUnreadDms)((prev) =>
      new Map(prev).set(id, (prev.get(id) ?? 0) + 1)
    );
  const clearUnread = (scope: "room" | "dm", id: number) =>
    (scope === "room" ? setUnreadRooms : setUnreadDms)((prev) =>
      prev.get(id) ? new Map(prev).set(id, 0) : prev
    );
  // Silencios (mute): Set de claves "room:id" / "dm:id" → dim + sin badge en el sidebar.
  const [mutes, setMutes] = useState<Set<string>>(new Set());
  const refreshMutes = () =>
    listMutesFn()
      .then((rows) => setMutes(new Set(rows.map((m) => `${m.scope}:${m.scope_id}`))))
      .catch(() => {});
  const toggleMute = (scope: "room" | "dm", id: number) => {
    const key = `${scope}:${id}`;
    // Optimista (el badge del scope silenciado desaparece al instante).
    setMutes((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
    toggleMuteFn({ data: { scope, scopeId: id } })
      .then(() => {
        refreshUnread();
        refreshCallMutes(); // el store tiene su propia copia: sin esto un scope recién silenciado seguiría timbrando
      })
      .catch(() => refreshMutes());
  };
  const [typing, setTyping] = useState<
    { sub: string; name: string; channelId: number | null; parentId: number | null; dmId: number | null } | null
  >(null);
  // Frontera de no-leídos del scope activo (last_read_at previo a abrirlo) → el
  // primer mensaje con created_at > at (y no mío) lleva el divisor "nuevos".
  const [boundary, setBoundary] = useState<{ key: string; at: number } | null>(null);
  // Un ÚNICO picker de reacciones abierto a la vez (Slack/Zulip): id del mensaje.
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // Mensaje que se está reenviando. Vive aquí y no dentro del botón: "puedo reenviar" es
  // una capacidad de la superficie, y el botón sólo la pide.
  const [reenviar, setReenviar] = useState<Message | null>(null);
  // Turnos de agente EN VUELO (id → estado). Lo alimenta el evento `turn` del bus; se
  // vacía solo al llegar el body final. Es lo que distingue "está trabajando" de "espera
  // su turno" y lo que da dónde colgar el botón de Detener.
  const [turns, setTurns] = useState<Map<number, { state: "running" | "queued"; position: number; startedAt: number }>>(new Map());
  // Turnos vivos ENRIQUECIDOS (agente, room, hilo) para el panel "Trabajando ahora" del
  // sidebar. `turns` sólo trae ids: no alcanza para decir QUIÉN trabaja ni DÓNDE, que es
  // justo lo que se pedía — con tres agentes en paralelo no había forma de verlos ni de
  // pararlos si no estabas parado en su hilo.
  const [liveTurns, setLiveTurns] = useState<Array<{
    id: number; state: "running" | "queued" | "stopped" | "done"; position: number; startedAt: number;
    agent: string; avatar: string; channelId: number | null; parentId: number | null; topic: string; dmId?: number | null; tarea?: string; paso?: string; outcome?: string;
  }>>([]);
  // ⚠️ El diff se calcula FUERA del actualizador de estado. Estaba dentro de
  // `setLiveTurns(prev => …)` llamando a `setDoneTurns` desde ahí, y React no garantiza ese
  // efecto secundario (puede re-ejecutar el updater): los terminados no llegaban a
  // registrarse y la fila simplemente desaparecía cuando ya no había tráfico.
  const liveTurnsRef = useRef<typeof liveTurns>([]);
  const refreshLiveTurns = useCallback(() => {
    getLiveTurnsFn()
      .then((r) => {
        // ⚠️ Se filtran los DETENIDOS, igual que en la siembra del montaje. `stopTurn` deja
        // la entrada 5s más como red anti-zombi, así que el reconcile la volvía a traer: la
        // fila reaparecía tras pulsar Detener —ahora sin botón— y al minuto se marcaba como
        // "terminó ✓". O sea: Detener parecía no funcionar y encima acabar bien.
        const todo = (r ?? []) as never as typeof liveTurns;
        // El servidor devuelve vivos + los que acabaron hace poco (leídos de gt_turns). Los
        // detenidos se descartan: `stopTurn` deja la entrada 5s más como red anti-zombi, y
        // sin este filtro la fila reaparecía tras pulsar Detener y acababa marcada como
        // "terminó ✓".
        const next = todo.filter((x) => x.state !== "stopped" && x.state !== "done");
        const yaHechos = todo.filter((x) => x.state === "done");
        if (yaHechos.length) {
          setDoneTurns((d) => {
            const nuevos = yaHechos.filter((h) => !d.some((x) => x.id === h.id));
            return nuevos.length
              ? [...d, ...nuevos.map((h) => ({ ...h, state: "done" as const, doneAt: Date.now() }))]
              : d;
          });
        }
        const vivos = new Set(next.map((x) => x.id));
        const recienTerminados = liveTurnsRef.current.filter((x) => !vivos.has(x.id));
        liveTurnsRef.current = next;
        setLiveTurns(next);
        if (recienTerminados.length) {
          setDoneTurns((d) => [
            ...d.filter((x) => !recienTerminados.some((y) => y.id === x.id)),
            ...recienTerminados.map((x) => ({ ...x, state: "done" as const, doneAt: Date.now() })),
          ]);
        }
      })
      .catch(() => {});
  }, []);
  // Los que acaban de terminar, con su marca de tiempo para retirarlos solos.
  const [doneTurns, setDoneTurns] = useState<Array<(typeof liveTurns)[number] & { doneAt: number }>>([]);
  useEffect(() => {
    if (!doneTurns.length) return;
    const h = setInterval(() => {
      // Minutos, no segundos: el aviso está para que te enteres de que terminó, y quien no
      // tenía la pestaña delante en ese instante también tiene que poder verlo. Se retira
      // solo, y al abrirlo desaparece — ya lo viste.
      setDoneTurns((d) => d.filter((x) => Date.now() - x.doneAt < 5 * 60 * 1000));
    }, 1000);
    return () => clearInterval(h);
  }, [doneTurns.length]);
  // Se refresca al montar, cada vez que cambia el mapa de turnos (o sea con cada evento SSE
  // de turno) y con un latido lento por si se pierde un evento.
  // ⚠️ La dependencia es el CONTENIDO del mapa, no su tamaño: si un turno termina justo
  // cuando otro empieza, `size` no cambia y el efecto no vuelve a correr — la lista se
  // quedaba enseñando al que acabó e ignorando al que arrancó (visto 2026-08-03 con blue
  // terminando y gaspar arrancando a la vez).
  const clavePorTurnos = [...turns.keys()].sort((a, b) => a - b).join(",");
  useEffect(() => {
    refreshLiveTurns();
  }, [refreshLiveTurns, clavePorTurnos]);
  useEffect(() => {
    // ⚠️ Late mientras haya algo QUE PINTAR, no mientras el mapa `turns` tenga entradas.
    // El panel se dibuja con `liveTurns` (lo que dice el servidor) y `turns` viene del SSE:
    // si el evento de cierre no llega, el mapa queda vacío, el latido nunca arranca y la
    // fila se congela para siempre enseñando un agente que ya terminó — visto con gaspar a
    // los 2:37 (2026-08-03).
    if (!turns.size && !liveTurns.length && !doneTurns.length) return;
    // RECONCILE, no sondeo. La barra se pinta con el evento `turn` del SSE, que llega con
    // todo el contexto; esto es sólo la red por si se pierde un evento. Antes eran 8s, o sea
    // 2 consultas por turno vivo cada 8s POR PESTAÑA — con tres agentes y tres pestañas,
    // ~135 consultas por minuto para pintar seis renglones.
    const h = setInterval(refreshLiveTurns, 60000);
    return () => clearInterval(h);
  }, [refreshLiveTurns, turns.size, liveTurns.length, doneTurns.length]);

  // Siembra los turnos EN VUELO al montar. El estado de un turno llega por SSE (`t:"turn"`)
  // y un evento no se puede volver a escuchar: quien recargaba a media respuesta se quedaba
  // sin cronómetro, sin Detener y sin ninguna señal de que el agente seguía trabajando —
  // el mensaje se veía idéntico a uno terminado.
  useEffect(() => {
    let vivo = true;
    getLiveTurnsFn()
      .then((states) => {
        if (!vivo || !states?.length) return;
        setTurns((prev) => {
          const next = new Map(prev);
          for (const s of states) {
            // `stopped`/`done` no son turnos en vuelo: la burbuja no debe ofrecer Detener.
            if (s.state === "stopped" || s.state === "done") continue;
            next.set(s.id, { state: s.state, position: s.position, startedAt: s.startedAt });
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const channelsById = useMemo(() => new Map(channels.map((c) => [c.id, c.slug])), [channels]);
  const router = useRouter();

  // Detener un turno. Optimista: la burbuja deja de ofrecer "Detener" al instante, y el
  // server confirma con el body final ("⏹ Detenido") — que es lo que de verdad cierra el
  // turno. Si el clic llegó tarde (ya terminaba), no pasa nada: no hay qué parar.
  const stopTurnLocal = (messageId: number) => {
    setTurns((prev) => {
      if (!prev.has(messageId)) return prev;
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
    // El panel se pinta con `liveTurns` (servidor), no con este mapa: sin quitarlo aquí
    // también, "Detener" no movía nada en la barra hasta el siguiente latido y parecía roto.
    setLiveTurns((prev) => prev.filter((x) => x.id !== messageId));
    liveTurnsRef.current = liveTurnsRef.current.filter((x) => x.id !== messageId);
    void stopTurnFn({ data: { messageId } })
      .catch(() => {})
      .finally(() => refreshLiveTurns());
  };

  // Parchea un mensaje (por id) en el flujo activo y en cualquier hilo cacheado (inmutable).
  const patchMessage = (id: number, fn: (m: Message) => Message) => {
    const arr = flowCache.get(channel.slug);
    if (arr && arr.some((m) => m.id === id))
      flowCache.set(channel.slug, arr.map((m) => (m.id === id ? fn(m) : m)));
    for (const [tid, t] of threadCache) {
      const hitRoot = t.root?.id === id;
      const hitReply = t.replies.some((m) => m.id === id);
      if (hitRoot || hitReply)
        threadCache.set(tid, {
          root: hitRoot && t.root ? fn(t.root) : t.root,
          replies: hitReply ? t.replies.map((m) => (m.id === id ? fn(m) : m)) : t.replies,
        });
    }
    for (const [did, arr] of dmFlowCache) {
      if (arr.some((m) => m.id === id))
        dmFlowCache.set(did, arr.map((m) => (m.id === id ? fn(m) : m)));
    }
    applyPatch();
  };

  // ── Artefacto en vivo (Canvas / OLA 2) ───────────────────────────────────────
  // Cuando el agente redacta un doc dentro de ```eb-doc```, el fence llega por los
  // deltas del mensaje; lo streameamos al panel (kind:"draft") y, al cerrarse, el
  // server compila el .docx y lo cuelga del mensaje → swap del draft al doc real.
  const draftMsgIdRef = useRef<number | null>(null);
  // Si CIERRAS el panel mientras el agente escribe el artefacto, no se te vuelve a abrir
  // por ese mensaje. El auto-abrir sigue (ver el bloque de abajo: verlo armarse es lo que
  // se pidió), pero cada token reabría el panel y cerrarlo no servía de nada hasta que el
  // agente terminaba.
  // ⚠️ Un CONJUNTO, no un id suelto. Guardando uno solo, cerrar el panel silenciaba a ese
  // mensaje y el siguiente chunk de OTRO agente lo reabría al instante: con varios
  // redactando a la vez, cerrar el artefacto era imposible (reportado varias veces, medido
  // el 2026-08-03). Cada documento que cierras se queda cerrado.
  const draftDismissedRef = useRef<Set<number>>(new Set());
  // El hilo (parent_id) del borrador en curso, para no pintar su píldora en los hilos ajenos.
  const draftParentRef = useRef<number | null>(null);
  const [hiddenDraftParent, setHiddenDraftParent] = useState<number | null>(null);
  // Lo que se está armando ahora mismo con el panel CERRADO. Es el mango para volver:
  // sin esto, cerrar durante la construcción te dejaba sin manera de mirar hasta que el
  // agente publicara la card. (Claude/ChatGPT usan la card del mensaje como mango; aquí
  // la card sólo existe al terminar, así que esta píldora cubre justo esa ventana.)
  const [hiddenDraft, setHiddenDraft] = useState<ArtifactView | null>(null);
  // Sonido del agente al PRIMER token (no al crear la cáscara vacía): ids ya sonados
  // para no repetir en cada re-pintado del stream. Ver message:body/message:delta.
  const chimedAgentIds = useRef<Set<number>>(new Set());
  const findMessageInCaches = (id: number): Message | undefined => {
    for (const arr of flowCache.values()) {
      const m = arr.find((x) => x.id === id);
      if (m) return m;
    }
    for (const t of threadCache.values()) {
      if (t.root?.id === id) return t.root;
      const m = t.replies.find((x) => x.id === id);
      if (m) return m;
    }
    for (const arr of dmFlowCache.values()) {
      const m = arr.find((x) => x.id === id);
      if (m) return m;
    }
    return undefined;
  };
  // Suena el sonido oficial del agente UNA vez, al primer token de su reply (no al crear la
  // caja vacía). Gate por mute del scope; ignora el foco (quieres oír que empezó a responder).
  const maybeChimeAgent = (id: number) => {
    if (chimedAgentIds.current.has(id)) return;
    const m = findMessageInCaches(id);
    if (!m || m.agent_handle == null || m.mentions_ghosty !== 0) return;
    chimedAgentIds.current.add(id);
    const muteKey = m.dm_id != null ? `dm:${m.dm_id}` : `room:${m.channel_id}`;
    if (!mutes.has(muteKey)) playGhostySound();
  };
  // "Artefacto terminado": suena UNA vez por mensaje, al cerrarse el fence. Necesita
  // dedupe propio porque los deltas SIGUEN llegando después del cierre (la frase de
  // contexto que el agente escribe tras el bloque) → sin el Set sonaría en cada delta.
  const chimedArtifactIds = useRef<Set<number>>(new Set());
  const maybeChimeArtifactReady = (id: number) => {
    if (chimedArtifactIds.current.has(id)) return;
    chimedArtifactIds.current.add(id);
    playArtifactReady();
  };
  const draftSeenLenRef = useRef(0);
  const driveDraftFromBody = (id: number, body: string) => {
    const doc = extractEbDoc(body);
    // EDICIÓN QUIRÚRGICA: el turno trae ```eb-patch``` en vez del artefacto entero. No hay
    // documento nuevo que pintar — se reemplazan nodos del que YA está en el panel. Solo
    // aplica si el panel muestra ese artefacto; si no hay nada abierto, el `refresh` del
    // final traerá la versión nueva (no abrimos un panel a media edición).
    if (!doc) {
      // ⚠️ El cuerpo ya no trae fence. Casi siempre significa que el turno TERMINÓ: el server
      // persiste el body sin el bloque (`bubbleWithoutEbDoc` lo corta), así que el momento
      // `doc.closed` —que era el único que limpiaba la píldora— NUNCA llega y "Armando ·
      // <doc>" se quedaba colgada para siempre después de entregar (2026-08-03).
      setHiddenDraft((d) => (d && "messageId" in d && d.messageId === id ? null : d));
      const patches = extractEbPatches(body);
      if (!patches.length) return;
      if (!belongsToOpenConversation(findMessageInCaches(id), openDmId, channel.id)) return;
      // DOCUMENTO: no hay preview cliente que aplicar (los bloques los parchea el
      // server). Se espera la versión nueva y se abre el panel en ella.
      const enDoc = !openArtifact || openArtifact.kind === "doc" || (openArtifact.kind === "draft" && !openArtifact.artifact);
      if (enDoc && patches.every((p) => p.closed)) {
        // Si el documento YA está abierto, se le pasan los alias del patch para que marque
        // AHORA: el editor tiene el documento que el agente vio, así que los alias casan y
        // los nodos están montados. Esperar la republicación era el orden equivocado.
        setOpenArtifact((cur) =>
          cur?.kind === "doc" ? { ...cur, patchRefs: patches.map((p) => p.nodeId) } : cur,
        );
        scheduleDocOpen(id);
        return;
      }
      setOpenArtifact((cur) => {
        const base =
          cur?.kind === "artifact" ? cur.html : cur?.kind === "draft" && cur.artifact ? cur.content : null;
        if (base == null) return cur;
        return {
          kind: "draft",
          title: cur!.title,
          content: base,
          sheet: false,
          artifact: true,
          streaming: !patches.every((p) => p.closed),
          patches,
          messageId: cur?.kind === "artifact" ? cur.messageId : cur?.kind === "draft" ? cur.messageId : undefined,
        };
      });
      return;
    }
    if (!doc.md.trim()) return;
    // El stream SSE trae los mensajes de TODOS los rooms visibles + DMs: sin este filtro,
    // un artefacto que un agente arma en #general te abría el panel aunque estuvieras
    // leyendo un DM (reportado 2026-07-24). Solo maneja el draft si el mensaje pertenece
    // a la conversación que el usuario tiene ABIERTA.
    if (!belongsToOpenConversation(findMessageInCaches(id), openDmId, channel.id)) return;
    // TRAZA (temporal): ¿el artefacto llega en gotitas o de un golpe? Cada línea es una
    // actualización del bloque; si solo sale UNA, el runtime no está streameando el bloque
    // y el preview no puede pintarse "token por token" por más que el iframe lo permita.
    if (doc.kind === "artifact") {
      const prev = draftSeenLenRef.current;
      draftSeenLenRef.current = doc.md.length;
      console.log(`[gt-draft] +${doc.md.length - prev}b total=${doc.md.length}b closed=${doc.closed} t=${Math.round(performance.now())}ms`);
    }
    draftMsgIdRef.current = id;
    // De qué HILO salió este borrador. La píldora "Armando · <doc>" es `fixed` y global a la
    // ruta: con tres agentes escribiendo a la vez, el último se la quedaba y aparecía en los
    // hilos de los otros — se veía como si escribieran el mismo documento (2026-08-03).
    // `findMessageInCaches` ya se llamó arriba para el filtro de conversación.
    draftParentRef.current = findMessageInCaches(id)?.parent_id ?? null;
    const draftView = (): ArtifactView => ({
      kind: "draft",
      title: draftTitle(doc.md, doc.kind, doc.fenceTitle),
      content: doc.md,
      sheet: doc.kind === "sheet",
      artifact: doc.kind === "artifact",
      streaming: !doc.closed,
      messageId: id,
    });
    // Lo cerraste a propósito: no se reabre solo (cada token lo reabría y cerrarlo no
    // servía de nada). Se guarda para poder volver cuando tú quieras.
    if (draftDismissedRef.current.has(id)) {
      setHiddenDraft(doc.closed ? null : draftView());
      setHiddenDraftParent(doc.closed ? null : draftParentRef.current);
      return;
    }
    // Lo que abriste TÚ manda: mientras lo tengas abierto, ningún borrador te lo quita.
    if (panelManualRef.current && openArtifactRef.current) {
      // Pero que no se pierda: queda como píldora para volver cuando quieras.
      if (!doc.closed) {
        setHiddenDraft(draftView());
        setHiddenDraftParent(draftParentRef.current);
      }
      return;
    }
    setOpenArtifact((cur) => {
      // Auto-abre si no hay panel, si ya estamos en el draft, o si está abierto el doc/hoja
      // que se está editando (para ver la edición EN VIVO). NO pisa otro artefacto (pdf/imagen…).
      // HTML en construcción: SIEMPRE toma el panel — el usuario quiere ver armarse el
      // artefacto cada vez que el agente escribe HTML (pedido explícito 2026-07-25). Para
      // doc/hoja seguimos siendo respetuosos: no pisamos un pdf/imagen ya abierto.
      // ⚠️ EL PANEL ES DE QUIEN LLEGÓ PRIMERO, hasta que cierre. Antes bastaba con que el
      // panel tuviera un borrador para pisarlo, sin mirar de QUÉ mensaje era: con dos o tres
      // agentes redactando a la vez, cada chunk de cada uno se llevaba el panel y se veían
      // "flashes" alternando entre documentos distintos (2026-08-03). Cuando el dueño cierra
      // su fence, el panel pasa a `doc` y el siguiente puede tomarlo en su próximo chunk.
      if (cur?.kind === "draft" && cur.messageId != null && cur.messageId !== id) return cur;
      if (doc.kind !== "artifact" && cur && cur.kind !== "draft" && cur.kind !== "doc" && cur.kind !== "sheet" && cur.kind !== "artifact") return cur;
      return {
        kind: "draft",
        title: draftTitle(doc.md, doc.kind, doc.fenceTitle),
        content: doc.md,
        sheet: doc.kind === "sheet",
        artifact: doc.kind === "artifact",
        streaming: !doc.closed,
        messageId: id, // ancla del stream progresivo (/api/artifact-stream/:id)
      };
    });
  };
  // Al cerrarse el fence, el server produce el .docx (refresh → refetch cuelga el
  // artifact). Poll acotado sobre las caches → swap del draft al doc real.
  /**
   * Un `eb-patch` sobre un DOCUMENTO no tiene borrador que streamear: el cambio lo aplica
   * el server y llega como versión nueva con el `refresh`. Sin esto el panel se quedaba
   * cerrado y la persona sólo veía la tarjeta — pidió un cambio y no se lo enseñábamos.
   *
   * Espera a que el artefacto cuelgue del mensaje (igual que scheduleDraftSwap: publicar
   * tarda) y entonces lo abre. NO le roba el panel a un pdf/imagen que estés mirando, y
   * el editor se encarga de llevarte al bloque y marcarlo (ver `changedIds`).
   */
  const scheduleDocOpen = (id: number, kind: "doc" | "artifact" = "doc") => {
    let tries = 0;
    const tick = () => {
      const m = findMessageInCaches(id);
      if (m?.artifact?.kind === kind) {
        // No le roba el panel a un pdf/imagen que estés mirando; sí releva a un borrador
        // o a otro documento, que es lo que acabas de dejar atrás.
        setOpenArtifact((cur) =>
          !cur || cur.kind === "draft" || cur.kind === "doc" || cur.kind === "artifact"
            ? artifactToView(m.artifact!)
            : cur,
        );
        return;
      }
      if (++tries < 60) setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  };

  const scheduleDraftSwap = (id: number) => {
    let tries = 0;
    const tick = () => {
      const m = findMessageInCaches(id);
      if (m?.artifact) {
        setOpenArtifact((cur) => (cur?.kind === "draft" ? artifactToView(m.artifact!) : cur));
        draftMsgIdRef.current = null;
        return;
      }
      // 60 intentos (~30s): publicar un artefacto grande a storage tarda más que los
      // 6s de antes → el panel se quedaba en "Construyendo…" para siempre aunque el
      // mensaje ya decía "listo".
      if (++tries < 60) setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  };

  // Reacción OPTIMISTA: parchea la cache al instante (el chip aparece/desaparece
  // sin esperar red) y dispara el server; el eco realtime confirma el count
  // autoritativo. Si el server falla, revalida para reconciliar.
  const react = (m: Message, emoji: string) => {
    const mySub = user?.sub;
    patchMessage(m.id, (msg) => {
      const prev = (msg.reactions ?? []).find((r) => r.emoji === emoji);
      const wasMine = prev?.mine ?? false;
      const op: "add" | "remove" = wasMine ? "remove" : "add";
      const count = (prev?.count ?? 0) + (wasMine ? -1 : 1);
      return applyReaction(msg, { emoji, op, count, userSub: mySub ?? "" }, mySub);
    });
    toggleReactionFn({ data: { slug: channel.slug, messageId: m.id, emoji } }).catch(() => revalidate());
  };

  // Quita un mensaje de todas las caches (flujo, hilos, DMs). Reusado por el
  // evento message:deleted y por el borrado optimista.
  const removeMessageLocal = (id: number) => {
    for (const [slug, arr] of flowCache)
      if (arr.some((m) => m.id === id)) flowCache.set(slug, arr.filter((m) => m.id !== id));
    for (const [tid, t] of threadCache)
      if (t.replies.some((m) => m.id === id))
        threadCache.set(tid, { root: t.root, replies: t.replies.filter((m) => m.id !== id) });
    for (const [did, arr] of dmFlowCache)
      if (arr.some((m) => m.id === id)) dmFlowCache.set(did, arr.filter((m) => m.id !== id));
    // Si el mensaje borrado era la RAÍZ de un hilo, el server borra el hilo en cascada;
    // reflejarlo aquí quita su submenú del sidebar (threadsCache) y su thread cacheado.
    for (const [slug, roots] of threadsCache)
      if (roots.some((m) => m.id === id)) threadsCache.set(slug, roots.filter((m) => m.id !== id));
    if (threadCache.has(id)) threadCache.delete(id);
    applyPatch();
  };

  // Mutaciones OPTIMISTAS de mensaje: patch local inmediato + server en 2º plano.
  // El eco realtime confirma (idempotente, trae el valor absoluto); si falla, revalida.
  const star = (m: Message) => {
    patchMessage(m.id, (msg) => ({ ...msg, starred: !msg.starred }));
    toggleStarFn({ data: { messageId: m.id } }).catch(() => revalidate());
  };
  const pin = (m: Message) => {
    patchMessage(m.id, (msg) => ({ ...msg, pinned: !msg.pinned }));
    togglePinFn({ data: { messageId: m.id } }).catch(() => revalidate());
  };
  // Borrado destructivo → NO optimista: espera al server (spinner en el modal) y
  // recién entonces quita local. El eco realtime message:deleted es idempotente.
  const remove = async (m: Message) => {
    try {
      await deleteMessageFn({ data: { id: m.id } });
      removeMessageLocal(m.id);
      playDeleteSound();
    } catch {
      revalidate();
    }
  };
  const editMsg = (m: Message, body: string) => {
    patchMessage(m.id, (msg) => ({ ...msg, body, edited_at: Date.now() }));
    editMessageFn({ data: { slug: channel.slug, id: m.id, body } }).catch(() => revalidate());
  };

  // Flujo del room: cacheado → volver a un room es instantáneo (sin skeleton si ya se vio).
  const messages = useCachedQuery(
    flowCache,
    channel.slug,
    () => getChannelFlow({ data: { slug: channel.slug } }),
    rev,
    patch,
    initialFlow ?? undefined
  );
  // Hilos del room (nacen al responder a un mensaje) → se listan como submenús del
  // sidebar; al abrir uno se enfoca en el centro (no en un drawer derecho).
  const threads =
    useCachedQuery(
      threadsCache,
      channel.slug,
      () => getChannelThreads({ data: { slug: channel.slug } }),
      rev,
      patch,
      initialThreads ?? undefined
    ) ?? [];
  // Conversaciones directas del usuario (sección "Mensajes directos" del sidebar).
  const dmsRaw = useCachedQuery(dmListCache, "list", () => listDmsFn(), rev, patch);
  const dms = dmsRaw ?? [];
  const dmsLoading = dmsRaw === undefined; // aún sin resolver → skeleton (no "vacío" falso)
  // Mensajes fijados del room activo (barra en el header del flujo).
  const pins =
    useCachedQuery(pinsCache, channel.slug, () => getPinsFn({ data: { slug: channel.slug } }), rev, patch) ?? [];

  // ── Realtime: aplica eventos entrantes sobre los Maps de cache (patch, sin red) ──
  const onEvent = (ev: RtEvent) => {
    switch (ev.t) {
      case "message:new": {
        // Eco de mi propio envío. NO basta descartarlo: hay que ATERRIZARLO como real y
        // retirar el optimista. Si sólo se descarta, mi mensaje sigue siendo optimista (se
        // renderiza en un bloque AL FINAL) y la CÁSCARA del agente —que llega como mensaje
        // real justo después (DM/hilo a un agente)— se pinta ENCIMA de mi mensaje, y luego
        // "salta" abajo al recargar. Al promover mi eco al flujo, la cáscara (created_at
        // posterior, llega después) ordena naturalmente DESPUÉS de mi mensaje. Sin sonido
        // ni badge (es mío).
        if (ev.nonce && sentNonces.has(ev.nonce)) {
          sentNonces.delete(ev.nonce);
          setOptimistic((prev) => prev.filter((o) => o.nonce !== ev.nonce));
          if (ev.msg.dm_id != null) {
            const arr = dmFlowCache.get(ev.msg.dm_id);
            if (arr && !arr.some((m) => m.id === ev.msg.id)) dmFlowCache.set(ev.msg.dm_id, [...arr, ev.msg]);
          } else if (ev.msg.parent_id == null) {
            const slug = channelsById.get(ev.msg.channel_id);
            if (slug) {
              const arr = flowCache.get(slug);
              if (arr && !arr.some((m) => m.id === ev.msg.id)) flowCache.set(slug, [...arr, ev.msg]);
            }
          } else {
            const th = threadCache.get(ev.msg.parent_id);
            if (th && !th.replies.some((m) => m.id === ev.msg.id))
              threadCache.set(ev.msg.parent_id, { root: th.root, replies: [...th.replies, ev.msg] });
          }
          // Yo lo envié → avanza MI cursor de lectura en el server para ese scope. Sin esto,
          // mi propio mensaje queda con created_at > last_read_at → reaparece como no-leído
          // (badge) al recargar/renavegar. (Este es el path común: eco de mi misma pestaña.)
          if (ev.msg.dm_id != null) markReadFn({ data: { scope: "dm", scopeId: ev.msg.dm_id } }).catch(() => {});
          else if (ev.msg.parent_id == null) markReadFn({ data: { scope: "room", scopeId: ev.msg.channel_id } }).catch(() => {});
          applyPatch();
          return;
        }
        // ¿El mensaje es MÍO? (llegó por SSE sin match de nonce: eco tardío, u otra
        // pestaña/dispositivo). Identidad estable por sub; fallback a nombre en legacy.
        // Nunca debe sonar ni badgear (yo lo envié).
        const isMine = ev.msg.sender_sub
          ? ev.msg.sender_sub === user?.sub
          : ev.msg.sender === user?.name;
        // ¿Realmente lo estoy viendo? = scope enfocado Y pestaña visible. Gatea sonido,
        // toast, notificación de escritorio Y el auto-marcado de leído.
        const visible = typeof document !== "undefined" && document.visibilityState === "visible";
        const inFocus =
          (openDmId != null && ev.msg.dm_id === openDmId) ||
          (openThreadId != null && ev.msg.parent_id === openThreadId) ||
          (openDmId == null && view == null && openThreadId == null &&
            ev.msg.dm_id == null && ev.msg.parent_id == null && ev.msg.channel_id === channel.id);
        const activeScope = inFocus && visible;
        // La REGLA de si suena vive en `lib/chime.ts`, no aquí: los rooms abiertos también
        // suenan, y una segunda copia de "cuándo suena" diverge al primer matiz.
        const chime = shouldChime(ev.msg, {
          miSub: user?.sub, miNombre: user?.name, miHandle: user?.handle,
          activeScope, mutes,
        });
        if (chime) {
          const mentionsMe = chime === "mention";
          {
            if (chime === "dm") playDmSound();
            else if (mentionsMe) playMentionSound();
            else playNotificationSound();
            // Aviso VISUAL que acompaña al sonido: toast in-app + (si la pestaña está oculta)
            // notificación de escritorio. Resuelve "suena pero no tengo notificaciones".
            const kind: ToastItem["kind"] = ev.msg.dm_id != null ? "dm" : mentionsMe ? "mention" : "room";
            const preview = plainExcerpt(ev.msg.body) || (ev.msg.attachments?.length ? "📎 Adjunto" : "");
            const dmId = ev.msg.dm_id, chId = ev.msg.channel_id, parentId = ev.msg.parent_id;
            const onOpen = () => {
              // Limpia SIEMPRE Inicio/vista (si no, el Home tapa la conversación y "no lleva").
              setHomeOpen(false); setView(null);
              if (dmId != null) { setOpenThreadId(null); setOpenDmId(dmId); }
              else if (parentId != null) { setOpenDmId(null); setOpenThreadId(parentId); }
              else {
                setOpenDmId(null); setOpenThreadId(null);
                const s = channelsById.get(chId);
                if (s && s !== channel.slug) router.navigate({ to: "/c/$slug", params: { slug: s } });
              }
            };
            pushToast({ sender: ev.msg.sender, avatar: ev.msg.avatar, preview, kind, onOpen });
            if (!visible) showSystemNotification(ev.msg.sender, preview, dmId != null ? undefined : channelsById.get(chId));
          }
        }
        // DM: parchea el flujo del DM y refresca la lista (orden / nueva conversación).
        if (ev.msg.dm_id != null) {
          const arr = dmFlowCache.get(ev.msg.dm_id);
          if (arr && !arr.some((m) => m.id === ev.msg.id))
            dmFlowCache.set(ev.msg.dm_id, [...arr, ev.msg]);
          // Auto-marca leído SOLO si de verdad lo estoy viendo (scope enfocado + pestaña
          // visible) o si es mío; si la pestaña está oculta → badgea (acumula no-leído).
          if (isMine || (openDmId === ev.msg.dm_id && visible))
            markReadFn({ data: { scope: "dm", scopeId: ev.msg.dm_id } }).catch(() => {});
          else bumpUnread("dm", ev.msg.dm_id);
          // No revalidar la cáscara de un agente (streaming): refetcharía el body vacío
          // del DB y pisaría los deltas. El orden del DM ya se refresca al done.
          if (!ev.msg.agent_handle) revalidate();
          applyPatch();
          return;
        }
        const slug = channelsById.get(ev.msg.channel_id);
        if (!slug) return;
        if (ev.msg.parent_id == null) {
          const arr = flowCache.get(slug);
          if (arr && !arr.some((m) => m.id === ev.msg.id)) flowCache.set(slug, [...arr, ev.msg]);
          // Badge del room (solo top-level, como cuenta el server). Auto-marca leído SOLO si
          // de verdad lo estoy viendo (room activo + pestaña visible) o si es mío; oculto →
          // badgea (acumula no-leído aunque el room esté "abierto" pero miro a otro lado).
          if (isMine || (openDmId == null && ev.msg.channel_id === channel.id && visible))
            markReadFn({ data: { scope: "room", scopeId: ev.msg.channel_id } }).catch(() => {});
          else bumpUnread("room", ev.msg.channel_id);
        } else {
          const t = threadCache.get(ev.msg.parent_id);
          if (t && !t.replies.some((m) => m.id === ev.msg.id))
            threadCache.set(ev.msg.parent_id, { root: t.root, replies: [...t.replies, ev.msg] });
          const arr = flowCache.get(slug);
          if (arr)
            flowCache.set(
              slug,
              arr.map((m) =>
                m.id === ev.msg.parent_id ? { ...m, reply_count: (m.reply_count ?? 0) + 1 } : m
              )
            );
          // Un hilo pudo nacer (primer reply) → refresca la lista de hilos del sidebar.
          // PERO no para la cáscara de un agente (streaming): un revalidate a media
          // corriente refetcha el body aún vacío del DB y pisa los deltas ya pintados.
          // El hilo ya nació del mensaje del usuario; el sidebar se refresca al done
          // (askAgent().then(revalidate)). Contrato: docs/AGENT-MEDIA-CONTRACT.md §1.2.
          if (!ev.msg.agent_handle) revalidate();
        }
        applyPatch();
        break;
      }
      case "message:deleted": {
        removeMessageLocal(ev.id); // idempotente — ya pudo quitarlo el borrado optimista
        break;
      }
      case "reaction":
        patchMessage(ev.messageId, (m) => applyReaction(m, ev, user?.sub));
        break;
      case "message:edited":
        patchMessage(ev.id, (m) => ({ ...m, body: ev.body, edited_at: ev.edited_at }));
        break;
      case "turn": {
        // Estado del turno de agente: corriendo o esperando su lugar en la cola. Vive en
        // memoria (no en el mensaje): es de la sesión, no del historial — al recargar, un
        // turno que ya terminó no debe seguir diciendo "en espera".
        setTurns((prev) => {
          const next = new Map(prev);
          if (ev.state === "stopped" || ev.state === "done") next.delete(ev.id);
          else next.set(ev.id, { state: ev.state, position: ev.position, startedAt: ev.startedAt });
          return next;
        });
        // …y la barra "Trabajando ahora" se pinta con ESTE evento, sin preguntar. Antes el
        // cliente sondeaba cada 8 s (2 consultas por turno vivo y por pestaña) y comparaba
        // dos fuentes de verdad: de esa comparación salieron tres bugs en una tarde.
        if (ev.state === "stopped" || ev.state === "done") {
          const fila = liveTurnsRef.current.find((x) => x.id === ev.id);
          liveTurnsRef.current = liveTurnsRef.current.filter((x) => x.id !== ev.id);
          setLiveTurns(liveTurnsRef.current);
          // Terminado ≠ detenido: sólo lo que ACABÓ deja constancia en la lista.
          if (ev.state === "done") {
            setDoneTurns((d) => {
              const yaEsta = d.find((x) => x.id === ev.id);
              // Puede llegar DOS veces: el "terminó" y, un instante después, el mismo estado
              // con el resumen (que se calcula tras publicar el artefacto). La segunda sólo
              // enriquece a la primera; si llegara sola, no hay fila que enriquecer.
              const base = fila ?? yaEsta;
              if (!base) return d;
              return [
                ...d.filter((x) => x.id !== ev.id),
                { ...base, state: "done" as const, outcome: ev.outcome ?? yaEsta?.outcome, doneAt: yaEsta?.doneAt ?? Date.now() },
              ];
            });
          }
        } else {
          const fila = {
            id: ev.id, state: ev.state, position: ev.position, startedAt: ev.startedAt,
            agent: ev.agent ?? "", avatar: ev.avatar ?? "", channelId: ev.channelId ?? null,
            parentId: ev.parentId ?? null, dmId: ev.dmId ?? null, topic: "", tarea: ev.tarea, paso: ev.paso,
          };
          const resto = liveTurnsRef.current.filter((x) => x.id !== ev.id);
          liveTurnsRef.current = [...resto, fila];
          setLiveTurns(liveTurnsRef.current);
        }
        break;
      }
      case "message:delta": {
        // Streaming del reply de un agente, pedacito a pedacito: appendea el chunk
        // al body del mensaje-cáscara ya visible.
        let nb = "";
        patchMessage(ev.id, (m) => {
          nb = (m.body ?? "") + ev.chunk;
          return { ...m, body: nb };
        });
        if (ev.chunk.trim()) maybeChimeAgent(ev.id); // primer token → sonido del agente
        driveDraftFromBody(ev.id, nb); // artefacto en vivo si hay ```eb-doc```
        break;
      }
      case "message:body": {
        // Body autoritativo al terminar el stream (reconcilia deltas perdidos). PERO si
        // llega EN BLANCO y ya había texto streameado, NO lo borres: deepseek/ghosty-gc a
        // veces cierra el turno con un body final vacío ("(sin respuesta)"/"") que hacía
        // DESAPARECER una respuesta ya renderizada. Conserva lo visible si el autoritativo
        // viene vacío.
        const blank = !(ev.body ?? "").trim();
        // El body autoritativo cierra el turno: si quedara en el mapa, la burbuja
        // seguiría ofreciendo "Detener" algo que ya respondió.
        setTurns((prev) => {
          if (!prev.has(ev.id)) return prev;
          const next = new Map(prev);
          next.delete(ev.id);
          return next;
        });
        patchMessage(ev.id, (m) => (blank && (m.body ?? "").trim() ? m : { ...m, body: ev.body }));
        if (!blank) {
          maybeChimeAgent(ev.id); // primer contenido del reply → sonido del agente
          driveDraftFromBody(ev.id, ev.body);
          // Fence cerrado → el server compila el .docx; swap del draft al doc real.
          const doc = extractEbDoc(ev.body);
          if (doc?.closed) {
            maybeChimeArtifactReady(ev.id); // terminó de generarse → chime
            scheduleDraftSwap(ev.id);
          }
          // Patches cerrados → MISMO swap. El preview aplica los patches en vivo sobre su
          // propia copia (para que se vea ocurrir), pero la VERDAD es la versión que
          // publica el server; sin este swap el panel se quedaba con su composición y
          // divergía (una tarjeta añadida que no aparecía hasta cerrar y reabrir el
          // artefacto — 2026-07-25).
          else {
            const ps = extractEbPatches(ev.body);
            if (ps.length && ps.every((p) => p.closed)) scheduleDraftSwap(ev.id);
          }
        }
        break;
      }
      case "refresh":
        // Churn de agente/status (room o DM) → refetch del contexto activo (rev).
        if (ev.channelId === channel.id || ev.dmId != null) revalidate();
        break;
      case "unread":
        // Otra pestaña/dispositivo cambió el read-state → reconcilia con el server.
        refreshUnread();
        break;
      case "pin":
        // Fijado/desfijado en un room (visible para todos): actualiza el flag del
        // mensaje y, si es el room activo, refresca la barra de fijados.
        patchMessage(ev.messageId, (m) => ({ ...m, pinned: ev.pinned }));
        if (ev.channelId === channel.id) revalidate();
        break;
      case "star":
        // Marcado personal → sincroniza el flag en mis otras pestañas.
        patchMessage(ev.messageId, (m) => ({ ...m, starred: ev.starred }));
        break;
      // "ábreme esto": hoy lo manda el formulario recién creado. Llega sólo a quien lo pidió
      // (canal personal), así que abrir el panel no le quita la pantalla a nadie más. Espera
      // a que el artefacto cuelgue del mensaje, igual que el documento.
      case "artifact:open":
        scheduleDocOpen(ev.messageId, "artifact");
        break;
      case "presence:init":
        setOnline(new Map(ev.online.map((p) => [p.sub, { name: p.name, avatar: p.avatar, lastActiveAt: p.lastActiveAt }])));
        break;
      case "presence":
        setOnline((prev) => {
          const n = new Map(prev);
          if (ev.status === "online") n.set(ev.sub, { name: ev.name, avatar: ev.avatar, lastActiveAt: ev.lastActiveAt });
          else n.delete(ev.sub);
          return n;
        });
        break;
      case "typing":
        // Room/hilo (channelId del room activo) o DM (dmId). El emisor se ignora.
        if (ev.sub !== user?.sub && (ev.dmId != null || ev.channelId === channel.id)) {
          setTyping({
            sub: ev.sub,
            name: ev.name,
            channelId: ev.channelId,
            parentId: ev.parentId ?? null,
            dmId: ev.dmId ?? null,
          });
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTyping(null), 3500);
        }
        break;
      // El aviso de ENTRANTE, el ring y mi propio dock los maneja el store global
      // (lib/call-store): tienen que funcionar también fuera de esta ruta. Aquí sólo se
      // mantiene el Map de calls activas, que es lo que pintan las tarjetas y los headers.
      case "quickcall:started": {
        const k = `${ev.scope}:${ev.scopeId}`;
        setActiveCalls((prev) => new Map(prev).set(k, { callId: ev.callId, host: ev.host, label: ev.label, startedAt: ev.startedAt }));
        break;
      }
      case "quickcall:ended": {
        const k = `${ev.scope}:${ev.scopeId}`;
        setActiveCalls((prev) => {
          if (!prev.has(k)) return prev;
          const n = new Map(prev);
          n.delete(k);
          return n;
        });
        break;
      }
    }
  };
  // Al (re)conectar o volver a la pestaña: catch-up (refetch de lo montado) → lossless.
  // Reconcilia también los no-leídos (pudo llegar algo con la pestaña dormida).
  // El EventSource lo abre la RAÍZ (CallLayer): aquí sólo nos suscribimos al fan-out.
  useRtSubscribe({
    onEvent,
    onReconnect: () => {
      revalidate();
      refreshUnread();
    },
  });
  // Semilla inicial de no-leídos y silencios (badges del sidebar).
  useEffect(() => {
    refreshUnread();
    refreshMutes();
  }, []);
  // Chime de "app lista": una vez por CARGA de página (el guard de módulo se
  // resetea en un reload → re-suena; pero no en cambios de room dentro de la SPA).
  useEffect(() => {
    if (readyChimePlayed) return;
    readyChimePlayed = true;
    playReadySound();
  }, []);
  // En el MOUNT restaura el foco del centro tras un reload (deploy/refresh) desde
  // sessionStorage; en cambios de room POSTERIORES cierra el foco (vuelve al flujo).
  // Distinguir mount de room-switch evita que el reset pise lo restaurado.
  const didRestoreFocus = useRef(false);
  useEffect(() => {
    if (!didRestoreFocus.current) {
      didRestoreFocus.current = true;
      // La URL manda, y la aplica el efecto de `search` de abajo. Aquí sólo se sale para no
      // pisarla con el foco guardado.
      if (search.thread != null || search.dm != null) return;
      try {
        const raw = sessionStorage.getItem(`focus:${channel.slug}`);
        if (raw) {
          const f = JSON.parse(raw) as { view?: typeof view; dm?: number; thread?: number; home?: boolean; room?: boolean };
          if (f.home) setHomeOpen(true);
          else if (f.view) setView(f.view);
          else if (f.dm != null) setOpenDmId(f.dm);
          else if (f.thread != null) setOpenThreadId(f.thread);
          // f.room → canal plano (homeOpen queda false).
        } else {
          // Primera entrada (sin foco guardado) → Teams arranca en INICIO, no en el canal.
          setHomeOpen(true);
        }
      } catch {
        /* sessionStorage/JSON inválido → arranca en el flujo */
      }
      return;
    }
    // Cambio de room DENTRO de la SPA. Si la URL trae foco, lo aplica el efecto de `search`;
    // aquí sólo se evita el reset que lo pisaría.
    if (search.thread != null || search.dm != null) return;
    setOpenThreadId(null);
    setOpenDmId(null);
    setView(null);
    setHomeOpen(false);
    // ⚠️ Y se libera la reserva del panel. Si no, abrir un artefacto a mano en un room y
    // cambiarte a otro SIN cerrarlo dejaba la reserva puesta el resto de la sesión: ningún
    // borrador volvía a auto-abrirse nunca más.
    panelManualRef.current = false;
  }, [channel.slug]);
  /**
   * El foco que pide la URL. Reactivo: `useSearch()` re-corre esto en cada navegación, así
   * que un deep-link funciona igual entrando en frío, cambiando de room dentro de la SPA o
   * con el botón atrás — sin leer `location` a mano ni duplicar la lógica en dos efectos.
   */
  useEffect(() => {
    if (search.thread != null) {
      setOpenThreadId(search.thread);
      setOpenDmId(null);
      setView(null);
      setHomeOpen(false);
    } else if (search.dm != null) {
      setOpenDmId(search.dm);
      setOpenThreadId(null);
      setView(null);
      setHomeOpen(false);
    }
  }, [search.thread, search.dm]);
  /**
   * …y al revés: abrir un hilo o un DM DESDE la app escribe la URL. Así el enlace siempre
   * dice la verdad y el botón atrás recorre lo que la persona hizo.
   *
   * `replace` para no llenar el historial con cada clic, y la comparación de igualdad es la
   * guarda contra el bucle con el efecto de arriba: sin ella, uno escribiría el search y el
   * otro el estado, en redondo.
   */
  useEffect(() => {
    // Hay un salto de canal en vuelo: este efecto NO puede escribir la ruta con el slug
    // viejo. Se suelta en cuanto el canal ya es el destino.
    if (saltandoA.current) {
      if (channel.slug === saltandoA.current) saltandoA.current = null;
      return;
    }
    const quiere = openThreadId != null ? { thread: openThreadId } : openDmId != null ? { dm: openDmId } : {};
    const tiene = search.thread != null ? { thread: search.thread } : search.dm != null ? { dm: search.dm } : {};
    if (quiere.thread === tiene.thread && quiere.dm === tiene.dm) return;
    router.navigate({ to: "/c/$slug", params: { slug: channel.slug }, search: quiere, replace: true });
  }, [openThreadId, openDmId, search.thread, search.dm, channel.slug]);
  // Persiste el foco actual (mutuamente excluyente) para sobrevivir un reload.
  useEffect(() => {
    // Siempre persiste algo (incluido `{room}` = canal plano) para que un reload en un
    // canal restaure el canal y NO caiga al default de Inicio (primera-entrada).
    const f = homeOpen ? { home: true } : view ? { view } : openDmId != null ? { dm: openDmId } : openThreadId != null ? { thread: openThreadId } : { room: true };
    try {
      sessionStorage.setItem(`focus:${channel.slug}`, JSON.stringify(f));
    } catch {
      /* storage lleno/bloqueado → no crítico */
    }
  }, [homeOpen, view, openDmId, openThreadId, channel.slug]);
  // Cambiar de contexto (room/hilo/DM/vista/inicio) descarta la cita pendiente — su
  // referente pertenece al contexto donde se citó; arrastrarla a otro sería confuso.
  useEffect(() => {
    setReplyTo(null);
  }, [homeOpen, view, openDmId, openThreadId, channel.slug]);
  // Enfocar un room (sin DM ni vista abiertos): PRIMERO captura la frontera de
  // no-leídos (last_read_at previo → divisor "nuevos mensajes"), LUEGO marca leído
  // y baja el badge. El orden importa: markRead pisa last_read_at con now().
  useEffect(() => {
    if (openDmId != null || view != null) return;
    const key = `room:${channel.id}`;
    lastReadFn({ data: { scope: "room", scopeId: channel.id } })
      .then((r) => setBoundary({ key, at: r.at }))
      .catch(() => setBoundary({ key, at: 0 }))
      .finally(() => {
        markReadFn({ data: { scope: "room", scopeId: channel.id } }).catch(() => {});
        clearUnread("room", channel.id);
      });
  }, [channel.id, openDmId, view]);
  // Abrir un DM → misma coreografía: frontera → marca leído → badge.
  useEffect(() => {
    if (openDmId == null) return;
    const key = `dm:${openDmId}`;
    lastReadFn({ data: { scope: "dm", scopeId: openDmId } })
      .then((r) => setBoundary({ key, at: r.at }))
      .catch(() => setBoundary({ key, at: 0 }))
      .finally(() => {
        markReadFn({ data: { scope: "dm", scopeId: openDmId } }).catch(() => {});
        clearUnread("dm", openDmId);
      });
  }, [openDmId]);
  // VOLVER a la pestaña marca leído el scope abierto. Sin esto, los mensajes que
  // llegaron con la pestaña oculta entran como no-leídos (bumpUnread en message:new)
  // y NADA los limpia al regresar: los effects de arriba no re-disparan porque el
  // scope no cambió. Es lo que hacía que un DM 1:1 activo acumulara burbujas
  // (reportado 2026-07-27). Slack/Zulip marcan leído al recuperar el foco.
  useEffect(() => {
    const markCurrent = () => {
      if (document.visibilityState !== "visible" || homeOpen) return;
      if (openDmId != null) {
        markReadFn({ data: { scope: "dm", scopeId: openDmId } }).catch(() => {});
        clearUnread("dm", openDmId);
      } else if (view == null) {
        markReadFn({ data: { scope: "room", scopeId: channel.id } }).catch(() => {});
        clearUnread("room", channel.id);
      }
    };
    document.addEventListener("visibilitychange", markCurrent);
    window.addEventListener("focus", markCurrent);
    return () => {
      document.removeEventListener("visibilitychange", markCurrent);
      window.removeEventListener("focus", markCurrent);
    };
  }, [openDmId, view, homeOpen, channel.id]);
  // Badge del ícono (PWA/dock): total de no-leídos. Sin esto no hay señal con la app
  // cerrada en el teléfono. El SW lo actualiza también desde el push (ver sw.js).
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge) return;
    const total =
      [...unreadRooms.values()].reduce((a, b) => a + b, 0) +
      [...unreadDms.values()].reduce((a, b) => a + b, 0);
    (total > 0 ? nav.setAppBadge(total) : nav.clearAppBadge?.() ?? Promise.resolve()).catch(() => {});
  }, [unreadRooms, unreadDms]);
  // Reconcilia optimistas de flujo (parentId y dmId null) contra el flujo real:
  // quita un optimista SOLO cuando su mensaje real (mismo sender+body) ya llegó —
  // así un evento SSE ajeno (otro autor) NO borra un optimista aún en vuelo.
  // Los de hilo (parentId) y DM (dmId) se limpian en su propio contexto.
  useEffect(() => {
    if (!messages) return;
    setOptimistic((prev) => {
      // Multiset de mensajes reales por (sender|body) → reconcilia 1:1 aun con
      // mensajes idénticos en vuelo (dos "ok" seguidos no se borran juntos).
      const avail = new Map<string, number>();
      for (const m of messages) {
        const k = `${m.sender.length}:${m.sender}:${m.body}`;
        avail.set(k, (avail.get(k) ?? 0) + 1);
      }
      return prev.filter((x) => {
        if (x.status === "failed") return true; // pega hasta retry/descartar
        if (x.parentId !== null || x.dmId !== null) return true;
        const k = `${x.sender.length}:${x.sender}:${x.body}`;
        const n = avail.get(k) ?? 0;
        if (n > 0) {
          avail.set(k, n - 1);
          return false; // aterrizó → quita este optimista (consume un match)
        }
        return true;
      });
    });
  }, [messages]);
  // Enfocar hilo, DM o vista en el centro son mutuamente excluyentes.
  const openThread = (id: number) => {
    // Siembra el root YA conocido del flujo → ThreadView lo muestra al instante (sin
    // skeleton); getThread solo rellena las respuestas en background. Mata el skeleton
    // molesto al navegar a un hilo cuyo mensaje ya tenemos.
    if (!threadCache.get(id)) {
      const root = flowCache.get(channel.slug)?.find((m) => m.id === id);
      if (root) threadCache.set(id, { root, replies: [], pending: true });
    }
    setView(null);
    setHomeOpen(false);
    setOpenDmId(null);
    setOpenThreadId(id);
    setNavOpen(false); // en móvil, elegir cierra el drawer y enfoca el centro
  };
  const openDm = (id: number) => {
    setView(null);
    setHomeOpen(false);
    setOpenThreadId(null);
    setOpenDmId(id);
    setNavOpen(false);
  };
  /**
   * "Volver al room" del encabezado de un hilo: ENFOCA el room, no deshace el último paso.
   *
   * ⚠️ Antes era sólo `setOpenThreadId(null)`, que apaga el hilo y deja que mande el foco
   * que hubiera debajo. Si habías llegado desde Inicio o desde una vista (Recientes,
   * Menciones, Destacados), ese foco seguía puesto y la flecha te devolvía ahí — se
   * comportaba como el "atrás" del navegador, no como lo que dice su tooltip. El room al
   * que pertenece el hilo es el que se está mirando, así que llegar a él no es navegar:
   * es apagar TODOS los focos que se le superponen.
   */
  /** Canal al que se está saltando, para que el sincronizador de la URL no lo pise. */
  const saltandoA = useRef<string | null>(null);
  const backToRoom = (roomSlug?: string | null) => {
    setView(null);
    setHomeOpen(false);
    setOpenDmId(null);
    setOpenThreadId(null);
    // ⚠️ Un hilo NO siempre pertenece al room que se está mirando: se abre también desde una
    // búsqueda, una mención o el panel de turnos, y entonces apagar los focos te deja en el
    // canal de la ruta. "Volver al room" tiene que llevar al room del HILO.
    if (roomSlug && roomSlug !== channel.slug) {
      // ⚠️ Y hay que avisarle al sincronizador de la URL. `setOpenThreadId(null)` lo dispara
      // en el MISMO ciclo, con `channel.slug` todavía apuntando al canal viejo, así que
      // reescribía la ruta y deshacía este salto: se veía el nombre correcto en el
      // encabezado y aun así aterrizabas en el canal anterior.
      saltandoA.current = roomSlug;
      router.navigate({ to: "/c/$slug", params: { slug: roomSlug } });
    }
  };
  const openView = (v: "recent" | "mentions" | "starred") => {
    setOpenThreadId(null);
    setOpenDmId(null);
    setHomeOpen(false);
    setView(v);
    setNavOpen(false);
  };
  const openHome = () => {
    setView(null);
    setOpenThreadId(null);
    setOpenDmId(null);
    setHomeOpen(true);
    setNavOpen(false);
  };
  // Hotkeys globales. ⌘K/Ctrl-K → command palette. Esc → cierra el OVERLAY actual en orden
  // de prioridad (panel de artefacto → hilo). NO cierra el DM: un DM es un DESTINO al que
  // entraste a propósito (no un overlay), y sacarte de él con Esc era sorpresivo e
  // inconsistente (dependía de si el foco estaba en el composer → "a veces sí, a veces no").
  // Se navega entre DMs/canales por el sidebar. No hace nada si estás escribiendo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        const el = document.activeElement as HTMLElement | null;
        // No robar el Esc si estás en un input/editor (cancelar cita, cerrar popups, etc.).
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        // Editando un artefacto, ESC es del editor (y el panel pide confirmación
        // para cerrar): este atajo global NO debe tirar el panel con cambios vivos.
        if (document.body.dataset.artifactEditing) return;
        if (openArtifactRef.current) { descartarPanel(); marcarCierre(); playArtifactClose(); setOpenArtifact(null); return; }
        if (openThreadId != null) { setOpenThreadId(null); return; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openThreadId]);
  // Al editar MI perfil (nombre/avatar), revalida el loader → el `user` (sidebar/header/
  // composer) se actualiza sin recargar. Los mensajes ya propagan por el directorio vivo.
  useEffect(() => {
    const on = () => router.invalidate();
    window.addEventListener("gt:me-updated", on);
    return () => window.removeEventListener("gt:me-updated", on);
  }, [router]);
  // Salta a un mensaje de room desde una vista/búsqueda (navega si es otro room).
  const jumpToRoomMessage = (slug: string, id: number) => {
    setView(null);
    setOpenThreadId(null);
    setOpenDmId(null);
    const doJump = () => {
      const el = document.getElementById(`msg-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add("flash-highlight");
      setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
    };
    if (slug === channel.slug) requestAnimationFrame(doJump);
    else {
      router.navigate({ to: "/c/$slug", params: { slug } });
      setTimeout(doJump, 500);
    }
  };
  // Salta a una RESPUESTA de hilo (desde Destacados/Menciones/búsqueda): abre el hilo
  // y scrollea a la respuesta. ThreadView carga sus replies async (useCachedQuery) →
  // el nodo msg-{replyId} puede no existir aún, así que reintenta unas veces.
  const jumpToThreadReply = (slug: string, parentId: number, replyId: number) => {
    const focusAndScroll = () => {
      setView(null);
      setOpenDmId(null);
      setOpenThreadId(parentId);
      let tries = 0;
      const tick = () => {
        const el = document.getElementById(`msg-${replyId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("flash-highlight");
          setTimeout(() => el.classList.remove("flash-highlight"), 1200);
        } else if (tries++ < 20) {
          setTimeout(tick, 100);
        }
      };
      setTimeout(tick, 60);
    };
    if (slug === channel.slug) focusAndScroll();
    else {
      router.navigate({ to: "/c/$slug", params: { slug } });
      setTimeout(focusAndScroll, 500);
    }
  };
  // ── Outbox: el ENVÍO vive aquí (no en el Composer) para poder reintentar un
  // fallo permanente. Cada optimista guarda su payload; sending→failed en error.
  const markFailed = (id: string) =>
    setOptimistic((o) => o.map((x) => (x.id === id ? { ...x, status: "failed" as const } : x)));
  // Dispara la red para un optimista concreto (usado por el envío inicial y el retry).
  const fireSend = (o: Optimistic) => {
    if (o.dmId != null) {
      postDmMessageFn({ data: { id: o.dmId, body: o.body, nonce: o.nonce, quotedId: o.quotedId ?? null, attachments: o.attachments } })
        .then((r) => {
          revalidate();
          if (r?.needsAgent && r.agentHandle)
            askDmAgentFn({ data: { id: o.dmId!, body: o.body, sender: "", handle: r.agentHandle, shellId: r.shellId ?? undefined, quotedAuthor: o.quotedAuthor ?? null, quotedExcerpt: o.quotedExcerpt ?? null, quotedId: o.quotedId ?? null, attachments: o.attachments } })
              .then(() => revalidate())
              .catch(() => revalidate());
        })
        .catch(() => markFailed(o.id));
      return;
    }
    postMessage({ data: { slug: o.slug, parentId: o.parentId, body: o.body, nonce: o.nonce, quotedId: o.quotedId ?? null, attachments: o.attachments } })
      .then((r) => {
        revalidate();
        const respondents = r?.respondents ?? [];
        if (respondents.length) {
          // MODELO ZULIP: el agente responde SIEMPRE dentro de un hilo colgado del mensaje
          // que lo invocó. Si lo mandaste desde el flujo, hay que ABRIR ese hilo — el
          // flujo sólo pinta top-level (`listChannelFlow`) y el filtro de realtime sólo
          // acepta lo que cuelga del hilo ABIERTO, así que sin esto el streaming aterriza
          // en una vista que no estás mirando y la respuesta parece no llegar nunca.
          //
          // Se siembra el root optimista en `threadCache` desde el mensaje que acabamos de
          // enviar (`o`, que todavía no está en flowCache) → el hilo abre mostrando TU
          // mensaje al instante, sin skeleton.
          //
          // Recuperado de b3f9530, que lo borró al pasar a respuestas inline. Hoy sale más
          // simple: la cáscara ya existe (`ag.shellId`) y llega por SSE.
          if (o.parentId === null) {
            const pid = respondents[0].parent;
            if (pid != null && !threadCache.get(pid)) {
              const root = {
                id: pid, channel_id: channel.id, parent_id: null, dm_id: null,
                sender: o.sender, avatar: o.avatar, body: o.body, kind: "msg",
                agent_handle: null, mentions_ghosty: 0,
                created_at: Math.floor(Date.now() / 1000), edited_at: null,
                reply_count: 0, reactions: [], pinned: false, starred: false, topic: null,
              } as unknown as Message;
              threadCache.set(pid, { root, replies: [], pending: true });
            }
            if (pid != null) openThread(pid);
          }
          // Cada agente mencionado responde en paralelo y limpia su propio "pensando…".
          for (const ag of respondents) {
            askAgent({ data: { slug: o.slug, parentId: ag.parent, fleetThread: ag.fleetThread, body: o.body, sender: "", handle: ag.handle, shellId: ag.shellId, quotedAuthor: o.quotedAuthor ?? null, quotedExcerpt: o.quotedExcerpt ?? null, quotedId: o.quotedId ?? null, attachments: o.attachments } })
              .then(() => revalidate())
              .catch(() => revalidate());
          }
        }
      })
      .catch(() => markFailed(o.id));
  };
  // Crea el optimista (con nonce para descartar mi propio eco SSE) y lo envía.
  const sendOptimistic = (p: {
    slug: string;
    parentId: number | null;
    dmId: number | null;
    body: string;
    attachments: Attach[];
    quotedId?: number | null;
    quotedAuthor?: string | null;
    quotedExcerpt?: string | null;
  }) => {
    const nonce = crypto.randomUUID();
    sentNonces.add(nonce);
    setTimeout(() => sentNonces.delete(nonce), 15_000); // limpia si nunca ecoa
    const o: Optimistic = {
      id: nonce,
      parentId: p.parentId,
      dmId: p.dmId,
      slug: p.slug,
      sender: user?.name ?? "tú",
      avatar: user?.avatar ?? "",
      body: p.body,
      attachments: p.attachments,
      nonce,
      status: "sending",
      quotedId: p.quotedId ?? null,
      quotedAuthor: p.quotedAuthor ?? null,
      quotedExcerpt: p.quotedExcerpt ?? null,
    };
    setOptimistic((prev) => [...prev, o]);
    fireSend(o);
  };
  // Respuesta rápida desde un artefacto inline (ask-user): envía `body` en el MISMO
  // hilo/DM que la pregunta. parentId = ownerMsg.parent_id ?? ownerMsg.id (coincide
  // con el parentFor del server); DM si el mensaje es de DM.
  const sendQuickReply = (body: string, ownerMsg: Message) => {
    const text = body.trim();
    if (!text) return;
    const dmId = (ownerMsg as { dm_id?: number | null }).dm_id ?? null;
    if (dmId != null) {
      sendOptimistic({ slug: "", parentId: null, dmId, body: text, attachments: [] });
    } else {
      sendOptimistic({ slug: channel.slug, parentId: ownerMsg.parent_id ?? ownerMsg.id, dmId: null, body: text, attachments: [] });
    }
  };
  const retrySend = (o: Optimistic) => {
    setOptimistic((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: "sending" as const } : x)));
    fireSend({ ...o, status: "sending" }); // reusa el mismo nonce (el server descarta mi eco)
  };
  const discardSend = (id: string) => setOptimistic((prev) => prev.filter((x) => x.id !== id));
  // Al recargar una vista se limpian SUS optimistas ya aterrizados; los fallidos
  // sobreviven (esperan retry/descartar del usuario). Reconcilia 1:1 por (sender+body)
  // contra los mensajes ya cargados: un optimista SOLO se retira cuando su mensaje real
  // ya está en la lista → nunca hay un hueco (el mensaje NO parpadea/desaparece si el
  // refetch resuelve un instante antes de que el row real sea consultable). Mismo criterio
  // que el reconciliador del flujo (arriba).
  const reconcileOptimistic = (
    loaded: { sender: string; body: string }[],
    inScope: (o: Optimistic) => boolean
  ) =>
    setOptimistic((prev) => {
      const avail = new Map<string, number>();
      for (const m of loaded) {
        const k = `${m.sender.length}:${m.sender}:${m.body}`;
        avail.set(k, (avail.get(k) ?? 0) + 1);
      }
      return prev.filter((x) => {
        if (x.status === "failed") return true; // pega hasta retry/descartar
        if (!inScope(x)) return true; // otro scope → no lo toca
        const k = `${x.sender.length}:${x.sender}:${x.body}`;
        const n = avail.get(k) ?? 0;
        if (n > 0) {
          avail.set(k, n - 1);
          return false; // aterrizó → quita este optimista (consume un match)
        }
        return true; // aún no llega el real → conserva el optimista (sin hueco)
      });
    });
  const clearOptimistic = (parentId: number | null, loaded: { sender: string; body: string }[]) =>
    reconcileOptimistic(loaded, (x) => x.dmId === null && x.parentId === parentId);
  const clearDmOptimistic = (dmId: number, loaded: { sender: string; body: string }[]) =>
    reconcileOptimistic(loaded, (x) => x.dmId === dmId);
  // Borra un hilo (autor u owner). Si es el enfocado, vuelve al flujo del room.
  const deleteThread = async (id: number) => {
    await deleteMessageFn({ data: { id } }).catch(() => {});
    threadCache.delete(id);
    if (openThreadId === id) setOpenThreadId(null);
    playDeleteSound();
    revalidate();
  };
  // Clic en el origen del hilo → vuelve al flujo y scrollea al mensaje (estilo Slack).
  const goToOrigin = (id: number) => {
    setOpenThreadId(null);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${id}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        el?.classList.add("flash-highlight");
        setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
      })
    );
  };


  // Ajustes/Preferencias como modal in-panel (SPA): estado a nivel shell para que
  // lo abran tanto el footer del sidebar como el "+ Añadir emoji" del picker.
  const t = useT();
  const [prefsTab, setPrefsTab] = useState<null | "general" | "agentes" | "emojis" | "integraciones">(null);
  const openPrefs = useCallback((tab: "general" | "agentes" | "emojis" = "general") => setPrefsTab(tab), []);
  // Precalienta la cache de Ajustes al montar el shell (idle) → al abrir Preferencias
  // no hay ni spinner ni pop-in de tabs; la data (setup/agentAccess) ya está lista.
  useEffect(() => { loadSettingsData().catch(() => {}); }, []);
  // Vuelta del OAuth de un conector: el callback redirige a ?connected=<p> | ?conn_error=<p>.
  // Abrimos Ajustes en Integraciones (que VEA el estado), toast + confetti al éxito, y
  // limpiamos el query (replace) para no re-disparar en cada render.
  const [connToast, setConnToast] = useState<{ ok: boolean; provider: string } | null>(null);

  // Deep-link a Ajustes: `?ajustes=agentes` abre el panel en esa pestaña. Ajustes
  // es un modal dentro del canal, así que sin esto no hay forma de mandarle a
  // alguien "míralo aquí" — sólo describirle el camino de clics.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const tab = sp.get("ajustes");
    if (!tab) return;
    if (tab === "general" || tab === "agentes" || tab === "emojis" || tab === "integraciones") {
      setPrefsTab(tab);
    }
    sp.delete("ajustes");
    const qs = sp.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const ok = sp.get("connected");
    const provider = ok || sp.get("conn_error");
    if (!provider) return;
    setPrefsTab("integraciones");
    setConnToast({ ok: !!ok, provider });
    const stop = ok ? startConfetti() : () => {};
    const hide = setTimeout(() => { stop(); setConnToast(null); }, ok ? 3500 : 5000);
    sp.delete("connected"); sp.delete("conn_error");
    const qs = sp.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    return () => { clearTimeout(hide); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [profile, setProfile] = useState<ProfileTarget | null>(null);
  const openProfile = useCallback((p: ProfileTarget) => setProfile(p), []);
  // Abrir artefacto CON sonido de rastrillo — SOLO en la transición cerrado→abierto (no al
  // cambiar de un artefacto a otro con el panel ya abierto). Gate en la categoría "artifact".
  /**
   * El panel abierto A MANO. Mientras vale, ningún borrador en vivo puede robarlo.
   *
   * Sin esto: con un agente escribiendo, abrías el resultado YA TERMINADO de otro, se veía un
   * instante y el siguiente chunk del que sigue trabajando te lo cambiaba por su borrador —
   * imposible leer nada (2026-08-03). Una acción explícita de la persona pesa más que
   * cualquier automatismo; se libera al cerrar el panel.
   */
  const panelManualRef = useRef(false);
  const openArtifactWithSound = useCallback((v: ArtifactView) => {
    if (!openArtifactRef.current) playArtifactOpen();
    panelManualRef.current = true;
    setOpenArtifact(v);
  }, []);

  // Volver a lo que se está armando: se limpia el descarte para que siga en vivo.
  /**
   * Marca como descartado el documento que SE ESTÁ VIENDO en el panel.
   *
   * ⚠️ Antes se marcaba `draftMsgIdRef`, o sea el último mensaje que escribió un chunk — que
   * con varios agentes redactando NO es el que tienes delante. Cerrabas el panel y silenciabas
   * al equivocado: el tuyo volvía a abrirse y el otro quedaba mudo.
   */
  const descartarPanel = useCallback(() => {
    // Cerrar libera el panel: a partir de aquí un borrador en vivo puede volver a tomarlo.
    panelManualRef.current = false;
    const v = openArtifactRef.current;
    // `ArtifactView` es una unión y sólo algunas variantes llevan `messageId` (un pdf o una
    // imagen no cuelgan de un borrador), de ahí el `in`.
    const id = (v && "messageId" in v ? v.messageId : null) ?? draftMsgIdRef.current;
    if (id != null) draftDismissedRef.current.add(id);
  }, []);
  const reopenHiddenDraft = useCallback(() => {
    setHiddenDraft((d) => {
      if (d) {
        if ("messageId" in d && d.messageId != null) draftDismissedRef.current.delete(d.messageId);
        playArtifactOpen();
        setOpenArtifact(d);
      }
      return null;
    });
    setHiddenDraftParent(null);
  }, []);

  return (
    <ChatCtx.Provider
      // El chat de Teams pasa TODAS las capacidades. Una superficie que no pueda hacer
      // algo simplemente no lo pasa, y el botón deja de existir — ver ChatCtxValue.
      value={{ me: user, slug: channel.slug, emojis, users, react, star, pin, remove, editMsg, retrySend, discardSend, replyTo, setReplyTo, pickerFor, setPickerFor, turns, stopTurn: stopTurnLocal, onOpenArtifact: openArtifactWithSound, sendQuickReply, openPrefs, openProfile, joinCall: joinCallFromCard, myCallKey, forward: setReenviar }}
    >
    {/* pt safe-area: en PWA standalone (viewport-fit=cover + status-bar black-translucent)
        el contenido va DEBAJO de la hora/notch → el header y su botón de menú quedaban
        tapados. El inset superior empuja todo bajo la barra de estado (h-[100dvh] es
        border-box → el alto interior se ajusta). En desktop el inset es 0 (sin efecto). */}
    <div className="flex h-[100dvh] bg-surface text-ink pt-[env(safe-area-inset-top)] md:pt-0">
      {/* Toast de resultado del OAuth de conectores (éxito → verde + confetti; error → rojo). */}
      {connToast && (
        <div
          role="status"
          className={`fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-xl border px-4 py-2.5 text-sm font-medium shadow-lg ${
            connToast.ok
              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-500"
              : "border-red-500/30 bg-red-500/15 text-red-400"
          }`}
        >
          {connToast.ok
            ? `✅ ${connToast.provider[0].toUpperCase()}${connToast.provider.slice(1)} ${t("conectado")}`
            : `⚠️ ${t("No se pudo conectar")} ${connToast.provider[0].toUpperCase()}${connToast.provider.slice(1)}`}
        </div>
      )}
      {/* Backdrop del drawer (solo móvil): tap fuera cierra el sidebar.
          `overscroll-none` + `touch-none`: arrastrar sobre el velo no debe mover nada de
          atrás — un backdrop que scrollea el contenido se siente roto. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 touch-none overscroll-none bg-black/50 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}
      <Sidebar
        liveTurns={liveTurns}
        doneTurns={doneTurns}
        onDismissTurn={(id) => setDoneTurns((d) => d.filter((x) => x.id !== id))}
        onStopTurn={stopTurnLocal}
        mobileOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
        channels={channels}
        active={channel.slug}
        user={user}
        threads={threads}
        activeThreadId={openThreadId}
        onOpenThread={openThread}
        onBackToRoom={() => {
          setOpenThreadId(null);
          setOpenDmId(null);
          setView(null);
          setHomeOpen(false); // clickear el room activo desde Inicio también cierra Inicio
        }}
        onDeleteThread={deleteThread}
        dms={dms}
        dmsLoading={dmsLoading}
        activeDmId={openDmId}
        online={online}
        onOpenDm={openDm}
        onRevalidate={revalidate}
        unreadRooms={unreadRooms}
        unreadDms={unreadDms}
        mutes={mutes}
        onToggleMute={toggleMute}
        activeView={view}
        onOpenView={openView}
        homeActive={homeOpen}
        onOpenHome={openHome}
      />
      {/* Centro: vista Zulip, DM, hilo, o flujo del room (nunca drawer derecho).
          CONTENIDO envuelto en boundary: un crash de render de un hilo/flujo/DM cae a un
          fallback RECUPERABLE (no tumba TODA la ruta / AppError) y se LOGUEA para diagnóstico.
          resetKey = el contexto → navegar (cambiar hilo/room/vista) resetea y recupera. */}
      <ArtifactBoundary
        resetKey={`${channel.id}:${view ?? ""}:${openDmId ?? ""}:${openThreadId ?? ""}`}
        onCatch={() => {
          // Rompe el bucle "crash → Volver al room → reabrir → re-crash": el cache del
          // cliente (persistido en sessionStorage) tenía una entrada PARCIAL de este
          // contexto — p.ej. un stream del agente que se cortó al reciclar su caja. La
          // evictamos y re-persistimos → al reabrir se re-fetchea limpio del server (los
          // datos en la DB están bien; lo roto era solo la copia cacheada del cliente).
          if (openThreadId != null) threadCache.delete(openThreadId);
          else if (openDmId != null) dmFlowCache.delete(openDmId);
          else if (view != null) viewCache.delete(view);
          persistCaches();
        }}
        fallback={
          <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="text-3xl">💤</div>
            <p className="max-w-xs text-sm text-muted">
              {t("Algo en esta vista se atoró. No se perdió nada.")}
            </p>
            <button
              type="button"
              onClick={() => {
                setOpenThreadId(null);
                setOpenDmId(null);
                setView(null);
              }}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
            >
              Volver al room
            </button>
          </section>
        }
      >
      {homeOpen ? (
        <HomeDashboard
          user={user}
          channels={channels}
          dms={dms}
          online={online}
          unreadRooms={unreadRooms}
          unreadDms={unreadDms}
          onOpenRoom={(slug) => router.navigate({ to: "/c/$slug", params: { slug } })}
          onOpenDm={openDm}
          onOpenNav={() => setNavOpen(true)}
          onQuickPost={(body) => {
            const slug = channels[0]?.slug ?? "general";
            sendOptimistic({ slug, parentId: null, dmId: null, body, attachments: [] });
            setHomeOpen(false);
            router.navigate({ to: "/c/$slug", params: { slug } });
          }}
        />
      ) : view != null ? (
        <ViewPane
          key={`view-${view}`}
          view={view}
          rev={rev}
          patch={patch}
          onJumpToRoom={jumpToRoomMessage}
          onJumpToThreadReply={jumpToThreadReply}
          onOpenDm={openDm}
          onOpenNav={() => setNavOpen(true)}
        />
      ) : openDmId != null ? (
        <DmView
          key={`dm-${openDmId}`}
          dm={dms.find((d) => d.id === openDmId) ?? null}
          dmId={openDmId}
          rev={rev}
          patch={patch}
          online={online}
          optimistic={optimistic.filter((o) => o.dmId === openDmId)}
          onSend={(p) => sendOptimistic({ ...p, slug: "", parentId: null, dmId: openDmId })}
          onReloaded={(loaded) => clearDmOptimistic(openDmId, loaded)}
          typing={typing && typing.dmId === openDmId ? typing : null}
          newAt={boundary?.key === `dm:${openDmId}` ? boundary.at : null}
          onBack={() => setOpenDmId(null)}
          call={{
            active: activeCalls.get(`dm:${openDmId}`) ?? null,
            joined: myCallKey === `dm:${openDmId}`,
            onStart: () => openCall(startCallFn, "dm", openDmId, { scope: "dm", dmId: openDmId }, dmCallLabel(openDmId)),
            onJoin: () => openCall(joinCallFn, "dm", openDmId, { scope: "dm", dmId: openDmId }, dmCallLabel(openDmId)),
            onLeave: leaveCall,
          }}
        />
      ) : openThreadId != null ? (
        <ThreadView
          key={openThreadId}
          channel={channel}
          threadId={openThreadId}
          rev={rev}
          patch={patch}
          optimistic={optimistic.filter((o) => o.parentId === openThreadId)}
          onSend={(p) => sendOptimistic({ ...p, slug: channel.slug, parentId: openThreadId, dmId: null })}
          onReloaded={(loaded) => clearOptimistic(openThreadId, loaded)}
          typing={typing && typing.parentId === openThreadId ? typing : null}
          onGoToOrigin={goToOrigin}
          onBack={backToRoom}
          channels={channels}
        />
      ) : (
        <Flow
          channel={channel}
          messages={messages}
          optimistic={optimistic.filter((o) => o.parentId === null && o.dmId === null)}
          onSend={(p) => sendOptimistic({ ...p, slug: channel.slug, parentId: null, dmId: null })}
          onOpenThread={openThread}
          typing={typing && typing.dmId == null && typing.parentId == null ? typing : null}
          newAt={boundary?.key === `room:${channel.id}` ? boundary.at : null}
          online={online}
          pins={pins}
          onOpenDm={openDm}
          onOpenNav={() => setNavOpen(true)}
          call={{
            active: activeCalls.get(`room:${channel.id}`) ?? null,
            joined: myCallKey === `room:${channel.id}`,
            onStart: () => openCall(startCallFn, "room", channel.id, { scope: "room", slug: channel.slug }, `#${channel.name}`),
            onJoin: () => openCall(joinCallFn, "room", channel.id, { scope: "room", slug: channel.slug }, `#${channel.name}`),
            onLeave: leaveCall,
          }}
        />
      )}
      </ArtifactBoundary>
      {/* Panel de artefactos: columna fija a la derecha (desktop) u overlay (móvil).
          Se rinde null solo cuando no hay artefacto abierto. */}
      {/* ⚠️ ANIMACIÓN DEL PANEL — NO regresar a `key={...}` aquí. Un `key` atado al artefacto
          (p.ej. openArtifact?.title) cambia al CERRAR o CAMBIAR de doc → React REMONTA el
          ArtifactPanel → destruye su <AnimatePresence> interno → el slide de CIERRE no corre
          y hay "doble apertura" al seleccionar. Usar SIEMPRE `resetKey` (resetea el error
          boundary SIN remontar). El drill-down lista↔detalle es estado INTERNO del panel
          (`detail`), no cambia `openArtifact`. Ver plan gteams-vertical-legal-y-documentos-cowork.md + memoria
          project_gteams_legal_vertical_live (GOTCHA de oro). */}
      {/* Mango para volver a lo que se está armando si cerraste el panel. Claude/ChatGPT
          usan la card del mensaje para esto; aquí la card sólo aparece al publicar, así
          que esta píldora cubre la ventana en la que el agente todavía escribe. */}
      {/* ⚠️ Y sólo en SU hilo: la píldora es `fixed`, o sea global a la ruta. Con varios
          agentes redactando a la vez, el último se la quedaba y se veía en los hilos de los
          otros — parecía que escribían el mismo documento. */}
      <AnimatePresence>
        {hiddenDraft && !openArtifact && (hiddenDraftParent ?? null) === openThreadId && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={reopenHiddenDraft}
            className="fixed bottom-24 right-6 z-30 flex items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm text-ink shadow-lg transition hover:bg-surface-3"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
            {t("Armando")} · {hiddenDraft.title}
            <span className="text-muted">{t("Ver")}</span>
          </motion.button>
        )}
      </AnimatePresence>
      <ArtifactBoundary resetKey={openArtifact?.title ?? "none"}>
        <ArtifactPanel artifact={openArtifact} onClose={() => { descartarPanel(); marcarCierre(); playArtifactClose(); setOpenArtifact(null); }} onOpen={(a) => { limpiarCierre(); setOpenArtifact(a); }} />
      </ArtifactBoundary>
      <AnimatePresence>
        {paletteOpen && (
          <CommandPalette
            channels={channels}
            dms={dms}
            onNavigateRoom={(slug) => router.navigate({ to: "/c/$slug", params: { slug } })}
            onOpenDm={openDm}
            onOpenView={openView}
            onClose={() => setPaletteOpen(false)}
          />
        )}
        {prefsTab && (
          <Modal onClose={() => setPrefsTab(null)} size="xl" flush>
            <SettingsContent initialTab={prefsTab} onClose={() => setPrefsTab(null)} />
          </Modal>
        )}
        {profile && (
          <ProfileDrawer
            target={profile}
            isOwner={!!user?.isOwner}
            onClose={() => setProfile(null)}
            onConfigure={() => { setProfile(null); openPrefs("agentes"); }}
            onStartDm={(sub) => {
              setProfile(null);
              openDmFn({ data: { subs: [sub] } }).then(({ id }) => openDm(id)).catch(() => {});
            }}
            onStartAgentDm={(handle) => {
              setProfile(null);
              openDmFn({ data: { agentHandle: handle } }).then(({ id }) => openDm(id)).catch(() => {});
            }}
          />
        )}
      </AnimatePresence>
      {/* El dock de la llamada y el aviso de entrante se pintan desde la RAÍZ
          (components/CallLayer), para que sobrevivan a salir de esta ruta. */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {/* El modal de reenviar lo monta QUIEN puede reenviar. El botón sólo pide abrirlo. */}
      {reenviar && <ForwardModal message={reenviar} onClose={() => setReenviar(null)} />}
      <NovedadesModal />
    </div>
    </ChatCtx.Provider>
  );
}

// Confetti PERSISTENTE mientras el anuncio está abierto, self-contained (sin dep),
// acorde al tema (--color-brand/-2 + pastel del hero). Burst inicial fuerte + lluvia
// suave continua desde arriba; al cerrar (stop) deja caer lo que queda y limpia.
// Respeta data-reduce-motion. Devuelve una función stop().
function startConfetti(): () => void {
  if (typeof document === "undefined") return () => {};
  if (document.documentElement.getAttribute("data-reduce-motion") === "1") return () => {};
  const cs = getComputedStyle(document.documentElement);
  const brand = cs.getPropertyValue("--color-brand").trim() || "#a78bfa";
  const brand2 = cs.getPropertyValue("--color-brand-2").trim() || "#7c3aed";
  const colors = [brand, brand2, "#86efac", "#fdba74", "#93c5fd", "#c4b5fd"];
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  let W = window.innerWidth;
  let H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  type P = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; s: number; c: string; drift: number };
  const parts: P[] = [];
  const mk = (burst: boolean): P => {
    const c = colors[(Math.random() * colors.length) | 0];
    if (burst) {
      const fromLeft = Math.random() < 0.5;
      const ang = (fromLeft ? -Math.PI / 4 : (-Math.PI * 3) / 4) + (Math.random() - 0.5) * 0.8;
      const sp = 9 + Math.random() * 9;
      return { x: fromLeft ? W * 0.15 : W * 0.85, y: H * 0.28, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, s: 6 + Math.random() * 6, c, drift: Math.random() * Math.PI * 2 };
    }
    // lluvia suave desde el borde superior
    return { x: Math.random() * W, y: -20, vx: (Math.random() - 0.5) * 1.5, vy: 1.5 + Math.random() * 2, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, s: 5 + Math.random() * 5, c, drift: Math.random() * Math.PI * 2 };
  };
  for (let i = 0; i < 140; i++) parts.push(mk(true)); // burst inicial

  let running = true;
  let raf = 0;
  let sinceSpawn = 0;
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(32, now - last);
    last = now;
    ctx.clearRect(0, 0, W, H);
    // mientras esté abierto, repone lluvia suave (cap ~180 partículas)
    if (running) {
      sinceSpawn += dt;
      while (sinceSpawn > 90 && parts.length < 180) {
        parts.push(mk(false));
        sinceSpawn -= 90;
      }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vy += 0.06; // gravedad suave
      p.drift += 0.05;
      p.x += p.vx + Math.sin(p.drift) * 0.5;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > H + 30) {
        parts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (running || parts.length > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      cleanup();
    }
  };
  const cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
  };
  raf = requestAnimationFrame(tick);
  // stop(): deja de reponer; las partículas restantes caen y luego se limpia solo.
  return () => {
    running = false;
  };
}

// Galería "Novedades" ("What's New" estilo Discord): al entrar, muestra las novedades
// GLOBALES publicadas que el usuario NO ha visto, UNA POR UNA (carrusel). Cada card que
// se ve se marca vista (persistente/cross-device) → si cierra a medias, las restantes
// vuelven a salir. Hero ilustrado (Ghosty actuando la feature) + confetti continuo +
// navegación Anterior/Siguiente. Tema del user vía tokens.
function NovedadesModal() {
  const t = useT();
  const [list, setList] = useState<Announcement[]>([]);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1); // dirección del slide: 1 siguiente, -1 anterior
  const open = list.length > 0;

  useEffect(() => {
    let alive = true;
    unreadAnnouncementsFn()
      .then((rows) => {
        if (alive && rows.length) {
          setList(rows);
          setIdx(0);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Marca vista la card ACTUAL en cuanto se muestra (persiste lectura parcial).
  useEffect(() => {
    const cur = list[idx];
    if (cur) markAnnouncementSeenFn({ data: { id: cur.id } }).catch(() => {});
  }, [idx, list]);

  // Confetti PERSISTENTE mientras la galería está abierta; al cerrar cae y se limpia.
  useEffect(() => {
    if (!open) return;
    let stop = () => {};
    const id = setTimeout(() => {
      stop = startConfetti();
    }, 180);
    return () => {
      clearTimeout(id);
      stop();
    };
  }, [open]);

  const cur = list[idx];
  const total = list.length;
  const isLast = idx >= total - 1;
  const close = () => setList([]); // vacía la lista → AnimatePresence anima la salida
  const next = () => {
    setDir(1);
    if (isLast) close();
    else setIdx((i) => i + 1);
  };
  const prev = () => {
    setDir(-1);
    setIdx((i) => Math.max(0, i - 1));
  };

  // AnimatePresence SIEMPRE montado (no return null antes) → al cerrar, el Modal
  // hace su exit-animation en vez de desaparecer de golpe.
  return (
    <AnimatePresence>
      {open && cur && (
        <Modal key="novedades" onClose={close} size="lg" flush>
          <div className="flex max-h-[85dvh] flex-col overflow-hidden">
            {/* Contenido que cambia por card → slide direccional */}
            <div className="min-h-0 flex-1 overflow-y-auto thin-scroll">
              <AnimatePresence mode="wait" custom={dir} initial={false}>
                <motion.div
                  key={cur.id}
                  custom={dir}
                  variants={novedadCardVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="relative">
                    {cur.heroImage ? (
                      <img
                        src={cur.heroImage}
                        alt=""
                        className="aspect-[3/2] w-full object-cover"
                        loading="eager"
                      />
                    ) : (
                      <div className="grid h-32 place-items-center bg-gradient-to-br from-brand/25 to-surface-3">
                        <Megaphone size={36} className="text-brand" />
                      </div>
                    )}
                    {/* Blend del hero hacia el cuerpo */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-surface-2 to-transparent" />
                  </div>
                  <div className="relative px-6 pb-8 pt-4">
                    <motion.span
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.06 }}
                      className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-brand ring-1 ring-brand/20"
                    >
                      <Megaphone size={12} /> {t("Novedad")}
                    </motion.span>
                    <motion.h2
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.12 }}
                      className="mt-3 text-2xl font-extrabold leading-tight tracking-tight"
                    >
                      {cur.title}
                    </motion.h2>
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.18 }}
                      className="mt-3 text-[15px] leading-relaxed text-muted [&_a]:text-brand [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:text-ink"
                    >
                      <Markdown body={cur.body} />
                    </motion.div>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
            {/* Navegación (fija, no desliza) */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-2 px-6 py-4">
              <div className="flex items-center gap-1.5">
                {total > 1 &&
                  list.map((_, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setDir(i > idx ? 1 : -1);
                        setIdx(i);
                      }}
                      aria-label={`Ir a ${i + 1}`}
                      className={`h-1.5 rounded-full transition-all ${
                        i === idx ? "w-5 bg-brand" : "w-1.5 bg-surface-3 hover:bg-brand/40"
                      }`}
                    />
                  ))}
              </div>
              <div className="flex items-center gap-2">
                {idx > 0 && (
                  <button
                    onClick={prev}
                    className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted transition hover:text-ink"
                  >
                    {t("Anterior")}
                  </button>
                )}
                <motion.button
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={next}
                  className="rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-brand-fg transition hover:bg-brand/90"
                >
                  {isLast ? t("Entendido") : `${t("Siguiente")} · ${idx + 1}/${total}`}
                </motion.button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
}

// Variantes del slide entre cards de la galería (dir: 1 = siguiente, -1 = anterior).
const novedadCardVariants = {
  enter: (d: number) => ({ x: d > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (d: number) => ({ x: d > 0 ? -60 : 60, opacity: 0 }),
};

// Stack de toasts de notificación (abajo-derecha). Acompaña al sonido con un aviso
// VISUAL: avatar + autor + preview; clic → salta al scope; auto-descarta a los 5s.
function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  const t = useT();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2">
      <AnimatePresence>
        {toasts.map((tst) => (
          <motion.button
            key={tst.id}
            layout
            initial={{ opacity: 0, x: 24, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            onClick={() => { tst.onOpen(); onDismiss(tst.id); }}
            className="pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-border bg-surface-2 p-3 text-left shadow-xl transition hover:bg-surface-3"
          >
            <Avatar name={tst.sender} avatar={tst.avatar} className="mt-0.5 h-8 w-8 shrink-0 !rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-ink">{tst.sender}</span>
                {tst.kind !== "room" && (
                  <span className="shrink-0 rounded bg-brand/15 px-1 text-[9px] font-bold uppercase tracking-wide text-brand">
                    {tst.kind === "dm" ? t("DM") : t("Mención")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">{tst.preview}</p>
            </div>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onDismiss(tst.id); }}
              className="shrink-0 rounded p-0.5 text-muted transition hover:text-ink"
              title={t("Cerrar")}
            >
              <X size={14} />
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}

/* ── Fila de hilo (compartida entre el submenú del sidebar y el modal "Ver todos") ── */
function ThreadRow({
  thr,
  active,
  onOpen,
  onDelete,
  canDelete,
  variant,
  working,
}: {
  thr: Message;
  active: boolean;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  canDelete: boolean;
  variant: "sidebar" | "modal";
  /** Hay un turno de agente EN VUELO en este hilo → punto latiendo. */
  working?: boolean;
}) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const thrIsAgent = (thr.agent_handle != null && thr.mentions_ghosty === 0) || thr.sender === "ghosty";
  const isGhosty = thrIsAgent && (thr.agent_handle === "ghosty" || thr.sender === "ghosty");
  const compact = variant === "sidebar";
  // Borrar hilo = destructivo → confirma primero y muestra spinner mientras corre.
  const handleDelete = async () => {
    if (deleting) return;
    if (!confirm(t("¿Eliminar este hilo y todas sus respuestas? No se puede deshacer."))) return;
    setDeleting(true);
    try {
      await onDelete(thr.id);
    } finally {
      setDeleting(false);
    }
  };
  return (
    <motion.li
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="group/thr flex items-center overflow-hidden"
    >
      <button
        onClick={() => onOpen(thr.id)}
        title={thr.body}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left ${
          compact ? "px-2 py-1 text-xs" : "px-2.5 py-2 text-sm"
        } ${
          active ? "bg-brand/15 font-medium text-ink" : "text-muted hover:bg-surface-3 hover:text-ink"
        }`}
      >
        {isGhosty ? (
          <img src="/ghosty.svg" alt="" className={compact ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0"} />
        ) : thrIsAgent ? (
          <Bot size={compact ? 13 : 15} className="shrink-0 text-brand" />
        ) : (
          <MessageSquare size={compact ? 12 : 14} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{threadTitle(thr) || t("Hilo")}</span>
        {/* Dónde se está trabajando ahora mismo, sin abrir el hilo. */}
        {working ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0" title={t("Un agente está trabajando aquí")}>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
          </span>
        ) : null}
        <span className={`shrink-0 tabular-nums text-muted ${compact ? "text-[10px]" : "text-xs"}`}>
          {thr.reply_count ?? 0}
        </span>
      </button>
      {canDelete && (
        <button
          onClick={handleDelete}
          disabled={deleting}
          title={t("Eliminar hilo")}
          className={`shrink-0 p-1 text-muted transition hover:text-brand disabled:opacity-100 ${
            deleting ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/thr:opacity-100"
          }`}
        >
          {deleting ? (
            <Loader2 size={compact ? 13 : 15} className="animate-spin text-brand" />
          ) : (
            <Trash2 size={compact ? 13 : 15} />
          )}
        </button>
      )}
    </motion.li>
  );
}

/* ── Modal "Ver todos los hilos": busca + revela de a THREAD_PAGE (carga parcial). ── */
function AllThreadsModal({
  threads,
  roomName,
  activeThreadId,
  onOpen,
  onDelete,
  user,
  onClose,
}: {
  threads: Message[];
  roomName: string;
  activeThreadId: number | null;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  user: SessionUser | null;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(THREAD_PAGE);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter(
      (thr) =>
        (threadTitle(thr) || "").toLowerCase().includes(needle) ||
        (thr.body || "").toLowerCase().includes(needle)
    );
  }, [threads, q]);
  // Al cambiar la búsqueda, reinicia la ventana de carga parcial.
  useEffect(() => setVisible(THREAD_PAGE), [q]);
  const shown = filtered.slice(0, visible);
  const remaining = filtered.length - shown.length;
  return (
    <Modal onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-2">
        <Layers size={18} className="shrink-0 text-brand" />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {t("Hilos de")} {roomName}
        </h2>
        <span className="shrink-0 tabular-nums text-xs text-muted">{filtered.length}</span>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("Buscar hilo…")}
        autoFocus
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
      />
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t("No se encontraron hilos.")}</p>
      ) : (
        <ul className="space-y-0.5">
          <AnimatePresence initial={false}>
            {shown.map((thr) => (
              <ThreadRow
                key={thr.id}
                thr={thr}
                active={activeThreadId === thr.id}
                onOpen={(id) => {
                  onOpen(id);
                  onClose();
                }}
                onDelete={onDelete}
                canDelete={!!(user?.isOwner || thr.sender === user?.name)}
                variant="modal"
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {remaining > 0 && (
        <button
          onClick={() => setVisible((v) => v + THREAD_PAGE)}
          className="mt-3 w-full rounded-lg border border-border py-2 text-sm text-muted transition hover:bg-surface-3 hover:text-ink"
        >
          {t("Cargar más")} ({remaining})
        </button>
      )}
    </Modal>
  );
}

/* ── Sidebar: Rooms + hilos como submenús + identidad ── */
// Badge de no-leídos (Fase 1.5): píldora compacta; 99+ como tope.
function UnreadBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="min-w-[18px] shrink-0 rounded-full bg-brand px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums text-white">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// Hamburguesa (solo móvil): abre el drawer del sidebar. Tap target ≥44px.
function NavToggle({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onOpen}
      aria-label={t("Abrir menú")}
      className="-ml-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink md:hidden"
    >
      <Menu size={20} />
    </button>
  );
}

type LiveTurnRow = {
  id: number; state: "running" | "queued" | "stopped" | "done"; position: number; startedAt: number;
  agent: string; avatar: string; channelId: number | null; parentId: number | null; topic: string;
  /** DM al que pertenece (los turnos de DM no tienen room). */
  dmId?: number | null;
  /** Lo que la persona pidió, recortado: nombra la FILA, como hace Cursor con sus tareas. */
  tarea?: string;
  /** Último paso narrado por el agente — el "en qué va", como la fila de Cursor. */
  paso?: string;
  /** Qué produjo el turno ("1 documento · 3 versiones"). Se calcula al cerrar, una vez. */
  outcome?: string;
};

/**
 * "Trabajando ahora" — los turnos de agente EN VUELO de TODO el workspace.
 *
 * Con varios agentes a la vez no había forma de saber quién estaba trabajando ni de pararlo
 * si no estabas parado justo en su hilo (2026-08-03). Es el mismo patrón que Cursor resuelve
 * con su panel de background agents y Claude Code con `/tasks`: el estado sale del hilo.
 *
 * No se pinta cuando no hay nada corriendo — un bloque permanente en cero se vuelve invisible.
 */
function LiveTurnsPanel({
  turns, done, channels, onOpen, onStop, onDismiss,
}: {
  turns: LiveTurnRow[];
  done: LiveTurnRow[];
  channels: Channel[];
  onOpen: (t: LiveTurnRow) => void;
  onStop: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const t = useT();
  const filas = [...turns, ...done];
  if (!filas.length) return null;
  const nombreDe = (id: number | null) => channels.find((c) => c.id === id)?.name ?? "";
  return (
    <div className="mb-2 rounded-lg border border-border bg-surface-3/40 p-1.5">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
        </span>
        {(() => {
          // Corriendo y EN COLA por separado. Los turnos del mismo agente se serializan en su
          // worker, así que "3" sin más engaña: puede ser uno trabajando y dos esperando. El
          // dato ya venía del servidor (`state`/`position`) y no se estaba enseñando.
          const corriendo = turns.filter((x) => x.state === "running").length;
          const enCola = turns.filter((x) => x.state === "queued").length;
          if (!corriendo && !enCola) return t("Listo");
          return `${t("Trabajando ahora")} · ${corriendo}${enCola ? ` · ${enCola} ${t("en cola")}` : ""}`;
        })()}
      </div>
      {filas.map((x) => (
        <div key={x.id} className="group flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-surface-3">
          <button
            type="button"
            onClick={() => onOpen(x)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={t("Ir a la conversación")}
          >
            {x.avatar ? (
              <img src={x.avatar} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-xs ${x.state === "done" ? "text-muted" : "text-ink"}`}>
                {x.agent || t("Agente")}
                <span className="text-muted"> · {x.tarea || nombreDe(x.channelId)}</span>
              </span>
              {/* EN QUÉ VA, que es lo que hace útil la fila de Cursor: un cronómetro sin
                  contexto no distingue "avanzando" de "atorado". */}
              {x.paso && x.state === "running" ? (
                <span className="block truncate text-[10px] italic text-muted">{x.paso}</span>
              ) : null}
            </span>
            {x.state === "queued" ? (
              <span className="shrink-0 text-[10px] text-muted">{t("en cola")} · {x.position}º</span>
            ) : x.state === "done" ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted">
                <Check size={11} className="text-green-500" />
                {/* QUÉ entregó, no sólo que acabó: es el "Files added/changed" de Cursor. */}
                {x.outcome || t("terminó")}
              </span>
            ) : (
              <TurnClock startedAt={x.startedAt} />
            )}
          </button>
          {/* Detener sólo si de verdad corre: encolado no hay nada que parar todavía. */}
          {x.state === "done" ? (
            <button
              type="button"
              onClick={() => onDismiss(x.id)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-3 hover:text-ink"
              title={t("Quitar")}
              aria-label={t("Quitar")}
            >
              <X size={12} />
            </button>
          ) : x.state === "running" ? (
            <button
              type="button"
              onClick={() => onStop(x.id)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-3 hover:text-ink"
              title={t("Detener")}
              aria-label={t("Detener")}
            >
              {/* El mismo `Square` relleno del botón de la burbuja: detener es el mismo gesto
                  en los dos sitios y no debe verse como dos cosas distintas. */}
              <Square size={9} className="fill-current" />
            </button>
          ) : (
            <span className="shrink-0 text-[10px] text-muted">{x.position}º</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Cronómetro del turno. Vive aquí para no re-renderizar el sidebar entero cada segundo. */
function TurnClock({ startedAt }: { startedAt: number }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const s = Math.max(0, Math.floor((ahora - startedAt) / 1000));
  return (
    <span className="shrink-0 tabular-nums text-[10px] text-muted">
      {s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}
    </span>
  );
}

function Sidebar({
  liveTurns,
  doneTurns,
  onStopTurn,
  onDismissTurn,
  mobileOpen,
  onCloseNav,
  channels,
  active,
  user,
  threads,
  activeThreadId,
  onOpenThread,
  onBackToRoom,
  onDeleteThread,
  dms,
  dmsLoading,
  activeDmId,
  online,
  onOpenDm,
  onRevalidate,
  unreadRooms,
  unreadDms,
  mutes,
  onToggleMute,
  activeView,
  onOpenView,
  homeActive,
  onOpenHome,
}: {
  mobileOpen: boolean;
  onCloseNav: () => void;
  channels: Channel[];
  active: string;
  user: SessionUser | null;
  threads: Message[];
  activeThreadId: number | null;
  onOpenThread: (id: number) => void;
  onBackToRoom: () => void;
  onDeleteThread: (id: number) => void;
  dms: DmConversation[];
  dmsLoading: boolean;
  activeDmId: number | null;
  online: OnlinePeople;
  onOpenDm: (id: number) => void;
  onRevalidate: () => void;
  unreadRooms: Map<number, number>;
  unreadDms: Map<number, number>;
  mutes: Set<string>;
  onToggleMute: (scope: "room" | "dm", id: number) => void;
  activeView: null | "recent" | "mentions" | "starred";
  onOpenView: (v: "recent" | "mentions" | "starred") => void;
  homeActive: boolean;
  onOpenHome: () => void;
  liveTurns: LiveTurnRow[];
  doneTurns: LiveTurnRow[];
  onStopTurn: (id: number) => void;
  onDismissTurn: (id: number) => void;
}) {
  const t = useT();
  const router = useRouter();
  const { openPrefs } = useContext(ChatCtx); // Ajustes in-panel (modal a nivel shell)
  const [wsOpen, setWsOpen] = useState(false); // dropdown del switcher de workspace
  // Multi-workspace: la lista de workspaces del user (verdad en gs). Se resuelve al
  // montar (barato) para poder etiquetar el workspace actual y ofrecer el salto.
  const [ws, setWs] = useState<{
    current: string | null;
    portal: string;
    workspaces: Array<{ slug: string; role: string; url: string }>;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    listMyWorkspacesFn().then((r) => { if (alive) setWs(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Nombre a mostrar del workspace actual (slug capitalizado; fallback "Ghosty Teams").
  const wsLabel = ws?.current ? ws.current.charAt(0).toUpperCase() + ws.current.slice(1) : "Ghosty Teams";
  const portal = ws?.portal || "https://www.ghosty.studio";
  // Ghosty Tasks del MISMO workspace: mismo subdominio, otro producto. Se deriva del
  // host (acme.teams.ghosty.studio → acme.tasks.ghosty.studio) para no depender de
  // que el switcher ya haya cargado; en el apex cae al selector de Tasks.
  const tasksUrl = ws?.current
    ? `https://${ws.current}.tasks.ghosty.studio`
    : typeof window !== "undefined"
      ? `https://${window.location.host.replace(".teams.", ".tasks.")}`
      : "https://tasks.ghosty.studio";
  // Dark sidebar: si está activo y el modo es claro, forzamos la paleta OSCURA del
  // preset SOLO en este subárbol (vars inline). Es una preferencia de CLIENTE
  // (localStorage) → se aplica POST-montaje vía ref (NO en el render), para no meter
  // estado dependiente de localStorage en SSR/hidratación (evita mismatch → AppError).
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // `card` va en la lista aunque no sea una clave de la paleta: `paletteVars` lo DERIVA
    // (ver allí). Sin él, `bg-card` dentro del sidebar oscuro se quedaría con el valor
    // computado en `:root` — o sea blanco sobre un sidebar oscuro.
    const KEYS = ["brand", "brand-2", "brand-fg", "surface", "surface-2", "surface-3", "border", "ink", "muted", "card"];
    const apply = () => {
      const el = asideRef.current;
      if (!el) return;
      const th = getTheme();
      KEYS.forEach((k) => el.style.removeProperty(`--color-${k}`));
      if (th.darkSidebar && !resolveDark(th.scheme)) {
        for (const [k, v] of Object.entries(paletteVars(presetById(th.preset), true))) el.style.setProperty(k, v);
      }
    };
    apply();
    return subscribeTheme(apply);
  }, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsSlug, setSettingsSlug] = useState<string | null>(null);
  const [newDmOpen, setNewDmOpen] = useState(false);
  // Mismo directorio vivo que alimenta el picker de menciones (cacheado en módulo y
  // refrescado por el bus): así el aviso de abajo nombra a los agentes que EXISTEN.
  const agentes = useMentions().filter((m) => m.kind === "agent");
  // Modal "Ver todos los hilos" del room activo (abierto desde el botón "+N más").
  const [allThreadsOpen, setAllThreadsOpen] = useState(false);
  // Cambiar de room cierra el modal (sus hilos ya no corresponden).
  useEffect(() => setAllThreadsOpen(false), [active]);
  // Acordeón: hilos del room colapsados (por slug). Colapsar evita que el sidebar
  // crezca sin fin cuando un room tiene muchos hilos.
  // Qué rooms tienen la lista de hilos plegada. PERSISTE: cerrar un room y encontrarlo
  // abierto otra vez al refrescar convierte el plegado en un gesto inútil — quien lo cierra
  // es porque no quiere verlo, y esa intención dura más que la sesión.
  // DMs CERRADOS (no borrados). Es el "close conversation" de Slack: se quitan de la lista y
  // vuelven solos en cuanto te escriben — nadie se pierde un mensaje por haber ordenado su
  // barra. Silenciar no servía para esto: silenciado sigue ocupando sitio.
  const [closedDms, setClosedDms] = useState<Set<number>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("gt:closedDms");
      return new Set<number>(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("gt:closedDms", JSON.stringify([...closedDms]));
    } catch {
      /* modo privado: no cerrar no rompe nada */
    }
  }, [closedDms]);
  const cerrarDm = (id: number) => setClosedDms((prev) => new Set(prev).add(id));

  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("gt:collapsedThreads");
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("gt:collapsedThreads", JSON.stringify([...collapsedThreads]));
    } catch {
      /* modo privado / cuota llena: que no plegar no rompa el sidebar */
    }
  }, [collapsedThreads]);
  const toggleThreads = (slug: string) =>
    setCollapsedThreads((prev) => {
      const n = new Set(prev);
      n.has(slug) ? n.delete(slug) : n.add(slug);
      return n;
    });
  const canManage = (c: Channel) => user?.isOwner || c.created_by === user?.sub;

  return (
    <aside
      ref={asideRef}
      className={`fixed inset-y-0 left-0 z-40 flex w-[84vw] max-w-xs flex-col border-r border-border bg-surface-2 transition-transform duration-200 ease-out md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 ${
        mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
      }`}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="relative flex items-center gap-1 border-b border-border px-2 py-2">
        {/* Switcher de workspace (multi-workspace: hoy uno; "nuevo" próximamente). */}
        <button
          onClick={() => setWsOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3"
        >
          <img src="/ghosty.svg" alt="" className="h-6 w-6 shrink-0" />
          {/* text-ink EXPLÍCITO: sin él, el span hereda el color YA computado del body
              (ink del modo claro) y con "sidebar oscuro" queda texto oscuro sobre fondo
              oscuro → invisible. Con la clase, resuelve el --color-ink que el aside sobre-
              escribe a la paleta oscura en su subárbol. */}
          <span className="min-w-0 flex-1 truncate font-semibold text-ink">{wsLabel}</span>
          <ChevronDown size={15} className={`shrink-0 text-muted transition ${wsOpen ? "rotate-180" : ""}`} />
        </button>
        {/* Cerrar drawer (solo móvil). */}
        <button
          onClick={onCloseNav}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink md:hidden"
          aria-label={t("Cerrar menú")}
        >
          <X size={20} />
        </button>
        {wsOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setWsOpen(false)} aria-hidden />
            <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-xl border border-border bg-surface p-1 shadow-xl">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                {ws && ws.workspaces.length > 1 ? t("Tus workspaces") : t("Workspace")}
              </p>
              {/* Lista real de workspaces del user (verdad en gs). El actual va marcado;
                  los demás son enlaces top-level a su subdominio (cambia de tenant). */}
              {(ws?.workspaces.length ? ws.workspaces : [{ slug: ws?.current ?? "", role: "", url: "" }]).map((w) => {
                const isCurrent = !!ws?.current && w.slug === ws.current;
                const label = w.slug ? w.slug.charAt(0).toUpperCase() + w.slug.slice(1) : "Ghosty Teams";
                if (isCurrent || !w.url) {
                  return (
                    <div key={w.slug || "current"} className="flex items-center gap-2 rounded-lg bg-surface-3 px-2 py-1.5">
                      <img src="/ghosty.svg" alt="" className="h-5 w-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{label}</span>
                      <Check size={15} className="shrink-0 text-brand" />
                    </div>
                  );
                }
                return (
                  <a
                    key={w.slug}
                    href={w.url}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-surface-3 hover:text-ink"
                  >
                    <img src="/ghosty.svg" alt="" className="h-5 w-5 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  </a>
                );
              })}
              <button
                onClick={() => { setWsOpen(false); openPrefs?.(); }}
                className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-3 hover:text-ink"
              >
                <Settings size={15} className="shrink-0" /> {t("Ajustes del workspace")}
              </button>
              <div className="my-1 border-t border-border" />
              {/* Volver al portal del ecosistema (donde también se crea un workspace nuevo). */}
              <a
                href={portal}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-3 hover:text-ink"
              >
                <ArrowLeft size={15} className="shrink-0" /> {t("Volver a Ghosty Studio")}
              </a>
              <a
                href={portal}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-3 hover:text-ink"
              >
                <Plus size={15} className="shrink-0" /> {t("Nuevo workspace")}
              </a>
            </div>
          </>
        )}
      </div>
      {/* `overscroll-contain`: al llegar al tope de la lista, el gesto NO se le pasa al
          documento de atrás. Sin esto, en móvil se scrolleaba el chat por debajo del cajón
          abierto y la nav se sentía "pegada" (reportado por Brendi, 2026-08-03). */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-2 thin-scroll">
        <LiveTurnsPanel
          turns={liveTurns}
          done={doneTurns}
          channels={channels}
          onStop={onStopTurn}
          onDismiss={onDismissTurn}
          onOpen={(x) => {
            onCloseNav();
            // Un turno de DM no tiene room: se abre por su conversación.
            if (x.dmId != null) {
              onOpenDm(x.dmId);
              return;
            }
            const slug = channels.find((c) => c.id === x.channelId)?.slug;
            if (!slug) return;
            // Mismo room → abrir el hilo en el acto, sin recargar.
            // Abrir NO lo descarta: quieres poder ir al resultado, volver y seguir viendo la
            // lista de lo que acabó. Se va con la ✕ o solo al envejecer.
            if (slug === active) {
              if (x.parentId != null) onOpenThread(x.parentId);
              else onBackToRoom();
              return;
            }
            // Otro room → navegación SPA (nada de `location.href`, que recargaba el sitio
            // entero con sidebar incluido). El foco viaja en la URL, así que sigue siendo un
            // enlace compartible; lo recoge el efecto de cambio de room.
            router.navigate(
              x.parentId != null
                ? { to: "/c/$slug", params: { slug }, search: { thread: x.parentId } }
                : { to: "/c/$slug", params: { slug } },
            );
          }}
        />
        {/* Home: dashboard de inicio con el personaje Ghosty. */}
        <button
          onClick={onOpenHome}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 ${
            homeActive ? "bg-brand/15 font-medium text-ink" : "text-muted hover:bg-surface-3 hover:text-ink"
          }`}
        >
          <HomeIcon size={16} className="shrink-0" /> {t("Inicio")}
        </button>
        {/* Tareas del equipo: Ghosty Tasks, mismo workspace y misma DB. El subdominio
            es el mismo cambiando el producto (acme.teams… → acme.tasks…); el slug del
            workspace vive en el host, no en la ruta ($slug aquí es el canal). */}
        <a
          href={tasksUrl}
          target="_blank"
          rel="noreferrer"
          className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-muted transition hover:bg-surface-3 hover:text-ink md:py-1.5"
        >
          <CheckCircle2 size={16} className="shrink-0" /> {t("Tareas")}
        </a>
        {/* Vistas (Zulip): recientes / menciones / destacados, enfocadas en el centro. */}
        <div className="mb-1 space-y-0.5">
          {([
            ["recent", t("Recientes"), Waves],
            ["mentions", t("Menciones"), Megaphone],
            ["starred", t("Destacados"), Star],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => onOpenView(key)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 ${
                activeView === key
                  ? "bg-brand/15 font-medium text-ink"
                  : "text-muted hover:bg-surface-3 hover:text-ink"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
          {/* Formularios de intake del team (ruta propia, no una vista de mensajes). */}
          <Link
            to="/forms"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 text-muted hover:bg-surface-3 hover:text-ink"
          >
            <FileText size={16} className="shrink-0" />
            <span className="truncate">{t("Formularios")}</span>
          </Link>
          {/* Documentos del team: los que redacta @ghosty (eb-doc) + los subidos al
              chat (pdf/office). Ruta /artifacts, página "Documentos". */}
          <Link
            to="/artifacts"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 text-muted hover:bg-surface-3 hover:text-ink"
          >
            <Layers size={16} className="shrink-0" />
            <span className="truncate">{t("Documentos")}</span>
          </Link>
          {/* Memoria del workspace: lo que los agentes saben de la empresa. Curaduría. */}
          <Link
            to="/memory"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 text-muted hover:bg-surface-3 hover:text-ink"
          >
            <Brain size={16} className="shrink-0" />
            <span className="truncate">{t("Memoria")}</span>
          </Link>
        </div>
        <div className="flex items-center justify-between px-2 pb-1 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t("Rooms")}</p>
          <button
            onClick={() => setCreateOpen(true)}
            title={t("Crear room")}
            className="rounded p-0.5 text-muted transition hover:text-brand"
          >
            <Plus size={17} />
          </button>
        </div>
        {channels.map((c) => {
          const muted = mutes.has(`room:${c.id}`);
          // Hilos POR room desde el cache de módulo: si un room ya los cargó, se
          // quedan listados aunque no sea el activo (y no se recargan al volver).
          // El activo usa la lista viva (más fresca); los demás, lo cacheado.
          // Room activo: lista viva (más fresca). Los demás: los hilos que el
          // loader adjuntó a cada room (persisten siempre) o el cache si ya se vio.
          const roomThreads =
            c.slug === active ? threads : threadsCache.get(c.slug) ?? c.threads ?? [];
          return (
          <div key={c.id}>
            <div className="group flex items-center">
              {roomThreads.length > 0 ? (
                <button
                  onClick={() => toggleThreads(c.slug)}
                  title={collapsedThreads.has(c.slug) ? t("Mostrar hilos") : t("Ocultar hilos")}
                  className="shrink-0 rounded p-0.5 text-muted transition hover:text-ink"
                >
                  {collapsedThreads.has(c.slug) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" />
              )}
              <Link
                to="/c/$slug"
                params={{ slug: c.slug }}
                onClick={() => {
                  if (c.slug === active) onBackToRoom();
                  onCloseNav();
                }}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 ${
                  c.slug === active && !homeActive && activeThreadId == null && activeView == null && activeDmId == null
                    ? "bg-brand/15 font-medium text-ink"
                    : "text-muted hover:bg-surface-3 hover:text-ink"
                } ${muted ? "opacity-50" : ""}`}
              >
                <RoomIcon name={c.icon} size={17} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {/* Silenciado → sin badge (pero mantiene el punto de "hay algo"). */}
                  {muted ? (
                    <BellOff size={12} className="text-muted" />
                  ) : (
                    <UnreadBadge n={unreadRooms.get(c.id) ?? 0} />
                  )}
                  {c.is_private ? <Lock size={13} className="text-muted" /> : null}
                </span>
              </Link>
              <button
                onClick={() => onToggleMute("room", c.id)}
                title={muted ? t("Reactivar notificaciones") : t("Silenciar room")}
                className="p-1 text-muted opacity-100 transition hover:text-ink md:opacity-0 md:group-hover:opacity-100"
              >
                {muted ? <BellOff size={15} /> : <Bell size={15} />}
              </button>
              {canManage(c) && (
                <button
                  onClick={() => setSettingsSlug(c.slug)}
                  title={t("Ajustes del room")}
                  className="p-1 text-muted opacity-100 transition hover:text-ink md:opacity-0 md:group-hover:opacity-100"
                >
                  <Settings size={15} />
                </button>
              )}
            </div>
            {/* Hilos del room como submenús (colapsables): solo los 5 más
                recientes; el resto se ve en el modal "Ver todos" con carga parcial.
                Se muestran para CUALQUIER room que ya los tenga cacheados —no solo
                el activo— para que no desaparezcan al cambiar de room ni se
                recarguen al volver. */}
            {roomThreads.length > 0 && !collapsedThreads.has(c.slug) && (
              <div className="mb-1 ml-3.5 mt-0.5 border-l border-border pl-2">
                <ul className="space-y-0.5">
                  <AnimatePresence initial={false}>
                    {roomThreads.slice(0, THREAD_PREVIEW).map((thr) => (
                      <ThreadRow
                        key={thr.id}
                        thr={thr}
                        active={activeThreadId === thr.id}
                        onOpen={onOpenThread}
                        onDelete={onDeleteThread}
                        canDelete={!!(user?.isOwner || thr.sender === user?.name)}
                        variant="sidebar"
                        working={liveTurns.some((x) => x.parentId === thr.id)}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
                {roomThreads.length > THREAD_PREVIEW && (
                  // "Ver todos" usa la lista viva del room ACTIVO; para rooms no
                  // activos con >5 hilos, entrar al room primero (Link normal).
                  c.slug === active ? (
                    <button
                      onClick={() => setAllThreadsOpen(true)}
                      className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted transition hover:bg-surface-3 hover:text-brand"
                    >
                      <MoreHorizontal size={13} className="shrink-0" />
                      <span className="truncate">
                        +{roomThreads.length - THREAD_PREVIEW} {t("más")}
                      </span>
                    </button>
                  ) : (
                    <Link
                      to="/c/$slug"
                      params={{ slug: c.slug }}
                      onClick={() => onCloseNav()}
                      className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted transition hover:bg-surface-3 hover:text-brand"
                    >
                      <MoreHorizontal size={13} className="shrink-0" />
                      <span className="truncate">
                        +{roomThreads.length - THREAD_PREVIEW} {t("más")}
                      </span>
                    </Link>
                  )
                )}
              </div>
            )}
          </div>
          );
        })}

        {/* Mensajes directos (referencia Zulip): 1:1 y grupos, con presencia. */}
        <div className="mt-3 flex items-center justify-between px-2 pb-1 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t("Mensajes directos")}
          </p>
          <button
            onClick={() => setNewDmOpen(true)}
            title={t("Nuevo mensaje directo")}
            className="rounded p-0.5 text-muted transition hover:text-brand"
          >
            <Plus size={17} />
          </button>
        </div>
        {dmsLoading ? (
          <DmListSkeleton />
        ) : dms.length === 0 ? (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="px-2 py-1 text-xs text-muted"
          >
            {t("Aún no tienes DMs.")}
          </motion.p>
        ) : (
          <AnimatePresence initial={false}>
            {dms
              // Un DM cerrado reaparece si tiene algo sin leer, o si es el que estás viendo.
              .filter((d) => !closedDms.has(d.id) || (unreadDms.get(d.id) ?? 0) > 0 || activeDmId === d.id)
              .map((dm, i) => {
              const isOnline = dm.members.some((m) => online.has(m.sub));
              const first = dm.members[0];
              const muted = mutes.has(`dm:${dm.id}`);
              return (
                <motion.div
                  key={dm.id}
                  layout
                  initial={{ opacity: 0, y: 4, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(i * 0.03, 0.24) }}
                  className="group flex items-center overflow-hidden"
                >
                  <button
                    onClick={() => onOpenDm(dm.id)}
                    title={dmTitle(dm, t("Conversación"))}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm md:py-1.5 ${
                      activeDmId === dm.id
                        ? "bg-brand/15 font-medium text-ink"
                        : "text-muted hover:bg-surface-3 hover:text-ink"
                    } ${muted ? "opacity-50" : ""}`}
                  >
                    <span className="relative shrink-0">
                      {dm.is_group ? (
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-3 text-ink">
                          <Users size={14} />
                        </span>
                      ) : (
                        <Avatar name={first?.name} avatar={first?.avatar} className="h-6 w-6 text-[10px]" />
                      )}
                      {isOnline && (
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-2 bg-green-500" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{dmTitle(dm, t("Conversación"))}</span>
                    {muted ? (
                      <BellOff size={12} className="shrink-0 text-muted" />
                    ) : (
                      <UnreadBadge n={unreadDms.get(dm.id) ?? 0} />
                    )}
                  </button>
                  <button
                    onClick={() => onToggleMute("dm", dm.id)}
                    title={muted ? t("Reactivar notificaciones") : t("Silenciar conversación")}
                    className="p-1 text-muted opacity-100 transition hover:text-ink md:opacity-0 md:group-hover:opacity-100"
                  >
                    {muted ? <BellOff size={15} /> : <Bell size={15} />}
                  </button>
                  <button
                    onClick={() => cerrarDm(dm.id)}
                    title={t("Quitar de la lista (vuelve si te escriben)")}
                    aria-label={t("Quitar de la lista")}
                    className="p-1 text-muted opacity-100 transition hover:text-ink md:opacity-0 md:group-hover:opacity-100"
                  >
                    <X size={15} />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Los agentes REALES de este workspace, no "Ghosty" cableado: el agente puede
          llamarse @blue o @gaspar, y un workspace sin agentes no debe anunciar ninguno. */}
      {agentes.length > 0 && (
        <div className="mx-2 mb-2 rounded-xl border border-border bg-surface p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            {agentes.length === 1 && agentes[0].avatar ? (
              <Avatar name={agentes[0].name} avatar={agentes[0].avatar} className="h-4 w-4" />
            ) : (
              <img src="/ghosty.svg" alt="" className="h-4 w-4" />
            )}
            {agentes.length === 1
              ? t("{name} está aquí", { name: agentes[0].name })
              : t("Tus agentes están aquí")}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {/* Sin `.slice(0, 3)`: el cap silencioso dejaba fuera al CUARTO agente y la
                tarjeta se leía como si no existiera (pasó con @deep el 2026-08-08). Aquí no
                sobra espacio para inventar un "+N": son los handles con los que se invoca al
                agente, y un handle que no se ve es un agente que nadie menciona. */}
            {agentes.map((a, i) => (
              <span key={a.handle}>
                {i > 0 ? " · " : ""}
                <span className="text-brand">@{a.handle}</span>
              </span>
            ))}
            <br />
            {agentes.length === 1
              ? t("Menciónalo en un room o hilo y responde ahí mismo.")
              : t("Menciónalos en un room o hilo y responden ahí mismo.")}
          </p>
        </div>
      )}

      <InstallAppButton />

      {/* Ajustes = modal instantáneo in-panel (SPA), no navegación de ruta. */}
      <button
        onClick={() => openPrefs?.()}
        className="flex w-full items-center gap-2 border-t border-border p-3 text-left hover:bg-surface-3"
      >
        <Avatar name={user?.name} avatar={user?.avatar} className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{user?.name ?? "—"}</p>
          {/* `isStaff` primero: el staff lleva `isOwner` en true para heredar permisos,
              pero no es el dueño. Ver `SessionUser` en users.server.ts. */}
          <p className="truncate text-xs text-muted">
            {user?.isStaff ? t("Staff") : user?.isOwner ? t("Owner") : t("Miembro")}
          </p>
        </div>
        <Settings size={16} className="text-muted" />
      </button>

      <AnimatePresence>
        {createOpen && (
          <CreateRoomModal
            onClose={() => setCreateOpen(false)}
            onCreated={(slug) => {
              setCreateOpen(false);
              router.invalidate();
              router.navigate({ to: "/c/$slug", params: { slug } });
            }}
          />
        )}
        {settingsSlug && (
          <RoomSettingsModal
            slug={settingsSlug}
            channel={channels.find((c) => c.slug === settingsSlug) ?? null}
            onClose={() => setSettingsSlug(null)}
            onChanged={() => router.invalidate()}
            onDeleted={() => {
              setSettingsSlug(null);
              router.invalidate();
              router.navigate({ to: "/c/$slug", params: { slug: "general" } });
            }}
          />
        )}
        {newDmOpen && (
          <NewDmModal
            me={user}
            onClose={() => setNewDmOpen(false)}
            onOpened={(id) => {
              setNewDmOpen(false);
              onOpenDm(id);
              onRevalidate();
            }}
          />
        )}
        {allThreadsOpen && (
          <AllThreadsModal
            threads={threads}
            roomName={channels.find((c) => c.slug === active)?.name ?? t("Room")}
            activeThreadId={activeThreadId}
            onOpen={onOpenThread}
            onDelete={onDeleteThread}
            user={user}
            onClose={() => setAllThreadsOpen(false)}
          />
        )}
      </AnimatePresence>
    </aside>
  );
}

// Botón pequeño y persistente para instalar la PWA (sidebar footer). Solo aparece
// si el navegador la ofrece (`beforeinstallprompt`); oculto si ya está instalada
// (standalone) o en navegadores sin prompt programático (iOS → usa el banner).
function InstallAppButton() {
  const t = useT();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(display-mode: standalone)").matches) return; // ya instalada
    const existing = getDeferredPrompt();
    if (existing) setDeferred(existing);
    const off = onInstallable((e) => setDeferred(e));
    const onInstalled = () => setDeferred(null);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      off();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  if (!deferred) return null;
  const install = async () => {
    await deferred.prompt().catch(() => {});
    await deferred.userChoice.catch(() => {});
    clearDeferredPrompt();
    setDeferred(null);
  };
  return (
    <button
      onClick={install}
      className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted hover:bg-surface-3 hover:text-ink"
    >
      <Download size={14} className="shrink-0" />
      {t("Instalar app")}
    </button>
  );
}

/* ── Perfil (drawer derecho) ─────────────────────────────────────────────────
   Identidad de una persona o agente. Informativo + acciones seguras: para agentes,
   el owner puede "Configurar" (→ Preferencias · Agentes). El DM 1:1 a un agente y el
   mensaje directo a personas se marcan como próximos (requieren backend de DM). */
function ProfileDrawer({
  target,
  isOwner,
  onClose,
  onConfigure,
  onStartDm,
  onStartAgentDm,
}: {
  target: ProfileTarget;
  isOwner: boolean;
  onClose: () => void;
  onConfigure: () => void;
  onStartDm: (sub: string) => void;
  onStartAgentDm: (handle: string) => void;
}) {
  const t = useT();
  const { users, me } = useContext(ChatCtx);
  const dir = target.sub ? users.get(target.sub) : undefined; // perfil vivo del directorio
  const isSelf = !!me && !!target.sub && target.sub === me.sub;
  const isGhosty = target.handle === "ghosty";
  const name = dir?.name || target.name;
  const avatar = dir?.avatar || target.avatar || undefined;
  const handle = dir?.handle || target.handle;

  const [editing, setEditing] = useState(false);
  const [sEmoji, setSEmoji] = useState(dir?.statusEmoji ?? "");
  const [sText, setSText] = useState(dir?.statusText ?? "");
  const [title, setTitle] = useState(dir?.title ?? "");
  const [pronouns, setPronouns] = useState(dir?.pronouns ?? "");
  const [bio, setBio] = useState(dir?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [expelBusy, setExpelBusy] = useState(false);
  const [confirmExpel, setConfirmExpel] = useState(false);
  const [pickEmoji, setPickEmoji] = useState(false);
  const [nameEdit, setNameEdit] = useState(dir?.name ?? target.name ?? "");
  const [avatarEdit, setAvatarEdit] = useState(dir?.avatar || target.avatar || "");
  const [avUploading, setAvUploading] = useState(false);
  const avFileRef = useRef<HTMLInputElement>(null);
  async function onAvatar(file: File) {
    setAvUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error("upload");
      const up = (await res.json()) as { fileId: string };
      setAvatarEdit(`/api/attachment/${encodeURIComponent(up.fileId)}`);
    } catch { /* noop */ } finally {
      setAvUploading(false);
      if (avFileRef.current) avFileRef.current.value = "";
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (editing ? setEditing(false) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  async function saveProfile() {
    setSaving(true);
    try {
      const origName = dir?.name ?? target.name ?? "";
      const origAvatar = dir?.avatar || target.avatar || "";
      await updateMyProfileFn({ data: {
        ...(nameEdit.trim() && nameEdit.trim() !== origName ? { name: nameEdit.trim() } : {}),
        ...(avatarEdit !== origAvatar ? { avatar: avatarEdit } : {}),
        statusEmoji: sEmoji || null, statusText: sText || null, title: title || null, pronouns: pronouns || null, bio: bio || null,
      } });
      clearMeCache();
      bumpUsers(); // se refleja al instante en el directorio (drawer + mensajes viejos + sidebar)
      window.dispatchEvent(new Event("gt:me-updated")); // revalida loader → header/sidebar/composer
      setEditing(false);
    } catch { /* noop */ } finally { setSaving(false); }
  }
  async function doExpel() {
    if (!target.sub) return;
    setExpelBusy(true);
    try { await expelMemberFn({ data: { sub: target.sub } }); bumpUsers(); onClose(); }
    catch { setExpelBusy(false); }
  }

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-0.5 text-sm text-ink">{children}</div>
    </div>
  );

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
    >
      <motion.aside
        initial={{ x: 32, opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 32, opacity: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 42 }}
        onClick={(e) => e.stopPropagation()}
        className="thin-scroll flex h-full w-[88vw] max-w-sm flex-col overflow-y-auto border-l border-border bg-surface-2 text-ink"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">{t("Perfil")}</span>
          <button onClick={onClose} className="text-muted hover:text-ink" title={t("Cerrar")}>
            <X size={18} />
          </button>
        </div>
        {/* Cabecera: avatar + nombre + status + tipo/handle */}
        <div className="flex flex-col items-center px-6 pb-2 pt-2 text-center">
          {editing && isSelf && !target.isAgent ? (
            // Editando MI perfil → el avatar se sube desde aquí (clic → archivo).
            <>
              <button
                type="button"
                onClick={() => avFileRef.current?.click()}
                disabled={avUploading}
                title={t("Cambiar foto")}
                className="group relative h-24 w-24 overflow-hidden rounded-2xl border border-border"
              >
                {avatarEdit ? (
                  <img src={avatarEdit} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center bg-surface-3 text-2xl font-semibold">{(nameEdit || name).slice(0, 2).toUpperCase()}</span>
                )}
                <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                  {avUploading ? <Loader2 size={18} className="animate-spin text-white" /> : <Pencil size={16} className="text-white" />}
                </span>
              </button>
              <input ref={avFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onAvatar(f); }} />
            </>
          ) : isGhosty ? (
            <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-2xl bg-white">
              <img src="/ghosty.svg" alt="" className="h-full w-full object-contain" />
            </div>
          ) : target.isAgent ? (
            avatar ? (
              <img src={avatar} alt="" loading="lazy" decoding="async" className="h-24 w-24 rounded-2xl object-cover" />
            ) : (
              <div className="grid h-24 w-24 place-items-center rounded-2xl bg-brand/15 text-brand"><Bot size={40} /></div>
            )
          ) : (
            <Avatar name={name} avatar={avatar} className="h-24 w-24 !rounded-2xl text-2xl" />
          )}
          {!editing && <h2 className="mt-3 text-lg font-semibold">{name}</h2>}
          {!editing && (dir?.statusText || dir?.statusEmoji) && (
            <p className="mt-0.5 text-sm text-ink">{dir?.statusEmoji} {dir?.statusText}</p>
          )}
          {/* Decía "Miembro" para todo el mundo, dueño incluido. Ahora dice el tipo real:
              es la ÚNICA señal de que hay alguien de fuera del equipo con acceso al
              espacio, y por eso el staff se nombra aquí en vez de esconderse. */}
          <p className="mt-0.5 text-sm text-muted">
            {target.isAgent
              ? t("Agente")
              : dir?.isStaff
                ? t("Staff")
                : dir?.isOwner
                  ? t("Owner")
                  : t("Miembro")}
            {handle ? ` · @${handle}` : ""}
            {dir?.pronouns ? ` · ${dir.pronouns}` : ""}
          </p>
          {dir?.title && !editing ? <p className="text-xs text-muted">{dir.title}</p> : null}
        </div>

        <div className="mt-3 space-y-2 px-4 pb-6">
          {target.isAgent ? (
            <>
              <button
                onClick={() => handle && onStartAgentDm(handle)}
                disabled={!handle}
                title={t("Mensaje directo")}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
              >
                <MessageSquare size={15} /> {t("Mensaje directo")}
              </button>
              {isOwner && (
                <button onClick={onConfigure} className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition hover:border-brand hover:text-ink">
                  <Settings size={15} /> {t("Configurar agente")}
                </button>
              )}
              <p className="px-1 pt-1 text-center text-xs text-muted">
                {t("Tagéalo con @{handle} en cualquier mensaje para que responda.", { handle: handle || "handle" })}
              </p>
            </>
          ) : editing ? (
            // Editar MI perfil completo: apodo (display name) + status (emoji picker +
            // presets) + título + pronombres + bio. Avatar se sube en la cabecera.
            <>
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Apodo (nombre visible)")}</span>
                <input value={nameEdit} onChange={(e) => setNameEdit(e.target.value)} placeholder={t("Tu apodo")} maxLength={60}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
              </label>
              {/* Status: presets rápidos + emoji (picker) + texto. */}
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Status")}</span>
                <div className="mt-1 mb-1.5 flex flex-wrap gap-1">
                  {STATUS_PRESETS.map((p) => (
                    <button key={p.text} type="button" onClick={() => { setSEmoji(p.emoji); setSText(p.text); }}
                      className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted transition hover:border-brand hover:text-ink">
                      {p.emoji} {t(p.text)}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <div className="relative">
                    <button type="button" onClick={() => setPickEmoji((v) => !v)} title={t("Elegir emoji")}
                      className="grid h-[42px] w-14 place-items-center rounded-lg border border-border bg-surface text-lg transition hover:border-brand">
                      {sEmoji ? <EmojiText code={sEmoji} className="h-6 w-6 object-contain" /> : <SmilePlus size={18} className="text-muted" />}
                    </button>
                    {pickEmoji && (
                      <EmojiPicker onPick={(e) => { setSEmoji(e); setPickEmoji(false); }} />
                    )}
                  </div>
                  <input value={sText} onChange={(e) => setSText(e.target.value)} placeholder={t("¿En qué andas?")} maxLength={80}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
                  {(sEmoji || sText) && (
                    <button type="button" onClick={() => { setSEmoji(""); setSText(""); }} title={t("Limpiar")}
                      className="shrink-0 rounded-lg border border-border px-2 text-muted hover:text-ink"><X size={14} /></button>
                  )}
                </div>
              </div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Título / rol")} maxLength={80}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
              <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder={t("Pronombres")} maxLength={40}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder={t("Sobre ti")} maxLength={400} rows={3}
                className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm" />
              <div className="flex gap-2 pt-1">
                <button onClick={saveProfile} disabled={saving} className="flex-1 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50">
                  {saving ? t("Guardando…") : t("Guardar")}
                </button>
                <button onClick={() => setEditing(false)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-ink">
                  {t("Cancelar")}
                </button>
              </div>
            </>
          ) : (
            <>
              {isSelf ? (
                <button onClick={() => setEditing(true)} className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition hover:border-brand">
                  <Pencil size={15} /> {t("Editar perfil")}
                </button>
              ) : (
                <button onClick={() => target.sub && onStartDm(target.sub)} disabled={!target.sub}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:brightness-110 disabled:opacity-50">
                  <MessageSquare size={15} /> {t("Enviar mensaje")}
                </button>
              )}
              {dir?.bio ? <Field label={t("Sobre")}>{dir.bio}</Field> : null}
              {/* Expulsar (owner, no a sí mismo, no agentes). Acción destructiva → DISCRETA:
                  separada por un divisor, texto chico apagado (rojo solo al hover), lejos de
                  "Enviar mensaje", y con confirmación explícita (advertencia) al clickear. */}
              {isOwner && !isSelf && target.sub && (
                <div className="mt-5 border-t border-border pt-3">
                  {confirmExpel ? (
                    <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                      <p className="mb-2 text-xs text-muted">{t("¿Expulsar a {name} del workspace? No podrá volver a entrar.", { name })}</p>
                      <div className="flex gap-2">
                        <button onClick={doExpel} disabled={expelBusy} className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                          {expelBusy ? t("Expulsando…") : t("Sí, expulsar")}
                        </button>
                        <button onClick={() => setConfirmExpel(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-muted">{t("Cancelar")}</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmExpel(true)} className="mx-auto block text-xs text-muted transition hover:text-red-400">
                      {t("Expulsar del workspace")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </motion.aside>
    </motion.div>,
    document.body
  );
}

function CreateRoomModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("hash");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ch = await createChannelFn({ data: { name: name.trim(), description: description.trim() || undefined, icon, isPrivate } });
      onCreated(ch.slug);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <h2 className="mb-4 text-base font-semibold">{t("Crear room")}</h2>
      <label className="mb-1.5 block text-xs font-medium text-muted">{t("Nombre")}</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder={t("nombre del room")}
        className="mb-4 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
      />
      <label className="mb-1.5 block text-xs font-medium text-muted">{t("Descripción")} <span className="text-faint">({t("opcional")})</span></label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("¿De qué trata este room?")}
        rows={2}
        maxLength={280}
        className="mb-1 w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <p className="mb-5 text-right text-[11px] text-faint tabular-nums">{description.length}/280</p>
      <label className="mb-2 block text-xs font-medium text-muted">{t("Icono")}</label>
      <div className="mb-5 grid grid-cols-8 gap-2">
        {ROOM_ICONS.map(({ name: n, Icon }) => (
          <button
            key={n}
            onClick={() => setIcon(n)}
            className={`grid aspect-square place-items-center rounded-lg transition ${
              icon === n
                ? "bg-brand text-brand-fg"
                : "bg-surface text-muted hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
      {/* El MISMO interruptor que en todas partes: éste era más pequeño (h-5 w-9) y con su
          propio cálculo de desplazamiento, así que el control de "privado" se veía distinto
          según desde dónde llegaras a él. */}
      <div className="mb-5 flex w-full items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-left text-sm">
        <Lock size={14} className="text-muted" />
        <span className="flex-1">{t("Privado (solo miembros invitados)")}</span>
        <Toggle on={isPrivate} onChange={setIsPrivate} />
      </div>
      {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
          {t("Cancelar")}
        </button>
        <button
          onClick={create}
          disabled={busy || !name.trim()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {busy ? t("Creando…") : t("Crear")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Convertir un room en la puerta de un evento abierto.
 *
 * ⚠️ Va aparte y con su propio botón de encendido porque cruza una frontera que
 * el resto del formulario no cruza: "privado / del workspace" es una cosa y
 * "abierto a internet" es otra. Meterlo como una casilla más entre el icono y la
 * descripción invitaría a prenderlo sin leerlo.
 */
function EventSection({
  slug,
  channel,
  onChanged,
}: {
  slug: string;
  channel: Channel | null;
  onChanged: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"webinar" | "taller">(channel?.call_mode ?? "webinar");
  const [shareSlug, setShareSlug] = useState(channel?.call_share_slug ?? "");
  const [title, setTitle] = useState(channel?.call_title ?? "");
  const [agentOn, setAgentOn] = useState(channel?.agent_enabled === 1);
  const [callOn, setCallOn] = useState(channel?.call_open === 1);
  // `datetime-local` habla en hora LOCAL y sin zona; la columna es epoch UTC. La ida y la
  // vuelta se hacen aquí, en un solo sitio, para que no haya dos conversiones que puedan
  // divergir por una hora sin que nadie lo note hasta el día del evento.
  const [startsAt, setStartsAt] = useState(() => {
    if (!channel?.starts_at) return "";
    const d = new Date(channel.starts_at * 1000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  });
  const [open, setOpen] = useState(channel?.public_access === 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [regs, setRegs] = useState<{ id: number; name: string; email: string }[] | null>(null);
  // ⚠️ El estado de "abierto" se lleva LOCAL además de en el prop. Leerlo sólo del
  // prop dejaba la UI mintiendo justo después de abrir: se guardaba bien, pero el
  // botón seguía diciendo "Abrir al público" hasta que el modal se remontara — o
  // sea que parecía que el clic no había hecho nada.
  const [isOn, setIsOn] = useState(channel?.public_access === 1);

  const effectiveSlug = (shareSlug.trim() || channel?.slug || "").toLowerCase();
  const liveUrl = typeof window !== "undefined" && effectiveSlug ? `${window.location.origin}/room/${effectiveSlug}` : "";

  async function save(next: { publicAccess?: boolean }) {
    setBusy(true);
    setErr(null);
    try {
      const r = await setChannelEventFn({
        data: {
          slug,
          mode,
          shareSlug: shareSlug.trim() || null,
          title: title.trim() || null,
          agentEnabled: agentOn,
          callOpen: callOn,
          startsAt: startsAt ? Math.floor(new Date(startsAt).getTime() / 1000) : null,
          ...(next.publicAccess !== undefined ? { publicAccess: next.publicAccess } : {}),
        },
      });
      // El servidor puede haber RELLENADO la liga (si se abrió sin una, la deriva
      // del nombre del room): sin leer la respuesta, la caja se quedaba vacía y la
      // liga que se enseña no sería la real.
      if (r.channel?.call_share_slug) setShareSlug(r.channel.call_share_slug);
      if (next.publicAccess !== undefined) setIsOn(next.publicAccess);
      onChanged();
    } catch (e) {
      setErr((e as Error).message || t("No pude guardar"));
    }
    setBusy(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sin permiso de portapapeles: el texto está a la vista para copiarlo a mano */
    }
  }

  useEffect(() => {
    if (!isOn) return;
    listEventRegistrationsFn({ data: { slug } })
      .then((r) => setRegs(r.registrations))
      .catch(() => setRegs([]));
  }, [slug, isOn]);

  if (!open) {
    return (
      <div className="mb-4">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
        >
          <Radio size={15} /> {t("Convertir en evento abierto…")}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <Radio size={15} className="text-muted" />
        <span className="text-sm font-semibold">{t("Evento abierto")}</span>
        {isOn && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">{t("EN VIVO")}</span>}
      </div>
      <p className="mb-3 text-xs text-muted">
        {t("Cualquiera con la liga entra a la sala, sin cuenta y sin ocupar un asiento de tu plan.")}
      </p>

      {/* Abierto: la liga es LO PRIMERO y con su botón de copiar. Es el único
          resultado que le importa a quien acaba de abrir el evento; enterrarla
          entre los campos obliga a buscarla justo cuando hay que repartirla. */}
      {isOn && liveUrl && (
        <div className="mb-4 rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-1.5 text-xs font-medium text-muted">{t("Comparte esta liga")}</div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={liveUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none"
            />
            <button
              onClick={copyLink}
              className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-surface-3"
            >
              {copied ? t("Copiada") : t("Copiar")}
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex gap-2">
        {(["webinar", "taller"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-xs transition ${
              mode === m ? "border-brand bg-brand/10" : "border-border hover:bg-surface-2"
            }`}
          >
            <div className="font-semibold capitalize">{t(m)}</div>
            <div className="text-muted">
              {m === "webinar" ? t("entran a escuchar; tú das la palabra") : t("entran con micrófono y cámara")}
            </div>
          </button>
        ))}
      </div>

      <label className="mb-1 block text-xs font-medium text-muted">{t("Título del evento")}</label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={channel?.name ?? ""}
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />

      <label className="mb-1 block text-xs font-medium text-muted">{t("Empieza el…")}</label>
      {/* `datetime-local` da la hora en el RELOJ DE QUIEN LA ESCRIBE y se guarda en UTC:
          un webinar se anuncia a gente de varias zonas, y la página se la pinta a cada
          quien en la suya. Vacío = room siempre abierto, que es un caso legítimo. */}
      <input
        type="datetime-local"
        value={startsAt}
        onChange={(e) => setStartsAt(e.target.value)}
        className="mb-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <p className="mb-3 text-[11px] text-muted">
        {t("Déjalo vacío si el room está siempre abierto y no hay una hora concreta.")}
      </p>

      <label className="mb-1 block text-xs font-medium text-muted">{t("Liga pública")}</label>
      <div className="mb-3 flex items-center gap-1 text-sm">
        <span className="shrink-0 text-muted">/room/</span>
        <input
          value={shareSlug}
          onChange={(e) => setShareSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          placeholder={channel?.slug ?? "mi-evento"}
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
      </div>

      {/* Interruptores, no casillas: es el control que usa el resto de Teams, y dos formas
          del mismo gesto en el mismo producto se leen como dos cosas distintas. Además
          esto se enciende y se apaga a media sesión —el agente sobre todo—, y un
          interruptor dice de un vistazo en qué estado está. */}
      <div className="mb-3 mt-2 flex items-start justify-between gap-3 text-xs">
        <span>
          <span className="font-medium">{t("El agente responde en este evento")}</span>
          <br />
          <span className="text-muted">
            {t("Sólo si lo mencionan. Cada respuesta consume saldo tuyo y aquí escribe gente de fuera.")}
          </span>
        </span>
        <Toggle on={agentOn} onChange={setAgentOn} />
      </div>

      <div className="mb-3 flex items-start justify-between gap-3 text-xs">
        <span>
          <span className="font-medium">{t("Llamada abierta")}</span>
          <br />
          <span className="text-muted">
            {t("Apagada, el botón sale desactivado. Déjala prendida para que la comunidad entre cuando quiera, o enciéndela sólo a la hora del evento.")}
          </span>
        </span>
        <Toggle on={callOn} onChange={setCallOn} />
      </div>

      {err && <p className="mb-2 text-xs text-red-400">{err}</p>}

      {isOn ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => save({})}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-2 disabled:opacity-50"
          >
            {t("Guardar cambios")}
          </button>
          <button
            onClick={() => {
              if (confirm(t("¿Cerrar el evento? La liga deja de funcionar de inmediato."))) save({ publicAccess: false });
            }}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-400/10 disabled:opacity-50"
          >
            {t("Cerrar el evento")}
          </button>
          {regs && (
            <span className="ml-auto text-xs text-muted">
              {regs.length} {t("registrados")}
            </span>
          )}
        </div>
      ) : (
        /* Cerrado: UN solo botón. Abrir guarda todo lo de arriba y abre — con dos
           botones no se elige nada, sólo se duda si hay que apretar los dos. */
        <button
          onClick={() => save({ publicAccess: true })}
          disabled={busy}
          className="w-full rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? t("Abriendo…") : t("Abrir al público")}
        </button>
      )}
    </div>
  );
}

function RoomSettingsModal({
  slug,
  channel,
  onClose,
  onChanged,
  onDeleted,
}: {
  slug: string;
  channel: Channel | null;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [members, setMembers] = useState<{ sub: string; name: string; email: string; avatar: string }[] | null>(null);
  const [users, setUsers] = useState<{ sub: string; handle: string; name: string; email: string; avatar: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(channel?.name ?? "");
  const [icon, setIcon] = useState(channel?.icon ?? "hash");
  const [isPrivate, setIsPrivate] = useState(channel?.is_private === 1);
  const [desc, setDesc] = useState(channel?.description ?? "");
  const [infoSaved, setInfoSaved] = useState(false);

  // Identidad del room (nombre + icono + privacidad + descripción) se guardan juntos.
  const infoDirty =
    name.trim() !== (channel?.name ?? "") ||
    icon !== (channel?.icon ?? "hash") ||
    isPrivate !== (channel?.is_private === 1) ||
    desc.trim() !== (channel?.description ?? "");

  async function saveInfo() {
    if (!name.trim() || !infoDirty) return;
    await updateChannelFn({
      data: {
        slug,
        name: name.trim(),
        icon,
        isPrivate,
        description: desc.trim() || null,
      },
    }).catch(() => {});
    setInfoSaved(true);
    onChanged();
    setTimeout(() => setInfoSaved(false), 1500);
  }
  async function archive() {
    if (!confirm(t("¿Archivar este room? Desaparece del sidebar (no se borra).")))
      return;
    await updateChannelFn({ data: { slug, archived: true } }).catch(() => {});
    onDeleted();
  }

  useEffect(() => {
    getChannelMembersFn({ data: { slug } })
      .then(setMembers)
      .catch(() => setMembers([]));
    listWorkspaceUsersFn().then(setUsers).catch(() => setUsers([]));
  }, [slug]);

  // Sugerencias: usuarios del workspace que matchean y NO son ya miembros.
  const memberSubs = new Set((members ?? []).map((m) => m.sub));
  const q = inviteEmail.trim().toLowerCase();
  const suggestions =
    q.length < 1
      ? []
      : users
          .filter((u) => !memberSubs.has(u.sub))
          .filter(
            (u) =>
              u.handle.includes(q) ||
              u.name.toLowerCase().includes(q) ||
              u.email.toLowerCase().includes(q)
          )
          .slice(0, 5);

  async function invite(email?: string) {
    const target = (email ?? inviteEmail).trim();
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await addChannelMemberFn({ data: { slug, email: target } });
      setInviteEmail("");
      setMembers(await getChannelMembersFn({ data: { slug } }));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("error"));
    }
    setBusy(false);
  }
  async function remove(sub: string) {
    await removeChannelMemberFn({ data: { slug, sub } }).catch(() => {});
    setMembers((m) => (m ? m.filter((x) => x.sub !== sub) : m));
    onChanged();
  }
  async function del() {
    if (!confirm(t("¿Eliminar este room y todos sus mensajes?"))) return;
    await deleteChannelFn({ data: { slug } }).catch(() => {});
    playDeleteSound();
    onDeleted();
  }

  return (
    <Modal onClose={onClose} wide>
      <h2 className="mb-4 text-base font-semibold">{t("Ajustes del room")}</h2>

      {/* Identidad: icono + nombre en la misma fila (estilo Zulip/Slack) */}
      <label className="mb-1.5 block text-xs font-medium text-muted">{t("Nombre")}</label>
      <div className="mb-3 flex items-center gap-2">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border bg-surface text-muted">
          <RoomIcon name={icon} size={18} />
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveInfo()}
          placeholder={t("nombre del room")}
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
        />
      </div>

      {/* Icono */}
      <label className="mb-2 block text-xs font-medium text-muted">{t("Icono")}</label>
      <div className="mb-4 grid grid-cols-8 gap-2">
        {ROOM_ICONS.map(({ name: n, Icon }) => (
          <button
            key={n}
            onClick={() => setIcon(n)}
            className={`grid aspect-square place-items-center rounded-lg transition ${
              icon === n
                ? "bg-brand text-brand-fg"
                : "bg-surface text-muted hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>

      {/* Descripción */}
      <label className="mb-1.5 block text-xs font-medium text-muted">{t("Descripción")}</label>
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        rows={2}
        maxLength={280}
        placeholder={t("¿De qué trata este room?")}
        className="mb-3 w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />

      {/* Privacidad — mismo interruptor que el resto de la app. */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2.5 text-sm">
        <span className="flex items-center gap-2">
          <Lock size={14} className="text-muted" />
          {t("Privado (solo miembros invitados)")}
        </span>
        <Toggle on={isPrivate} onChange={setIsPrivate} />
      </div>

      {/* Guardar identidad (nombre/icono/privado/descripción juntos) */}
      <div className="mb-5 flex items-center justify-end gap-2">
        {infoSaved && <span className="text-xs text-brand">{t("Guardado")}</span>}
        <button
          onClick={saveInfo}
          disabled={!name.trim() || !infoDirty}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition disabled:opacity-40"
        >
          {t("Guardar cambios")}
        </button>
      </div>

      <div className="mb-4 border-t border-border" />

      <p className="mb-1 text-xs font-medium text-muted">{t("Miembros (rooms privados)")}</p>
      <div className="mb-2 flex gap-2">
        <div className="relative flex-1">
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
              {suggestions.map((u) => (
                <li key={u.sub}>
                  <button
                    type="button"
                    onClick={() => invite(u.email)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    <Avatar name={u.name} avatar={u.avatar} className="h-6 w-6 text-[10px]" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink">{u.name}</span>{" "}
                      <span className="text-xs text-muted">@{u.handle}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && invite()}
            placeholder={t("nombre, @handle o email")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
          />
        </div>
        <button
          onClick={() => invite()}
          disabled={busy}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {t("Invitar")}
        </button>
      </div>
      {err && <p className="mb-2 text-sm text-red-400">{err}</p>}
      <div className="mb-4 max-h-40 space-y-1 overflow-y-auto">
        {members === null ? (
          <p className="text-sm text-muted">{t("Cargando…")}</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted">{t("Sin miembros aún (público = todos).")}</p>
        ) : (
          members.map((m) => (
            <div key={m.sub} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-3">
              <Avatar name={m.name} avatar={m.avatar} className="h-6 w-6" />
              <span className="min-w-0 flex-1 truncate text-sm">{m.email || m.name}</span>
              <button onClick={() => remove(m.sub)} className="text-xs text-muted hover:text-brand">
                {t("sacar")}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="mb-4 border-t border-border" />
      <EventSection slug={slug} channel={channel} onChanged={onChanged} />

      <div className="mb-3 border-t border-border" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button onClick={archive} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink">
            <Archive size={15} /> {t("Archivar")}
          </button>
          <button onClick={del} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-red-400 hover:bg-red-400/10">
            <Trash2 size={15} /> {t("Eliminar")}
          </button>
        </div>
        <button onClick={onClose} className="ml-auto rounded-lg border border-border px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2">
          {t("Listo")}
        </button>
      </div>
    </Modal>
  );
}

/* ── Nuevo DM: elegir persona(s) del workspace (1:1 o grupo) ── */
// Cache de módulo para el picker de DM (mismo patrón que emojis/menciones/directorio):
// re-abrir el modal es INSTANTÁNEO. Agentes = una vez; búsquedas = por término, TTL corto.
let dmAgentsCache: { handle: string; name: string; avatar: string }[] | null = null;
const dmSearchCache = new Map<string, { at: number; users: { sub: string; handle: string; name: string; avatar: string }[] }>();
const DM_SEARCH_TTL = 30_000;

function NewDmModal({
  me,
  onClose,
  onOpened,
}: {
  me: SessionUser | null;
  onClose: () => void;
  onOpened: (id: number) => void;
}) {
  const t = useT();
  // Seed desde cache → re-abrir el modal pinta al instante (revalida en background).
  const [users, setUsers] = useState(() => dmSearchCache.get("")?.users ?? []);
  const [agents, setAgents] = useState(() => dmAgentsCache ?? []);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!dmSearchCache.has(""));

  // Agentes: pocos, se cargan una vez y se cachean.
  useEffect(() => {
    if (dmAgentsCache) return;
    listAgentsFn().then((a) => { dmAgentsCache = a; setAgents(a); }).catch(() => setAgents([]));
  }, []);
  // Personas: BÚSQUEDA server-side (escala) con cache por término (TTL 30s). Si hay hit
  // fresco → instantáneo, sin spinner; si no → debounce + fetch + cachea.
  useEffect(() => {
    const key = q.trim().toLowerCase();
    const hit = dmSearchCache.get(key);
    if (hit && Date.now() - hit.at < DM_SEARCH_TTL) { setUsers(hit.users); setLoading(false); return; }
    setLoading(true);
    const h = setTimeout(() => {
      searchUsersFn({ data: { query: q } })
        .then((u) => { dmSearchCache.set(key, { at: Date.now(), users: u }); setUsers(u); })
        .catch(() => setUsers([]))
        .finally(() => setLoading(false));
    }, key ? 200 : 0);
    return () => clearTimeout(h);
  }, [q]);

  // DM 1:1 con un agente = inmediato (no multi-select): abre y entra.
  async function startAgent(handle: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { id } = await openDmFn({ data: { agentHandle: handle } });
      onOpened(id);
    } catch {
      setBusy(false);
    }
  }

  const query = q.trim().toLowerCase();
  // El filtro de personas ya lo hace el server (searchUsersFn); aquí solo excluyo mi propio sub.
  const list = users.filter((u) => u.sub !== me?.sub);
  const toggle = (sub: string) =>
    setPicked((p) => (p.includes(sub) ? p.filter((s) => s !== sub) : [...p, sub]));

  async function start() {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const { id } = await openDmFn({ data: { subs: picked } });
      onOpened(id);
    } catch {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="mb-3 font-semibold">{t("Nuevo mensaje directo")}</h2>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("Buscar personas…")}
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="mb-4 max-h-56 space-y-1 overflow-y-auto">
        {/* Agentes de la flota: DM 1:1 directo (cada mensaje enruta al agente). */}
        {(() => {
          const ags = agents.filter((a) => !query || a.handle.includes(query) || a.name.toLowerCase().includes(query));
          return ags.length ? (
            <>
              <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-faint">{t("Agentes")}</p>
              {ags.map((a) => (
                <button
                  key={`ag:${a.handle}`}
                  onClick={() => startAgent(a.handle)}
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3 disabled:opacity-50"
                >
                  <Avatar name={a.name} avatar={a.avatar} className="h-7 w-7 text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-ink">{a.name}</span>{" "}
                    <span className="text-xs text-muted">@{a.handle}</span>
                  </span>
                  <MessageSquare size={14} className="shrink-0 text-muted" />
                </button>
              ))}
              {list.length > 0 && <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-faint">{t("Personas")}</p>}
            </>
          ) : null;
        })()}
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("Cargando personas…")}
          </div>
        ) : list.length === 0 && agents.filter((a) => !query || a.handle.includes(query) || a.name.toLowerCase().includes(query)).length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted">{t("Sin resultados.")}</p>
        ) : (
          list.map((u) => {
            const on = picked.includes(u.sub);
            return (
              <button
                key={u.sub}
                onClick={() => toggle(u.sub)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  on ? "bg-brand/15 text-ink" : "hover:bg-surface-3"
                }`}
              >
                <Avatar name={u.name} avatar={u.avatar} className="h-7 w-7 text-[10px]" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">{u.name}</span>{" "}
                  <span className="text-xs text-muted">@{u.handle}</span>
                </span>
                {on && <CheckCircle2 size={16} className="shrink-0 text-brand" />}
              </button>
            );
          })
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
          {t("Cancelar")}
        </button>
        <button
          onClick={start}
          disabled={busy || !picked.length}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {picked.length > 1 ? t("Iniciar grupo ({n})", { n: picked.length }) : t("Iniciar")}
        </button>
      </div>
    </Modal>
  );
}

// Buscador (Fase 2.4): botón en el header → overlay tipo spotlight con resultados.
// Botón de Documentos del CASO (matter-centric): abre el índice Cowork del room en
// el panel (todos sus docs generados + subidos). Convención Slack/Zulip: acción por
// canal a la derecha del header. Mismo channelId para el room y sus hilos.
function DocsButton({ channelId, channelSlug, threadRootId }: { channelId: number; channelSlug: string; threadRootId?: number }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  return (
    <button
      type="button"
      onClick={() => onOpenArtifact?.({ kind: "docindex", title: t("Documentos"), channelId, channelSlug, threadRootId })}
      title={t("Documentos del caso")}
      aria-label={t("Documentos del caso")}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink"
    >
      <FolderOpen size={17} />
    </button>
  );
}

// ── Repos del room ───────────────────────────────────────────────────────────
// El room declara sobre qué código habla, y el agente hereda ese alcance en vez de
// adivinarlo en cada turno. El porqué de la frontera vive junto a la tabla
// (server/schema.server.ts, gt_room_repos); aquí sólo está la UI.
//
// Dos estados y son distintos a propósito:
//   · sin repo  → "Connect": buscador sobre TU instalación + preview de PRs del candidato
//                 enfocado, para no atar un fork homónimo.
//   · con repo  → el chip del repo, y su menú es la lista de PRs abiertos. Ése es el de
//                 diario: entras al room y ves el estado sin gastar un turno del agente.
function RepoButton({ channelId }: { channelId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<{ repo: string; connectedBy: string }[] | null>(null);

  const cargar = useCallback(() => {
    roomReposFn({ data: { channelId } })
      .then((r) => setMine(r.map((x) => ({ repo: x.repo, connectedBy: x.connectedBy }))))
      .catch(() => setMine([]));
  }, [channelId]);

  useEffect(() => cargar(), [cargar]);

  const atado = mine?.[0]?.repo ?? null;
  const extra = (mine?.length ?? 0) - 1;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={atado ?? t("Conectar un repositorio")}
        aria-label={atado ?? t("Conectar un repositorio")}
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink ${atado ? "px-2" : "w-9 justify-center"} ${open ? "bg-surface-3 text-ink" : ""}`}
      >
        <Github size={17} className="shrink-0" />
        {/* Texto SÓLO cuando lleva información. Sin repo decía "Conectar", que es lo mismo
            que ya dice el pulpo, y con "Llamada" al lado dejaba el encabezado cargado de
            palabras entre puros íconos. El nombre del repo sí vale el espacio — y aun así
            es lo primero que se va al angostarse. */}
        {atado && (
          <>
            <span className="hidden max-w-[13ch] truncate text-xs @lg/hdr:inline">
              {atado.split("/")[1]}
            </span>
            {extra > 0 && <span className="hidden text-[11px] text-muted @lg/hdr:inline">+{extra}</span>}
          </>
        )}
      </button>
      {open && (
        <RepoPanel
          channelId={channelId}
          mine={mine ?? []}
          onClose={() => setOpen(false)}
          onChange={(next) => setMine(next.map((x) => ({ repo: x.repo, connectedBy: x.connectedBy })))}
        />
      )}
    </div>
  );
}

function RepoPanel({
  channelId,
  mine,
  onClose,
  onChange,
}: {
  channelId: number;
  mine: { repo: string; connectedBy: string }[];
  onClose: () => void;
  onChange: (next: { repo: string; connectedBy: string }[]) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [disponibles, setDisponibles] = useState<{ repo: string; private?: boolean }[] | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  // El repo cuyo preview se está mirando: el atado si lo hay, o el candidato enfocado.
  const [focus, setFocus] = useState<string | null>(mine[0]?.repo ?? null);
  const [prs, setPrs] = useState<{ number: number; title: string; url: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);

  // La lista se pide al ABRIR, nunca con la página: es una llamada a GitHub por persona, y
  // el resultado depende de SU instalación (dos miembros del mismo room ven distinto).
  useEffect(() => {
    githubInstallationReposFn()
      .then((r) => {
        setDisponibles(r.repos.map((x) => ({ repo: x.repo, private: x.private })));
        setInstallUrl(r.installUrl);
      })
      .catch(() => setDisponibles([]));
  }, []);

  // Un preview por repo enfocado = una llamada a GitHub por fila. Debounce + caché mientras
  // el panel viva, o teclear en el buscador dispara una ráfaga.
  const cache = useRef(new Map<string, { number: number; title: string; url: string | null }[]>());
  useEffect(() => {
    if (!focus) return setPrs(null);
    const hit = cache.current.get(focus);
    if (hit) return setPrs(hit);
    setPrs(null);
    const id = setTimeout(() => {
      githubOpenPrsFn({ data: { repo: focus, limit: 6 } })
        .then((r) => {
          cache.current.set(focus, r as any);
          setPrs(r as any);
        })
        .catch(() => setPrs([]));
    }, 250);
    return () => clearTimeout(id);
  }, [focus]);

  const ya = new Set(mine.map((m) => m.repo.toLowerCase()));
  const candidatos = (disponibles ?? [])
    .filter((r) => !ya.has(r.repo.toLowerCase()))
    .filter((r) => !q.trim() || r.repo.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 8);

  const conectar = async (repo: string) => {
    setBusy(true);
    try {
      const next = await addRoomRepoFn({ data: { channelId, repo } });
      onChange(next.map((x) => ({ repo: x.repo, connectedBy: x.connectedBy })));
      setFocus(repo);
      setQ("");
    } finally {
      setBusy(false);
    }
  };

  const quitar = async (repo: string) => {
    setBusy(true);
    try {
      const next = await removeRoomRepoFn({ data: { channelId, repo } });
      onChange(next.map((x) => ({ repo: x.repo, connectedBy: x.connectedBy })));
      setFocus(next[0]?.repo ?? null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* En pantalla chica el panel tapa los mensajes y el borde de 1px no basta para
          separarlo: el velo hace de fondo. En desktop se queda invisible (sólo cierra al
          clic), que es lo que espera un popover de encabezado. */}
      <div className="fixed inset-0 z-40 bg-black/40 sm:bg-transparent" onClick={onClose} />
      {/* ⚠️ `bg-surface`, NO `bg-surface-1`: ese token NO existe (styles.css define surface,
          surface-2 y surface-3). Tailwind no falla con una clase inventada — simplemente no
          pinta nada, así que el panel salía transparente y se leía como un bug de z-index.
          Y z-50, el mismo de los otros popovers del archivo. */}
      {/* En móvil es una hoja anclada bajo el encabezado y a lo ancho: `absolute right-0`
          con 22rem se salía del contenedor y el `max-w` lo dejaba pegado al borde. En
          `sm:` vuelve a ser el popover de siempre.
          El `ring` va además del borde: sobre el chat —blanco sobre blanco— un borde de
          #e4e2f0 es casi invisible y el panel se lee como transparente. */}
      <div className="fixed inset-x-2 top-14 z-50 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl ring-1 ring-black/10 sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-1 sm:w-[22rem] dark:ring-white/10">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Buscar un repositorio…")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>

        {/* dvh, no rem: en un teléfono con el teclado abierto 26rem no cabe y la lista
            quedaba cortada sin poder llegar al final. */}
        <div className="max-h-[min(26rem,65dvh)] overflow-y-auto thin-scroll">
          {mine.length > 0 && (
            <section className="border-b border-border py-1">
              <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">
                {t("Conectados a este room")}
              </p>
              {mine.map((m) => (
                <div
                  key={m.repo}
                  onMouseEnter={() => setFocus(m.repo)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm ${focus === m.repo ? "bg-surface-2" : ""}`}
                >
                  <Github size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{m.repo}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => quitar(m.repo)}
                    className="shrink-0 rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"
                    aria-label={t("Quitar del room")}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </section>
          )}

          <section className="py-1">
            <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">
              {t("Conectar un repositorio")}
            </p>
            {disponibles === null ? (
              <p className="px-3 py-2 text-xs text-muted">{t("Buscando tus repositorios…")}</p>
            ) : !disponibles.length ? (
              // El vacío correcto NO es un buscador mudo: lo que la persona ve en el picker
              // son los repos de SU instalación, así que si no hay ninguno lo que falta es
              // elegirlos en GitHub, no buscar mejor.
              <div className="px-3 py-2 text-xs text-muted">
                <p>{t("No hay repositorios en tu instalación de GitHub.")}</p>
                {installUrl && (
                  <a
                    href={installUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    {t("Elegir repos en GitHub")} <ExternalLink size={11} />
                  </a>
                )}
              </div>
            ) : !candidatos.length ? (
              // Sin búsqueda escrita, la lista vacía NO es "no coincide": es que todos los
              // repos de tu instalación ya están en este room. Decir "ninguno coincide"
              // manda a buscar algo que no existe en vez de a GitHub por más repos.
              <div className="px-3 py-2 text-xs text-muted">
                {q.trim() ? (
                  <p>{t("Ningún repositorio coincide.")}</p>
                ) : (
                  <>
                    <p>{t("Ya conectaste todos los repositorios de tu instalación.")}</p>
                    {installUrl && (
                      <a
                        href={installUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-brand hover:underline"
                      >
                        {t("Elegir repos en GitHub")} <ExternalLink size={11} />
                      </a>
                    )}
                  </>
                )}
              </div>
            ) : (
              candidatos.map((r) => (
                <button
                  key={r.repo}
                  type="button"
                  disabled={busy}
                  onMouseEnter={() => setFocus(r.repo)}
                  onFocus={() => setFocus(r.repo)}
                  onClick={() => conectar(r.repo)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${focus === r.repo ? "bg-surface-2" : ""}`}
                >
                  {r.private ? (
                    <Lock size={13} className="shrink-0 text-muted" />
                  ) : (
                    <Github size={13} className="shrink-0 text-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{r.repo}</span>
                </button>
              ))
            )}
          </section>

          {/* El preview sigue al repo enfocado: sirve para confirmar que es el que crees
              antes de atarlo, y una vez atado es la lista que se abre a diario. */}
          {focus && (
            <section className="border-t border-border py-1">
              <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">
                {t("PRs abiertos")} · <span className="normal-case">{focus}</span>
              </p>
              {prs === null ? (
                <p className="px-3 py-2 text-xs text-muted">{t("Cargando…")}</p>
              ) : !prs.length ? (
                <p className="px-3 py-2 text-xs text-muted">{t("Ninguno abierto.")}</p>
              ) : (
                prs.map((p) => (
                  <a
                    key={p.number}
                    href={p.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2"
                  >
                    <GitPullRequest size={13} className="shrink-0 text-emerald-600" />
                    <span className="shrink-0 text-muted">#{p.number}</span>
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  </a>
                ))
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

// Quién está en el room: facepile + contador en el header, abierto a CUALQUIERA que
// pueda ver el room (patrón Slack/Discord). Antes la lista solo existía dentro del modal
// de Ajustes, gateado por canManage → un member no podía ver con quién comparte el canal.
// Invitar/expulsar SIGUE viviendo en Ajustes (sigue gateado): esto es solo lectura.
// Chip de "N en línea". El conteo es del WORKSPACE, no del room: son las pestañas
// abiertas contra este tenant, deduplicadas por persona. Para el OWNER es además
// una lista de quiénes — cuando el número no cuadra con lo que ve, el nombre es la
// única forma de saber si sobra una sesión fantasma o hay alguien que no esperaba.
// Para el resto se queda en el número: quién está conectado no es asunto de todos.
function OnlineChip({ online }: { online: OnlinePeople }) {
  const t = useT();
  const { me } = useContext(ChatCtx);
  const [open, setOpen] = useState(false);
  // Reloj propio: `lastActiveAt` envejece sin que llegue ningún evento (nadie emite el
  // paso a inactivo), así que sin este tick el chip se quedaría contando a alguien que
  // ya se fue a comer. Un minuto basta para un umbral de diez.
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (online.size === 0) return null;

  const people = [...online.entries()]
    .map(([sub, p]) => ({ sub, ...p, idle: ahora - p.lastActiveAt > IDLE_MS }))
    .sort((a, b) => Number(a.idle) - Number(b.idle) || b.lastActiveAt - a.lastActiveAt);
  // El chip cuenta ACTIVOS. Los conectados-pero-quietos siguen en la lista del owner,
  // que es donde importa saber que están ahí sin estar.
  const activos = people.filter((p) => !p.idle).length;
  if (activos === 0) return null;
  const chip = (
    <>
      <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
      <span>{t("{n} en línea", { n: activos })}</span>
    </>
  );

  if (!me?.isOwner) {
    return (
      <span className="hidden items-center gap-1.5 text-xs text-muted @xl/hdr:flex" title={t("Personas activas en el espacio ahora mismo")}>
        {chip}
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t("Ver quién está conectado")}
        className="hidden items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-muted transition hover:bg-surface-2 @xl/hdr:flex"
      >
        {chip}
      </button>
      <AnimatePresence>
        {open && (
          <Modal onClose={() => setOpen(false)}>
            <h3 className="mb-1 text-base font-semibold text-ink">{t("Conectados ahora")}</h3>
            <p className="mb-3 text-xs text-muted">
              {t("Cuenta a cada quien una vez, aunque tenga varias pestañas. Sin actividad reciente no quiere decir desconectado: la pestaña sigue abierta.")}
            </p>
            <ul className="max-h-80 space-y-1 overflow-y-auto thin-scroll">
              {people.map((p) => (
                <li key={p.sub} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
                  <Avatar name={p.name} avatar={p.avatar} className={`h-8 w-8 ${p.idle ? "opacity-50" : ""}`} />
                  {/* Relleno vs hueco, no verde vs gris: la diferencia se ve igual sin
                      distinguir color. */}
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${p.idle ? "border border-muted" : "bg-green-500"}`}
                    aria-hidden
                  />
                  <span className={`truncate text-sm ${p.idle ? "text-muted" : "text-ink"}`}>{p.name}</span>
                  {p.sub === me.sub && <span className="text-xs text-muted">{t("tú")}</span>}
                  {p.idle && (
                    <span className="ml-auto shrink-0 text-xs text-muted">
                      {t("hace {n} min", { n: Math.round((ahora - p.lastActiveAt) / 60_000) })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Modal>
        )}
      </AnimatePresence>
    </>
  );
}

function RoomMembersButton({ slug }: { slug: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    derived: boolean;
    members: { sub: string; name: string; avatar: string }[];
  } | null>(null);

  useEffect(() => {
    setData(null);
    listRoomMembersFn({ data: { slug } })
      .then(setData)
      .catch(() => setData({ derived: false, members: [] }));
  }, [slug]);

  const members = data?.members ?? [];
  if (!members.length) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={data?.derived ? t("Personas activas en el canal") : t("Miembros del room")}
        className="flex shrink-0 items-center gap-1 rounded-lg py-1 pl-1 pr-2 transition hover:bg-surface-2"
      >
        <span className="flex -space-x-1.5">
          {members.slice(0, 3).map((m) => (
            <Avatar
              key={m.sub}
              name={m.name}
              avatar={m.avatar}
              className="h-6 w-6 ring-2 ring-surface"
            />
          ))}
        </span>
        <span className="text-xs text-muted">{members.length}</span>
      </button>
      <AnimatePresence>
        {open && (
          <Modal onClose={() => setOpen(false)}>
            <h3 className="mb-1 text-base font-semibold text-ink">{t("Miembros")}</h3>
            {/* En un room público no hay membresía explícita: la lista sale de quién ha
                participado. Se rotula distinto para no prometer algo que no existe. */}
            <p className="mb-3 text-xs text-muted">
              {data?.derived
                ? t("Personas que han participado en este canal.")
                : t("Personas con acceso a este room.")}
            </p>
            <ul className="max-h-80 space-y-1 overflow-y-auto thin-scroll">
              {members.map((m) => (
                <li key={m.sub} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
                  <Avatar name={m.name} avatar={m.avatar} className="h-8 w-8" />
                  <span className="truncate text-sm text-ink">{m.name}</span>
                </li>
              ))}
            </ul>
          </Modal>
        )}
      </AnimatePresence>
    </>
  );
}

// `threadRootId` acota la búsqueda a UN hilo: es el mismo botón, montado también en el
// header del hilo. Sin él, buscar dentro de una conversación larga obligaba a salir al room
// y filtrar a ojo entre los resultados de todos los hilos.
function SearchButton({
  onOpenDm,
  onOpenThread,
  threadRootId,
  currentSlug,
}: {
  onOpenDm: (id: number) => void;
  onOpenThread?: (id: number) => void;
  threadRootId?: number;
  currentSlug?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={threadRootId ? t("Buscar en este hilo") : t("Buscar mensajes")}
        className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <Search size={17} />
      </button>
      <AnimatePresence>
        {open && (
          <SearchModal
            onClose={() => setOpen(false)}
            onOpenDm={onOpenDm}
            onOpenThread={onOpenThread}
            threadRootId={threadRootId}
            currentSlug={currentSlug}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function SearchModal({
  onClose,
  onOpenDm,
  onOpenThread,
  threadRootId,
  currentSlug,
}: {
  onClose: () => void;
  onOpenDm: (id: number) => void;
  onOpenThread?: (id: number) => void;
  threadRootId?: number;
  currentSlug?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ rooms: RoomHit[]; dms: Message[] } | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const h = setTimeout(() => {
      searchMessagesFn({ data: { q: term, threadRootId } })
        .then((r) => setResults(r ?? { rooms: [], dms: [] }))
        .catch(() => setResults({ rooms: [], dms: [] }));
    }, 250);
    return () => clearTimeout(h);
  }, [q, threadRootId]);

  const destello = (id: number) => {
    setTimeout(() => {
      const el = document.getElementById(`msg-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add("flash-highlight");
      setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
    }, 500);
  };
  const goRoom = (m: RoomHit) => {
    onClose();
    // Una respuesta DENTRO de un hilo no existe en el flujo del room: navegar ahí y buscar
    // su `msg-<id>` no encontraría nada (fallo mudo). Desde que la búsqueda dejó de excluir
    // los hilos, hay que ABRIRLO — y sólo si ya estamos en su room, porque `onOpenThread`
    // es estado de esta pantalla.
    if (m.parent_id && onOpenThread && m.slug === currentSlug) {
      onOpenThread(m.parent_id);
      destello(m.id);
      return;
    }
    router.navigate({ to: "/c/$slug", params: { slug: m.slug } });
    destello(m.id);
  };
  const goDm = (dmId: number) => {
    onClose();
    onOpenDm(dmId);
  };

  const empty = results && results.rooms.length === 0 && results.dms.length === 0;
  const hitRow =
    "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-surface-2";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-center bg-black/50 p-4 pt-[10vh]"
    >
      <motion.div
        initial={{ scale: 0.98, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.98, y: 8 }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={18} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={threadRootId ? t("Buscar en este hilo…") : t("Buscar en rooms y DMs…")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <button onClick={onClose} className="shrink-0 rounded p-1 text-muted hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 no-scrollbar">
          {q.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{t("Escribe al menos 2 letras.")}</p>
          ) : !results ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{t("Buscando…")}</p>
          ) : empty ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{t("Sin resultados.")}</p>
          ) : (
            <>
              {results!.rooms.length > 0 && (
                <div className="mb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {threadRootId ? t("En este hilo") : t("Rooms")}
                  </p>
                  {results!.rooms.map((m) => (
                    <button key={`r-${m.id}`} onClick={() => goRoom(m)} className={hitRow}>
                      <span className="text-[11px] text-muted">
                        #{m.roomName} · {m.sender === "ghosty" ? "Ghosty" : m.sender}
                        {/* Marca los hits de hilo: antes ni siquiera aparecían, así que sin
                            esto un resultado que abre otra vista se lee como un salto raro. */}
                        {!threadRootId && m.parent_id ? ` · ${t("en un hilo")}` : ""}
                      </span>
                      <span className="line-clamp-2 text-sm text-ink">{m.body}</span>
                    </button>
                  ))}
                </div>
              )}
              {results!.dms.length > 0 && (
                <div>
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {t("Mensajes directos")}
                  </p>
                  {results!.dms.map((m) => (
                    <button key={`d-${m.id}`} onClick={() => goDm(m.dm_id!)} className={hitRow}>
                      <span className="text-[11px] text-muted">{m.sender === "ghosty" ? "Ghosty" : m.sender}</span>
                      <span className="line-clamp-2 text-sm text-ink">{m.body}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// Command palette (⌘K / Ctrl-K): salto rápido a cualquier room, DM o vista sin
// tocar el sidebar. Filtra por nombre; ↑/↓ + Enter navegan, Esc cierra. Reusa el
// estilo spotlight del buscador. Solo navegación (no busca en mensajes: eso es la
// lupa) — el 80% del valor de ⌘K es "llévame ahí ya".
type CmdItem =
  | { type: "view"; id: "recent" | "mentions" | "starred"; label: string }
  | { type: "room"; slug: string; icon: string | null; label: string; sub?: string }
  | { type: "dm"; id: number; label: string; group: boolean; avatar?: string; name?: string };

function CommandPalette({
  channels,
  dms,
  onNavigateRoom,
  onOpenDm,
  onOpenView,
  onClose,
}: {
  channels: Channel[];
  dms: DmConversation[];
  onNavigateRoom: (slug: string) => void;
  onOpenDm: (id: number) => void;
  onOpenView: (v: "recent" | "mentions" | "starred") => void;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const items = useMemo<CmdItem[]>(() => {
    const views: CmdItem[] = [
      { type: "view", id: "recent", label: t("Recientes") },
      { type: "view", id: "mentions", label: t("Menciones") },
      { type: "view", id: "starred", label: t("Destacados") },
    ];
    const rooms: CmdItem[] = channels.map((c) => ({
      type: "room",
      slug: c.slug,
      icon: c.icon,
      label: c.name,
      sub: c.is_private ? t("Privado") : undefined,
    }));
    const dmItems: CmdItem[] = dms.map((d) => ({
      type: "dm",
      id: d.id,
      label: dmTitle(d, t("Conversación")),
      group: !!d.is_group,
      avatar: d.members[0]?.avatar,
      name: d.members[0]?.name,
    }));
    return [...views, ...rooms, ...dmItems];
  }, [channels, dms, t]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    document.getElementById(`cmd-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (i: CmdItem) => {
    onClose();
    if (i.type === "view") onOpenView(i.id);
    else if (i.type === "room") onNavigateRoom(i.slug);
    else onOpenDm(i.id);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, filtered.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
    else if (e.key === "Enter") (e.preventDefault(), filtered[sel] && run(filtered[sel]));
    else if (e.key === "Escape") (e.preventDefault(), onClose());
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-center bg-black/50 p-4 pt-[10vh]"
    >
      <motion.div
        initial={{ scale: 0.98, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.98, y: 8 }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Rocket size={18} className="shrink-0 text-brand" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("Ir a un room, DM o vista…")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">esc</kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 no-scrollbar">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">{t("Sin resultados.")}</p>
          ) : (
            filtered.map((i, idx) => (
              <button
                key={`${i.type}-${i.type === "room" ? i.slug : i.type === "dm" ? i.id : i.id}`}
                id={`cmd-${idx}`}
                onMouseMove={() => setSel(idx)}
                onClick={() => run(i)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${
                  idx === sel ? "bg-brand/15 text-ink" : "text-muted hover:bg-surface-2"
                }`}
              >
                {i.type === "view" ? (
                  <span className="grid h-6 w-6 shrink-0 place-items-center text-brand">
                    {i.id === "recent" ? <Waves size={16} /> : i.id === "mentions" ? <Megaphone size={16} /> : <Star size={16} />}
                  </span>
                ) : i.type === "room" ? (
                  <RoomIcon name={i.icon} size={16} className="shrink-0 text-muted" />
                ) : i.group ? (
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-3">
                    <Users size={14} />
                  </span>
                ) : (
                  <Avatar name={i.name} avatar={i.avatar} className="h-6 w-6 text-[10px]" />
                )}
                <span className="min-w-0 flex-1 truncate text-ink">{i.label}</span>
                <span className="shrink-0 text-[11px] text-muted">
                  {i.type === "view" ? t("Vista") : i.type === "room" ? (i.sub ?? t("Room")) : t("DM")}
                </span>
              </button>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// En qué código anda el equipo: cada repo con los rooms que lo declararon suyo. Es lo único
// que junta esa información — cada room la fija por su cuenta, y sin esta card nadie sabe
// qué se está tocando sin recorrerlos uno por uno.
//
// El servidor ya filtra por visibilidad: el nombre de un repo delata en qué anda un room
// privado.
function RepoHomeCard({ onOpenRoom }: { onOpenRoom: (slug: string) => void }) {
  const t = useT();
  const [repos, setRepos] = useState<
    { repo: string; rooms: { id: number; slug: string; name: string }[] }[] | null
  >(null);
  const [prs, setPrs] = useState<Record<string, number>>({});

  useEffect(() => {
    let vivo = true;
    workspaceRoomReposFn()
      .then((r) => {
        if (!vivo) return;
        setRepos(r);
        // El contador es un extra: si GitHub falla o el repo lo conectó alguien a cuya
        // instalación no llego, la fila se pinta sin número. Nunca bloquea el home.
        for (const x of r.slice(0, 6))
          githubOpenPrsFn({ data: { repo: x.repo, limit: 20 } })
            .then((list) => vivo && setPrs((p) => ({ ...p, [x.repo]: list.length })))
            .catch(() => {});
      })
      .catch(() => vivo && setRepos([]));
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <section className="gt-card rounded-2xl p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Github size={15} className="text-muted" /> {t("Repos")}
      </h2>
      <div className="space-y-0.5">
        {repos === null ? (
          <p className="px-2 py-1 text-xs text-muted">{t("Cargando…")}</p>
        ) : !repos.length ? (
          <p className="px-2 py-1 text-xs text-muted">
            {t("Ningún room tiene repositorios conectados. Ábrelos y usa el botón de GitHub del encabezado.")}
          </p>
        ) : (
          repos.slice(0, 6).map((r) => (
            <button
              key={r.repo}
              onClick={() => r.rooms[0] && onOpenRoom(r.rooms[0].slug)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3"
            >
              <Github size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{r.repo}</span>
              <span className="hidden shrink-0 truncate text-xs text-muted sm:inline">
                {r.rooms.slice(0, 2).map((c) => `#${c.name}`).join(" ")}
                {r.rooms.length > 2 ? ` +${r.rooms.length - 2}` : ""}
              </span>
              {prs[r.repo] > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                  <GitPullRequest size={12} className="text-emerald-600" />
                  {prs[r.repo]}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

/* ── Home dashboard ─────────────────────────────────────────────────────────
   Pantalla de inicio con el personaje Ghosty: saludo, tarjetas de resumen (datos
   reales del cliente), acceso a rooms/DMs/gente, y un composer "pregunta lo que sea"
   que postea al primer room (dispara @ghosty inline si lo tageas). Sin backend nuevo. */
function HomeDashboard({
  user,
  channels,
  dms,
  online,
  unreadRooms,
  unreadDms,
  onOpenRoom,
  onOpenDm,
  onOpenNav,
  onQuickPost,
}: {
  user: SessionUser | null;
  channels: Channel[];
  dms: DmConversation[];
  online: OnlinePeople;
  unreadRooms: Map<number, number>;
  unreadDms: Map<number, number>;
  onOpenRoom: (slug: string) => void;
  onOpenDm: (id: number) => void;
  onOpenNav: () => void;
  onQuickPost: (body: string) => void;
}) {
  const t = useT();
  const people = useMentions();
  const { openProfile } = useContext(ChatCtx);
  const [ask, setAsk] = useState("");

  const totalUnread =
    [...unreadRooms.values()].reduce((a, b) => a + b, 0) +
    [...unreadDms.values()].reduce((a, b) => a + b, 0);
  const firstName = (user?.name ?? "").split(" ")[0] || t("ahí");
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const dmLabel = (d: DmConversation) => d.title || d.members.map((m) => m.name).join(", ") || t("Conversación");

  // ⚠️ Sin `tint` ni icono. Las cuatro fichas llevaban el MISMO icono de destellos en
  // cuatro tintes distintos: un color que no codifica nada y un icono que no distingue
  // nada, o sea decoración con el peso visual de un dato. Mientras todo era una tarjeta
  // gris no se notaba; al aplanar quedó a la vista.
  const stats: { label: string; value: number; sub: string }[] = [
    { label: t("Sin leer"), value: totalUnread, sub: totalUnread ? t("mensajes te esperan") : t("estás al día") },
    { label: t("Rooms"), value: channels.length, sub: t("en el workspace") },
    { label: t("Conversaciones"), value: dms.length, sub: t("mensajes directos") },
    { label: t("En línea"), value: online.size, sub: t("ahora mismo") },
  ];

  const submitAsk = () => {
    const body = ask.trim();
    if (!body) return;
    onQuickPost(body);
    setAsk("");
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto thin-scroll">
      {/* Header móvil (hamburguesa). */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 md:hidden">
        <button onClick={onOpenNav} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink" aria-label={t("Abrir menú")}>
          <Menu size={20} />
        </button>
        <span className="font-semibold">{t("Inicio")}</span>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {/* Saludo + Ghosty */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{today}</p>
            <h1 className="text-3xl font-bold leading-tight text-ink sm:text-4xl">
              {t("¿Qué construimos hoy,")}<br />{firstName}?
            </h1>
          </div>
          <img src="/ghosty.svg" alt="Ghosty" className="h-24 w-24 shrink-0 opacity-90 sm:h-28 sm:w-28" />
        </div>

        {/* Resumen: UNA tira, no cuatro tarjetas.
            Cuatro cajas del tamaño de una tarjeta de contenido le daban a «9 mensajes
            directos» el mismo peso visual que a la lista de repos. Agrupadas en una sola
            superficie dividida, siguen siendo cuatro datos pero pesan lo que son.
            Los separadores van explícitos por índice y no con `divide-x`: esa utilidad
            reparte por orden del DOM, así que en la rejilla de 2 columnas del móvil le
            pondría raya izquierda a la tercera ficha, que abre renglón. */}
        <div className="gt-card mb-8 grid grid-cols-2 sm:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className={[
                "px-4 py-3",
                i % 2 === 1 ? "border-l border-border" : "",
                i >= 2 ? "border-t border-border" : "",
                i > 0 ? "sm:border-l sm:border-border" : "sm:border-l-0",
                "sm:border-t-0",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <p className="truncate text-xs font-medium text-muted">{s.label}</p>
              <p className="mt-0.5 text-2xl font-bold leading-tight tabular-nums text-ink">{s.value}</p>
              <p className="mt-0.5 truncate text-xs text-muted">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Repos + Conversaciones.
            `items-start`: sin él la rejilla estira las dos tarjetas a la altura de la más
            alta, y con un solo repo eso dejaba ~250 px de vacío bajo un renglón. Con el
            relleno gris el hueco pasaba por "tarjeta grande"; en plano se lee como que
            algo falta. Cada una mide lo que tiene. */}
        <div className="mb-8 grid items-start gap-4 sm:grid-cols-2">
          {/* La lista de rooms vivía aquí y era redundante: el sidebar ya los tiene y sus
              nombres no dicen nada. Los repos sí — es en qué código anda el equipo, y el
              único sitio donde se ve junto lo que cada room declaró por su cuenta. */}
          <RepoHomeCard onOpenRoom={onOpenRoom} />

          <section className="gt-card rounded-2xl p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <MessageSquare size={15} className="text-muted" /> {t("Conversaciones")}
            </h2>
            <div className="space-y-0.5">
              {dms.slice(0, 6).map((d) => (
                <button key={d.id} onClick={() => onOpenDm(d.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3">
                  <Avatar name={dmLabel(d)} avatar={d.members[0]?.avatar} className="h-6 w-6 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{dmLabel(d)}</span>
                  <UnreadBadge n={unreadDms.get(d.id) ?? 0} />
                </button>
              ))}
              {dms.length === 0 && <p className="px-2 py-1 text-xs text-muted">{t("Aún no hay conversaciones.")}</p>}
            </div>
          </section>
        </div>

        {/* Personas y agentes */}
        <section className="gt-card mb-8 rounded-2xl p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Users size={15} className="text-muted" /> {t("Personas y agentes")}
            <span className="ml-auto text-xs font-normal text-muted">{people.length}</span>
          </h2>
          <div className="grid gap-1 sm:grid-cols-2">
            {people.slice(0, 8).map((p) => (
              <button
                key={`${p.kind}:${p.handle}`}
                onClick={() => openProfile?.({ name: p.name, avatar: p.avatar, handle: p.handle, isAgent: p.kind === "agent", sub: p.kind === "user" ? p.sub : null })}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3"
              >
                {p.kind === "agent" ? (
                  p.avatar ? (
                    <img src={p.avatar} alt="" loading="lazy" decoding="async" className="h-7 w-7 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand"><Bot size={15} /></span>
                  )
                ) : (
                  <Avatar name={p.name} avatar={p.avatar} className="h-7 w-7 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted">
                    {p.kind === "agent" ? t("Agente") : `@${p.handle}`}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Composer "pregunta lo que sea" → postea al primer room (dispara @ghosty inline). */}
        <div className="rounded-2xl gt-card p-2">
          <div className="flex items-end gap-2">
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitAsk();
                }
              }}
              rows={2}
              placeholder={t("Pregunta lo que sea… (tagea @ghosty)")}
              className="thin-scroll max-h-32 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-ink outline-none placeholder:text-muted"
            />
            <button
              onClick={submitAsk}
              disabled={!ask.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand text-brand-fg disabled:opacity-40"
              aria-label={t("Enviar")}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

// Vista Zulip (recientes/menciones/destacados) enfocada en el centro. Lista de hits
// clickables: room → salta al mensaje; DM → abre la conversación.
function ViewPane({
  view,
  rev,
  patch,
  onJumpToRoom,
  onJumpToThreadReply,
  onOpenDm,
  onOpenNav,
}: {
  view: "recent" | "mentions" | "starred";
  rev: number;
  patch: number;
  onJumpToRoom: (slug: string, id: number) => void;
  onJumpToThreadReply: (slug: string, parentId: number, replyId: number) => void;
  onOpenDm: (id: number) => void;
  onOpenNav: () => void;
}) {
  const t = useT();
  const meta = {
    recent: { title: t("Recientes"), desc: t("Lo último de cada conversación."), Icon: Waves },
    mentions: { title: t("Menciones"), desc: t("Donde te taggearon."), Icon: Megaphone },
    starred: { title: t("Destacados"), desc: t("Tus mensajes marcados."), Icon: Star },
  }[view];
  const fetcher =
    view === "recent" ? recentViewFn : view === "mentions" ? mentionsViewFn : starredViewFn;
  const hits = useCachedQuery(viewCache, view, () => fetcher(), rev, patch);

  const open = (m: ViewHit) => {
    if (m.dm_id != null) onOpenDm(m.dm_id);
    else if (m.slug) {
      // Respuesta de hilo → abre el hilo y scrollea a ESA respuesta (no al room).
      if (m.parent_id != null) onJumpToThreadReply(m.slug, m.parent_id, m.id);
      else onJumpToRoom(m.slug, m.id);
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3 md:px-6">
        <NavToggle onOpen={onOpenNav} />
        <meta.Icon size={18} className="shrink-0 text-brand" />
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight text-ink">{meta.title}</h2>
          <p className="text-xs text-muted">{meta.desc}</p>
        </div>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto px-6 py-4 thin-scroll">
        {hits === null ? (
          <ThreadSkeleton />
        ) : hits.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">{t("Nada por aquí todavía.")}</p>
        ) : (
          hits.map((m) => (
            <button
              key={`${m.slug ?? "dm"}-${m.id}`}
              onClick={() => open(m)}
              className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition hover:bg-surface-2"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                {m.dm_id != null ? (
                  <>
                    <Users size={11} /> {t("Mensaje directo")}
                  </>
                ) : (
                  <>#{m.roomName}</>
                )}
                <span>·</span>
                <span>{m.sender === "ghosty" ? "Ghosty" : m.sender}</span>
                <span>·</span>
                <span>{new Date(m.created_at * 1000).toLocaleDateString()}</span>
              </span>
              <span className="line-clamp-2 text-sm text-ink">{m.body}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

/* ── Flujo del canal ── */
// Primer mensaje no-leído del scope: el más antiguo con created_at > frontera y
// que NO sea mío (no me notifico a mí mismo). null = nada nuevo → sin divisor.
function firstUnreadId(messages: Message[] | null, newAt: number | null, meName?: string): number | null {
  if (newAt == null || !messages) return null;
  const m = messages.find((x) => x.created_at > newAt && x.sender !== meName);
  return m ? m.id : null;
}

// Divisor "nuevos mensajes" (referencia Zulip: inline, no pill flotante).
// Preview de link (unfurl) estilo Slack/WhatsApp: tarjeta con imagen OG + título + desc.
// El fetch + parseo es server-side (unfurlLinkFn), cacheado por URL en el cliente también.
function NewDivider() {
  const t = useT();
  return (
    <div className="my-2 flex items-center gap-2" aria-label={t("Nuevos mensajes")}>
      <div className="h-px flex-1 bg-red-500/40" />
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-red-500">
        {t("Nuevos mensajes")}
      </span>
      <div className="h-px flex-1 bg-red-500/40" />
    </div>
  );
}

// Divisor de fecha (Hoy/Ayer/fecha), estilo Slack, cuando cambia el día en el feed.
function DateDivider({ at }: { at: number }) {
  const label = useMemo(() => {
    const d = new Date(at * 1000);
    const today = new Date();
    const yst = new Date(today); yst.setDate(today.getDate() - 1);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(d, today)) return "Hoy";
    if (same(d, yst)) return "Ayer";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
  }, [at]);
  const t = useT();
  return (
    <div className="my-3 flex items-center gap-2">
      <div className="h-px flex-1 bg-border" />
      {/* Misma razón que la hora de cada mensaje: la fecha depende de zona horaria y
          locale del que renderiza (el SSR escribía "July 22", el cliente "22 de julio")
          → mismatch de hidratación. */}
      <span suppressHydrationWarning className="shrink-0 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted">{t(label)}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
// ¿m y prev cruzan un límite de día? (para insertar DateDivider antes de m).
function crossesDay(prevAt: number | undefined, at: number): boolean {
  if (prevAt == null) return true; // primer mensaje → siempre muestra su fecha
  return new Date(prevAt * 1000).toDateString() !== new Date(at * 1000).toDateString();
}

// Línea efímera "X está escribiendo…" (encima del Composer). Altura fija → no salta.
function TypingLine({ typing }: { typing: { name: string } | null }) {
  const t = useT();
  return (
    <div className="h-5 px-6 text-xs italic text-muted">
      {typing ? t("{name} está escribiendo…", { name: typing.name }) : ""}
    </div>
  );
}

// ── Quick-calls (quick calls) — botón de header, banner de "unirse" y dock (iframe) ──
// El target distingue canal (por slug) de DM (por id); el server (quick-calls.ts) verifica
// membresía y acuña un token scoped a la sala HMAC del scope. Cero cruce de llamadas.
// (`CallTarget` vive en lib/call-store, que es quien opera la llamada.)
type CallActiveInfo = { callId: string; host: { sub: string; name: string; avatar: string }; label: string; startedAt: number };
type CallWiring = {
  active: CallActiveInfo | null; // hay un call en curso en este scope
  joined: boolean; // estoy dentro (dock abierto)
  onStart: () => void;
  onJoin: () => void;
  onLeave: () => void;
};

function CallHeaderButton({ h }: { h: CallWiring }) {
  const t = useT();
  if (h.joined)
    return (
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand"
        title={t("Estás en la llamada")}
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
        <span className="hidden sm:inline">{t("En llamada")}</span>
      </span>
    );
  if (h.active)
    return (
      <button
        onClick={h.onJoin}
        title={t("Unirse a la llamada")}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-brand/50 bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand transition hover:bg-brand/20"
      >
        <Headphones size={15} className="shrink-0" />
        <span className="hidden sm:inline">{t("Unirse")}</span>
      </button>
    );
  return (
    <button
      onClick={h.onStart}
      title={t("Iniciar llamada")}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted transition hover:border-brand hover:text-brand"
    >
      <Headphones size={15} className="shrink-0" />
      <span className="hidden sm:inline">{t("Llamada")}</span>
    </button>
  );
}

function CallBanner({ h }: { h: CallWiring }) {
  const t = useT();
  if (!h.active || h.joined) return null;
  return (
    <div className="flex items-center gap-3 border-b border-brand/30 bg-brand/10 px-4 py-2 md:px-6">
      <Avatar name={h.active.host.name} avatar={h.active.host.avatar} className="h-6 w-6" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">
        {t("{name} inició una llamada", { name: h.active.host.name })}
      </span>
      <button
        onClick={h.onJoin}
        className="shrink-0 rounded-full bg-brand px-3 py-1 text-xs font-semibold text-brand-fg transition hover:opacity-90"
      >
        {t("Unirse")}
      </button>
    </div>
  );
}

function Flow({
  channel,
  messages,
  optimistic,
  onSend,
  onOpenThread,
  typing,
  newAt,
  online,
  pins,
  onOpenDm,
  onOpenNav,
  call,
}: {
  channel: Channel;
  messages: Message[] | null;
  optimistic: Optimistic[];
  onSend: (p: SendPayload) => void;
  onOpenThread: (id: number) => void;
  typing: { sub: string; name: string } | null;
  newAt: number | null;
  online: OnlinePeople;
  pins: Message[];
  onOpenDm: (id: number) => void;
  onOpenNav: () => void;
  call: CallWiring;
}) {
  const t = useT();
  const { me } = useContext(ChatCtx);
  const canManage = !!me && (me.isOwner || channel.created_by === me.sub);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadId = firstUnreadId(messages, newAt, me?.name);
  const { onScroll, atBottom, scrollToBottom, contentRef } = useChatScroll(scrollRef, messages, optimistic.length, unreadId, channel.id);
  // TRAZA de arranque (temporal): imprime en consola cuándo el flujo llega al DOM y con
  // cuántos mensajes, medido desde el inicio de la navegación. Sirve para separar
  // "el servidor tarda" de "el cliente tarda en pintar".
  const bootLogged = useRef(false);
  useEffect(() => {
    if (bootLogged.current || !messages?.length) return;
    bootLogged.current = true;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    console.log(
      `[gt-boot] flujo pintado a ${Math.round(performance.now())}ms · msgs=${messages?.length ?? 0}` +
        (nav ? ` · ttfb=${Math.round(nav.responseStart)}ms · domInteractive=${Math.round(nav.domInteractive)}ms · load=${Math.round(nav.loadEventStart)}ms` : "")
    );
  }, [messages?.length]);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop(
    (f) => composerRef.current?.addFiles(f),
    () => composerRef.current?.focus(),
  );
  // Scroll a un mensaje (clic en un fijado) con destello, estilo "ir al origen".
  const jumpTo = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("flash-highlight");
    setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
  };

  return (
    <section className="relative flex min-w-0 flex-1 flex-col" {...handlers}>
      <DropOverlay show={dragOver} />
      {/* @container (NO breakpoints de viewport): al abrir el panel de artefacto esta columna se
          angosta sin que la ventana cambie, así que `md:`/`lg:` no se enteran. Con container
          queries la barra cede en el ancho REAL que tiene. */}
      <header className="@container/hdr flex items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle onOpen={onOpenNav} />
          <RoomIcon name={channel.icon} size={18} className="shrink-0 text-muted" />
          <div className="min-w-0">
            <h2 className="truncate font-semibold leading-tight text-ink">{channel.name}</h2>
            {channel.description ? (
              <p className="hidden truncate text-xs text-muted @md/hdr:block">{channel.description}</p>
            ) : (
              <p className="hidden truncate text-xs text-muted @md/hdr:block">
                {t("Escribe aquí · responde en hilo a cualquier mensaje · tagea")}{" "}
                <span className="text-brand">@ghosty</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 @lg/hdr:gap-2">
          <OnlineChip online={online} />
          {/* El facepile es lo PRIMERO que se va al angostarse: la lista sigue disponible en
              el modal de settings del room. */}
          <span className="hidden @2xl/hdr:flex">
            <RoomMembersButton slug={channel.slug} />
          </span>
          {/* Quick-call (quick call) del room — audio/video/pantalla vía la caja LiveKit compartida. */}
          <CallHeaderButton h={call} />
          <DocsButton channelId={channel.id} channelSlug={channel.slug} />
          {/* Sobre qué código habla este room. Es la frontera del conector de GitHub, no un
              atajo: sin repo atado el agente no tiene tools de GitHub aquí. */}
          <RepoButton channelId={channel.id} />
          <SearchButton onOpenDm={onOpenDm} onOpenThread={onOpenThread} currentSlug={channel.slug} />
        </div>
      </header>
      <CallBanner h={call} />
      {pins.length > 0 && <PinnedBar pins={pins} onJump={jumpTo} />}
      {/* overflow-anchor:none → desactiva el scroll-anchoring nativo del navegador. Al cargar
          una imagen ARRIBA del viewport el browser movía scrollTop para conservar la vista, lo
          que disparaba onScroll → apagaba `stick` a media carga y el ResizeObserver dejaba de
          re-anclar (quedaba a la mitad). Con none, el RO es el ÚNICO ancla y pega al fondo bien. */}
      <div ref={scrollRef} onScroll={onScroll} className="w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 thin-scroll [overflow-anchor:none]">
        <div ref={contentRef}>
        {messages === null ? (
          <ThreadSkeleton />
        ) : messages.length === 0 && optimistic.length === 0 ? (
          // Room vacío: la mascota en vez de una línea de texto sola. El SVG es el de
          // fondo transparente (los PNG del PWA traen cuadro oscuro horneado).
          <div className="mt-16 flex flex-col items-center gap-4 text-center">
            <img src="/ghosty.svg" alt="" aria-hidden className="h-24 w-24 opacity-90 drop-shadow-sm" />
            <p className="text-sm text-muted">
              {t("Sé el primero en escribir en {room}.", { room: channel.name })}
            </p>
          </div>
        ) : (
          messages.map((m, i) => {
            // El divisor de no-leídos rompe el grupo (el primer no-leído siempre con header).
            const divider = m.id === unreadId;
            const dayBreak = crossesDay(messages[i - 1]?.created_at, m.created_at);
            const prev = divider || dayBreak ? undefined : messages[i - 1];
            return (
              <Fragment key={m.id}>
                {dayBreak && <DateDivider at={m.created_at} />}
                {divider && <NewDivider />}
                <MessageRow m={m} prev={prev} onOpenThread={onOpenThread} showThreadLink canPin={canManage} />
              </Fragment>
            );
          })
        )}
        {optimistic.map((o, i) => (
          <OptimisticRow key={o.id} o={o} grouped={optIsGrouped(o, i > 0 ? optimistic[i - 1] : messages ? messages[messages.length - 1] : undefined)} />
        ))}
        </div>
      </div>
      <ScrollDownButton show={!atBottom} onClick={scrollToBottom} />
      <TypingLine typing={typing} />
      <Composer
        ref={composerRef}
        slug={channel.slug}
        parentId={null}
        onSend={(p) => { onSend(p); scrollToBottom(); }}
        placeholder={t(composerHint(channel.slug))}
      />
    </section>
  );
}

/* ── Hilo enfocado en el CENTRO (no drawer): nace desde un mensaje del room ── */
function ThreadView({
  channel,
  threadId,
  rev,
  patch,
  optimistic,
  onSend,
  onReloaded,
  typing,
  onGoToOrigin,
  onBack,
  channels,
}: {
  channel: Channel;
  threadId: number;
  rev: number;
  patch: number;
  optimistic: Optimistic[];
  onSend: (p: SendPayload) => void;
  onReloaded: (loaded: { sender: string; body: string }[]) => void;
  typing: { name: string } | null;
  onGoToOrigin: (id: number) => void;
  /** Recibe el room del HILO, que no siempre es el que se está mirando. */
  onBack: (roomSlug: string | null) => void;
  channels: Channel[];
}) {
  const t = useT();
  // Cacheado por threadId → reabrir el mismo hilo es instantáneo (sin skeleton).
  const data = useCachedQuery(
    threadCache,
    threadId,
    () => getThread({ data: { messageId: threadId } }),
    rev,
    patch
  );
  // ⚠️ El room del hilo es el del mensaje RAÍZ, no el de la ruta. Un hilo se abre también
  // desde una búsqueda, una mención o el panel de turnos, y entonces la ruta sigue en otro
  // canal: el encabezado decía "#general" y "Volver al room" te dejaba ahí. Mientras el
  // root no ha cargado se usa el de la ruta, que es lo que ya se veía.
  const suyo = channels.find((c) => c.id === (data?.root as any)?.channel_id) ?? channel;
  const scrollRef = useRef<HTMLDivElement>(null);
  // `replies` SIEMPRE un array: una entrada de cache producida en vivo (realtime crudo)
  // podría traer `replies` no-array → `.length`/`.map` crasheaban el render. Normalizar
  // aquí complementa la validación-al-cargar (cubre también corrupción de esta sesión).
  const replies = Array.isArray(data?.replies) ? data.replies : [];
  const replyCount = replies.length;
  useEffect(() => {
    if (data) onReloaded(replies);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  // Sigue las respuestas del hilo + el streaming de la respuesta del agente.
  const { onScroll, atBottom, scrollToBottom, contentRef } = useChatScroll(scrollRef, data?.replies ?? null, optimistic.length, null);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop(
    (f) => composerRef.current?.addFiles(f),
    () => composerRef.current?.focus(),
  );

  return (
    <section className="relative flex min-w-0 flex-1 flex-col" {...handlers}>
      <DropOverlay show={dragOver} />
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:gap-3 md:px-6">
        <button
          onClick={() => onBack(suyo.slug)}
          title={t("Volver al room")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink md:h-9 md:w-9"
        >
          <ArrowLeft size={18} />
        </button>
        <RoomIcon name={suyo.icon} size={18} className="shrink-0 text-muted" />
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight text-ink">{t("Hilo")}</h2>
          <button onClick={() => onBack(suyo.slug)} className="truncate text-xs text-muted transition hover:text-brand">
            {suyo.name}
          </button>
        </div>
        <div className="ml-auto flex shrink-0 items-center">
          {/* Buscar DENTRO del hilo. Una conversación larga (un contrato revisado a lo largo
              de 20 mensajes) no se recorre a scroll, y hasta hoy el buscador ni siquiera
              existía aquí — ni la búsqueda global miraba dentro de los hilos. */}
          <SearchButton onOpenDm={() => {}} threadRootId={threadId} />
          <DocsButton channelId={channel.id} channelSlug={channel.slug} threadRootId={threadId} />
        </div>
      </header>
      {/* overflow-anchor:none → desactiva el scroll-anchoring nativo del navegador. Al cargar
          una imagen ARRIBA del viewport el browser movía scrollTop para conservar la vista, lo
          que disparaba onScroll → apagaba `stick` a media carga y el ResizeObserver dejaba de
          re-anclar (quedaba a la mitad). Con none, el RO es el ÚNICO ancla y pega al fondo bien. */}
      <div ref={scrollRef} onScroll={onScroll} className="w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 thin-scroll [overflow-anchor:none]">
        <div ref={contentRef}>
        {!data ? (
          <ThreadSkeleton />
        ) : !data.root ? (
          // Link viejo a un hilo ya eliminado → informa en vez de quedar en blanco.
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div className="text-sm text-muted">
              <Trash2 size={20} className="mx-auto mb-2 opacity-60" />
              {t("Este hilo fue eliminado.")}
            </div>
          </div>
        ) : (
          <>
            {data.root && (
              <div>
                <MessageRow m={data.root} />
                <button
                  onClick={() => data.root && onGoToOrigin(data.root.id)}
                  className="mb-1 ml-12 text-[11px] text-muted transition hover:text-brand"
                >
                  {t("↑ Ver en el room")}
                </button>
              </div>
            )}
            {(data as { pending?: boolean }).pending && replyCount === 0 ? (
              // Detonador ya visible (sin skeleton); las RESPUESTAS aún cargan → skeleton.
              <div className="mt-2 border-t border-border pt-3">
                <ThreadSkeleton />
              </div>
            ) : (
              <>
                <div className="my-2 border-t border-border pt-1 text-center text-[11px] text-muted">
                  {replyCount === 1 ? t("1 respuesta") : t("{n} respuestas", { n: replyCount })}
                </div>
                {replies.map((m, i) => (
                  <MessageRow key={m.id} m={m} prev={replies[i - 1]} />
                ))}
              </>
            )}
            {optimistic.map((o, i) => (
              <OptimisticRow key={o.id} o={o} grouped={optIsGrouped(o, i > 0 ? optimistic[i - 1] : replies[replies.length - 1])} />
            ))}
          </>
        )}
        </div>
      </div>
      <ScrollDownButton show={!atBottom} onClick={scrollToBottom} />
      <TypingLine typing={typing} />
      <Composer
        ref={composerRef}
        slug={channel.slug}
        parentId={threadId}
        onSend={(p) => { onSend(p); scrollToBottom(); }}
        placeholder={t("Responder en el hilo…")}
      />
    </section>
  );
}

/* ── DM enfocado en el CENTRO (referencia Zulip): conversación directa 1:1/grupo ── */
function DmView({
  dm,
  dmId,
  rev,
  patch,
  online,
  optimistic,
  onSend,
  onReloaded,
  typing,
  newAt,
  onBack,
  call,
}: {
  dm: DmConversation | null;
  dmId: number;
  rev: number;
  patch: number;
  online: OnlinePeople;
  optimistic: Optimistic[];
  onSend: (p: SendPayload) => void;
  onReloaded: (loaded: { sender: string; body: string }[]) => void;
  typing: { name: string } | null;
  newAt: number | null;
  onBack: () => void;
  call: CallWiring;
}) {
  const t = useT();
  const { me } = useContext(ChatCtx);
  // Cacheado por dmId → reabrir la misma conversación es instantáneo (sin skeleton).
  const flowRaw = useCachedQuery(
    dmFlowCache,
    dmId,
    () => getDmFlowFn({ data: { id: dmId } }).then((r) => r?.flow ?? []),
    rev,
    patch
  );
  // `flow` SIEMPRE array-o-null: una entrada de cache corrupta (no-array) pasaba los guards
  // de null/length y crasheaba en `firstUnreadId`/`.map`. Normalizar complementa la
  // validación-al-cargar (cubre corrupción de esta sesión).
  const flow = Array.isArray(flowRaw) ? flowRaw : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadId = firstUnreadId(flow, newAt, me?.name);
  useEffect(() => {
    if (flow) onReloaded(flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  const { onScroll, atBottom, scrollToBottom, contentRef } = useChatScroll(scrollRef, flow, optimistic.length, unreadId);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop(
    (f) => composerRef.current?.addFiles(f),
    () => composerRef.current?.focus(),
  );

  const title = dm ? dmTitle(dm, t("Conversación")) : t("Conversación");
  const isOnline = dm?.members.some((m) => online.has(m.sub)) ?? false;
  const isAgentDm = dm?.agent_handle != null; // DM 1:1 con un agente → sin llamadas (aún)
  const first = dm?.members[0];

  // Escalón de modelo de ESTA conversación. `null` = no aplica (el agente corre en un
  // runtime o un motor que no escala) → el control ni se pinta. Se pide al abrir el DM
  // y se refresca al escalar; no hace falta más, porque nadie más lo cambia.
  const [esc, setEsc] = useState<{
    model: string | null; to: string | null; escalated: boolean;
    turnsLeft: number | null; turnsOnEscalate: number;
  } | null>(null);
  const [pidiendoPro, setPidiendoPro] = useState(false);
  const [pidiendoClear, setPidiendoClear] = useState(false);
  // ⚠️ Depende del LARGO del flujo, no sólo del dmId. Pidiéndolo una vez al abrir, el
  // contador se congelaba: el ícono seguía en ámbar aunque la escalada ya hubiera
  // caducado, y sólo se enteraba al recargar la página. Cada respuesta del agente hace
  // crecer el flujo, que es exactamente cuando el contador cambió.
  useEffect(() => {
    if (!isAgentDm) { setEsc(null); return; }
    let vivo = true;
    dmEscalationFn({ data: { id: dmId } })
      .then((r) => { if (vivo) setEsc(r ?? null); })
      .catch(() => { if (vivo) setEsc(null); });
    return () => { vivo = false; };
  }, [dmId, isAgentDm, flow?.length]);

  // Una sola vía para subir: la usan el botón y el comando /pro. Refresca el estado con
  // lo que devuelve el servidor en vez de asumir que salió bien — si el servidor dice
  // que no, el ícono no debe quedarse encendido mintiendo.
  const subirDeModelo = async () => {
    const r = await escalateDmAgentFn({ data: { id: dmId } }).catch(() => null);
    if (r?.ok) {
      setEsc((e) => (e ? { ...e, escalated: true, to: null, turnsLeft: r.turnsLeft ?? e.turnsOnEscalate } : e));
    } else {
      // Si el servidor dijo que no, se relee: el ícono no puede quedarse encendido
      // afirmando algo que no pasó.
      setEsc(await dmEscalationFn({ data: { id: dmId } }).catch(() => null));
    }
  };
  const bajarDeModelo = async () => {
    await deescalateDmAgentFn({ data: { id: dmId } }).catch(() => null);
    setEsc(await dmEscalationFn({ data: { id: dmId } }).catch(() => null));
  };

  return (
    <section className="relative flex min-w-0 flex-1 flex-col" {...handlers}>
      <DropOverlay show={dragOver} />
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:gap-3 md:px-6">
        <button
          onClick={onBack}
          title={t("Volver")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink md:h-9 md:w-9"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="relative shrink-0">
          {dm?.is_group ? (
            <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-3 text-ink">
              <Users size={16} />
            </span>
          ) : (
            <Avatar name={first?.name} avatar={first?.avatar} className="h-8 w-8" />
          )}
          {isOnline && (
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-green-500" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold leading-tight text-ink">{title}</h2>
          <p className="text-xs text-muted">
            {isOnline ? t("En línea") : t("Mensaje directo")}
          </p>
        </div>
        {/* Llamada 1:1/grupo (caja LiveKit compartida). NO con agentes de la flota (aún). */}
        {!isAgentDm && <CallHeaderButton h={call} />}
        {/* DM con agente: borrar memoria (mismo reset que el comando /clear). Acción
            destructiva → ADVERTENCIA antes de invocar. */}
        {isAgentDm && (
          <button
            onClick={() => setPidiendoClear(true)}
            title={t("Borrar memoria de la conversación")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink md:h-9 md:w-9"
          >
            <RotateCcw size={17} />
          </button>
        )}
        {/* Subir esta conversación a un modelo más capaz. NO es destructivo (la memoria
            se conserva) → sin advertencia; pero SÍ es de ida y no vuelta, y eso lo dice
            el propio texto en vez de esconderlo. El servidor decide a qué modelo: aquí
            no se nombra ninguno. */}
        {/* RELLENO ámbar = corriendo en el modelo capaz; contorno = se puede subir.
            SIEMPRE es un botón: escalado, el clic RENUEVA los turnos, que es lo que pide
            quien sigue en la misma tarea. Un `button disabled` heredaba el
            `cursor: not-allowed` global de styles.css y leía como "prohibido" cuando en
            realidad ya estaba hecho — y encima dejaba sin salida a quien necesitaba más. */}
        {isAgentDm && esc && (
          <button
            onClick={() => { if (esc.escalated) void bajarDeModelo(); else setPidiendoPro(true); }}
            title={
              esc.escalated
                ? t("Modelo capaz · quedan {n} mensajes. Clic para volver al rápido.", { n: String(esc.turnsLeft ?? esc.turnsOnEscalate) })
                : t("Subir a un modelo más capaz para esta conversación")
            }
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg transition md:h-9 md:w-9 ${
              esc.escalated
                ? "text-amber-500 hover:bg-surface-3"
                : "text-muted hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <Zap size={17} fill={esc.escalated ? "currentColor" : "none"} />
          </button>
        )}
      </header>
      {!isAgentDm && <CallBanner h={call} />}
      {/* overflow-anchor:none → desactiva el scroll-anchoring nativo del navegador. Al cargar
          una imagen ARRIBA del viewport el browser movía scrollTop para conservar la vista, lo
          que disparaba onScroll → apagaba `stick` a media carga y el ResizeObserver dejaba de
          re-anclar (quedaba a la mitad). Con none, el RO es el ÚNICO ancla y pega al fondo bien. */}
      <div ref={scrollRef} onScroll={onScroll} className="w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 thin-scroll [overflow-anchor:none]">
        <div ref={contentRef}>
        {flow === null ? (
          <ThreadSkeleton />
        ) : flow.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Escribe el primer mensaje de {name}.", { name: title })}
          </p>
        ) : (
          flow.map((m, i) => {
            const divider = m.id === unreadId;
            const dayBreak = crossesDay(flow[i - 1]?.created_at, m.created_at);
            const prev = divider || dayBreak ? undefined : flow[i - 1];
            return (
              <Fragment key={m.id}>
                {dayBreak && <DateDivider at={m.created_at} />}
                {divider && <NewDivider />}
                <MessageRow m={m} prev={prev} />
              </Fragment>
            );
          })
        )}
        {optimistic.map((o, i) => (
          <OptimisticRow key={o.id} o={o} grouped={optIsGrouped(o, i > 0 ? optimistic[i - 1] : flow ? flow[flow.length - 1] : undefined)} />
        ))}
        </div>
      </div>
      <ScrollDownButton show={!atBottom} onClick={scrollToBottom} />
      <TypingLine typing={typing} />
      <Composer
        ref={composerRef}
        slug=""
        parentId={null}
        dmId={dmId}
        onSend={(p) => {
          // Comando /clear en DM con agente: borra la memoria de la conversación.
          // Acción destructiva → ADVERTENCIA antes de invocar (no se postea el "/clear").
          // Comando /pro: mismo escalón que el botón del header. Existe porque el
          // agente puede SUGERIRLO en su respuesta, y una sugerencia que se ejecuta
          // escribiendo lo que te dijeron es más directa que buscar un ícono.
          if (isAgentDm && p.body?.trim() === "/pro") {
            // Sin modal: escribir el comando YA es la confirmación. El modal existe para
            // el botón, donde un clic puede ser un resbalón. Alterna, igual que el rayo.
            void (esc?.escalated ? bajarDeModelo() : subirDeModelo());
            scrollToBottom();
            return;
          }
          if (isAgentDm && p.body?.trim() === "/clear") {
            setPidiendoClear(true);
            scrollToBottom();
            return;
          }
          onSend(p);
          scrollToBottom();
        }}
        placeholder={t(composerHint(`dm-${dmId}`))}
      />
      {/* Confirmación del escalón. NO es `danger`: no destruye nada y la memoria se
          conserva. Lo que sí hay que decir es que es de IDA — es la única parte que
          el usuario no puede deducir del ícono. */}
      {/* Borrar memoria. Éste SÍ va como `danger`: es irreversible y el agente pierde
          todo el contexto de la conversación. Sustituye a `window.confirm`, que no se
          puede estilar y no distingue lo peligroso de lo rutinario. */}
      {pidiendoClear && (
        <ConfirmModal
          title={t("Borrar memoria de la conversación")}
          body={t("{name} empezará de cero: pierde todo el contexto de esta conversación. Los mensajes que ya están escritos se quedan. No se puede deshacer.", { name: title })}
          confirmLabel={t("Borrar memoria")}
          danger
          onCancel={() => setPidiendoClear(false)}
          onConfirm={async () => { await clearDmAgentFn({ data: { id: dmId } }).catch(() => {}); setPidiendoClear(false); }}
        />
      )}
      {pidiendoPro && (
        <ConfirmModal
          title={t("Subir a un modelo más capaz")}
          body={t("{name} responderá con más capacidad durante los próximos {n} mensajes de esta conversación, conservando la memoria. El primer mensaje tardará un poco más. Después vuelve solo al modelo rápido; puedes extenderlo cuando quieras.", { name: title, n: String(esc?.turnsOnEscalate ?? 10) })}
          confirmLabel={t("Subir")}
          onCancel={() => setPidiendoPro(false)}
          onConfirm={async () => { await subirDeModelo(); setPidiendoPro(false); }}
        />
      )}
    </section>
  );
}

function ThreadSkeleton() {
  return (
    <div className="space-y-4 px-1 py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-3" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-3 w-24 animate-pulse rounded bg-surface-3" />
            <div className="h-3 w-full animate-pulse rounded bg-surface-3" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Placeholder de carga de la lista de DMs (sidebar): filas con avatar + línea que
// pulsan y entran con fade → nunca "vacío falso" ni pop abrupto (animación de presencia).
function DmListSkeleton() {
  return (
    <div className="space-y-0.5">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, delay: i * 0.05 }}
          className="flex items-center gap-2 px-2 py-2 md:py-1.5"
        >
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-surface-3" />
          <div className="h-3 flex-1 animate-pulse rounded bg-surface-3" style={{ maxWidth: `${70 - i * 12}%` }} />
        </motion.div>
      ))}
    </div>
  );
}

function PinnedBar({ pins, onJump }: { pins: Message[]; onJump: (id: number) => void }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 border-b border-border bg-surface-2/60 px-6 py-2">
      <Pin size={14} className="mt-0.5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {pins.length === 1 ? t("1 fijado") : t("{n} fijados", { n: pins.length })}
        </p>
        <div className="flex flex-col gap-0.5">
          {pins.slice(0, 3).map((p) => (
            <button
              key={p.id}
              onClick={() => onJump(p.id)}
              className="truncate text-left text-xs text-muted hover:text-ink"
              title={p.body}
            >
              <span className="font-medium text-ink">{p.sender === "ghosty" ? "Ghosty" : p.sender}:</span>{" "}
              {p.body}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function optIsGrouped(o: Optimistic, prev: Message | Optimistic | undefined): boolean {
  if (o.quotedExcerpt || !prev) return false;
  if ("nonce" in prev) return !prev.quotedExcerpt; // optimista consecutivo = mismo yo, recién
  if (prev.kind !== "msg" || prev.quoted_excerpt) return false;
  const prevIsAgent = (prev.agent_handle != null && prev.mentions_ghosty === 0) || prev.sender === "ghosty";
  if (prevIsAgent) return false;
  return prev.sender === o.sender && Date.now() / 1000 - prev.created_at < 300;
}

function OptimisticRow({ o, grouped }: { o: Optimistic; grouped?: boolean }) {
  const t = useT();
  const { retrySend, discardSend, emojis } = useContext(ChatCtx);
  const failed = o.status === "failed";
  // 100% optimista: mientras "sending" el mensaje se ve IDÉNTICO a uno entregado
  // (opacidad plena, hora en vivo, sin "enviando…"); el reconciliador lo canjea
  // por el real cuando aterriza por SSE. Solo si FALLA de verdad degrada a
  // "No se envió" + reintentar/descartar.
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Agrupado (mismo look que MessageRow): sin avatar/header, gutter angosto. Si FALLÓ,
  // forzamos header para mostrar "No se envió" + reintentar.
  const g = !!grouped && !failed;
  return (
    <div className={`group relative flex items-start gap-3 rounded-lg px-2 ${g ? "py-px" : "mt-2 py-0.5"}`}>
      {g ? (
        <div className="w-9 shrink-0 select-none whitespace-nowrap pt-0.5 text-right text-[10px] leading-5 tabular-nums text-muted opacity-0 group-hover:opacity-100">
          {time}
        </div>
      ) : (
        <Avatar name={o.sender} avatar={o.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      )}
      <div className="min-w-0 flex-1">
        {!g && (
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{o.sender}</span>
          {failed ? (
            <span className="text-[11px] font-medium text-red-500">{t("No se envió")}</span>
          ) : (
            <span suppressHydrationWarning className="text-[11px] text-muted">{time}</span>
          )}
        </div>
        )}
        {/* Cita optimista: se ve al instante (mismo look que el mensaje ya entregado). */}
        {o.quotedExcerpt ? (
          <div className="mb-1 flex w-full max-w-md items-start gap-1.5 rounded-md border-l-2 border-brand/60 bg-surface-2 px-2 py-1">
            <Reply size={12} className="mt-0.5 shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="mr-1.5 text-xs font-semibold text-brand">{o.quotedAuthor || "—"}</span>
              <span className="truncate text-xs text-muted">{o.quotedExcerpt}</span>
            </span>
          </div>
        ) : null}
        <div className={`text-sm ${failed ? "text-ink/70" : "text-ink"}`}>
          <Markdown body={o.body} emojis={emojis} />
        </div>
        {failed && (
          <div className="mt-1 flex items-center gap-3 text-xs">
            <button
              onClick={() => retrySend?.(o)}
              className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              <RotateCcw size={12} /> {t("Reintentar")}
            </button>
            <button onClick={() => discardSend?.(o.id)} className="text-muted hover:text-ink">
              {t("Descartar")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Composer con typeahead de menciones + optimistic + @ghosty ── */
// Drag-drop de archivos sobre un contenedor GRANDE (toda la conversación, no solo el
// composer): más fácil de acertar, estilo WhatsApp. `counter` evita el parpadeo por
// dragenter/leave de los hijos. Solo reacciona a arrastres de ARCHIVOS (no de texto/links).
function useFileDrop(onFiles: (files: FileList | File[]) => void, onDropped?: () => void) {
  const [dragOver, setDragOver] = useState(false);
  const counter = useRef(0);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      counter.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      counter.current -= 1;
      if (counter.current <= 0) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      counter.current = 0;
      setDragOver(false);
      if (e.dataTransfer.files?.length) {
        onFiles(e.dataTransfer.files);
        // El foco se pide TAMBIÉN aquí, dentro del handler del gesto. `addFiles` ya lo
        // intenta, pero desde el evento el navegador es más permisivo con un `focus()`
        // programático que desde un callback diferido.
        onDropped?.();
      }
    },
  };
  return { dragOver, handlers };
}

// Overlay GRANDE de "suelta aquí" que cubre toda la conversación (WhatsApp-like). El
// contenedor padre debe ser `relative`.
function DropOverlay({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 border-[3px] border-dashed border-brand bg-surface/85 backdrop-blur-sm">
      <div className="grid size-16 place-items-center rounded-2xl bg-brand/15 text-brand">
        <ImagePlus size={32} />
      </div>
      <p className="text-lg font-semibold text-brand">{t("Suelta para enviar")}</p>
      <p className="text-sm text-muted">{t("Imágenes y archivos")}</p>
    </div>
  );
}

// Handle imperativo del Composer → la zona de drop grande (nivel conversación) le pasa
// los archivos soltados.
type ComposerHandle = {
  addFiles: (files: FileList | File[]) => void;
  /** Devuelve el cursor al campo de texto. Lo llama el drop de la conversación: ahí
   *  estamos DENTRO del gesto del usuario, que es cuando el navegador deja enfocar sin
   *  pelear con el final del arrastre. */
  focus: () => void;
};

// Botón flotante SUTIL "ir al final" — solo cuando estás scrolleado arriba. Se posa sobre
// el composer (el contenedor padre es `relative`).
function ScrollDownButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  const t = useT();
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("Ir al final")}
      title={t("Ir al final")}
      className="pointer-events-auto absolute bottom-28 left-1/2 z-30 grid size-10 -translate-x-1/2 place-items-center rounded-full border border-border bg-surface-2 text-muted shadow-lg transition hover:text-ink hover:border-brand/60 hover:bg-surface-3"
    >
      <ChevronDown size={18} />
    </button>
  );
}

const Composer = forwardRef<ComposerHandle, {
  slug: string;
  parentId: number | null;
  dmId?: number | null;
  onSend: (p: SendPayload) => void;
  placeholder: string;
}>(function Composer({
  slug,
  parentId,
  dmId = null,
  onSend,
  placeholder,
}, ref) {
  const t = useT();
  // Quote-reply: la cita activa vive en ChatCtx (global; solo un composer visible a la
  // vez). Al enviar viaja en el payload y se limpia.
  const { replyTo, setReplyTo } = useContext(ChatCtx);
  // Borrador por scope (Fase 4): persiste lo tecleado en localStorage para no
  // perderlo al cambiar de room/hilo/DM o recargar. Clave estable por conversación.
  const draftKey =
    dmId != null ? `draft:dm:${dmId}` : parentId != null ? `draft:thread:${parentId}` : `draft:room:${slug}`;
  const mentions = useMentions();
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions; // el suggestion de TipTap lee la lista fresca por ref
  const lastTypingPing = useRef(0);
  const submitRef = useRef<() => void>(() => {}); // handleKeyDown llama al submit más reciente
  // Toolbar de formato: toggle recordado en localStorage.
  const [showFormat, setShowFormat] = useState(() => {
    try { return localStorage.getItem("composer:format") === "1"; } catch { return false; }
  });
  const toggleFormat = () => setShowFormat((v) => {
    const n = !v;
    try { localStorage.setItem("composer:format", n ? "1" : "0"); } catch { /* bloqueado */ }
    return n;
  });
  // ── Popup de mención: el suggestion de TipTap actualiza este estado (ref +
  //    force-render) y reusamos la UI de menciones. mentionOpenRef corta el Enter-envía. ──
  type MentionPopup = { items: Mention[]; command: (a: { handle: string; name: string }) => void; rect: DOMRect | null; index: number };
  const popup = useRef<MentionPopup | null>(null);
  const [, forcePopup] = useReducer((x: number) => x + 1, 0);
  const setPopup = (v: MentionPopup | null) => { popup.current = v; forcePopup(); };
  const mentionOpenRef = useRef(false);
  mentionOpenRef.current = popup.current != null;

  // ── Adjuntos (Fase 4) ──────────────────────────────────────────────────────
  // Cada archivo se sube en cuanto se elige/suelta (POST /api/upload → EasyBits);
  // guardamos su fileId. Al enviar, los fileIds subidos viajan con el mensaje.
  type Pending = {
    localId: string;
    name: string;
    mime: string;
    size: number;
    fileId?: string;
    thumbFileId?: string | null; // derivado WebP (del /api/upload de imágenes)
    width?: number | null; // dims intrínsecas → reserva de alto exacta al renderizar
    height?: number | null;
    uploading: boolean;
    error?: boolean;
    previewUrl?: string; // objectURL de la imagen → miniatura INSTANTÁNEA (antes de subir)
  };
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => p.uploading);
  // El editor se crea más abajo; por ref para que `addFiles` siga con deps vacías —
  // se expone por `useImperativeHandle` y una identidad que cambie re-crearía el handle.
  const editorRef = useRef<Editor | null>(null);

  // Foco al campo de texto. Adjuntar un archivo —soltándolo o con el clip— es "voy a
  // escribir sobre esto": sin esto la miniatura aparecía y el cursor NO, y había que dar
  // un clic extra en un campo que estaba justo debajo.
  //
  // ⚠️ Se INSISTE, y no es paranoia: un solo `requestAnimationFrame` no bastó (probado en
  // prod). Al soltar, el navegador termina de desmontar el arrastre DESPUÉS del frame y
  // devuelve el foco al body; con el clip, el diálogo de archivos se está cerrando y el
  // foco vuelve al botón. Los dos reintentos cubren las dos ventanas y son inocuos: si el
  // cursor ya está en el editor, `focus()` no hace nada visible.
  //
  // Guarda de puntero fino, igual que el autofocus al cambiar de room: en táctil
  // levantaría el teclado justo encima de la miniatura recién adjuntada.
  const focusComposer = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia?.("(pointer: fine)").matches) return;
    const go = () => editorRef.current?.commands.focus("end");
    go();
    requestAnimationFrame(go);
    setTimeout(go, 180);
  }, []);

  // Solo depende de setPending (estable) → estable entre renders; seguro exponerlo por ref.
  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    for (const f of list) {
      const localId = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${f.name}`;
      // WhatsApp-like: la miniatura aparece YA (objectURL local), sin esperar la subida.
      const previewUrl = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setPending((p) => [
        ...p,
        { localId, name: f.name, mime: f.type || "application/octet-stream", size: f.size, uploading: true, previewUrl },
      ]);
      const fd = new FormData();
      fd.append("file", f);
      fetch("/api/upload", { method: "POST", body: fd })
        .then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.json() as Promise<{ fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null }>;
        })
        .then((up) =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, fileId: up.fileId, thumbFileId: up.thumbFileId ?? null, width: up.width ?? null, height: up.height ?? null } : x)))
        )
        .catch(() =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, error: true } : x)))
        );
    }
    focusComposer();
  }, [focusComposer]);
  // La zona de drop grande (nivel conversación) empuja los archivos aquí.
  useImperativeHandle(ref, () => ({ addFiles, focus: focusComposer }), [addFiles, focusComposer]);
  const removePending = (localId: string) =>
    setPending((p) => {
      const gone = p.find((x) => x.localId === localId);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl); // libera el objectURL
      return p.filter((x) => x.localId !== localId);
    });
  // Libera los objectURL pendientes al desmontar (cambiar de hilo/DM/room).
  useEffect(() => () => setPending((p) => { p.forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl)); return p; }), []);

  // ── Editor TipTap (WYSIWYG) ─────────────────────────────────────────────────
  // Mention extendido: (a) serializa a markdown como texto plano @handle → el server
  // (detectMentions) y el resaltado del cliente lo siguen detectando; (b) el suggestion
  // puentea al popup React de arriba. Se crea una vez (deps = refs/setters estables).
  const MentionMd = useMemo(
    () =>
      Mention.extend({
        addStorage() {
          return { markdown: { serialize: (state: any, node: any) => state.write(`@${node.attrs.id}`), parse: {} } };
        },
      }).configure({
        HTMLAttributes: { class: "mention" },
        renderText: ({ node }: any) => `@${node.attrs.id}`,
        suggestion: {
          char: "@",
          items: ({ query }: { query: string }) =>
            mentionsRef.current.filter((a) => a.handle.startsWith(query.toLowerCase())).slice(0, 8),
          command: ({ editor, range, props }: any) => {
            // Warm seam: elegir un @agente = alta intención de enviarle → pre-calienta su
            // turno (fire-and-forget, el server no-opea si el handle no es agente de flota).
            warmAgentFn({ data: { handle: props.handle } }).catch(() => {});
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                // label = handle (NO el nombre): el pill del composer debe mostrar @ghosty,
                // igual que el mensaje enviado y el resaltado — no el nombre del fleet agent.
                { type: "mention", attrs: { id: props.handle, label: props.handle } },
                { type: "text", text: " " },
              ])
              .run();
          },
          render: () => ({
            onStart: (props: any) =>
              setPopup({ items: props.items, command: props.command, rect: props.clientRect?.() ?? null, index: 0 }),
            onUpdate: (props: any) =>
              setPopup(
                popup.current
                  ? { ...popup.current, items: props.items, command: props.command, rect: props.clientRect?.() ?? null, index: Math.min(popup.current.index, Math.max(0, props.items.length - 1)) }
                  : null
              ),
            onKeyDown: (props: any) => {
              const p = popup.current;
              if (!p || !p.items.length) return false;
              const k = props.event.key;
              if (k === "ArrowDown") { setPopup({ ...p, index: (p.index + 1) % p.items.length }); return true; }
              if (k === "ArrowUp") { setPopup({ ...p, index: (p.index - 1 + p.items.length) % p.items.length }); return true; }
              if (k === "Enter" || k === "Tab") { const it = p.items[p.index]; if (it) p.command({ handle: it.handle, name: it.name }); return true; }
              if (k === "Escape") { setPopup(null); return true; }
              return false;
            },
            onExit: () => setPopup(null),
          }),
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const editor = useEditor({
    immediatelyRender: false, // SSR de TanStack Start: sin esto → mismatch de hidratación
    extensions: [
      // autolink:false → al teclear una URL NO se convierte en <a> dentro del editor: eso
      // atrapaba el caret dentro del link (no se podía escribir después, y el texto seguía
      // enlazado tras el espacio). La URL viaja como texto plano en el markdown; al RENDERIZAR
      // el mensaje, Streamdown (remark-gfm autolink) la vuelve clickable igual → sin pérdida.
      StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
      Placeholder.configure({ placeholder }),
      MarkdownExt.configure({ html: false, bulletListMarker: "-", linkify: false, breaks: false, transformPastedText: true }),
      MentionMd,
    ],
    content: typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : "",
    editorProps: {
      attributes: { class: "thin-scroll max-h-40 min-h-9 flex-1 overflow-y-auto px-1 py-2 text-sm leading-5 text-ink" },
      // Enter envía (salvo popup de mención abierto o Shift). Shift+Enter → salto nativo.
      handleKeyDown: (_v, event) => {
        if (event.key === "Enter" && !event.shiftKey && !mentionOpenRef.current) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
      // Pegar imagen del portapapeles → adjunto con miniatura instantánea (mismo addFiles).
      handlePaste: (_v, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (files.length) { addFiles(files); return true; }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const md = (editor.storage as any).markdown.getMarkdown() as string;
      if (typeof window !== "undefined") {
        if (md.trim()) localStorage.setItem(draftKey, md);
        else localStorage.removeItem(draftKey);
      }
      // Señal "escribiendo…" throttled a 1 cada 2s (efímera, sin DB). Room/hilo/DM.
      const now = Date.now();
      if (md.trim() && now - lastTypingPing.current > 2000) {
        lastTypingPing.current = now;
        pingTypingFn({ data: dmId != null ? { dmId } : { slug, parentId } }).catch(() => {});
      }
    },
  });

  // El ref que `addFiles` usa para devolver el foco tras adjuntar (ver allá arriba).
  editorRef.current = editor ?? null;

  // Recarga el borrador al cambiar de scope sin desmontar (room-switch en Flow). Los
  // paneles keyados (hilo/DM) ya remontan. setContent parsea markdown (tiptap-markdown).
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : "");
    // Autofocus al cambiar de room/DM → puedes escribir de inmediato sin clic. Solo en
    // punteros finos (desktop): en táctil abriría el teclado en cada cambio (molesto).
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches) {
      editor.commands.focus("end");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, editor]);

  function submit() {
    // Adjuntos ya subidos (con fileId). Bloquea envío mientras alguno sube.
    const attachments = pending
      .filter((p) => p.fileId && !p.error)
      .map((p) => ({ fileId: p.fileId!, mime: p.mime, size: p.size, name: p.name, thumbFileId: p.thumbFileId ?? null, width: p.width ?? null, height: p.height ?? null }));
    const body = editor ? ((editor.storage as any).markdown.getMarkdown() as string).trim() : "";
    if ((!body && attachments.length === 0) || uploading) return;
    setPending((p) => { p.forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl)); return []; });
    if (typeof window !== "undefined") localStorage.removeItem(draftKey); // borrador consumido
    editor?.commands.clearContent(true);
    playSelfSound(); // confirmación sonora del envío propio (distinta de las notifs)
    editor?.commands.focus(); // re-habilita al instante — no esperamos el round-trip
    // El ENVÍO lo hace el padre (outbox): crea el optimista, dispara la red en 2º plano.
    // La cita (si hay) viaja en el payload; se limpia al enviar.
    onSend(
      replyTo
        ? { body, attachments, quotedId: replyTo.id, quotedAuthor: replyTo.author, quotedExcerpt: replyTo.excerpt }
        : { body, attachments }
    );
    if (replyTo) setReplyTo?.(null);
  }
  submitRef.current = submit;

  // Al citar un mensaje, enfoca el editor para escribir la respuesta de inmediato.
  useEffect(() => {
    if (replyTo) editor?.commands.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTo?.id]);
  // Autofocus al entrar a un room/hilo/DM (o cambiar de scope): poder escribir de una,
  // sin clickear el input (como Slack). Solo en DESKTOP — en móvil (puntero grueso) NO,
  // para no abrir el teclado de golpe. draftKey cambia con el scope → re-enfoca al navegar.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(pointer: coarse)")?.matches) return;
    editor?.commands.focus("end");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftKey]);

  // Toolbar → comandos del editor (WYSIWYG), con estado activo resaltado.
  const FMT_TOOLS = editor
    ? [
        { icon: Bold, title: t("Negrita"), active: editor.isActive("bold"), fn: () => editor.chain().focus().toggleBold().run() },
        { icon: Italic, title: t("Itálica"), active: editor.isActive("italic"), fn: () => editor.chain().focus().toggleItalic().run() },
        { icon: Strikethrough, title: t("Tachado"), active: editor.isActive("strike"), fn: () => editor.chain().focus().toggleStrike().run() },
        { icon: Link2, title: t("Enlace"), active: editor.isActive("link"), fn: () => {
            const prev = editor.getAttributes("link").href as string | undefined;
            const url = window.prompt(t("URL del enlace"), prev || "https://");
            if (url === null) return;
            if (url === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
            else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          } },
        { icon: List, title: t("Lista"), active: editor.isActive("bulletList"), fn: () => editor.chain().focus().toggleBulletList().run() },
        { icon: ListOrdered, title: t("Lista numerada"), active: editor.isActive("orderedList"), fn: () => editor.chain().focus().toggleOrderedList().run() },
        { icon: Quote, title: t("Cita"), active: editor.isActive("blockquote"), fn: () => editor.chain().focus().toggleBlockquote().run() },
        { icon: Code, title: t("Código"), active: editor.isActive("code"), fn: () => editor.chain().focus().toggleCode().run() },
      ]
    : [];

  return (
    <form
      className="relative border-t border-border p-3"
      // Respeta la home-bar/notch en móvil (viewport-fit=cover): el composer no
      // queda tapado por el inset inferior.
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Quote-reply: cita activa. Barra con autor + extracto + cerrar. Al enviar viaja
          en el payload y se pinta como cita del mensaje (y el agente la recibe). */}
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand bg-surface-2 px-2.5 py-1.5">
          <Reply size={14} className="mt-0.5 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-brand">
              {t("Respondiendo a {name}", { name: replyTo.author })}
            </p>
            <p className="truncate text-xs text-muted">{replyTo.excerpt || t("(sin texto)")}</p>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo?.(null)}
            title={t("Cancelar")}
            className="shrink-0 rounded p-0.5 text-muted transition hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {/* Adjuntos: miniatura INSTANTÁNEA (objectURL) para imágenes; chip para el resto.
          Spinner sobrepuesto mientras sube; error en rojo. El drag-drop grande vive a
          nivel de toda la conversación (ver DropOverlay en Flow/ThreadView/DmView). */}
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div key={p.localId} className="relative">
              {p.previewUrl ? (
                <img
                  src={p.previewUrl}
                  alt={p.name}
                  className={`size-16 rounded-lg border border-border object-cover ${p.error ? "opacity-40" : ""}`}
                />
              ) : (
                <div
                  className={`flex size-16 flex-col items-center justify-center gap-1 rounded-lg border px-1 text-center text-[10px] ${
                    p.error ? "border-red-500/40 text-red-500" : "border-border text-muted"
                  }`}
                >
                  <Paperclip size={16} className="text-brand" />
                  <span className="w-full truncate">{p.name}</span>
                </div>
              )}
              {p.uploading && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
                  <Loader2 size={18} className="animate-spin text-white" />
                </span>
              )}
              {p.error && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-lg bg-red-500/80 py-0.5 text-center text-[9px] font-semibold text-white">
                  {t("Error")}
                </span>
              )}
              <button
                type="button"
                onClick={() => removePending(p.localId)}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-surface-3 text-muted shadow ring-1 ring-border transition hover:text-ink"
                aria-label={t("Quitar adjunto")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = ""; // permite re-elegir el mismo archivo
        }}
      />
      {/* Popup de mención (@) — por portal a body y posicionado sobre el caret, para
          que no lo clipe el overflow del composer. Reusa la UI de menciones. */}
      {popup.current && popup.current.items.length > 0 && popup.current.rect &&
        createPortal(
          <ul
            style={{ position: "fixed", left: popup.current.rect.left, top: popup.current.rect.top - 6, transform: "translateY(-100%)", zIndex: 60 }}
            className="thin-scroll max-h-64 w-60 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-surface shadow-lg"
          >
            {popup.current.items.map((a, i) => (
              <li key={a.handle}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); popup.current?.command({ handle: a.handle, name: a.name }); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                    i === popup.current!.index ? "bg-brand/15" : "hover:bg-surface-2"
                  }`}
                >
                  {a.kind === "group" ? (
                    <Megaphone size={18} className="text-brand" />
                  ) : a.kind === "agent" ? (
                    a.avatar ? (
                      <img src={a.avatar} alt="" loading="lazy" decoding="async" className="h-5 w-5 rounded" />
                    ) : (
                      <Bot size={18} className="text-brand" />
                    )
                  ) : (
                    <Avatar name={a.name} avatar={a.avatar} className="h-5 w-5 text-[9px]" />
                  )}
                  {/* Sólo las grupales se traducen: su "nombre" es copy nuestro. El de un
                      usuario o un agente es un nombre propio y no pasa por t(). */}
                  <span className="font-medium text-ink">{a.kind === "group" ? t(a.name) : a.name}</span>
                  <span className="text-xs text-muted">@{a.handle}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
      {/* Caja UNIFICADA (referencia Slack/Zulip/Rocket.Chat): un solo borde envuelve
          toolbar + clip + editor + Enviar. El toolbar de formato vive DENTRO de la
          caja (divisor arriba), no como barra suelta → se siente parte del composer. */}
      <div className="w-full rounded-xl border border-border bg-surface transition focus-within:border-brand">
        {showFormat && (
          <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
            {FMT_TOOLS.map((tool, i) => (
              <button
                key={i}
                type="button"
                title={tool.title}
                onMouseDown={(e) => e.preventDefault()} // no robar el foco del editor
                onClick={tool.fn}
                className={`grid h-7 w-7 place-items-center rounded-md transition hover:bg-surface-2 hover:text-ink ${
                  tool.active ? "bg-surface-2 text-brand" : "text-muted"
                }`}
              >
                <tool.icon size={15} />
              </button>
            ))}
          </div>
        )}
        <div className="relative flex w-full items-end gap-1 px-1.5 py-1.5">
        <button
          type="button"
          onClick={toggleFormat}
          title={showFormat ? t("Ocultar formato") : t("Mostrar formato")}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg transition hover:bg-surface-2 hover:text-ink ${
            showFormat ? "bg-surface-2 text-brand" : "text-muted"
          }`}
        >
          <Type size={17} />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title={t("Adjuntar archivo")}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Paperclip size={18} />
        </button>
        {/* Editor WYSIWYG (TipTap). El formato se ve visualmente; el body sale como
            markdown (getMarkdown) al enviar. Paste de imagen y Enter-envía en editorProps. */}
        <EditorContent editor={editor} className="min-w-0 flex-1" />
        <button
          type="submit"
          disabled={uploading}
          title={uploading ? t("Subiendo adjunto…") : undefined}
          aria-label={t("Enviar")}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-semibold text-brand-fg transition hover:brightness-110 disabled:opacity-50 sm:px-3.5"
        >
          <Send size={15} />
          {/* En un teléfono el label se come el ancho del editor (queda ~180px con los
              dos botones de la izquierda): ahí el botón va sólo con el ícono. */}
          <span className="hidden sm:inline">{t("Enviar")}</span>
        </button>
        </div>
      </div>
    </form>
  );
});
