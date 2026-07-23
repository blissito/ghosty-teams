import { Component, createContext, forwardRef, Fragment, type ReactNode, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
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
  PinOff,
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
  ChevronDown,
  Headphones,
  Copy,
  Check,
  ChevronRight,
  Layers,
  Table2,
  Image as ImageIcon,
  ImagePlus,
  Home as HomeIcon,
  Hash as HashIcon,
  Sparkles,
} from "lucide-react";
import { searchMessagesFn } from "../server/search";
import { createFileRoute, notFound, Link, useRouter } from "@tanstack/react-router";
import type { Channel, Message, DmConversation, RoomHit, ViewHit, Attachment, Artifact, CustomEmoji } from "../db.server";
import { listEmojisFn } from "../server/emojis";
import { recentViewFn, mentionsViewFn, starredViewFn } from "../server/views";
import { openDmFn, listDmsFn, getDmFlowFn, postDmMessageFn, askDmAgentFn } from "../server/dm";
import { listAgentsFn } from "../server/agents";
import { unreadCountsFn, markReadFn, readReceiptsFn, lastReadFn } from "../server/reads";
import { toggleStarFn, togglePinFn, getPinsFn, toggleMuteFn, listMutesFn } from "../server/stars";
import { listMyWorkspacesFn } from "../server/workspaces";
import {
  getChannelView,
  getChannelFlow,
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
} from "../server/chat";
import { SmilePlus, Pencil, ArrowLeft, RotateCcw, Send, Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Type, Reply } from "lucide-react";
import { getDeferredPrompt, onInstallable, clearDeferredPrompt, type BeforeInstallPromptEvent } from "../utils/pwa-install";
import { useLiveStream } from "../hooks/useLiveStream";
import type { RtEvent } from "../server/bus.server";
import { Markdown } from "../components/Markdown";
import { SettingsContent, loadSettingsData } from "../components/SettingsContent";
import { getTheme, subscribeTheme, resolveDark, presetById, paletteVars } from "../utils/theme";
import { subscribeMentions } from "../utils/mentions-bus";
import { subscribeEmojis } from "../utils/emojis-bus";
import { subscribeUsers, bumpUsers } from "../utils/users-bus";
import { clearMeCache } from "../server/auth";
import { unfurlLinkFn } from "../server/unfurl";
import { registerModalEsc } from "../utils/modal-esc";
import ArtifactPanel, { type ArtifactView, viewFromAttachment } from "../components/ArtifactPanel";
import { extractEbDoc, draftTitle, bubbleWithoutEbDoc } from "../lib/ebdoc";
import { ThinkingRing } from "../components/ThinkingRing";
import { playNotificationSound, playGhostySound, playSelfSound, playMentionSound, playDmSound, playReadySound, playDeleteSound } from "../utils/notificationSound";

// Menciones que cuentan como "a ti": tu @handle o una grupal (@all/@channel/…).
const SOUND_GROUP_MENTIONS = new Set(["all", "channel", "everyone", "aqui", "here", "todos"]);
import { useT } from "../i18n";

type Mention = { handle: string; name: string; avatar: string; kind: "agent" | "user" | "group" };
import { me } from "../server/auth";
import {
  createChannelFn,
  updateChannelFn,
  deleteChannelFn,
  getChannelMembersFn,
  addChannelMemberFn,
  removeChannelMemberFn,
  listWorkspaceUsersFn,
} from "../server/channels";

// Cache CLIENTE del shell (rooms + user). Navegar a un room que YA está en el
// sidebar resuelve el loader al instante (sin round-trip) → cambio de pantalla
// inmediato; el flujo sigue cargando client-side con su skeleton. SOLO cliente:
// en SSR cada request es de otro usuario → jamás cachear ahí (fuga cross-user).
let shellCache: { channels: Channel[]; user: Awaited<ReturnType<typeof me>> } | null = null;

export const Route = createFileRoute("/c/$slug")({
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
    const prefetch = typeof window === "undefined" || !hydrated;

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
    const [view, user] = await Promise.all([
      getChannelView({ data: { slug: params.slug } }),
      me(),
    ]);
    if (!view) throw notFound();
    if (typeof window !== "undefined") shellCache = { channels: view.channels, user };

    let initialFlow: Awaited<ReturnType<typeof getChannelFlow>> | undefined;
    let initialThreads: Awaited<ReturnType<typeof getChannelThreads>> | undefined;
    if (prefetch) {
      const cachedFlow = typeof window !== "undefined" ? flowCache.get(params.slug) : undefined;
      const cachedThreads = typeof window !== "undefined" ? threadsCache.get(params.slug) : undefined;
      [initialFlow, initialThreads] = await Promise.all([
        cachedFlow ?? getChannelFlow({ data: { slug: params.slug } }).catch(() => undefined),
        cachedThreads ?? getChannelThreads({ data: { slug: params.slug } }).catch(() => undefined),
      ]);
    }
    return { ...view, user, initialFlow, initialThreads };
  },
  component: ChannelPage,
});

type SessionUser = { sub: string; name: string; email: string; avatar: string; isOwner: boolean; handle: string };
type Attach = { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null };
// El optimista guarda su propio payload de envío → se puede reintentar tal cual.
type Optimistic = {
  id: string; // == nonce
  parentId: number | null;
  dmId: number | null;
  slug: string;
  sender: string;
  avatar: string;
  body: string;
  attachments: Attach[];
  nonce: string;
  status: "sending" | "failed";
  // Quote-reply: snapshot para render optimista + payload al server/agente.
  quotedId?: number | null;
  quotedAuthor?: string | null;
  quotedExcerpt?: string | null;
};

// Iconos de room (Lucide, no emojis). Se guarda el NOMBRE; se renderiza el componente.
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
// `hydrated` = false hasta que el primer render del cliente se monta. El loader lo
// usa para prefetchear flujo/hilos durante la hidratación (igualar el SSR, sin
// parpadeo) pero NO en navegaciones posteriores (switch instantáneo con skeleton).
let hydrated = false;
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

