import { Component, createContext, Fragment, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  ChevronRight,
  Layers,
  Table2,
  Image as ImageIcon,
  FileType,
} from "lucide-react";
import { searchMessagesFn } from "../server/search";
import { createFileRoute, notFound, Link, useRouter } from "@tanstack/react-router";
import type { Channel, Message, DmConversation, RoomHit, ViewHit, Attachment, Artifact, CustomEmoji } from "../db.server";
import { listEmojisFn } from "../server/emojis";
import { recentViewFn, mentionsViewFn, starredViewFn } from "../server/views";
import { openDmFn, listDmsFn, getDmFlowFn, postDmMessageFn, askDmAgentFn } from "../server/dm";
import { unreadCountsFn, markReadFn, readReceiptsFn, lastReadFn } from "../server/reads";
import { toggleStarFn, togglePinFn, getPinsFn, toggleMuteFn, listMutesFn } from "../server/stars";
import {
  getChannelView,
  getChannelFlow,
  getThread,
  getChannelThreads,
  postMessage,
  askAgent,
  deleteMessageFn,
  listMentionsFn,
  pingTypingFn,
  toggleReactionFn,
  editMessageFn,
} from "../server/chat";
import { SmilePlus, Pencil, ArrowLeft, RotateCcw, Send } from "lucide-react";
import { getDeferredPrompt, onInstallable, clearDeferredPrompt, type BeforeInstallPromptEvent } from "../utils/pwa-install";
import { useLiveStream } from "../hooks/useLiveStream";
import type { RtEvent } from "../server/bus.server";
import { Markdown } from "../components/Markdown";
import ArtifactPanel, { type ArtifactView, viewFromAttachment } from "../components/ArtifactPanel";
import { extractEbDoc, draftTitle, bubbleWithoutEbDoc } from "../lib/ebdoc";
import { ThinkingRing } from "../components/ThinkingRing";
import { playNotificationSound, playGhostySound, playSelfSound, playMentionSound, playDmSound } from "../utils/notificationSound";

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
type Attach = { fileId: string; mime: string; size: number; name: string };
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

// Contexto de chat (usuario + slug activo) para que MessageRow acceda sin prop-drilling.
const ChatCtx = createContext<{
  me: SessionUser | null;
  slug: string;
  emojis: CustomEmoji[];
  react: (m: Message, emoji: string) => void;
  star: (m: Message) => void;
  pin: (m: Message) => void;
  remove: (m: Message) => void;
  editMsg: (m: Message, body: string) => void;
  retrySend: (o: Optimistic) => void;
  discardSend: (id: string) => void;
  // Picker de reacciones GLOBAL (id del mensaje con el picker abierto, o null).
  // Uno solo a la vez (referencia Slack/Zulip): abrir otro cierra el anterior.
  pickerFor: number | null;
  setPickerFor: (id: number | null) => void;
  // Abre un artefacto (pdf/imagen/doc) en el panel lateral del room.
  onOpenArtifact: (a: ArtifactView) => void;
}>({
  me: null,
  slug: "",
  emojis: [],
  react: () => {},
  star: () => {},
  pin: () => {},
  remove: () => {},
  editMsg: () => {},
  retrySend: () => {},
  discardSend: () => {},
  pickerFor: null,
  setPickerFor: () => {},
  onOpenArtifact: () => {},
});

// Emojis rápidos para el picker (evita una lib de ~1MB).
const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🙌", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😮"];

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
  const others = cur.filter((r) => r.emoji !== ev.emoji);
  if (ev.count <= 0) return { ...m, reactions: others };
  const prev = cur.find((r) => r.emoji === ev.emoji);
  const mine = ev.userSub === mySub ? ev.op === "add" : prev?.mine ?? false;
  return { ...m, reactions: [...others, { emoji: ev.emoji, count: ev.count, mine }] };
}

// Menciones disponibles (agentes + usuarios) para el typeahead @. Cache módulo.
let mentionsCache: Mention[] | null = null;
function useMentions(): Mention[] {
  const [mentions, setMentions] = useState<Mention[]>(mentionsCache ?? []);
  useEffect(() => {
    let alive = true;
    listMentionsFn().then((m) => {
      mentionsCache = m as Mention[];
      if (alive) setMentions(m as Mention[]);
    });
    return () => {
      alive = false;
    };
  }, []);
  return mentions;
}