if (typeof window !== "undefined") {
  try {
    // v3: descarta v1/v2 envenenados. Un cache de hilo serializado por una versión del
    // app y re-renderizado por otra tras un deploy → mismatch de hidratación → crash
    // (incidente 2026-07-09: el usuario tuvo que borrar datos del sitio a mano). Bumpear
    // ESTA versión al cambiar la forma de Message/thread invalida los viejos ANTES de
    // que rompan; el purge-on-error de router.tsx cubre los que se escapen.
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
type ReplyTarget = { id: number; author: string; excerpt: string };

// Estados rápidos sugeridos (estilo Slack): emoji + texto, un clic los llena.
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
const ChatCtx = createContext<{
  me: SessionUser | null;
  slug: string;
  emojis: CustomEmoji[];
  users: Map<string, WsUser>; // directorio vivo sub→perfil (avatars/nombres/status)
  react: (m: Message, emoji: string) => void;
  star: (m: Message) => void;
  pin: (m: Message) => void;
  remove: (m: Message) => Promise<void>;
  editMsg: (m: Message, body: string) => void;
  retrySend: (o: Optimistic) => void;
  discardSend: (id: string) => void;
  // Quote-reply: cita activa del composer (una global; solo un composer visible a la vez).
  replyTo: ReplyTarget | null;
  setReplyTo: (r: ReplyTarget | null) => void;
  // Picker de reacciones GLOBAL (id del mensaje con el picker abierto, o null).
  // Uno solo a la vez (referencia Slack/Zulip): abrir otro cierra el anterior.
  pickerFor: number | null;
  setPickerFor: (id: number | null) => void;
  // Abre un artefacto (pdf/imagen/doc) en el panel lateral del room.
  onOpenArtifact: (a: ArtifactView) => void;
  // Envía `body` como respuesta del usuario en el MISMO hilo/DM que `ownerMsg`
  // (usado por artefactos interactivos inline, ej. ask-user: un clic = enviar).
  sendQuickReply: (body: string, ownerMsg: Message) => void;
  // Abre Ajustes/Preferencias como modal in-panel (SPA) en la pestaña indicada.
  openPrefs: (tab?: "general" | "agentes" | "emojis") => void;
  // Abre el perfil (drawer) de una persona o agente.
  openProfile: (p: ProfileTarget) => void;
}>({
  me: null,
  slug: "",
  emojis: [],
  users: new Map(),
  react: () => {},
  star: () => {},
  pin: () => {},
  remove: async () => {},
  editMsg: () => {},
  retrySend: () => {},
  discardSend: () => {},
  replyTo: null,
  setReplyTo: () => {},
  pickerFor: null,
  setPickerFor: () => {},
  onOpenArtifact: () => {},
  sendQuickReply: () => {},
  openPrefs: () => {},
  openProfile: () => {},
});

// Identidad mostrada en el drawer de perfil (persona o agente).
type ProfileTarget = { name: string; avatar?: string | null; handle?: string | null; isAgent: boolean; sub?: string | null };

// Emojis rápidos para el picker (evita una lib de ~1MB).
const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🙌", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😮"];

// Categorías del picker (estilo Slack) — set curado, sin lib de ~1MB. Cada tab
// tiene un glifo (para la barra de categorías) y su lista de emojis. El buscador
// sigue usando EMOJI_SEARCH (keywords); esto es solo el navegado por categoría.
const EMOJI_CATEGORIES: { id: string; icon: string; label: string; emojis: string[] }[] = [
  { id: "people", icon: "🙂", label: "Personas", emojis: ["🙂","😊","😄","😁","😅","😂","🤣","😍","😘","😎","🤔","🤨","😐","🙄","😬","😴","😭","😢","😡","🤯","🥳","🤩","😱","🤗","😉","😜","🤪","🥺","😤","🫠","🤡","💀","👽","👻","🤖"] },
  { id: "gestures", icon: "👍", label: "Gestos", emojis: ["👍","👎","👏","🙌","👋","🤙","💪","🫡","🙏","🤝","🫶","👌","✌️","🤞","🫰","👊","🤛","🖐️","✋","🤚","🖖"] },
  { id: "hearts", icon: "❤️", label: "Corazones", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝"] },
  { id: "symbols", icon: "✅", label: "Símbolos", emojis: ["✅","❌","⭐","🌟","💯","✨","💡","⚡","💥","🎯","🔥","👀","📌","⏰","✏️","🔒","💰","📈","🎨","🐛"] },
  { id: "celebrate", icon: "🎉", label: "Fiesta", emojis: ["🎉","🎊","🚀","🏆","🥇","👑","💎","🎁","🌈","☀️","🌙","❄️","🎂","🍕","☕","🍺","🌮","🍩","🥤"] },
];

// Recientes del picker: localStorage, tope 24, más nuevo primero. Módulo-cacheado
// para pintar al instante al reabrir.
let emojiRecents: string[] | null = null;
function getEmojiRecents(): string[] {
  if (emojiRecents) return emojiRecents;
  try { emojiRecents = JSON.parse(localStorage.getItem("emoji:recents") || "[]"); } catch { emojiRecents = []; }
  return emojiRecents || [];
}
function pushEmojiRecent(e: string) {
  const cur = getEmojiRecents().filter((x) => x !== e);
  emojiRecents = [e, ...cur].slice(0, 24);
  try { localStorage.setItem("emoji:recents", JSON.stringify(emojiRecents)); } catch { /* storage bloqueado */ }
}

// Set curado con keywords (ES+EN) para el buscador del picker — evita una lib de
// ~1MB. Al escribir filtra esto + los emojis custom; vacío muestra los rápidos.
const EMOJI_SEARCH: { c: string; k: string }[] = [
  { c: "👍", k: "thumbsup like yes bien ok pulgar arriba aprobado +1" },
  { c: "👎", k: "thumbsdown no mal pulgar abajo -1" },
  { c: "❤️", k: "heart love corazon rojo amor" },
  { c: "🧡", k: "heart orange corazon naranja" },
  { c: "💛", k: "heart yellow corazon amarillo" },
  { c: "💚", k: "heart green corazon verde" },
  { c: "💙", k: "heart blue corazon azul" },
  { c: "💜", k: "heart purple corazon morado" },
  { c: "🖤", k: "heart black corazon negro" },
  { c: "💔", k: "broken heart corazon roto" },
  { c: "😂", k: "joy laugh risa lol jaja llorar" },
  { c: "🤣", k: "rofl rolling laugh risa piso" },
  { c: "😅", k: "sweat smile risa nervios" },
  { c: "🙂", k: "slight smile sonrisa" },
  { c: "😊", k: "blush smile sonrojo feliz" },
  { c: "😍", k: "heart eyes enamorado amor ojos" },
  { c: "😘", k: "kiss beso" },
  { c: "😎", k: "cool sunglasses lentes genial" },
  { c: "🤔", k: "thinking pensar duda hmm" },
  { c: "🤨", k: "raised eyebrow ceja duda" },
  { c: "😐", k: "neutral serio" },
  { c: "😴", k: "sleep dormir sueno zzz" },
  { c: "😭", k: "cry sob llorar triste" },
  { c: "😢", k: "cry tear triste lagrima" },
  { c: "😡", k: "angry enojado rabia rojo" },
  { c: "🤯", k: "mind blown explota cabeza wow" },
  { c: "🥳", k: "party face fiesta celebrar" },
  { c: "🤩", k: "star struck estrellas wow" },
  { c: "😱", k: "scream miedo shock grito" },
  { c: "🙄", k: "eye roll ojos rodar" },
  { c: "😬", k: "grimace mueca incomodo" },
  { c: "🤗", k: "hug abrazo" },
  { c: "🤝", k: "handshake trato acuerdo manos" },
  { c: "🙏", k: "pray gracias porfavor thanks please rezar" },
  { c: "👏", k: "clap aplauso bravo" },
  { c: "🙌", k: "raised hands celebrar manos arriba" },
  { c: "👋", k: "wave hola adios saludo mano" },
  { c: "🤙", k: "call me shaka llamame" },
  { c: "💪", k: "muscle fuerza biceps fuerte" },
  { c: "🫡", k: "salute saludo militar" },
  { c: "👀", k: "eyes ojos mirar viendo" },
  { c: "🔥", k: "fire fuego caliente lit" },
  { c: "✅", k: "check ok hecho listo done verde" },
  { c: "❌", k: "cross no error mal x" },
  { c: "⭐", k: "star estrella favorito" },
  { c: "🌟", k: "glowing star estrella brillo" },
  { c: "💯", k: "hundred cien perfecto 100" },
  { c: "🎉", k: "tada party fiesta celebrar confeti" },
  { c: "🎊", k: "confetti confeti fiesta" },
  { c: "🚀", k: "rocket cohete lanzar rapido ship deploy" },
  { c: "✨", k: "sparkles brillo magia" },
  { c: "💡", k: "idea bombilla luz" },
  { c: "⚡", k: "zap rayo energia rapido" },
  { c: "💥", k: "boom explosion" },
  { c: "🎯", k: "target dardo objetivo bullseye" },
  { c: "🏆", k: "trophy trofeo ganar premio" },
  { c: "🥇", k: "gold medal oro primero" },
  { c: "👑", k: "crown corona rey" },
  { c: "💎", k: "gem diamante joya" },
  { c: "🤖", k: "robot bot ghosty agente ai" },
  { c: "👻", k: "ghost fantasma ghosty" },
  { c: "🙈", k: "see no evil mono ojos" },
  { c: "💩", k: "poop caca mierda" },
  { c: "🤡", k: "clown payaso" },
  { c: "👀", k: "eyes ojos" },
  { c: "🫠", k: "melting derretir calor" },
  { c: "😤", k: "triumph resoplido enojo" },
  { c: "🥺", k: "pleading suplica ojitos porfa" },
  { c: "😉", k: "wink guino" },
  { c: "😜", k: "wink tongue lengua broma" },
  { c: "🤪", k: "zany loco" },
  { c: "🫶", k: "heart hands manos corazon amor" },
  { c: "👌", k: "ok perfecto bien" },
  { c: "✌️", k: "peace paz victoria dedos" },
  { c: "🤞", k: "fingers crossed suerte dedos" },
  { c: "🫰", k: "fingers crossed dinero suerte" },
  { c: "👊", k: "fist puno golpe bro" },
  { c: "☕", k: "coffee cafe" },
  { c: "🍕", k: "pizza comida" },
  { c: "🍺", k: "beer cerveza chela" },
  { c: "🎂", k: "cake pastel cumpleanos" },
  { c: "🌮", k: "taco comida mexico" },
  { c: "💀", k: "skull calavera muerto rip lol" },
  { c: "👽", k: "alien extraterrestre" },
  { c: "🐛", k: "bug insecto error" },
  { c: "🎨", k: "art arte diseno paleta" },
  { c: "📌", k: "pin fijar chincheta" },
  { c: "⏰", k: "alarm reloj tiempo" },
  { c: "✏️", k: "pencil lapiz editar" },
  { c: "🔒", k: "lock candado seguro privado" },
  { c: "💰", k: "money dinero bolsa" },
  { c: "📈", k: "chart up grafica subir crecer" },
  { c: "🎁", k: "gift regalo" },
  { c: "🌈", k: "rainbow arcoiris" },
  { c: "☀️", k: "sun sol" },
  { c: "🌙", k: "moon luna noche" },
  { c: "❄️", k: "snow nieve frio" },
];

// Título corto de un hilo = primera línea de su mensaje raíz (para los submenús).
function threadTitle(m: Message): string {
  const first = (m.body || "").split("\n")[0].trim();
  return first.length > 40 ? first.slice(0, 39) + "…" : first;
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
  const updated = { emoji: ev.emoji, count: ev.count, mine };
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
export type WsUser = {
  sub: string; name: string; avatar: string; handle: string; isOwner: boolean;
  statusEmoji: string | null; statusText: string | null; title: string | null; pronouns: string | null; bio: string | null;
};
let usersCache: Map<string, WsUser> | null = null;
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
function EmojiText({ code, className }: { code: string; className?: string }) {
  const { emojis } = useContext(ChatCtx);
  const m = /^:([a-z0-9_]+):$/.exec(code);
  const custom = m ? emojis.find((e) => e.name === m[1]) : null;
  if (custom)
    return (
      <img
        src={`/api/attachment/${encodeURIComponent(custom.file_id)}`}
        alt={code}
        title={code}
        loading="lazy"
        decoding="async"
        className={className ?? "inline-block h-[1.15em] w-[1.15em] object-contain align-[-0.15em]"}
      />
    );
  return <span>{code}</span>;
}

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
    // Media (imágenes) carga DESPUÉS del primer paint y su reflow crece el contenido por
    // debajo → si el scroll-to-bottom corrió con el scrollHeight subestimado, el canal
    // abre "arriba" y el botón "ir al final" no aparece (el layout mentía que ya estaba
    // al fondo). Escuchamos el `load` de CUALQUIER imagen del scroller (captura: `load`
    // no burbujea) y: si seguíamos pegados al fondo, re-anclamos; si no, recalculamos
    // atBottom para que el botón salga cuando el crecimiento nos dejó mid-history.
    const el = scrollRef.current;
    if (!el) return;
    const onImgLoad = (e: Event) => {
      if (!(e.target instanceof HTMLImageElement)) return;
      if (stick.current) {
        el.scrollTo({ top: el.scrollHeight });
      } else {
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        setAtBottom((prev) => (prev === near ? prev : near));
      }
    };
    el.addEventListener("load", onImgLoad, true);
    return () => el.removeEventListener("load", onImgLoad, true);
  }, [scrollRef]);
  return { onScroll, atBottom, scrollToBottom };
}