// Emojis custom del workspace (para picker + render de reacciones). Cache módulo.
let emojisCache: CustomEmoji[] | null = null;
function useEmojis(): CustomEmoji[] {
  const [emojis, setEmojis] = useState<CustomEmoji[]>(emojisCache ?? []);
  useEffect(() => {
    let alive = true;
    listEmojisFn()
      .then((e) => {
        emojisCache = e;
        if (alive) setEmojis(e);
      })
      .catch(() => {});
    return () => {
      alive = false;
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
  const count = msgs?.length ?? 0;
  const contentLen = msgs?.reduce((n, m) => n + (m.body?.length ?? 0), 0) ?? 0;
  useEffect(() => {
    didLand.current = false;
  }, [resetKey]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    if (unreadId != null && !didLand.current) {
      const el = document.getElementById(`msg-${unreadId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        didLand.current = true;
        return;
      }
    }
    if (stick.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, contentLen, extra, unreadId]);
  return onScroll;
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
  // Drawer del sidebar en móvil (off-canvas). En ≥md el sidebar es fijo y esto se ignora.
  const [navOpen, setNavOpen] = useState(false);
  // Command palette (⌘K): salto rápido a room/DM/vista.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const emojis = useEmojis();
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
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
  const remove = (m: Message) => {
    removeMessageLocal(m.id);
    deleteMessageFn({ data: { id: m.id } }).catch(() => revalidate());
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
  const dms = useCachedQuery(dmListCache, "list", () => listDmsFn(), rev, patch) ?? [];
  // Mensajes fijados del room activo (barra en el header del flujo).
  const pins =
    useCachedQuery(pinsCache, channel.slug, () => getPinsFn({ data: { slug: channel.slug } }), rev, patch) ?? [];

  // ── Realtime: aplica eventos entrantes sobre los Maps de cache (patch, sin red) ──
  const onEvent = (ev: RtEvent) => {
    switch (ev.t) {
      case "message:new": {
        // Eco de mi propio envío → ya está optimista, descartar.
        if (ev.nonce && sentNonces.has(ev.nonce)) {
          sentNonces.delete(ev.nonce);
          return;
        }
        // Sonido oficial de notificación: mensaje real de alguien más (incluye
        // agentes/Ghosty) en un scope no silenciado. Los "status" (churn de agente)
        // no suenan.
        if (ev.msg.kind === "msg" && ev.msg.sender !== user?.name) {
          const muteKey = ev.msg.dm_id != null ? `dm:${ev.msg.dm_id}` : `room:${ev.msg.channel_id}`;
          // No sonar si el mensaje ya está a la vista en el scope enfocado (Slack/Zulip):
          // DM abierto, hilo abierto, o el flujo del room activo. Si la pestaña está
          // oculta sí suena (no lo estás viendo).
          const visible = typeof document !== "undefined" && document.visibilityState === "visible";
          const inFocus =
            (openDmId != null && ev.msg.dm_id === openDmId) ||
            (openThreadId != null && ev.msg.parent_id === openThreadId) ||
            (openDmId == null && view == null && openThreadId == null &&
              ev.msg.dm_id == null && ev.msg.parent_id == null && ev.msg.channel_id === channel.id);
          if (!mutes.has(muteKey) && !(visible && inFocus)) {
            // ¿Me menciona? (mi @handle o una grupal). Solo relevante en rooms.
            const h = user?.handle?.toLowerCase();
            const mentionsMe = (ev.msg.body.match(/@([\wáéíóúñ]+)/gi) ?? [])
              .map((x) => x.slice(1).toLowerCase())
              .some((x) => x === h || SOUND_GROUP_MENTIONS.has(x));
            // Prioridad: DM → DM · agente(@ghosty en room) → Ghosty · mención → atención
            // · resto → knock. (DM antes que agente: un DM que tagea @ghosty suena a DM.)
            if (ev.msg.dm_id != null) playDmSound();
            else if (ev.msg.agent_handle && ev.msg.mentions_ghosty === 0) playGhostySound(); // reply real del agente
            else if (mentionsMe) playMentionSound();
            else playNotificationSound();
          }
        }
        // DM: parchea el flujo del DM y refresca la lista (orden / nueva conversación).
        if (ev.msg.dm_id != null) {
          const arr = dmFlowCache.get(ev.msg.dm_id);
          if (arr && !arr.some((m) => m.id === ev.msg.id))
            dmFlowCache.set(ev.msg.dm_id, [...arr, ev.msg]);
          // Badge: si NO estoy viendo este DM → +1; si sí, márcalo leído (server).
          if (openDmId === ev.msg.dm_id)
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
          // Badge del room (solo top-level, como cuenta el server). El room activo
          // (sin DM abierto) se marca leído; los demás rooms visibles suman.
          if (openDmId == null && ev.msg.channel_id === channel.id)
            markReadFn({ data: { scope: "room", scopeId: channel.id } }).catch(() => {});
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
        driveDraftFromBody(ev.id, nb); // artefacto en vivo si hay ```eb-doc```
        break;
      }
      case "message:body": {
        // Body autoritativo al terminar el stream (reconcilia deltas perdidos).
        patchMessage(ev.id, (m) => ({ ...m, body: ev.body }));
        driveDraftFromBody(ev.id, ev.body);
        // Fence cerrado → el server compila el .docx; swap del draft al doc real.
        const doc = extractEbDoc(ev.body);
        if (doc?.closed) scheduleDraftSwap(ev.id);
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
          const f = JSON.parse(raw) as { view?: typeof view; dm?: number; thread?: number };
          if (f.view) setView(f.view);
          else if (f.dm != null) setOpenDmId(f.dm);
          else if (f.thread != null) setOpenThreadId(f.thread);
        }
      } catch {
        /* sessionStorage/JSON inválido → arranca en el flujo */
      }
      return;
    }
    setOpenThreadId(null);
    setOpenDmId(null);
    setView(null);
  }, [channel.slug]);
  // Persiste el foco actual (mutuamente excluyente) para sobrevivir un reload.
  useEffect(() => {
    const f = view ? { view } : openDmId != null ? { dm: openDmId } : openThreadId != null ? { thread: openThreadId } : null;
    try {
      if (f) sessionStorage.setItem(`focus:${channel.slug}`, JSON.stringify(f));
      else sessionStorage.removeItem(`focus:${channel.slug}`);
    } catch {
      /* storage lleno/bloqueado → no crítico */
    }
  }, [view, openDmId, openThreadId, channel.slug]);
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
    setOpenDmId(null);
    setOpenThreadId(id);
    setNavOpen(false); // en móvil, elegir cierra el drawer y enfoca el centro
  };
  const openDm = (id: number) => {
    setView(null);
    setOpenThreadId(null);
    setOpenDmId(id);
    setNavOpen(false);
  };
  const openView = (v: "recent" | "mentions" | "starred") => {
    setOpenThreadId(null);
    setOpenDmId(null);
    setView(v);
    setNavOpen(false);
  };
  // Hotkey global ⌘K / Ctrl-K → abre/cierra el command palette (salto rápido).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
      postDmMessageFn({ data: { id: o.dmId, body: o.body, nonce: o.nonce, attachments: o.attachments } })
        .then((r) => {
          revalidate();
          if (r?.needsAgent && r.agentHandle)
            askDmAgentFn({ data: { id: o.dmId!, body: o.body, sender: "", handle: r.agentHandle, attachments: o.attachments } })
              .then(() => revalidate())
              .catch(() => revalidate());
        })
        .catch(() => markFailed(o.id));
      return;
    }
    postMessage({ data: { slug: o.slug, parentId: o.parentId, body: o.body, nonce: o.nonce, attachments: o.attachments } })
      .then((r) => {
        revalidate();
        const respondents = r?.respondents ?? [];
        if (respondents.length) {
          if (o.parentId === null) {
            // Al ABRIR el hilo recién creado, siembra el root desde el mensaje que
            // acabamos de enviar (el optimista `o`, NO está en flowCache aún) → el hilo
            // muestra el MENSAJE ORIGINAL al instante, sin skeleton.
            const pid = respondents[0].parent;
            if (!threadCache.get(pid)) {
              const root = {
                id: pid, channel_id: channel.id, parent_id: null, dm_id: null,
                sender: o.sender, avatar: o.avatar, body: o.body, kind: "msg",
                agent_handle: null, mentions_ghosty: 0,
                created_at: Math.floor(Date.now() / 1000), edited_at: null,
                reply_count: 0, reactions: [], pinned: false, starred: false, topic: null,
              } as unknown as Message;
              threadCache.set(pid, { root, replies: [], pending: true });
            }
            openThread(pid); // @agente(s) en el flujo → abre su hilo
          }
          // Cada agente mencionado responde en paralelo (cada uno limpia su propio "pensando").
          for (const ag of respondents) {
            askAgent({ data: { slug: o.slug, parentId: ag.parent, fleetThread: ag.fleetThread, body: o.body, sender: "", handle: ag.handle, attachments: o.attachments } })
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
    };
    setOptimistic((prev) => [...prev, o]);
    fireSend(o);
  };
  const retrySend = (o: Optimistic) => {
    setOptimistic((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: "sending" as const } : x)));
    fireSend({ ...o, status: "sending" }); // reusa el mismo nonce (el server descarta mi eco)
  };
  const discardSend = (id: string) => setOptimistic((prev) => prev.filter((x) => x.id !== id));
  // Al recargar una vista se limpian SUS optimistas ya aterrizados; los fallidos
  // sobreviven (esperan retry/descartar del usuario).
  const clearOptimistic = (parentId: number | null) =>
    setOptimistic((o) => o.filter((x) => x.status === "failed" || x.parentId !== parentId || x.dmId !== null));
  const clearDmOptimistic = (dmId: number) =>
    setOptimistic((o) => o.filter((x) => x.status === "failed" || x.dmId !== dmId));
  // Borra un hilo (autor u owner). Si es el enfocado, vuelve al flujo del room.
  const deleteThread = async (id: number) => {
    await deleteMessageFn({ data: { id } }).catch(() => {});
    threadCache.delete(id);
    if (openThreadId === id) setOpenThreadId(null);
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

  return (
    <ChatCtx.Provider
      value={{ me: user, slug: channel.slug, emojis, react, star, pin, remove, editMsg, retrySend, discardSend, pickerFor, setPickerFor, onOpenArtifact: setOpenArtifact }}
    >
    <div className="flex h-[100dvh] bg-surface text-ink">
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
        }}
        onDeleteThread={deleteThread}
        dms={dms}
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
      {view != null ? (
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
          onReloaded={() => clearDmOptimistic(openDmId)}
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
          onReloaded={() => clearOptimistic(openThreadId)}
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
      </AnimatePresence>
    </div>
    </ChatCtx.Provider>
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
}) {
  const t = useT();
  const router = useRouter();
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
      className={`fixed inset-y-0 left-0 z-40 flex w-[84vw] max-w-xs flex-col border-r border-border bg-surface-2 transition-transform duration-200 ease-out md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 ${
        mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
      }`}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <img src="/ghosty.svg" alt="" className="h-7 w-7" />
        <span className="font-semibold">Ghosty Teams</span>
        {/* Cerrar drawer (solo móvil). */}
        <button
          onClick={onCloseNav}
          className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink md:hidden"
          aria-label={t("Cerrar menú")}
        >
          <X size={20} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
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
                  c.slug === active && activeThreadId == null && activeView == null
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
        {dms.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted">{t("Aún no tienes DMs.")}</p>
        ) : (
          dms.map((dm) => {
            const isOnline = dm.members.some((m) => online.has(m.sub));
            const first = dm.members[0];
            const muted = mutes.has(`dm:${dm.id}`);
            return (
              <div key={dm.id} className="group flex items-center">
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
              </div>
            );
          })
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

      <Link
        to="/settings"
        className="flex items-center gap-2 border-t border-border p-3 hover:bg-surface-3"
      >
        <Avatar name={user?.name} avatar={user?.avatar} className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{user?.name ?? "—"}</p>
          <p className="truncate text-xs text-muted">{user?.isOwner ? t("Owner") : t("Miembro")}</p>
        </div>
        <Settings size={16} className="text-muted" />
      </Link>

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

function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  // Esc cierra (para cualquier modal que use este wrapper).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
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
        className={`max-h-[85dvh] w-full overflow-y-auto overflow-x-hidden rounded-2xl border border-border bg-surface-2 p-5 text-ink ${
          wide ? "max-w-md" : "max-w-sm"
        }`}
      >
        {children}
      </motion.div>
    </motion.div>
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
  const [icon, setIcon] = useState("hash");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ch = await createChannelFn({ data: { name: name.trim(), icon, isPrivate } });
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
        className="mb-5 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
      />
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
      <label className="mb-5 flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
        <Lock size={14} className="text-muted" />
        <span>{t("Privado (solo miembros invitados)")}</span>
      </label>
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
  const [users, setUsers] = useState<
    { sub: string; handle: string; name: string; email: string; avatar: string }[]
  >([]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listWorkspaceUsersFn().then(setUsers).catch(() => setUsers([]));
  }, []);

  const query = q.trim().toLowerCase();
  const list = users
    .filter((u) => u.sub !== me?.sub)
    .filter(
      (u) =>
        !query ||
        u.handle.includes(query) ||
        u.name.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query)
    );
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
        {list.length === 0 ? (
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
      <div className="flex-1 space-y-1 overflow-y-auto px-4 py-4 no-scrollbar">
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
  onSend: (p: { body: string; attachments: Attach[] }) => void;
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
  const onScroll = useChatScroll(scrollRef, messages, optimistic.length, unreadId, channel.id);
  // Scroll a un mensaje (clic en un fijado) con destello, estilo "ir al origen".
  const jumpTo = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("flash-highlight");
    setTimeout(() => el?.classList.remove("flash-highlight"), 1200);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
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
          <DocsButton channelId={channel.id} channelSlug={channel.slug} />
          <SearchButton onOpenDm={onOpenDm} />
        </div>
      </header>
      {pins.length > 0 && <PinnedBar pins={pins} onJump={jumpTo} />}
      <div ref={scrollRef} onScroll={onScroll} className="mx-auto w-full max-w-4xl flex-1 space-y-1 overflow-y-auto px-4 py-4 no-scrollbar">
        {messages === null ? (
          <ThreadSkeleton />
        ) : messages.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Sé el primero en escribir en {room}.", { room: channel.name })}
          </p>
        ) : (
          messages.map((m) => (
            <Fragment key={m.id}>
              {m.id === unreadId && <NewDivider />}
              <MessageRow m={m} onOpenThread={onOpenThread} showThreadLink canPin={canManage} />
            </Fragment>
          ))
        )}
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <TypingLine typing={typing} />
      <Composer
        slug={channel.slug}
        parentId={null}
        onSend={onSend}
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
  onSend: (p: { body: string; attachments: Attach[] }) => void;
  onReloaded: () => void;
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
    if (data) onReloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  // Sigue las respuestas del hilo + el streaming de la respuesta del agente.
  const onScroll = useChatScroll(scrollRef, data?.replies ?? null, optimistic.length, null);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
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
      <div ref={scrollRef} onScroll={onScroll} className="mx-auto w-full max-w-4xl flex-1 space-y-1 overflow-y-auto px-4 py-4 no-scrollbar">
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
                {replies.map((m) => (
                  <MessageRow key={m.id} m={m} />
                ))}
              </>
            )}
            {optimistic.map((o) => (
              <OptimisticRow key={o.id} o={o} />
            ))}
          </>
        )}
      </div>
      <TypingLine typing={typing} />
      <Composer
        slug={channel.slug}
        parentId={threadId}
        onSend={onSend}
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
  onSend: (p: { body: string; attachments: Attach[] }) => void;
  onReloaded: () => void;
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
    if (flow) onReloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  const onScroll = useChatScroll(scrollRef, flow, optimistic.length, unreadId);

  const title = dm ? dmTitle(dm, t("Conversación")) : t("Conversación");
  const isOnline = dm?.members.some((m) => online.has(m.sub)) ?? false;
  const first = dm?.members[0];

  return (
    <section className="flex min-w-0 flex-1 flex-col">
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
        <div className="min-w-0">
          <h2 className="truncate font-semibold leading-tight text-ink">{title}</h2>
          <p className="text-xs text-muted">
            {isOnline ? t("En línea") : t("Mensaje directo")} · {t("tagea")}{" "}
            <span className="text-brand">@ghosty</span>
          </p>
        </div>
      </header>
      <div ref={scrollRef} onScroll={onScroll} className="mx-auto w-full max-w-4xl flex-1 space-y-1 overflow-y-auto px-4 py-4 no-scrollbar">
        {flow === null ? (
          <ThreadSkeleton />
        ) : flow.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Escribe el primer mensaje de {name}.", { name: title })}
          </p>
        ) : (
          flow.map((m) => (
            <Fragment key={m.id}>
              {m.id === unreadId && <NewDivider />}
              <MessageRow m={m} />
            </Fragment>
          ))
        )}
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <TypingLine typing={typing} />
      <Composer
        slug=""
        parentId={null}
        dmId={dmId}
        onSend={onSend}
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

function Avatar({ name, avatar, className }: { name?: string; avatar?: string; className?: string }) {
  if (avatar) return <img src={avatar} alt="" className={`shrink-0 rounded-full ${className}`} />;
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
    <span className="relative block overflow-hidden rounded-lg border border-border">
      {!loaded && (
        <span className="absolute inset-0 animate-pulse bg-surface-3" aria-hidden />
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`max-h-72 max-w-full object-cover transition-opacity duration-300 ${
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
              <ChatImage src={src} alt={a.name ?? ""} />
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
};

// Construye la vista del panel desde un artefacto del mensaje (mapeo ÚNICO: lo usa la
// card Y el link inline del reply). Kind desconocido → `file` (descarga segura).
function artifactToView(a: Artifact): ArtifactView {
  const title = a.title ?? "";
  if (a.kind === "doc") return { kind: "doc", title, documentId: a.url, md: a.md ?? "" };
  if (a.kind === "sheet") return { kind: "sheet", title, documentId: a.url, csv: a.md ?? "" };
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

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const t = useT();
  const { onOpenArtifact } = useContext(ChatCtx);
  const [downloading, setDownloading] = useState(false);
  const view = artifactToView(artifact);
  const isDoc = view.kind === "doc";
  const isOffice = view.kind === "office";
  const isSheet = view.kind === "sheet";
  // Subtítulo tipo "Documento · DOCX" / "Hoja de cálculo · CSV" (estilo claude.ai); el label
  // del registro para el resto.
  const subtitle = isSheet
    ? `${t("Hoja de cálculo")} · CSV`
    : isDoc || isOffice
      ? `${t("Documento")} · DOCX`
      : t(ARTIFACT_KIND_META[view.kind]?.labelKey ?? "Descargar");
  const downloadHref = isDoc
    ? `/api/doc-docx/${encodeURIComponent(view.documentId)}?name=${encodeURIComponent(artifact.title || "documento")}`
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
    a.download = `${(artifact.title || "hoja").replace(/[^\w.\- ]/g, "_")}.csv`;
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
          <img src={view.src} alt={artifact.title || ""} className="size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-3 text-brand">
            {view.kind === "sheet" ? (
              <Table2 size={20} />
            ) : view.kind === "pdf" ? (
              <FileType size={20} />
            ) : view.kind === "video" ? (
              <ImageIcon size={20} />
            ) : (
              <FileText size={20} />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{artifact.title || t(defaultArtifactTitle(view.kind))}</span>
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
              a.download = `${(artifact.title || "documento").replace(/[^\w.\- ]/g, "_")}.docx`;
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
  onOpenThread,
  showThreadLink,
  canPin,
}: {
  m: Message;
  onOpenThread?: (id: number) => void;
  showThreadLink?: boolean;
  canPin?: boolean;
}) {
  const t = useT();
  const { me, slug, pickerFor, onOpenArtifact } = useContext(ChatCtx);
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
  const displayName = isAgent && m.sender === "ghosty" ? "Ghosty" : m.sender;
  const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const canEdit = !!me && (me.isOwner || m.sender === me.name) && !isAgent && m.kind === "msg";
  const canDelete = !!me && (me.isOwner || m.sender === me.name) && m.kind === "msg";
  const canReact = m.kind === "msg" && !!slug;

  if (m.kind === "status") {
    return (
      <div className="flex items-center gap-2.5 py-1 pl-11 text-xs text-muted">
        <ThinkingRing size={20} />
        <span className="italic">{m.body || t("Pensando…")}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className="group relative flex gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
      {isGhostyAvatar ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white">
          <img src="/ghosty.svg" alt="Ghosty" className="h-full w-full object-contain" />
        </div>
      ) : isAgent && m.avatar ? (
        <img src={m.avatar} alt={m.sender} className="mt-0.5 h-9 w-9 shrink-0 rounded-lg object-cover" />
      ) : isAgent ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Bot size={20} />
        </div>
      ) : (
        <Avatar name={m.sender} avatar={m.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      )}
      {/* Acciones al hover: reaccionar · destacar · menú (copiar/fijar/editar/borrar) */}
      {m.kind === "msg" && !editing && (
        <div
          className={`absolute right-2 top-0 z-20 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-0.5 shadow-sm transition ${
            barVisible ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
          }`}
        >
          {canReact && <ReactButton m={m} />}
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
        {editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          m.body ? (
            <div className="text-sm text-ink">
              <Markdown
                body={bubbleWithoutEbDoc(m.body)}
                artifactUrl={m.artifact?.url}
                onOpenArtifact={m.artifact ? () => onOpenArtifact(artifactToView(m.artifact!)) : undefined}
              />
            </div>
          ) : null
        )}
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
            <ArtifactCard artifact={m.artifact} />
          </ArtifactBoundary>
        )}
        {canReact && (m.reactions?.length ?? 0) > 0 && <ReactionBar m={m} />}
        {showThreadLink && onOpenThread && (
          <div className="mt-1 flex items-center gap-3 text-xs">
            {m.reply_count ? (
              <button
                onClick={() => onOpenThread(m.id)}
                className="flex items-center gap-1.5 font-medium text-brand hover:underline"
              >
                <MessageSquare size={13} /> {m.reply_count === 1 ? t("1 respuesta") : t("{n} respuestas", { n: m.reply_count })}
              </button>
            ) : (
              <button
                onClick={() => onOpenThread(m.id)}
                className="text-muted opacity-100 transition hover:text-ink md:opacity-0 md:group-hover:opacity-100"
              >
                {t("Responder en hilo")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
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
                  remove(m);
                  close();
                }}
              >
                <Trash2 size={14} /> {t("Eliminar")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
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
  const { emojis } = useContext(ChatCtx);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  // Buscando → filtra el set curado (por keywords) + los custom (por nombre). Sin
  // texto → muestra los rápidos + todos los custom (comportamiento por defecto).
  const unicode = query ? EMOJI_SEARCH.filter((e) => e.k.includes(query)).map((e) => e.c) : QUICK_EMOJIS;
  const custom = query ? emojis.filter((e) => e.name.toLowerCase().includes(query)) : emojis;
  const empty = unicode.length === 0 && custom.length === 0;
  return (
    <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
      {/* Buscador estilo Slack (el cierre por click-afuera lo maneja ReactButton). */}
      <div className="border-b border-border p-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Buscar emoji…")}
          className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-muted focus:border-brand"
        />
        </div>
        <div className="grid max-h-52 grid-cols-6 gap-0.5 overflow-y-auto p-1.5">
          {empty ? (
            <p className="col-span-6 px-2 py-3 text-center text-xs text-muted">{t("Sin resultados")}</p>
          ) : (
            <>
              {unicode.map((e, i) => (
                <button
                  key={`${e}-${i}`}
                  onClick={() => onPick(e)}
                  className="rounded-md p-1 text-lg leading-none transition hover:scale-110 hover:bg-surface-2"
                >
                  {e}
                </button>
              ))}
              {custom.map((e) => (
                <button
                  key={e.name}
                  onClick={() => onPick(`:${e.name}:`)}
                  title={`:${e.name}:`}
                  className="grid place-items-center rounded-md p-1 transition hover:scale-110 hover:bg-surface-2"
                >
                  <img
                    src={`/api/attachment/${encodeURIComponent(e.file_id)}`}
                    alt={e.name}
                    className="h-5 w-5 object-contain"
                  />
                </button>
              ))}
            </>
          )}
        </div>
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
  const { retrySend, discardSend } = useContext(ChatCtx);
  const failed = o.status === "failed";
  // 100% optimista: mientras "sending" el mensaje se ve IDÉNTICO a uno entregado
  // (opacidad plena, hora en vivo, sin "enviando…"); el reconciliador lo canjea
  // por el real cuando aterriza por SSE. Solo si FALLA de verdad degrada a
  // "No se envió" + reintentar/descartar.
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex gap-3 rounded-lg px-2 py-1.5">
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
        <div className={`text-sm ${failed ? "text-ink/70" : "text-ink"}`}>
          <Markdown body={o.body} />
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
function Composer({
  slug,
  parentId,
  dmId = null,
  onSend,
  placeholder,
}: {
  slug: string;
  parentId: number | null;
  dmId?: number | null;
  onSend: (p: { body: string; attachments: Attach[] }) => void;
  placeholder: string;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Borrador por scope (Fase 4): persiste lo tecleado en localStorage para no
  // perderlo al cambiar de room/hilo/DM o recargar. Clave estable por conversación.
  const draftKey =
    dmId != null ? `draft:dm:${dmId}` : parentId != null ? `draft:thread:${parentId}` : `draft:room:${slug}`;
  const [body, setBody] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : ""
  );
  // Indicador visual de arrastre de archivo sobre el composer (dragCounter evita el
  // parpadeo por dragenter/leave de los hijos).
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // Recarga el borrador al cambiar de scope sin desmontar (p.ej. cambiar de room
  // en el Flow, que no se re-keya). Los paneles keyados (hilo/DM) ya remontan.
  useEffect(() => {
    setBody(typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : "");
  }, [draftKey]);
  const mentions = useMentions();
  const [mq, setMq] = useState<string | null>(null);
  const [mSel, setMSel] = useState(0);
  const lastTypingPing = useRef(0);
  const matches =
    mq === null ? [] : mentions.filter((a) => a.handle.startsWith(mq.toLowerCase()));

  // ── Adjuntos (Fase 4) ──────────────────────────────────────────────────────
  // Cada archivo se sube en cuanto se elige/suelta (POST /api/upload → EasyBits);
  // guardamos su fileId. Al enviar, los fileIds subidos viajan con el mensaje.
  type Pending = {
    localId: string;
    name: string;
    mime: string;
    size: number;
    fileId?: string;
    uploading: boolean;
    error?: boolean;
  };
  const [pending, setPending] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => p.uploading);

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const f of list) {
      const localId = `${Date.now()}-${f.name}-${Math.round(f.size)}`;
      setPending((p) => [
        ...p,
        { localId, name: f.name, mime: f.type || "application/octet-stream", size: f.size, uploading: true },
      ]);
      const fd = new FormData();
      fd.append("file", f);
      fetch("/api/upload", { method: "POST", body: fd })
        .then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.json() as Promise<{ fileId: string; mime: string; size: number; name: string }>;
        })
        .then((up) =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, fileId: up.fileId } : x)))
        )
        .catch(() =>
          setPending((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, error: true } : x)))
        );
    }
  };
  const removePending = (localId: string) =>
    setPending((p) => p.filter((x) => x.localId !== localId));

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setBody(val);
    // Persiste/limpia el borrador de este scope.
    if (typeof window !== "undefined") {
      if (val) localStorage.setItem(draftKey, val);
      else localStorage.removeItem(draftKey);
    }
    // Señal "escribiendo…" throttled a 1 cada 2s (efímera, sin DB). Room/hilo/DM.
    const now = Date.now();
    if (val && now - lastTypingPing.current > 2000) {
      lastTypingPing.current = now;
      pingTypingFn({ data: dmId != null ? { dmId } : { slug, parentId } }).catch(() => {});
    }
    const upto = val.slice(0, e.target.selectionStart ?? val.length);
    // Boundary: el popup de mención SOLO abre si el @ arranca en inicio o tras espacio
    // — no dentro de un email (fixtergeek@gmail…). Mismo criterio que el resaltado.
    const m = upto.match(/(?:^|\s)@(\w*)$/);
    if (m) {
      setMq(m[1]);
      setMSel(0);
    } else setMq(null);
  }
  function insertMention(id: string) {
    const el = bodyRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/(^|\s)@\w*$/, `$1@${id} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMq(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  }

  function submit() {
    // Adjuntos ya subidos (con fileId). Bloquea envío mientras alguno sube.
    const attachments = pending
      .filter((p) => p.fileId && !p.error)
      .map((p) => ({ fileId: p.fileId!, mime: p.mime, size: p.size, name: p.name }));
    if ((!body.trim() && attachments.length === 0) || uploading) return;
    const sent = body;
    setBody("");
    setPending([]);
    if (typeof window !== "undefined") localStorage.removeItem(draftKey); // borrador consumido
    playSelfSound(); // confirmación sonora del envío propio (distinta de las notifs)
    bodyRef.current?.focus(); // re-habilita al instante — no esperamos el round-trip
    // El ENVÍO lo hace el padre (outbox): crea el optimista, dispara la red en 2º
    // plano y, si falla permanentemente, marca la fila como "fallida" con retry.
    onSend({ body: sent, attachments });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mq !== null && matches.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setMSel((i) => (i + 1) % matches.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setMSel((i) => (i - 1 + matches.length) % matches.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), insertMention(matches[mSel].handle);
      if (e.key === "Escape") return e.preventDefault(), setMq(null);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      className={`relative border-t p-3 transition-colors ${dragOver ? "border-brand bg-brand/5" : "border-border"}`}
      // Respeta la home-bar/notch en móvil (viewport-fit=cover): el composer no
      // queda tapado por el inset inferior.
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.types?.includes("Files")) {
          dragCounter.current += 1;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-surface/80 text-sm font-medium text-brand backdrop-blur-sm">
          {t("Suelta para adjuntar")}
        </div>
      )}
      {/* Chips de adjuntos (subiendo / listos / error). */}
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <span
              key={p.localId}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
                p.error ? "border-red-500/40 text-red-500" : "border-border text-muted"
              }`}
            >
              {p.uploading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : p.error ? (
                <X size={13} />
              ) : (
                <Paperclip size={13} className="text-brand" />
              )}
              <span className="max-w-[10rem] truncate">{p.name}</span>
              <button
                type="button"
                onClick={() => removePending(p.localId)}
                className="text-muted hover:text-ink"
                aria-label={t("Quitar adjunto")}
              >
                <X size={13} />
              </button>
            </span>
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
      {/* Caja UNIFICADA (referencia Slack/Zulip/Rocket.Chat): un solo borde envuelve
          clip + textarea + Enviar → alineados por dentro, sin píldora suelta. Llena
          el ancho del panel pero los botones fijos a los bordes lo hacen cohesivo. */}
      <div className="relative mx-auto flex w-full max-w-4xl items-end gap-1 rounded-xl border border-border bg-surface px-1.5 py-1.5 transition focus-within:border-brand">
        {mq !== null && matches.length > 0 && (
          <ul className="absolute bottom-full left-10 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
            {matches.map((a, i) => (
              <li key={a.handle}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(a.handle);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                    i === mSel ? "bg-brand/15" : "hover:bg-surface-2"
                  }`}
                >
                  {a.kind === "group" ? (
                    <Megaphone size={18} className="text-brand" />
                  ) : a.kind === "agent" ? (
                    a.avatar ? (
                      <img src={a.avatar} alt="" className="h-5 w-5 rounded" />
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
          </ul>
        )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title={t("Adjuntar archivo")}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={bodyRef}
          value={body}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-5 text-ink outline-none placeholder:text-muted"
        />
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
    </form>
  );
}