function ChannelPage() {
  const { channels, channel, user, initialFlow, initialThreads } = Route.useLoaderData();
  // Marca la hidratación como completa → el loader deja de prefetchear en las
  // navegaciones siguientes (solo lo hacía para igualar el SSR en el primer render).
  useEffect(() => {
    hydrated = true;
  }, []);
  // Hilo / DM abierto = ESTADO CLIENTE (no URL) → abre instantáneo, sin revalidar el
  // router. Igual que los hilos, un DM se enfoca en el CENTRO (referencia Zulip).
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [openDmId, setOpenDmId] = useState<number | null>(null);
  // Artefacto abierto en el panel lateral (pdf/imagen; doc en Fase 3). Estado
  // cliente puro, como openThreadId — abre instantáneo sin tocar el router.
  const [openArtifact, setOpenArtifact] = useState<ArtifactView | null>(null);
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
  const [online, setOnline] = useState<Set<string>>(new Set());
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
      .then(() => refreshUnread())
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
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const channelsById = useMemo(() => new Map(channels.map((c) => [c.id, c.slug])), [channels]);
  const router = useRouter();

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
  const driveDraftFromBody = (id: number, body: string) => {
    const doc = extractEbDoc(body);
    if (!doc || !doc.md.trim()) return;
    draftMsgIdRef.current = id;
    setOpenArtifact((cur) => {
      // Auto-abre si no hay panel, si ya estamos en el draft, o si está abierto el doc/hoja
      // que se está editando (para ver la edición EN VIVO). NO pisa otro artefacto (pdf/imagen…).
      if (cur && cur.kind !== "draft" && cur.kind !== "doc" && cur.kind !== "sheet") return cur;
      return {
        kind: "draft",
        title: draftTitle(doc.md, doc.kind, doc.fenceTitle),
        content: doc.md,
        sheet: doc.kind === "sheet",
        streaming: !doc.closed,
      };
    });
  };
  // Al cerrarse el fence, el server produce el .docx (refresh → refetch cuelga el
  // artifact). Poll acotado sobre las caches → swap del draft al doc real.
  const scheduleDraftSwap = (id: number) => {
    let tries = 0;
    const tick = () => {
      const m = findMessageInCaches(id);
      if (m?.artifact) {
        setOpenArtifact((cur) => (cur?.kind === "draft" ? artifactToView(m.artifact!) : cur));
        draftMsgIdRef.current = null;
        return;
      }
      if (++tries < 12) setTimeout(tick, 500);
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
        // Sonido oficial de notificación: mensaje real de alguien más en un scope no
        // silenciado. Los "status" no suenan, y la CÁSCARA del agente (kind:"msg" con
        // agent_handle y mentions_ghosty=0) tampoco AQUÍ: nace vacía al enviar → su sonido
        // se dispara al PRIMER token (message:body/delta), no al aparecer la caja.
        const isAgentShell = ev.msg.agent_handle != null && ev.msg.mentions_ghosty === 0;
        // ¿Realmente lo estoy viendo? = scope enfocado Y pestaña visible. Gatea sonido,
        // toast, notificación de escritorio Y el auto-marcado de leído.
        const visible = typeof document !== "undefined" && document.visibilityState === "visible";
        const inFocus =
          (openDmId != null && ev.msg.dm_id === openDmId) ||
          (openThreadId != null && ev.msg.parent_id === openThreadId) ||
          (openDmId == null && view == null && openThreadId == null &&
            ev.msg.dm_id == null && ev.msg.parent_id == null && ev.msg.channel_id === channel.id);
        const activeScope = inFocus && visible;
        if (ev.msg.kind === "msg" && !isMine && !isAgentShell) {
          const muteKey = ev.msg.dm_id != null ? `dm:${ev.msg.dm_id}` : `room:${ev.msg.channel_id}`;
          if (!mutes.has(muteKey) && !activeScope) {
            // ¿Me menciona? (mi @handle o una grupal). Solo relevante en rooms.
            const h = user?.handle?.toLowerCase();
            const mentionsMe = (ev.msg.body.match(/@([\wáéíóúñ]+)/gi) ?? [])
              .map((x) => x.slice(1).toLowerCase())
              .some((x) => x === h || SOUND_GROUP_MENTIONS.has(x));
            // Prioridad: DM → DM · mención → atención · resto → knock. (El reply del
            // agente ya no suena aquí: se maneja al primer token — ver isAgentShell arriba.)
            if (ev.msg.dm_id != null) playDmSound();
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
            if (!visible && typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                const n = new Notification(ev.msg.sender, { body: preview, icon: "/ghosty.svg", tag: `gc-${dmId ?? chId}` });
                n.onclick = () => { window.focus(); onOpen(); n.close(); };
              } catch { /* algunos browsers exigen SW para notificar */ }
            }
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
        patchMessage(ev.id, (m) => (blank && (m.body ?? "").trim() ? m : { ...m, body: ev.body }));
        if (!blank) {
          maybeChimeAgent(ev.id); // primer contenido del reply → sonido del agente
          driveDraftFromBody(ev.id, ev.body);
          // Fence cerrado → el server compila el .docx; swap del draft al doc real.
          const doc = extractEbDoc(ev.body);
          if (doc?.closed) scheduleDraftSwap(ev.id);
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
      case "presence:init":
        setOnline(new Set(ev.online));
        break;
      case "presence":
        setOnline((prev) => {
          const n = new Set(prev);
          if (ev.status === "online") n.add(ev.sub);
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
    }
  };
  // Al (re)conectar o volver a la pestaña: catch-up (refetch de lo montado) → lossless.
  // Reconcilia también los no-leídos (pudo llegar algo con la pestaña dormida).
  useLiveStream({
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
    setOpenThreadId(null);
    setOpenDmId(null);
    setView(null);
    setHomeOpen(false);
  }, [channel.slug]);
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
  // Hotkeys globales. ⌘K/Ctrl-K → command palette. Esc → cierra el foco actual en orden
  // de prioridad (panel de artefacto → hilo → DM), como Slack/Discord. No hace nada si
  // estás escribiendo (el composer maneja su propio Esc) o si hay un modal/palette abierto.
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
        if (openArtifactRef.current) { setOpenArtifact(null); return; }
        if (openThreadId != null) { setOpenThreadId(null); return; }
        if (openDmId != null) { setOpenDmId(null); return; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openThreadId, openDmId]);
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
            askDmAgentFn({ data: { id: o.dmId!, body: o.body, sender: "", handle: r.agentHandle, shellId: r.shellId ?? undefined, quotedAuthor: o.quotedAuthor ?? null, quotedExcerpt: o.quotedExcerpt ?? null, attachments: o.attachments } })
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
          // El agente responde INLINE (en el flujo o en el mismo hilo) — NO abrimos un
          // hilo nuevo. Cada agente mencionado responde en paralelo y limpia su propio
          // "pensando…"; el streaming (message:delta) aterriza en el flujo por su id.
          for (const ag of respondents) {
            askAgent({ data: { slug: o.slug, parentId: ag.parent, fleetThread: ag.fleetThread, body: o.body, sender: "", handle: ag.handle, shellId: ag.shellId, quotedAuthor: o.quotedAuthor ?? null, quotedExcerpt: o.quotedExcerpt ?? null, attachments: o.attachments } })
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
  const [prefsTab, setPrefsTab] = useState<null | "general" | "agentes" | "emojis">(null);
  const openPrefs = useCallback((tab: "general" | "agentes" | "emojis" = "general") => setPrefsTab(tab), []);
  // Precalienta la cache de Ajustes al montar el shell (idle) → al abrir Preferencias
  // no hay ni spinner ni pop-in de tabs; la data (setup/agentAccess) ya está lista.
  useEffect(() => { loadSettingsData().catch(() => {}); }, []);
  const [profile, setProfile] = useState<ProfileTarget | null>(null);
  const openProfile = useCallback((p: ProfileTarget) => setProfile(p), []);

  return (
    <ChatCtx.Provider
      value={{ me: user, slug: channel.slug, emojis, users, react, star, pin, remove, editMsg, retrySend, discardSend, replyTo, setReplyTo, pickerFor, setPickerFor, onOpenArtifact: setOpenArtifact, sendQuickReply, openPrefs, openProfile }}
    >
    {/* pt safe-area: en PWA standalone (viewport-fit=cover + status-bar black-translucent)
        el contenido va DEBAJO de la hora/notch → el header y su botón de menú quedaban
        tapados. El inset superior empuja todo bajo la barra de estado (h-[100dvh] es
        border-box → el alto interior se ajusta). En desktop el inset es 0 (sin efecto). */}
    <div className="flex h-[100dvh] bg-surface text-ink pt-[env(safe-area-inset-top)] md:pt-0">
      {/* Backdrop del drawer (solo móvil): tap fuera cierra el sidebar. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}
      <Sidebar
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
              Algo en esta vista se atoró. No se perdió nada.
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
          onBack={() => setOpenThreadId(null)}
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
          onlineCount={online.size}
          pins={pins}
          onOpenDm={openDm}
          onOpenNav={() => setNavOpen(true)}
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
      <ArtifactBoundary resetKey={openArtifact?.title ?? "none"}>
        <ArtifactPanel artifact={openArtifact} onClose={() => setOpenArtifact(null)} onOpen={setOpenArtifact} />
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
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
    </ChatCtx.Provider>
  );
}

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
}: {
  thr: Message;
  active: boolean;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  canDelete: boolean;
  variant: "sidebar" | "modal";
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

function Sidebar({
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
  online: Set<string>;
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
}) {
  const t = useT();
  const router = useRouter();
  const { openPrefs } = useContext(ChatCtx); // Ajustes in-panel (modal a nivel shell)
  const [wsOpen, setWsOpen] = useState(false); // dropdown del switcher de workspace
  const [tasksOpen, setTasksOpen] = useState(false); // modal "Tareas (próximamente)"
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
  // Dark sidebar: si está activo y el modo es claro, forzamos la paleta OSCURA del
  // preset SOLO en este subárbol (vars inline). Es una preferencia de CLIENTE
  // (localStorage) → se aplica POST-montaje vía ref (NO en el render), para no meter
  // estado dependiente de localStorage en SSR/hidratación (evita mismatch → AppError).
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const KEYS = ["brand", "brand-2", "brand-fg", "surface", "surface-2", "surface-3", "border", "ink", "muted"];
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
  // Modal "Ver todos los hilos" del room activo (abierto desde el botón "+N más").
  const [allThreadsOpen, setAllThreadsOpen] = useState(false);
  // Cambiar de room cierra el modal (sus hilos ya no corresponden).
  useEffect(() => setAllThreadsOpen(false), [active]);
  // Acordeón: hilos del room colapsados (por slug). Colapsar evita que el sidebar
  // crezca sin fin cuando un room tiene muchos hilos.
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(new Set());
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
          <span className="min-w-0 flex-1 truncate font-semibold">{wsLabel}</span>
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
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
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
                onClick={() => { setWsOpen(false); openPrefs(); }}
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
      <div className="flex-1 overflow-y-auto p-2 thin-scroll">
        {/* Home: dashboard de inicio con el personaje Ghosty. */}
        <button
          onClick={onOpenHome}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm md:py-1.5 ${
            homeActive ? "bg-brand/15 font-medium text-ink" : "text-muted hover:bg-surface-3 hover:text-ink"
          }`}
        >
          <HomeIcon size={16} className="shrink-0" /> {t("Inicio")}
        </button>
        {/* Tareas de equipo (próximamente). */}
        <button
          onClick={() => setTasksOpen(true)}
          className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-muted transition hover:bg-surface-3 hover:text-ink md:py-1.5"
        >
          <CheckCircle2 size={16} className="shrink-0" /> {t("Tareas")}
          <span className="ml-auto rounded-full border border-border px-1.5 text-[10px] text-muted">{t("pronto")}</span>
        </button>
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
            {dms.map((dm, i) => {
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
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      <div className="mx-2 mb-2 rounded-xl border border-border bg-surface p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <img src="/ghosty.svg" alt="" className="h-4 w-4" /> {t("Ghosty está aquí")}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t("Escribe")} <span className="text-brand">@ghosty</span> {t("en cualquier mensaje.")}
        </p>
      </div>

      <InstallAppButton />

      {/* Ajustes = modal instantáneo in-panel (SPA), no navegación de ruta. */}
      <button
        onClick={() => openPrefs()}
        className="flex w-full items-center gap-2 border-t border-border p-3 text-left hover:bg-surface-3"
      >
        <Avatar name={user?.name} avatar={user?.avatar} className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{user?.name ?? "—"}</p>
          <p className="truncate text-xs text-muted">{user?.isOwner ? t("Owner") : t("Miembro")}</p>
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
        {tasksOpen && (
          <Modal onClose={() => setTasksOpen(false)} wide>
            <div className="flex flex-col items-center px-2 py-4 text-center">
              <div className="mb-3 grid h-16 w-16 place-items-center rounded-2xl bg-brand/15 text-brand">
                <CheckCircle2 size={30} />
              </div>
              <h2 className="text-base font-semibold">{t("Tareas de equipo")}</h2>
              <p className="mt-1 max-w-xs text-sm text-muted">
                {t("Tareas, epics y responsables junto a la conversación — @ghosty podrá crearlas y cerrarlas desde el chat.")}
              </p>
              <span className="mt-4 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted">
                {t("Próximamente")}
              </span>
            </div>
          </Modal>
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
          <p className="mt-0.5 text-sm text-muted">
            {target.isAgent ? t("Agente") : t("Miembro")}
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

function Modal({
  children,
  onClose,
  wide,
  size,
  flush,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  // flush = sin padding ni scroll propio → el hijo controla su layout (ej. panel de
  // altura fija con header/tabs fijos y cuerpo scrolleable, estilo Ajustes).
  flush?: boolean;
}) {
  // `size` gana; `wide` se mantiene por compatibilidad (equivale a "md").
  const maxW = size
    ? { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl", xl: "max-w-3xl" }[size]
    : wide
      ? "max-w-md"
      : "max-w-sm";
  // Esc cierra SOLO el modal superior (stack compartido) → un modal anidado no cierra
  // también el de abajo. Ver utils/modal-esc.
  useEffect(() => registerModalEsc(onClose), [onClose]);
  if (typeof document === "undefined") return null; // SSR-safe (portal necesita document)
  // PORTAL a document.body: varios modales se renderizan DENTRO del <aside> (sidebar),
  // que tiene `transform` → un `fixed inset-0` se anclaría a la sidebar (modal "atrapado
  // en la barra"), no al viewport. El portal lo saca del ancestro transformado → SIEMPRE
  // centrado sobre toda la pantalla.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    >
      <motion.div
        initial={{ scale: 0.95, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 8 }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[85dvh] w-full overflow-x-hidden rounded-2xl border border-border bg-surface-2 text-ink ${maxW} ${
          flush ? "overflow-y-hidden" : "thin-scroll overflow-y-auto p-5"
        }`}
      >
        {children}
      </motion.div>
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
      <button
        type="button"
        role="switch"
        aria-checked={isPrivate}
        onClick={() => setIsPrivate((v) => !v)}
        className="mb-5 flex w-full items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-left text-sm transition hover:bg-surface-2"
      >
        <Lock size={14} className="text-muted" />
        <span className="flex-1">{t("Privado (solo miembros invitados)")}</span>
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${isPrivate ? "bg-brand" : "bg-surface-3"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isPrivate ? "translate-x-[18px]" : "translate-x-0.5"}`} />
        </span>
      </button>
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

      {/* Privacidad */}
      <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        <Lock size={14} className="text-muted" />
        <span>{t("Privado (solo miembros invitados)")}</span>
      </label>

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
      onClick={() => onOpenArtifact({ kind: "docindex", title: t("Documentos"), channelId, channelSlug, threadRootId })}
      title={t("Documentos del caso")}
      aria-label={t("Documentos del caso")}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink"
    >
      <FolderOpen size={17} />
    </button>
  );
}

function SearchButton({ onOpenDm }: { onOpenDm: (id: number) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t("Buscar mensajes")}
        className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <Search size={17} />
      </button>
      <AnimatePresence>
        {open && <SearchModal onClose={() => setOpen(false)} onOpenDm={onOpenDm} />}
      </AnimatePresence>
    </>
  );
}

function SearchModal({ onClose, onOpenDm }: { onClose: () => void; onOpenDm: (id: number) => void }) {
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
      searchMessagesFn({ data: { q: term } })
        .then((r) => setResults(r ?? { rooms: [], dms: [] }))
        .catch(() => setResults({ rooms: [], dms: [] }));
    }, 250);
    return () => clearTimeout(h);
  }, [q]);

  const goRoom = (slug: string, id: number) => {
    onClose();
    router.navigate({ to: "/c/$slug", params: { slug } });
    // Salta al mensaje una vez montado el flujo del room (con destello).
    setTimeout(() => {
      const el = document.getElementById(`msg-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add("flash-highlight");
      setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
    }, 500);
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
            placeholder={t("Buscar en rooms y DMs…")}
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
                    {t("Rooms")}
                  </p>
                  {results!.rooms.map((m) => (
                    <button key={`r-${m.id}`} onClick={() => goRoom(m.slug, m.id)} className={hitRow}>
                      <span className="text-[11px] text-muted">
                        #{m.roomName} · {m.sender === "ghosty" ? "Ghosty" : m.sender}
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
  online: Set<string>;
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

  const stats: { label: string; value: number; sub: string; tint: string }[] = [
    { label: t("Sin leer"), value: totalUnread, sub: totalUnread ? t("mensajes te esperan") : t("estás al día"), tint: "bg-rose-500/15 text-rose-500" },
    { label: t("Rooms"), value: channels.length, sub: t("en el workspace"), tint: "bg-amber-500/15 text-amber-500" },
    { label: t("Conversaciones"), value: dms.length, sub: t("mensajes directos"), tint: "bg-fuchsia-500/15 text-fuchsia-500" },
    { label: t("En línea"), value: online.size, sub: t("ahora mismo"), tint: "bg-sky-500/15 text-sky-500" },
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

        {/* Tarjetas de resumen */}
        <div className="mb-8 grid grid-cols-2 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl border border-border bg-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${s.tint}`}>
                  <Sparkles size={16} />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{s.label}</span>
              </div>
              <p className="text-3xl font-bold text-ink">{s.value}</p>
              <p className="mt-0.5 text-xs text-muted">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Rooms + Conversaciones */}
        <div className="mb-8 grid gap-4 sm:grid-cols-2">
          <section className="rounded-2xl border border-border bg-surface-2 p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <HashIcon size={15} className="text-muted" /> {t("Rooms")}
            </h2>
            <div className="space-y-0.5">
              {channels.slice(0, 6).map((c) => (
                <button key={c.slug} onClick={() => onOpenRoom(c.slug)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3">
                  <HashIcon size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <UnreadBadge n={unreadRooms.get(c.id) ?? 0} />
                </button>
              ))}
              {channels.length === 0 && <p className="px-2 py-1 text-xs text-muted">{t("Aún no hay rooms.")}</p>}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface-2 p-4">
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
        <section className="mb-8 rounded-2xl border border-border bg-surface-2 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Users size={15} className="text-muted" /> {t("Personas y agentes")}
            <span className="ml-auto text-xs font-normal text-muted">{people.length}</span>
          </h2>
          <div className="grid gap-1 sm:grid-cols-2">
            {people.slice(0, 8).map((p) => (
              <button
                key={`${p.kind}:${p.handle}`}
                onClick={() => openProfile({ name: p.name, avatar: p.avatar, handle: p.handle, isAgent: p.kind === "agent" })}
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
        <div className="rounded-2xl border border-border bg-surface-2 p-2">
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
type LinkData = { url: string; title?: string; description?: string; image?: string; site?: string } | null;
const unfurlCache = new Map<string, LinkData>();
function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState<LinkData>(unfurlCache.get(url) ?? null);
  useEffect(() => {
    if (unfurlCache.has(url)) { setData(unfurlCache.get(url) ?? null); return; }
    let alive = true;
    unfurlLinkFn({ data: { url } }).then((d) => { unfurlCache.set(url, d); if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [url]);
  if (!data) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener"
      className="mt-1.5 flex max-w-md overflow-hidden rounded-lg border-l-2 border-brand bg-surface-2 transition hover:bg-surface-3">
      {data.image ? <img src={data.image} alt="" loading="lazy" decoding="async" className="h-auto max-h-28 w-24 shrink-0 object-cover" /> : null}
      <div className="min-w-0 flex-1 p-2.5">
        {data.site ? <p className="truncate text-[11px] uppercase tracking-wide text-muted">{data.site}</p> : null}
        {data.title ? <p className="truncate text-sm font-semibold text-ink">{data.title}</p> : null}
        {data.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{data.description}</p> : null}
      </div>
    </a>
  );
}
// Primera URL http(s) del cuerpo (para unfurl). Quita puntuación final pegada.
function firstUrl(body: string): string | null {
  const m = body.match(/https?:\/\/[^\s<>()]+/);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, "") : null;
}

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
      <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted">{t(label)}</span>
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

function Flow({
  channel,
  messages,
  optimistic,
  onSend,
  onOpenThread,
  typing,
  newAt,
  onlineCount,
  pins,
  onOpenDm,
  onOpenNav,
}: {
  channel: Channel;
  messages: Message[] | null;
  optimistic: Optimistic[];
  onSend: (p: SendPayload) => void;
  onOpenThread: (id: number) => void;
  typing: { sub: string; name: string } | null;
  newAt: number | null;
  onlineCount: number;
  pins: Message[];
  onOpenDm: (id: number) => void;
  onOpenNav: () => void;
}) {
  const t = useT();
  const { me } = useContext(ChatCtx);
  const canManage = !!me && (me.isOwner || channel.created_by === me.sub);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadId = firstUnreadId(messages, newAt, me?.name);
  const { onScroll, atBottom, scrollToBottom } = useChatScroll(scrollRef, messages, optimistic.length, unreadId, channel.id);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop((f) => composerRef.current?.addFiles(f));
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
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <NavToggle onOpen={onOpenNav} />
          <RoomIcon name={channel.icon} size={18} className="shrink-0 text-muted" />
          <div className="min-w-0">
            <h2 className="font-semibold leading-tight text-ink">{channel.name}</h2>
            {channel.description ? (
              <p className="hidden truncate text-xs text-muted md:block">{channel.description}</p>
            ) : (
              <p className="hidden truncate text-xs text-muted md:block">
                {t("Escribe aquí · responde en hilo a cualquier mensaje · tagea")}{" "}
                <span className="text-brand">@ghosty</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {onlineCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted" title={t("Conectados ahora")}>
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              <span className="hidden sm:inline">{t("{n} en línea", { n: onlineCount })}</span>
            </span>
          )}
          {/* Llamada de voz/video del room. UI en su lugar; se cablea a la caja Studio
              (LiveKit) después → por ahora "Próximamente". */}
          <button
            disabled
            title={t("Llamada del room · Próximamente")}
            className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted opacity-60"
          >
            <Headphones size={15} className="shrink-0" />
            <span className="hidden sm:inline">{t("Llamada")}</span>
            <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] uppercase tracking-wide">{t("pronto")}</span>
          </button>
          <DocsButton channelId={channel.id} channelSlug={channel.slug} />
          <SearchButton onOpenDm={onOpenDm} />
        </div>
      </header>
      {pins.length > 0 && <PinnedBar pins={pins} onJump={jumpTo} />}
      <div ref={scrollRef} onScroll={onScroll} className="w-full flex-1 overflow-y-auto px-6 py-4 thin-scroll">
        {messages === null ? (
          <ThreadSkeleton />
        ) : messages.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Sé el primero en escribir en {room}.", { room: channel.name })}
          </p>
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
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <ScrollDownButton show={!atBottom} onClick={scrollToBottom} />
      <TypingLine typing={typing} />
      <Composer
        ref={composerRef}
        slug={channel.slug}
        parentId={null}
        onSend={(p) => { onSend(p); scrollToBottom(); }}
        placeholder={t("Mensaje a #{room}…", { room: channel.name })}
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
  onBack: () => void;
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
  const { onScroll, atBottom, scrollToBottom } = useChatScroll(scrollRef, data?.replies ?? null, optimistic.length, null);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop((f) => composerRef.current?.addFiles(f));

  return (
    <section className="relative flex min-w-0 flex-1 flex-col" {...handlers}>
      <DropOverlay show={dragOver} />
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:gap-3 md:px-6">
        <button
          onClick={onBack}
          title={t("Volver al room")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink md:h-9 md:w-9"
        >
          <ArrowLeft size={18} />
        </button>
        <RoomIcon name={channel.icon} size={18} className="shrink-0 text-muted" />
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight text-ink">{t("Hilo")}</h2>
          <button onClick={onBack} className="truncate text-xs text-muted transition hover:text-brand">
            {channel.name}
          </button>
        </div>
        <div className="ml-auto shrink-0">
          <DocsButton channelId={channel.id} channelSlug={channel.slug} threadRootId={threadId} />
        </div>
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="w-full flex-1 overflow-y-auto px-6 py-4 thin-scroll">
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
            {optimistic.map((o) => (
              <OptimisticRow key={o.id} o={o} />
            ))}
          </>
        )}
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
}: {
  dm: DmConversation | null;
  dmId: number;
  rev: number;
  patch: number;
  online: Set<string>;
  optimistic: Optimistic[];
  onSend: (p: SendPayload) => void;
  onReloaded: (loaded: { sender: string; body: string }[]) => void;
  typing: { name: string } | null;
  newAt: number | null;
  onBack: () => void;
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
  const { onScroll, atBottom, scrollToBottom } = useChatScroll(scrollRef, flow, optimistic.length, unreadId);
  const composerRef = useRef<ComposerHandle>(null);
  const { dragOver, handlers } = useFileDrop((f) => composerRef.current?.addFiles(f));

  const title = dm ? dmTitle(dm, t("Conversación")) : t("Conversación");
  const isOnline = dm?.members.some((m) => online.has(m.sub)) ?? false;
  const first = dm?.members[0];

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
        {/* Llamada 1:1 (Slack: las llamadas van en room + DM, no en hilo). UI en su lugar;
            se cablea a la caja Studio (LiveKit) después → por ahora "Próximamente". */}
        <button
          disabled
          title={t("Llamada · Próximamente")}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted opacity-60"
        >
          <Headphones size={15} className="shrink-0" />
          <span className="hidden sm:inline">{t("Llamada")}</span>
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] uppercase tracking-wide">{t("pronto")}</span>
        </button>
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="w-full flex-1 overflow-y-auto px-6 py-4 thin-scroll">
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
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <ScrollDownButton show={!atBottom} onClick={scrollToBottom} />
      <TypingLine typing={typing} />
      <Composer
        ref={composerRef}
        slug=""
        parentId={null}
        dmId={dmId}
        onSend={(p) => { onSend(p); scrollToBottom(); }}
        placeholder={t("Mensaje a {name}…", { name: title })}
      />
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

function Avatar({ name, avatar, className }: { name?: string; avatar?: string; className?: string }) {
  if (avatar) return <img src={avatar} alt="" loading="lazy" decoding="async" className={`shrink-0 rounded-full ${className}`} />;
  return (
    <div className={`grid shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-ink ${className}`}>
      {(name || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Render de adjuntos (Fase 4): imágenes inline, resto como tarjeta con descarga.
// Imagen del chat con skeleton (shimmer) mientras carga + fade-in al listo → mata el
// pop-in feo. `decoding=async`+`loading=lazy` para no bloquear el hilo.
function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className={`relative block overflow-hidden rounded-lg border border-border ${
        // Reserva un alto mientras carga → el scroller no subestima scrollHeight (canal
        // abre al fondo + botón "ir al final" correcto); al cargar, el alto real manda.
        loaded ? "" : "min-h-40 w-60 max-w-full"
      }`}
    >
      {!loaded && (
        <span className="absolute inset-0 animate-pulse bg-surface-3" aria-hidden />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`max-h-80 w-auto max-w-full object-contain transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </span>
  );
}

// Todo pasa por el proxy autenticado /api/attachment/:fileId (re-firma readUrl).
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        const src = `/api/attachment/${encodeURIComponent(a.file_id)}`;
        // Inline: usa el thumbnail WebP si existe (liviano/rápido); el panel abre el original.
        const inlineSrc = a.thumb_file_id ? `/api/attachment/${encodeURIComponent(a.thumb_file_id)}` : src;
        const view = viewFromAttachment(a);
        // Imagen → abre en el panel lateral (antes: pestaña nueva).
        if (view?.kind === "image") {
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpenArtifact(view)}
              className="block cursor-pointer"
              title={t("Abrir en panel")}
            >
              <ChatImage src={inlineSrc} alt={a.name ?? ""} />
            </button>
          );
        }
        // PDF y Office (docx/xlsx/pptx) → card que abre el VISOR en el panel lateral
        // (preview mammoth / tabla xlsx), no descarga. La descarga vive en el header del panel.
        if (view?.kind === "pdf" || view?.kind === "office") {
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpenArtifact(view)}
              className="group flex max-w-xs items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left transition hover:border-brand"
              title={t("Abrir en panel")}
            >
              <FileText size={20} className="shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{a.name ?? t("Archivo")}</span>
                <span className="block text-[11px] text-muted">{fmtBytes(a.size)}</span>
              </span>
            </button>
          );
        }
        // Otros archivos (docx, zip, etc.) → descarga directa, sin visor.
        return (
          <a
            key={a.id}
            href={src}
            target="_blank"
            rel="noreferrer"
            download={a.name ?? undefined}
            className="group flex max-w-xs items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2 transition hover:border-brand"
          >
            <FileText size={20} className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{a.name ?? t("Archivo")}</span>
              <span className="block text-[11px] text-muted">{fmtBytes(a.size)}</span>
            </span>
            <Download size={15} className="shrink-0 text-muted group-hover:text-brand" />
          </a>
        );
      })}
    </div>
  );
}

// Card del ARTEFACTO que produjo el agente (doc/pdf). Clic → abre en el panel del
// room (co-edición en vivo si kind:"html"). Mapea el Artifact de la DB a la vista.
// Registro de kinds (patrón sólido: agregar un tipo = una entrada, no editar N
// switches). `embed` = va en iframe con embedUrl (editor colab); el resto comparte
// shape {kind, src:url}. `label` = subtítulo HONESTO de la card.
// Título por defecto por tipo → una imagen sin título no se llama "Documento".
// Los nombres (título de artefacto / adjunto) son TEXTO PLANO, pero el agente a veces los
// entrega con markdown — `**leads_crm.xlsx**`, `` `informe` ``, `[x](url)` — y se vería el
// `**` crudo en la card (o `**leads_crm` si el título viene truncado). Quita los marcadores
// de énfasis/código/enlace comunes. Conserva `_` intra-palabra (leads_crm) — solo colapsa
// `__bold__` balanceado; los `*`/`` ` ``/`~` no son válidos en nombres de archivo, se van todos.
function stripMdName(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [texto](url) → texto
    .replace(/`+/g, "") // `código`
    .replace(/\*+/g, "") // **negrita** *cursiva* (y marcadores sueltos/truncados)
    .replace(/~~/g, "") // ~~tachado~~
    .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2") // __negrita__ (respeta a_b)
    .trim();
}
function defaultArtifactTitle(kind: string): string {
  switch (kind) {
    case "image": return "Imagen";
    case "sheet": return "Hoja de cálculo";
    case "pdf": return "PDF";
    case "audio": return "Audio";
    case "video": return "Video";
    case "file": return "Archivo";
    default: return "Documento";
  }
}

const ARTIFACT_KIND_META: Record<string, { embed?: boolean; labelKey: string }> = {
  doc: { labelKey: "Documento" },
  sheet: { labelKey: "Hoja de cálculo" },
  html: { embed: true, labelKey: "Vista previa" },
  office: { labelKey: "Vista previa · Descargar" },
  pdf: { labelKey: "Vista previa" },
  image: { labelKey: "Vista previa" },
  audio: { labelKey: "Reproducir" },
  video: { labelKey: "Reproducir" },
  file: { labelKey: "Descargar" },
  "ask-user": { labelKey: "Elige una opción" },
};

// Construye la vista del panel desde un artefacto del mensaje (mapeo ÚNICO: lo usa la
// card Y el link inline del reply). Kind desconocido → `file` (descarga segura).
function artifactToView(a: Artifact): ArtifactView {
  const title = a.title ?? "";
  if (a.kind === "doc") return { kind: "doc", title, documentId: a.url, md: a.md ?? "" };
  if (a.kind === "sheet") return { kind: "sheet", title, documentId: a.url, csv: a.md ?? "" };
  if (a.kind === "ask-user") {
    let options: string[] = [];
    try { const p = JSON.parse(a.md ?? "[]"); if (Array.isArray(p)) options = p.map(String); } catch {}
    return { kind: "ask-user", title, question: a.title ?? "", options };
  }
  const kind = ARTIFACT_KIND_META[a.kind] ? a.kind : "file";
  return ARTIFACT_KIND_META[kind].embed
    ? { kind: "html", title, embedUrl: a.url }
    : ({ kind, title, src: a.url } as ArtifactView);
}

// Contiene cualquier fallo de render de un artefacto (campo faltante, dato viejo con
// forma inesperada) a un placeholder — NUNCA debe tumbar el hilo/room entero. Incidente
// 2026-07-09: un `.trim()` sobre md/csv undefined en ArtifactPanel crasheaba el room al
// abrir hilos con artefacto. Reset por `key` (id del artefacto) al montar la boundary.
class ArtifactBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; resetKey?: unknown; onCatch?: () => void },
  { failed: boolean; key: unknown }
> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  // Resetea el estado de error cuando cambia `resetKey` (nuevo artefacto) SIN remontar los
  // hijos → el ArtifactPanel persiste montado y su AnimatePresence anima abrir/cerrar. Antes
  // se reseteaba con `key` en el JSX, que remontaba el panel al cerrar → mataba el exit.
  static getDerivedStateFromProps(
    props: { resetKey?: unknown },
    state: { failed: boolean; key: unknown }
  ) {
    if (props.resetKey !== state.key) return { failed: false, key: props.resetKey };
    return null;
  }
  componentDidCatch(err: unknown, info: unknown) {
    // Log fuerte para diagnóstico (el fallback ya evitó tumbar la ruta).
    console.error("[gt boundary] render failed:", err, info);
    // Deja que el padre limpie el cache envenenado del contexto que crasheó (ver
    // el onCatch del boundary central) → reabrir re-fetchea limpio en vez de re-crashear.
    this.props.onCatch?.();
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}

// ── ask-user: artefacto INLINE de opciones clicables ────────────────────────
// Un solo listener de teclado a nivel módulo; la ÚLTIMA card interactiva montada
// "reclama" el teclado (activeAsk) para que teclas 1..9 no las peleen varias cards.
let activeAsk: { id: number; handle: (e: KeyboardEvent) => void } | null = null;
let auListenerBound = false;
function bindAuListener() {
  if (auListenerBound || typeof document === "undefined") return;
  auListenerBound = true;
  document.addEventListener("keydown", (e) => activeAsk?.handle(e));
}
// Estado persistido (sobrevive revalidate): respondida (opción elegida) / descartada.
function readAuState(id: number): { answered?: string; dismissed?: boolean } {
  if (typeof localStorage === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(`askuser:${id}`) || "{}"); } catch { return {}; }
}
function writeAuState(id: number, s: { answered?: string; dismissed?: boolean }) {
  try { localStorage.setItem(`askuser:${id}`, JSON.stringify(s)); } catch {}
}

function AskUserCard({
  artifactId,
  question,
  options,
  onPick,
}: {
  artifactId: number;
  question: string;
  options: string[];
  onPick: (opt: string) => void;
}) {
  const t = useT();
  const init = readAuState(artifactId);
  const [answered, setAnswered] = useState<string | null>(init.answered ?? null);
  const [dismissed, setDismissed] = useState<boolean>(!!init.dismissed);
  const [focusIdx, setFocusIdx] = useState(-1);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = !answered && !dismissed;

  const pick = useCallback((opt: string) => {
    if (!opt) return;
    setAnswered(opt);
    writeAuState(artifactId, { answered: opt });
    onPick(opt);
  }, [artifactId, onPick]);
  const dismiss = useCallback(() => {
    setDismissed(true);
    writeAuState(artifactId, { dismissed: true });
  }, [artifactId]);
  const undo = useCallback(() => {
    setDismissed(false);
    writeAuState(artifactId, {});
  }, [artifactId]);

  // Handler de teclado (siempre la versión más fresca vía ref → el listener módulo la llama).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e: KeyboardEvent) => {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement as HTMLElement | null;
    const editing = !!ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable);
    const withinCard = !!ae && !!containerRef.current?.contains(ae);
    // 1..9 → elige directo (pero NO si estás escribiendo en el composer).
    if (/^[1-9]$/.test(e.key)) {
      if (editing && !withinCard) return;
      const i = Number(e.key) - 1;
      if (i < options.length) { e.preventDefault(); pick(options[i]); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (editing && !withinCard) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = focusIdx < 0 ? (dir === 1 ? 0 : options.length - 1) : Math.min(Math.max(focusIdx + dir, 0), options.length - 1);
      setFocusIdx(next);
      btnRefs.current[next]?.focus();
      return;
    }
    if (e.key === "Enter" && withinCard && focusIdx >= 0) { e.preventDefault(); pick(options[focusIdx]); return; }
    if (e.key === "Escape" && !editing) { e.preventDefault(); dismiss(); }
  };

  // Reclama el teclado mientras esté activa; libera al responder/descartar/desmontar.
  useEffect(() => {
    if (!active) { if (activeAsk?.id === artifactId) activeAsk = null; return; }
    bindAuListener();
    activeAsk = { id: artifactId, handle: (e) => handlerRef.current(e) };
    return () => { if (activeAsk?.id === artifactId) activeAsk = null; };
  }, [active, artifactId]);

  if (dismissed) {
    return (
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
        {t("Pregunta descartada")}
        <button type="button" onClick={undo} className="font-medium text-brand hover:underline">{t("Mostrar")}</button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="mt-1.5 max-w-md rounded-xl border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-ink">{question || t("Elige una opción")}</span>
        {active && (
          <button
            type="button"
            onClick={dismiss}
            title={t("Descartar (Esc)")}
            className="shrink-0 rounded-md p-0.5 text-muted transition hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {options.map((opt, i) => {
          const chosen = answered === opt;
          return (
            <button
              key={i}
              ref={(el) => { btnRefs.current[i] = el; }}
              type="button"
              disabled={!active}
              onClick={() => pick(opt)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                chosen
                  ? "border-brand bg-brand/10 text-ink"
                  : active
                    ? "border-border text-ink hover:border-brand/60 hover:bg-surface-3"
                    : "border-border text-muted"
              }`}
            >
              <span className={`grid size-5 shrink-0 place-items-center rounded text-[10px] font-bold ${chosen ? "bg-brand text-white" : "bg-surface-3 text-muted"}`}>
                {chosen ? <Check size={12} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{opt}</span>
            </button>
          );
        })}
      </div>
      {active && (
        <p className="mt-2 text-[11px] text-muted">{t("Un clic o teclas 1–{n} · ↑↓ Enter · Esc descarta", { n: Math.min(options.length, 9) })}</p>
      )}
    </div>
  );
}

function ArtifactCard({ artifact, ownerMsg }: { artifact: Artifact; ownerMsg: Message }) {
  const t = useT();
  const { onOpenArtifact, sendQuickReply } = useContext(ChatCtx);
  const [downloading, setDownloading] = useState(false);
  const view = artifactToView(artifact);
  // ask-user: artefacto INLINE de opciones clicables → botones directos en el bubble
  // (un clic = enviar). No abre el panel lateral. Ver AskUserCard.
  if (view.kind === "ask-user") {
    return (
      <AskUserCard
        artifactId={artifact.id}
        question={view.question}
        options={view.options}
        onPick={(opt) => sendQuickReply(opt, ownerMsg)}
      />
    );
  }
  const isDoc = view.kind === "doc";
  const isOffice = view.kind === "office";
  const isSheet = view.kind === "sheet";
  const isPdf = view.kind === "pdf";
  // Subtítulo tipo "Documento · PDF" / "Hoja de cálculo · XLSX" / "Hoja · CSV" (estilo claude.ai).
  // Office = badge + tipo REALES derivados de la extensión del nombre — no hardcodear DOCX
  // para todo (xlsx/pptx/docx colapsan en kind "office"). Ver ArtifactPanel.extBadge.
  const officeExt = (/\.(docx?|xlsx?|pptx?)$/i.exec(view.kind === "office" ? artifact.title ?? "" : "")?.[1] ?? "").toUpperCase();
  const officeLabel = /^XLS/.test(officeExt)
    ? t("Hoja de cálculo")
    : /^PPT/.test(officeExt)
      ? t("Presentación")
      : t("Documento");
  const subtitle = isSheet
    ? `${t("Hoja de cálculo")} · CSV`
    : isPdf
      ? `${t("Documento")} · PDF`
      : isDoc
        ? `${t("Documento")} · DOCX`
        : isOffice
          ? `${officeLabel} · ${officeExt || "DOCX"}`
          : t(ARTIFACT_KIND_META[view.kind]?.labelKey ?? "Descargar");
  // Nombre mostrado: si es PDF y el título no trae extensión, le añadimos `.pdf` para que
  // se lea como archivo (el nombre SEMÁNTICO por contenido lo debe poner el agente al
  // generarlo — hoy a veces es un slug de storage tipo "df1VVGQO").
  const rawTitle = stripMdName(artifact.title?.trim() ?? "");
  const displayTitle = rawTitle
    ? (isPdf && !/\.[a-z0-9]{1,5}$/i.test(rawTitle) ? `${rawTitle}.pdf` : rawTitle)
    : t(defaultArtifactTitle(view.kind));
  const downloadHref = isDoc
    ? `/api/doc-docx/${encodeURIComponent(view.documentId)}?name=${encodeURIComponent(rawTitle || "documento")}`
    : isOffice
      ? view.src
      : null;
  // Sheet: el CSV vive en el cliente → descarga por blob (sin red).
  const downloadSheet = () => {
    if (!isSheet) return;
    const blob = new Blob([view.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(rawTitle || "hoja").replace(/[^\w.\- ]/g, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  return (
    <div className="group mt-1.5 flex max-w-md items-center gap-3 rounded-xl border border-border bg-surface-2 p-2 pr-2.5 transition hover:border-brand/50">
      <button
        type="button"
        onClick={() => onOpenArtifact(view)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={t("Abrir en el panel")}
      >
        {view.kind === "image" ? (
          // Miniatura real → una imagen se ve como imagen, no como "Documento".
          <img src={view.src} alt={artifact.title || ""} loading="lazy" decoding="async" className="size-10 shrink-0 rounded-lg object-cover" />
        ) : isPdf ? (
          // Documento en ROJO = convención universal de PDF (icono, no texto).
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-red-500/15 text-red-500">
            <FileText size={20} />
          </span>
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-3 text-brand">
            {view.kind === "sheet" || /^XLS/.test(officeExt) ? (
              <Table2 size={20} />
            ) : view.kind === "video" ? (
              <ImageIcon size={20} />
            ) : (
              <FileText size={20} />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{displayTitle}</span>
          <span className="block text-[11px] text-muted">{subtitle}</span>
        </span>
      </button>
      {isSheet ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            downloadSheet();
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-3"
        >
          {t("Descargar")}
        </button>
      ) : downloadHref ? (
        <button
          type="button"
          disabled={downloading}
          onClick={async (e) => {
            e.stopPropagation();
            if (downloading) return;
            // Office = URL pública externa → navegación directa (evita CORS del blob).
            if (isOffice) {
              window.open(downloadHref, "_blank", "noopener");
              return;
            }
            // Doc = proxy same-origin (export lento) → spinner. fetch → blob → download.
            setDownloading(true);
            try {
              const r = await fetch(downloadHref);
              if (!r.ok) throw new Error();
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${(rawTitle || "documento").replace(/[^\w.\- ]/g, "_")}.docx`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 4000);
            } catch {
              /* silencioso: el usuario reintenta */
            } finally {
              setDownloading(false);
            }
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-3 disabled:opacity-60"
        >
          {downloading ? <Loader2 size={12} className="animate-spin" /> : null}
          {downloading ? t("Descargando…") : t("Descargar")}
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({
  m,
  prev,
  onOpenThread,
  showThreadLink,
  canPin,
}: {
  m: Message;
  prev?: Message;
  onOpenThread?: (id: number) => void;
  showThreadLink?: boolean;
  canPin?: boolean;
}) {
  const t = useT();
  const { me, slug, emojis, users, pickerFor, onOpenArtifact, openProfile } = useContext(ChatCtx);
  const [editing, setEditing] = useState(false);
  // Mientras un popover de la barra (reaccionar/⋯) esté abierto, la barra NO debe
  // desaparecer al perder el hover del row (si no, el popover se vuelve inclicable).
  const [menuOpen, setMenuOpen] = useState(false);
  const barVisible = menuOpen || pickerFor === m.id; // ⋯ propio o picker global de esta fila
  // OJO: agent_handle también se setea en el mensaje HUMANO que TAGEA a un agente
  // (createMessage guarda mentions_ghosty=1). El reply DEL agente lo hace postAgent
  // con mentions_ghosty=0. Así, "es del agente" = tiene handle Y no es una mención.
  const isAgent = (m.agent_handle != null && m.mentions_ghosty === 0) || m.sender === "ghosty";
  const isGhostyAvatar = isAgent && (m.agent_handle === "ghosty" || m.sender === "ghosty");
  // Personas: resuelve nombre/avatar del DIRECTORIO VIVO por sub (fallback al denormalizado
  // del mensaje) → editar tu avatar se ve en mensajes viejos también, como Slack. Agentes
  // conservan su propio nombre/avatar (no están en el directorio de personas).
  const dirUser = !isAgent && m.sender_sub ? users.get(m.sender_sub) : undefined;
  const displayName = isAgent && m.sender === "ghosty" ? "Ghosty" : (dirUser?.name || m.sender);
  const avatarSrc = dirUser?.avatar || m.avatar;
  const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Hora compacta (24h, sin am/pm) para el gutter angosto de mensajes agrupados: "18:47"
  // cabe en w-9 (36px) en UNA línea → no wrappea a 2 líneas (lo que inflaba el alto de la
  // fila y descuadraba el spacing) ni se corta. Los headers (no-agrupados) siguen con `time`.
  const timeShort = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const canEdit = !!me && (me.isOwner || m.sender === me.name) && !isAgent && m.kind === "msg";
  const canDelete = !!me && (me.isOwner || m.sender === me.name) && m.kind === "msg";
  const canReact = m.kind === "msg" && !!slug;
  // Agrupación estilo Slack: mensajes CONSECUTIVOS del mismo autor dentro de ~5 min se
  // colapsan (sin repetir avatar/nombre/hora → feed denso). No agrupa si el previo es de
  // otro autor, si cambia el tipo (humano↔agente), si pasó la ventana, o si ESTE cita
  // a otro (la cita necesita su header). El divisor de no-leídos rompe la cadena (el
  // caller pasa prev=undefined en el primer no-leído).
  const prevIsAgent = prev ? ((prev.agent_handle != null && prev.mentions_ghosty === 0) || prev.sender === "ghosty") : false;
  const grouped =
    !!prev &&
    prev.kind === "msg" &&
    m.kind === "msg" &&
    !m.quoted_excerpt &&
    prevIsAgent === isAgent &&
    (prev.sender_sub && m.sender_sub ? prev.sender_sub === m.sender_sub : prev.sender === m.sender) &&
    m.created_at - prev.created_at < 300;

  if (m.kind === "status") {
    return (
      <div className="flex items-center gap-2.5 py-1 pl-11 text-xs text-muted">
        <ThinkingRing size={20} />
        <span className="italic">{m.body || t("Pensando…")}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className={`group relative flex items-start gap-3 rounded-lg px-2 transition-colors hover:bg-surface-2 ${grouped ? "py-px" : "mt-2 py-0.5"}`}>
      {grouped ? (
        // Agrupado: sin avatar. Gutter angosto que muestra la hora SOLO al hover (Slack).
        <div className="w-9 shrink-0 select-none whitespace-nowrap pt-0.5 text-right text-[10px] leading-5 tabular-nums text-muted opacity-0 group-hover:opacity-100">
          {timeShort}
        </div>
      ) : (
      /* Avatar clickable → perfil (persona o agente). */
      <button
        onClick={() => openProfile({ name: displayName, avatar: avatarSrc, handle: m.agent_handle ?? (isGhostyAvatar ? "ghosty" : null), isAgent, sub: isAgent ? null : m.sender_sub })}
        className="shrink-0 rounded-lg transition hover:opacity-80"
        title={t("Ver perfil")}
      >
      {isGhostyAvatar ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white">
          <img src="/ghosty.svg" alt="Ghosty" className="h-full w-full object-contain" />
        </div>
      ) : isAgent && m.avatar ? (
        <img src={m.avatar} alt={m.sender} loading="lazy" decoding="async" className="mt-0.5 h-9 w-9 shrink-0 rounded-lg object-cover" />
      ) : isAgent ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Bot size={20} />
        </div>
      ) : (
        <Avatar name={displayName} avatar={avatarSrc} className="mt-0.5 h-9 w-9 !rounded-lg" />
      )}
      </button>
      )}
      {/* Acciones al hover: reaccionar · destacar · menú (copiar/fijar/editar/borrar) */}
      {m.kind === "msg" && !editing && (
        <div
          className={`absolute right-2 top-0 z-20 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-0.5 shadow-sm transition ${
            barVisible ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
          }`}
        >
          {canReact && <ReactButton m={m} />}
          <ReplyButton m={m} author={displayName} />
          {showThreadLink && onOpenThread && !m.reply_count && <ThreadReplyButton onOpen={() => onOpenThread(m.id)} />}
          <CopyButton m={m} />
          <StarButton m={m} />
          <MessageActions
            m={m}
            slug={slug}
            canEdit={canEdit}
            canDelete={canDelete}
            canPin={!!canPin}
            onEdit={() => setEditing(true)}
            onOpenChange={setMenuOpen}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Header (nombre/badges/hora) SOLO en el primer mensaje del grupo. Los agrupados
            van sin header (más denso); la hora aparece en el gutter al hover. */}
        {!grouped && (
        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${isAgent ? "text-brand" : "text-ink"}`}>
            {displayName}
          </span>
          {isAgent ? (
            <span className="rounded bg-brand/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-brand">
              {t("Agente")}
            </span>
          ) : null}
          <span className="text-[11px] text-muted">{time}</span>
          {m.edited_at ? <span className="text-[11px] text-muted">{t("(editado)")}</span> : null}
          {m.pinned ? (
            <span title={t("Fijado")} className="inline-flex">
              <Pin size={11} className="text-brand" />
            </span>
          ) : null}
          {m.starred ? (
            <span title={t("Destacado")} className="inline-flex">
              <Star size={11} className="text-amber-500" fill="currentColor" />
            </span>
          ) : null}
        </div>
        )}
        {/* Quote-reply: cita del mensaje al que responde (sobre el cuerpo, clic → salta). */}
        {m.quoted_excerpt ? <QuotedCitation m={m} /> : null}
        {editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          m.body ? (
            <div className="text-sm text-ink">
              <Markdown
                body={bubbleWithoutEbDoc(m.body)}
                artifactUrl={m.artifact?.url}
                onOpenArtifact={m.artifact ? () => onOpenArtifact(artifactToView(m.artifact!)) : undefined}
                emojis={emojis}
                onMention={(h) => {
                  // Clic en @mención → abre el perfil de esa persona (Slack: hovercard con
                  // Message). Resuelve por handle en el directorio vivo; grupos (@all…) no matchean.
                  const u = [...users.values()].find((x) => x.handle.toLowerCase() === h.toLowerCase());
                  if (u) openProfile({ name: u.name, avatar: u.avatar, handle: u.handle, isAgent: false, sub: u.sub });
                }}
              />
            </div>
          ) : isAgent ? (
            // Caja caliente: cáscara del agente aún sin texto → indicador inline (la fila
            // con avatar+nombre ya está arriba y PERMANECE). Se reemplaza al primer token.
            <div className="flex items-center gap-2 py-0.5 text-xs text-muted">
              <ThinkingRing size={16} />
              <span className="italic">{t("pensando…")}</span>
            </div>
          ) : null
        )}
        {/* Link preview (unfurl) de la primera URL — salvo que el link sea el del artefacto. */}
        {!editing && m.body && !m.artifact && (() => {
          const u = firstUrl(bubbleWithoutEbDoc(m.body));
          return u ? <LinkPreview url={u} /> : null;
        })()}
        {m.attachments && m.attachments.length > 0 && <AttachmentList attachments={m.attachments} />}
        {m.artifact && (
          <ArtifactBoundary
            key={m.artifact.url}
            fallback={
              <div className="mt-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
                No se pudo mostrar el artefacto.
              </div>
            }
          >
            <ArtifactCard artifact={m.artifact} ownerMsg={m} />
          </ArtifactBoundary>
        )}
        {canReact && (m.reactions?.length ?? 0) > 0 && <ReactionBar m={m} />}
        {/* Con respuestas → "N respuestas" es contenido REAL, siempre visible (reserva su
            espacio legítimo). SIN respuestas → NO se renderiza nada inline: el afordance
            "responder en hilo" vive en la barra flotante de hover (posición absoluta → cero
            reserva de espacio, cero brinco de layout, como Slack). */}
        {showThreadLink && onOpenThread && m.reply_count ? (
          <div className="mt-1 flex items-center gap-3 text-xs">
            <button
              onClick={() => onOpenThread(m.id)}
              className="flex items-center gap-1.5 font-medium text-brand hover:underline"
            >
              <MessageSquare size={13} /> {m.reply_count === 1 ? t("1 respuesta") : t("{n} respuestas", { n: m.reply_count })}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Extracto de texto plano de un mensaje para la cita (quita fences eb-doc/código,
// markdown básico, y colapsa espacios). Espejo de quoteExcerpt del server.
function plainExcerpt(body: string): string {
  const s = (body || "")
    .replace(/```eb-(doc|sheet)[\s\S]*?```/g, "[documento]")
    .replace(/```[\s\S]*?```/g, "[código]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[imagen]")
    .replace(/[*_`#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

// Cita renderizada sobre el mensaje (quote-reply). Clic → salta al original si está en
// pantalla (resalta un instante). Snapshot denormalizado → se ve aunque el original ya
// no exista.
function QuotedCitation({ m }: { m: Message }) {
  const jump = () => {
    if (m.quoted_id == null) return;
    const el = document.getElementById(`msg-${m.quoted_id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-brand");
    setTimeout(() => el.classList.remove("ring-2", "ring-brand"), 1200);
  };
  return (
    <button
      onClick={jump}
      className="mb-1 flex w-full max-w-md items-start gap-1.5 rounded-md border-l-2 border-brand/60 bg-surface-2 px-2 py-1 text-left transition hover:bg-surface-3"
    >
      <Reply size={12} className="mt-0.5 shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="mr-1.5 text-xs font-semibold text-brand">{m.quoted_author || "—"}</span>
        <span className="text-xs text-muted">
          {(m.quoted_excerpt ?? "").length > 140 ? (m.quoted_excerpt ?? "").slice(0, 140) + "…" : m.quoted_excerpt}
        </span>
      </span>
    </button>
  );
}

// Botón "Responder en hilo" en la barra flotante de hover (Slack): abre el hilo. Vive
// en la barra absoluta → no reserva espacio inline ni provoca brincos de layout.
function ThreadReplyButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onOpen}
      title={t("Responder en hilo")}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
    >
      <MessageSquare size={14} />
    </button>
  );
}

// Botón "Responder" (quote-reply, estilo WhatsApp/WABA): arma la cita en el composer.
function ReplyButton({ m, author }: { m: Message; author: string }) {
  const t = useT();
  const { setReplyTo } = useContext(ChatCtx);
  return (
    <button
      onClick={() => setReplyTo({ id: m.id, author, excerpt: plainExcerpt(m.body) })}
      title={t("Responder")}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
    >
      <Reply size={14} />
    </button>
  );
}

function ReactButton({ m }: { m: Message }) {
  const t = useT();
  const { react, pickerFor, setPickerFor } = useContext(ChatCtx);
  const open = pickerFor === m.id; // estado GLOBAL → solo uno abierto a la vez
  const wrapRef = useRef<HTMLDivElement>(null);
  // Outside-close por listener de documento (NO backdrop `fixed`: la barra tiene
  // `-translate-y-1/2` y un fixed dentro de un ancestro con transform se ancla a
  // ese ancestro, no al viewport → el backdrop no cubría la pantalla).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPickerFor(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerFor(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setPickerFor]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setPickerFor(open ? null : m.id)}
        title={t("Reaccionar")}
        className={`rounded p-1 transition ${open ? "text-brand" : "text-muted hover:text-ink"}`}
      >
        <SmilePlus size={14} />
      </button>
      {open && (
        <EmojiPicker
          onPick={(e) => {
            setPickerFor(null);
            react(m, e);
          }}
        />
      )}
    </div>
  );
}

// Destacar (star): marcador personal. Va por el evento `star` (ch.user) → el flag
// se sincroniza en todas mis pestañas, igual que las reacciones.
// Copia TODO el contenido del mensaje al portapapeles, con palomita animada (~1.5s).
// Junto a Destacar. Fallback a execCommand si el Clipboard API no está disponible.
function CopyButton({ m }: { m: Message }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = (m.body ?? "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? t("¡Copiado!") : t("Copiar mensaje")}
      className={`rounded p-1 transition hover:text-ink ${copied ? "text-green-500" : "text-muted"}`}
    >
      {copied ? <Check size={14} className="gc-pop" /> : <Copy size={14} />}
    </button>
  );
}

function StarButton({ m }: { m: Message }) {
  const t = useT();
  const { star } = useContext(ChatCtx);
  return (
    <button
      onClick={() => star(m)}
      title={m.starred ? t("Quitar destacado") : t("Destacar")}
      className={`rounded p-1 hover:text-ink ${m.starred ? "text-amber-500" : "text-muted"}`}
    >
      <Star size={14} fill={m.starred ? "currentColor" : "none"} />
    </button>
  );
}

// Menú "⋯" de acciones de mensaje: copiar enlace, fijar (owner/creador), editar, borrar.
function MessageActions({
  m,
  slug,
  canEdit,
  canDelete,
  canPin,
  onEdit,
  onOpenChange,
}: {
  m: Message;
  slug: string;
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
  onEdit: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const { pin, remove } = useContext(ChatCtx);
  const [open, setOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => onOpenChange?.(open), [open]); // mantiene la barra visible con el menú abierto
  const [receipts, setReceipts] = useState<{ sub: string; name: string; avatar: string }[] | null>(null);
  const close = () => {
    setOpen(false);
    setReceipts(null);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  // Cerrar con ESC y con click fuera (robusto, independiente del z-index).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-2";
  const showReceipts = () => {
    setReceipts([]);
    readReceiptsFn({ data: { messageId: m.id } })
      .then((rs) => setReceipts(rs))
      .catch(() => setReceipts([]));
  };
  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("Más acciones")}
        className="rounded p-1 text-muted hover:text-ink"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && receipts !== null && (
        <>
          <div className="absolute right-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
            <button className={`${item} text-muted`} onClick={() => setReceipts(null)}>
              <ArrowLeft size={14} /> {t("Leído por")}
            </button>
            <div className="border-t border-border" />
            {receipts.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted">{t("Nadie todavía")}</p>
            ) : (
              receipts.map((r) => (
                <div key={r.sub} className="flex items-center gap-2 px-2 py-1.5 text-xs text-ink">
                  <Avatar name={r.name} avatar={r.avatar} className="h-5 w-5 text-[9px]" />
                  <span className="truncate">{r.name}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
      {open && receipts === null && (
        <>
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-surface p-1 shadow-lg">
            {slug && (
              <button
                className={item}
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(`${location.origin}/c/${slug}#msg-${m.id}`)
                    .catch(() => {});
                  close();
                }}
              >
                <Link2 size={14} className="text-muted" /> {t("Copiar enlace")}
              </button>
            )}
            <button className={item} onClick={showReceipts}>
              <CheckCircle2 size={14} className="text-muted" /> {t("Leído por")}
            </button>
            {canPin && (
              <button
                className={item}
                onClick={() => {
                  pin(m);
                  close();
                }}
              >
                {m.pinned ? <PinOff size={14} className="text-muted" /> : <Pin size={14} className="text-muted" />}
                {m.pinned ? t("Desfijar") : t("Fijar en el room")}
              </button>
            )}
            {canEdit && (
              <button className={item} onClick={() => { onEdit(); close(); }}>
                <Pencil size={14} className="text-muted" /> {t("Editar")}
              </button>
            )}
            {canDelete && (
              <button
                className={`${item} !text-red-500 hover:bg-red-500/10`}
                onClick={() => {
                  close();
                  setConfirmDel(true);
                }}
              >
                <Trash2 size={14} /> {t("Eliminar")}
              </button>
            )}
          </div>
        </>
      )}
      {confirmDel && (
        <ConfirmModal
          title={t("Eliminar mensaje")}
          body={t("Esto no se puede deshacer.")}
          confirmLabel={t("Eliminar")}
          danger
          onCancel={() => setConfirmDel(false)}
          onConfirm={() => remove(m)}
        />
      )}
    </div>
  );
}

// Confirmación destructiva reutilizable (borrar mensaje/hilo/room). Overlay centrado
// con backdrop; ESC = cancelar, Enter = confirmar. Estilo alineado a la app.
function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Ejecuta la acción mostrando spinner; si resuelve OK normalmente el componente
  // se desmonta (el ítem borrado desaparece). Si falla, se libera el spinner.
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      setBusy(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") void run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, busy]);
  // Portal a document.body: un `fixed` dentro de un ancestro con `transform`
  // (la barra de acciones usa -translate-y-1/2) se ancla a ESE ancestro, no al
  // viewport → se aplasta. El portal lo saca del árbol transformado.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-xs text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border px-3.5 py-1.5 text-sm text-muted transition hover:text-ink disabled:opacity-50"
          >
            {/* Cancelar es el default seguro → foco aquí */}
            {t("Cancelar")}
          </button>
          <button
            onClick={run}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white transition disabled:opacity-70 ${
              danger ? "bg-red-500 hover:bg-red-600" : "bg-brand hover:brightness-110"
            }`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Barra de mensajes fijados del room (header). Clic → salta al mensaje.
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

function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  const t = useT();
  const { emojis, openPrefs } = useContext(ChatCtx);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("recents");
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const recents = getEmojiRecents();
  // Envuelve onPick para registrar el reciente (unicode y :custom: por igual).
  const pick = (e: string) => { pushEmojiRecent(e); onPick(e); };

  // Buscando → filtra el set curado (keywords) + custom (nombre). Navegando →
  // recientes (o rápidos si aún no hay) o la categoría activa.
  const unicode = searching
    ? EMOJI_SEARCH.filter((e) => e.k.includes(query)).map((e) => e.c)
    : cat === "recents"
      ? (recents.length ? recents : QUICK_EMOJIS)
      : EMOJI_CATEGORIES.find((c) => c.id === cat)?.emojis ?? [];
  // Los custom (imágenes/GIFs del workspace) salen al buscar, en su tab, y también
  // en "recientes" (vista por defecto) para que no queden escondidos.
  const custom = searching
    ? emojis.filter((e) => e.name.toLowerCase().includes(query))
    : cat === "custom" || cat === "recents"
      ? emojis
      : [];
  const empty = unicode.length === 0 && custom.length === 0;

  const renderEmoji = (e: string, i: number) =>
    e.startsWith(":") ? null : (
      <button
        key={`${e}-${i}`}
        onClick={() => pick(e)}
        className="grid aspect-square place-items-center rounded-md text-lg leading-none transition hover:scale-110 hover:bg-surface-2"
      >
        {e}
      </button>
    );
  const renderCustom = (e: CustomEmoji) => (
    <button
      key={e.name}
      onClick={() => pick(`:${e.name}:`)}
      title={`:${e.name}:`}
      className="grid aspect-square place-items-center rounded-md transition hover:scale-110 hover:bg-surface-2"
    >
      <img src={`/api/attachment/${encodeURIComponent(e.file_id)}`} alt={e.name} loading="lazy" decoding="async" className="h-5 w-5 object-contain" />
    </button>
  );

  return (
    <div className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
      {/* Buscador (el cierre por click-afuera lo maneja ReactButton). */}
      <div className="p-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Buscar emoji…")}
          className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-muted focus:border-brand"
        />
      </div>

      {/* Barra de categorías (oculta al buscar). */}
      {!searching && (
        <div className="flex items-center gap-0.5 border-y border-border px-1.5 py-1">
          {[{ id: "recents", icon: "🕐" }, ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, icon: c.icon })), ...(emojis.length ? [{ id: "custom", icon: "🧩" }] : [])].map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`grid h-7 w-7 place-items-center rounded-md text-base transition hover:bg-surface-2 ${
                cat === c.id ? "bg-surface-2 ring-1 ring-brand" : ""
              }`}
            >
              {c.icon}
            </button>
          ))}
        </div>
      )}

      <div className="grid max-h-52 grid-cols-7 gap-0.5 overflow-y-auto p-1.5">
        {empty ? (
          <p className="col-span-7 px-2 py-3 text-center text-xs text-muted">{t("Sin resultados")}</p>
        ) : (
          <>
            {unicode.map(renderEmoji)}
            {custom.map(renderCustom)}
          </>
        )}
      </div>

      {/* Footer: añadir emoji custom del workspace (owner) → Preferencias en la pestaña
          Emojis, in-panel (SPA), no navegación de ruta. */}
      <button
        onClick={() => openPrefs("emojis")}
        className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-xs text-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <Plus size={13} /> {t("Añadir emoji")}
      </button>
    </div>
  );
}

function ReactionBar({ m }: { m: Message }) {
  const t = useT();
  const { react } = useContext(ChatCtx);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {(m.reactions ?? []).map((r) => (
        <button
          key={r.emoji}
          onClick={() => react(m, r.emoji)}
          title={t("Toggle reacción")}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition ${
            r.mine
              ? "border-brand bg-brand/15 text-brand"
              : "border-border bg-surface-2 text-muted hover:border-brand"
          }`}
        >
          <EmojiText code={r.emoji} />
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

function EditBox({ m, onDone }: { m: Message; onDone: () => void }) {
  const t = useT();
  const { editMsg } = useContext(ChatCtx);
  const [val, setVal] = useState(m.body);
  function save() {
    if (!val.trim()) return;
    editMsg(m, val.trim()); // optimista: patch local + server en bg, cierra al instante
    onDone();
  }
  return (
    <div className="mt-1">
      <textarea
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") onDone();
        }}
        rows={2}
        className="w-full resize-none rounded-lg border border-border bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand"
      />
      <div className="mt-1 flex gap-2 text-xs">
        <button
          onClick={save}
          disabled={!val.trim()}
          className="rounded bg-brand px-2 py-0.5 font-semibold text-brand-fg disabled:opacity-50"
        >
          {t("Guardar")}
        </button>
        <button onClick={onDone} className="text-muted hover:text-ink">
          {t("Cancelar")}
        </button>
      </div>
    </div>
  );
}

function OptimisticRow({ o }: { o: Optimistic }) {
  const t = useT();
  const { retrySend, discardSend, emojis } = useContext(ChatCtx);
  const failed = o.status === "failed";
  // 100% optimista: mientras "sending" el mensaje se ve IDÉNTICO a uno entregado
  // (opacidad plena, hora en vivo, sin "enviando…"); el reconciliador lo canjea
  // por el real cuando aterriza por SSE. Solo si FALLA de verdad degrada a
  // "No se envió" + reintentar/descartar.
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-1.5">
      <Avatar name={o.sender} avatar={o.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{o.sender}</span>
          {failed ? (
            <span className="text-[11px] font-medium text-red-500">{t("No se envió")}</span>
          ) : (
            <span className="text-[11px] text-muted">{time}</span>
          )}
        </div>
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
              onClick={() => retrySend(o)}
              className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              <RotateCcw size={12} /> {t("Reintentar")}
            </button>
            <button onClick={() => discardSend(o.id)} className="text-muted hover:text-ink">
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
function useFileDrop(onFiles: (files: FileList | File[]) => void) {
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
      if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
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
type ComposerHandle = { addFiles: (files: FileList | File[]) => void };

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
    uploading: boolean;
    error?: boolean;
    previewUrl?: string; // objectURL de la imagen → miniatura INSTANTÁNEA (antes de subir)
  };
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => p.uploading);

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
          return r.json() as Promise<{ fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null }>;
        })
        .then((up) =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, fileId: up.fileId, thumbFileId: up.thumbFileId ?? null } : x)))
        )
        .catch(() =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, error: true } : x)))
        );
    }
  }, []);
  // La zona de drop grande (nivel conversación) empuja los archivos aquí.
  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);
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
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
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

  // Recarga el borrador al cambiar de scope sin desmontar (room-switch en Flow). Los
  // paneles keyados (hilo/DM) ya remontan. setContent parsea markdown (tiptap-markdown).
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, editor]);

  function submit() {
    // Adjuntos ya subidos (con fileId). Bloquea envío mientras alguno sube.
    const attachments = pending
      .filter((p) => p.fileId && !p.error)
      .map((p) => ({ fileId: p.fileId!, mime: p.mime, size: p.size, name: p.name, thumbFileId: p.thumbFileId ?? null }));
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
    if (replyTo) setReplyTo(null);
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
            onClick={() => setReplyTo(null)}
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
                  <span className="font-medium text-ink">{a.name}</span>
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
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-sm font-semibold text-brand-fg transition hover:brightness-110 disabled:opacity-50"
        >
          <Send size={15} />
          {t("Enviar")}
        </button>
        </div>
      </div>
    </form>
  );
});
