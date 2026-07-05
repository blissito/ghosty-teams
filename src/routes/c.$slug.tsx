import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  Download,
  Loader2,
  Archive,
} from "lucide-react";
import { searchMessagesFn } from "../server/search";
import { createFileRoute, notFound, Link, useRouter } from "@tanstack/react-router";
import type { Channel, Message, DmConversation, RoomHit, ViewHit, Attachment, CustomEmoji } from "../db.server";
import { listEmojisFn } from "../server/emojis";
import { recentViewFn, mentionsViewFn, starredViewFn } from "../server/views";
import { openDmFn, listDmsFn, getDmFlowFn, postDmMessageFn, askDmAgentFn } from "../server/dm";
import { unreadCountsFn, markReadFn, readReceiptsFn } from "../server/reads";
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
import { SmilePlus, Pencil, ArrowLeft } from "lucide-react";
import { getDeferredPrompt, onInstallable, clearDeferredPrompt, type BeforeInstallPromptEvent } from "../utils/pwa-install";
import { useLiveStream } from "../hooks/useLiveStream";
import type { RtEvent } from "../server/bus.server";
import { Markdown } from "../components/Markdown";
import { playNotificationSound, playGhostySound, playSelfSound } from "../utils/notificationSound";
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
    // Ruta rápida (cliente): el room ya está en el sidebar → resuelve sin red y
    // revalida en segundo plano. El meta del room vive en la misma lista.
    if (typeof window !== "undefined" && shellCache) {
      const channel = shellCache.channels.find((c) => c.slug === params.slug);
      if (channel) {
        const user = shellCache.user;
        getChannelView({ data: { slug: params.slug } })
          .then((v) => {
            if (v) shellCache = { channels: v.channels, user };
          })
          .catch(() => {});
        return { channels: shellCache.channels, channel, user };
      }
    }
    const [view, user] = await Promise.all([
      getChannelView({ data: { slug: params.slug } }),
      me(),
    ]);
    if (!view) throw notFound();
    if (typeof window !== "undefined") shellCache = { channels: view.channels, user };
    return { ...view, user };
  },
  component: ChannelPage,
});

type SessionUser = { sub: string; name: string; email: string; avatar: string; isOwner: boolean };
type Optimistic = { id: string; parentId: number | null; dmId: number | null; sender: string; avatar: string; body: string };

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
const threadCache = new Map<number, { root: Message | null; replies: Message[] }>();
// DMs: la lista de conversaciones (una key fija) y el flujo por conversación.
const dmListCache = new Map<string, DmConversation[]>();
const dmFlowCache = new Map<number, Message[]>();
// Mensajes fijados por room (barra en el header).
const pinsCache = new Map<string, Message[]>();
// VIEWS (recientes/menciones/destacados): resultado por nombre de vista.
const viewCache = new Map<string, ViewHit[]>();

// Nonces de mensajes que ESTA pestaña envió → para descartar su propio eco vivo
// (ya se muestra optimista). Módulo: compartido entre Composer y el handler SSE.
const sentNonces = new Set<string>();

// Contexto de chat (usuario + slug activo) para que MessageRow acceda sin prop-drilling.
const ChatCtx = createContext<{ me: SessionUser | null; slug: string; emojis: CustomEmoji[] }>({
  me: null,
  slug: "",
  emojis: [],
});

// Emojis rápidos para el picker (evita una lib de ~1MB).
const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🙌", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😮"];

// Título corto de un hilo = primera línea de su mensaje raíz (para los submenús).
function threadTitle(m: Message): string {
  const first = (m.body || "").split("\n")[0].trim();
  return first.length > 40 ? first.slice(0, 39) + "…" : first;
}

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
  patch = 0
): T | null {
  const [data, setData] = useState<T | null>(() => cache.get(key) ?? null);
  useEffect(() => {
    let alive = true;
    const cached = cache.get(key);
    setData(cached ?? null); // cacheado → sin skeleton; nuevo → skeleton
    fetcher().then((d) => {
      if (!alive) return;
      cache.set(key, d);
      setData(d);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rev]);
  // Live-patch: un evento realtime ya mutó el Map (con referencia nueva) → re-lee
  // el cache parcheado SIN red. Requiere updates inmutables (nueva ref) para re-render.
  useEffect(() => {
    if (patch === 0) return;
    const cached = cache.get(key);
    if (cached !== undefined) setData(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);
  return data;
}

function ChannelPage() {
  const { channels, channel, user } = Route.useLoaderData();
  // Hilo / DM abierto = ESTADO CLIENTE (no URL) → abre instantáneo, sin revalidar el
  // router. Igual que los hilos, un DM se enfoca en el CENTRO (referencia Zulip).
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [openDmId, setOpenDmId] = useState<number | null>(null);
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
  const [typing, setTyping] = useState<{ sub: string; name: string } | null>(null);
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

  // Flujo del room: cacheado → volver a un room es instantáneo (sin skeleton si ya se vio).
  const messages = useCachedQuery(
    flowCache,
    channel.slug,
    () => getChannelFlow({ data: { slug: channel.slug } }),
    rev,
    patch
  );
  // Hilos del room (nacen al responder a un mensaje) → se listan como submenús del
  // sidebar; al abrir uno se enfoca en el centro (no en un drawer derecho).
  const threads =
    useCachedQuery(
      threadsCache,
      channel.slug,
      () => getChannelThreads({ data: { slug: channel.slug } }),
      rev,
      patch
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
          // Ghosty/agentes (agent_handle) → sonido especial etéreo; humanos → knock.
          if (!mutes.has(muteKey)) (ev.msg.agent_handle ? playGhostySound : playNotificationSound)();
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
          revalidate();
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
          revalidate();
        }
        applyPatch();
        break;
      }
      case "message:deleted": {
        const slug = ev.channelId != null ? channelsById.get(ev.channelId) : undefined;
        if (slug) {
          const arr = flowCache.get(slug);
          if (arr) flowCache.set(slug, arr.filter((m) => m.id !== ev.id));
        }
        if (ev.parentId != null) {
          const t = threadCache.get(ev.parentId);
          if (t) threadCache.set(ev.parentId, { root: t.root, replies: t.replies.filter((m) => m.id !== ev.id) });
        }
        if (ev.dmId != null) {
          const arr = dmFlowCache.get(ev.dmId);
          if (arr) dmFlowCache.set(ev.dmId, arr.filter((m) => m.id !== ev.id));
        }
        applyPatch();
        break;
      }
      case "reaction":
        patchMessage(ev.messageId, (m) => applyReaction(m, ev, user?.sub));
        break;
      case "message:edited":
        patchMessage(ev.id, (m) => ({ ...m, body: ev.body, edited_at: ev.edited_at }));
        break;
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
        if (ev.channelId === channel.id && ev.sub !== user?.sub) {
          setTyping({ sub: ev.sub, name: ev.name });
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
  // Al cambiar de room, vuelve al flujo (cierra el hilo/DM/vista enfocado).
  useEffect(() => {
    setOpenThreadId(null);
    setOpenDmId(null);
    setView(null);
  }, [channel.slug]);
  // Enfocar un room (sin DM ni vista abiertos) → marca leído + baja su badge
  // (cross-device vía ch.user). También cubre "volver al room" al cerrar un DM/vista.
  useEffect(() => {
    if (openDmId != null || view != null) return;
    markReadFn({ data: { scope: "room", scopeId: channel.id } }).catch(() => {});
    clearUnread("room", channel.id);
  }, [channel.id, openDmId, view]);
  // Abrir un DM → marca leído + baja su badge.
  useEffect(() => {
    if (openDmId == null) return;
    markReadFn({ data: { scope: "dm", scopeId: openDmId } }).catch(() => {});
    clearUnread("dm", openDmId);
  }, [openDmId]);
  // Al reconciliar el flujo, limpia SOLO optimistic de flujo (parentId y dmId null);
  // los de hilo (parentId) y DM (dmId) se limpian cuando su propio contexto recarga.
  useEffect(() => {
    if (messages) setOptimistic((o) => o.filter((x) => x.parentId !== null || x.dmId !== null));
  }, [messages]);
  // Enfocar hilo, DM o vista en el centro son mutuamente excluyentes.
  const openThread = (id: number) => {
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
  const addOptimistic = (parentId: number | null, body: string) =>
    setOptimistic((o) => [
      ...o,
      {
        id: `${Date.now()}-${o.length}`,
        parentId,
        dmId: null,
        sender: user?.name ?? "tú",
        avatar: user?.avatar ?? "",
        body,
      },
    ]);
  const addDmOptimistic = (dmId: number, body: string) =>
    setOptimistic((o) => [
      ...o,
      {
        id: `${Date.now()}-${o.length}`,
        parentId: null,
        dmId,
        sender: user?.name ?? "tú",
        avatar: user?.avatar ?? "",
        body,
      },
    ]);
  const clearOptimistic = (parentId: number | null) =>
    setOptimistic((o) => o.filter((x) => x.parentId !== parentId || x.dmId !== null));
  const clearDmOptimistic = (dmId: number) =>
    setOptimistic((o) => o.filter((x) => x.dmId !== dmId));
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
    <ChatCtx.Provider value={{ me: user, slug: channel.slug, emojis }}>
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
      {/* Centro: vista Zulip, DM, hilo, o flujo del room (nunca drawer derecho). */}
      {view != null ? (
        <ViewPane
          key={`view-${view}`}
          view={view}
          rev={rev}
          patch={patch}
          onJumpToRoom={jumpToRoomMessage}
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
          onOptimistic={(body) => addDmOptimistic(openDmId, body)}
          onReloaded={() => clearDmOptimistic(openDmId)}
          onRevalidate={revalidate}
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
          onOptimistic={(body) => addOptimistic(openThreadId, body)}
          onReloaded={() => clearOptimistic(openThreadId)}
          onRevalidate={revalidate}
          onGoToOrigin={goToOrigin}
          onBack={() => setOpenThreadId(null)}
        />
      ) : (
        <Flow
          channel={channel}
          messages={messages}
          optimistic={optimistic.filter((o) => o.parentId === null && o.dmId === null)}
          onOptimistic={(body) => addOptimistic(null, body)}
          onOpenThread={openThread}
          onRevalidate={revalidate}
          typing={typing}
          onlineCount={online.size}
          pins={pins}
          onOpenDm={openDm}
          onOpenNav={() => setNavOpen(true)}
        />
      )}
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
          return (
          <div key={c.id}>
            <div className="group flex items-center">
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
            {/* Hilos del room activo como submenús; clic → enfoca el hilo en el centro. */}
            {c.slug === active && threads.length > 0 && (
              <ul className="mb-1 ml-3.5 mt-0.5 space-y-0.5 border-l border-border pl-2">
                {threads.map((thr) => {
                  const isGhosty = thr.agent_handle === "ghosty" || thr.sender === "ghosty";
                  const canDelete = user?.isOwner || thr.sender === user?.name;
                  return (
                    <li key={thr.id} className="group/thr flex items-center">
                      <button
                        onClick={() => onOpenThread(thr.id)}
                        title={thr.body}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs ${
                          activeThreadId === thr.id
                            ? "bg-brand/15 font-medium text-ink"
                            : "text-muted hover:bg-surface-3 hover:text-ink"
                        }`}
                      >
                        {isGhosty ? (
                          <img src="/ghosty.svg" alt="" className="h-3.5 w-3.5 shrink-0" />
                        ) : thr.agent_handle ? (
                          <Bot size={13} className="shrink-0 text-brand" />
                        ) : (
                          <MessageSquare size={12} className="shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{threadTitle(thr) || t("Hilo")}</span>
                        <span className="shrink-0 tabular-nums text-[10px] text-muted">{thr.reply_count ?? 0}</span>
                      </button>
                      {canDelete && (
                        <button
                          onClick={() => onDeleteThread(thr.id)}
                          title={t("Eliminar hilo")}
                          className="shrink-0 p-1 text-muted opacity-100 transition hover:text-brand md:opacity-0 md:group-hover/thr:opacity-100"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
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

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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
        className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-2xl border border-border bg-surface-2 p-5 text-ink"
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
    <Modal onClose={onClose}>
      <h2 className="mb-3 font-semibold">{t("Crear room")}</h2>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder={t("nombre del room")}
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <p className="mb-1 text-xs text-muted">{t("Icono")}</p>
      <div className="mb-3 flex flex-wrap gap-1">
        {ROOM_ICONS.map(({ name: n, Icon }) => (
          <button
            key={n}
            onClick={() => setIcon(n)}
            className={`grid h-9 w-9 place-items-center rounded-lg transition ${
              icon === n ? "bg-brand text-brand-fg" : "bg-surface text-muted hover:bg-surface-3 hover:text-ink"
            }`}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm">
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
  const [desc, setDesc] = useState(channel?.description ?? "");
  const [descSaved, setDescSaved] = useState(false);

  async function saveDesc() {
    await updateChannelFn({ data: { slug, description: desc.trim() || null } }).catch(() => {});
    setDescSaved(true);
    onChanged();
    setTimeout(() => setDescSaved(false), 1500);
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
    <Modal onClose={onClose}>
      <h2 className="mb-3 font-semibold">{t("Ajustes del room")}</h2>
      <p className="mb-1 text-xs font-medium text-muted">{t("Descripción")}</p>
      <div className="mb-4">
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={2}
          maxLength={280}
          placeholder={t("¿De qué trata este room?")}
          className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
        <div className="mt-1 flex items-center justify-end gap-2">
          {descSaved && <span className="text-xs text-brand">{t("Guardado")}</span>}
          <button
            onClick={saveDesc}
            disabled={desc.trim() === (channel?.description ?? "")}
            className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-ink transition hover:bg-surface-2 disabled:opacity-40"
          >
            {t("Guardar descripción")}
          </button>
        </div>
      </div>
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button onClick={del} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-400/10">
            <Trash2 size={15} /> {t("Eliminar")}
          </button>
          <button onClick={archive} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink">
            <Archive size={15} /> {t("Archivar")}
          </button>
        </div>
        <button onClick={onClose} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
  onOpenDm,
  onOpenNav,
}: {
  view: "recent" | "mentions" | "starred";
  rev: number;
  patch: number;
  onJumpToRoom: (slug: string, id: number) => void;
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
      // Si es una respuesta de hilo, salta al origen visible del hilo en el flujo.
      if (m.parent_id != null) onJumpToRoom(m.slug, m.parent_id);
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
      <div className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
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
function Flow({
  channel,
  messages,
  optimistic,
  onOptimistic,
  onOpenThread,
  onRevalidate,
  typing,
  onlineCount,
  pins,
  onOpenDm,
  onOpenNav,
}: {
  channel: Channel;
  messages: Message[] | null;
  optimistic: Optimistic[];
  onOptimistic: (body: string) => void;
  onOpenThread: (id: number) => void;
  onRevalidate: () => void;
  typing: { sub: string; name: string } | null;
  onlineCount: number;
  pins: Message[];
  onOpenDm: (id: number) => void;
  onOpenNav: () => void;
}) {
  const t = useT();
  const { me } = useContext(ChatCtx);
  const canManage = !!me && (me.isOwner || channel.created_by === me.sub);
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = messages?.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [count, optimistic.length]);
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
          <SearchButton onOpenDm={onOpenDm} />
        </div>
      </header>
      {pins.length > 0 && <PinnedBar pins={pins} onJump={jumpTo} />}
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
        {messages === null ? (
          <ThreadSkeleton />
        ) : messages.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Sé el primero en escribir en {room}.", { room: channel.name })}
          </p>
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} m={m} onOpenThread={onOpenThread} showThreadLink canPin={canManage} />
          ))
        )}
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <div className="h-5 px-6 text-xs italic text-muted">
        {typing ? t("{name} está escribiendo…", { name: typing.name }) : ""}
      </div>
      <Composer
        slug={channel.slug}
        parentId={null}
        onOptimistic={onOptimistic}
        onOpenThread={onOpenThread}
        onRevalidate={onRevalidate}
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
  onOptimistic,
  onReloaded,
  onRevalidate,
  onGoToOrigin,
  onBack,
}: {
  channel: Channel;
  threadId: number;
  rev: number;
  patch: number;
  optimistic: Optimistic[];
  onOptimistic: (body: string) => void;
  onReloaded: () => void;
  onRevalidate: () => void;
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
  const replyCount = data?.replies.length ?? 0;
  useEffect(() => {
    if (data) onReloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [replyCount, optimistic.length]);

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
      </header>
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
        {!data ? (
          <ThreadSkeleton />
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
            <div className="my-2 border-t border-border pt-1 text-center text-[11px] text-muted">
              {replyCount === 1 ? t("1 respuesta") : t("{n} respuestas", { n: replyCount })}
            </div>
            {data.replies.map((m) => (
              <MessageRow key={m.id} m={m} />
            ))}
            {optimistic.map((o) => (
              <OptimisticRow key={o.id} o={o} />
            ))}
          </>
        )}
      </div>
      <Composer
        slug={channel.slug}
        parentId={threadId}
        onOptimistic={onOptimistic}
        onRevalidate={onRevalidate}
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
  onOptimistic,
  onReloaded,
  onRevalidate,
  onBack,
}: {
  dm: DmConversation | null;
  dmId: number;
  rev: number;
  patch: number;
  online: Set<string>;
  optimistic: Optimistic[];
  onOptimistic: (body: string) => void;
  onReloaded: () => void;
  onRevalidate: () => void;
  onBack: () => void;
}) {
  const t = useT();
  // Cacheado por dmId → reabrir la misma conversación es instantáneo (sin skeleton).
  const flow = useCachedQuery(
    dmFlowCache,
    dmId,
    () => getDmFlowFn({ data: { id: dmId } }).then((r) => r?.flow ?? []),
    rev,
    patch
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = flow?.length ?? 0;
  useEffect(() => {
    if (flow) onReloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [count, optimistic.length]);

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
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
        {flow === null ? (
          <ThreadSkeleton />
        ) : flow.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            {t("Escribe el primer mensaje de {name}.", { name: title })}
          </p>
        ) : (
          flow.map((m) => <MessageRow key={m.id} m={m} />)
        )}
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <Composer
        slug=""
        parentId={null}
        dmId={dmId}
        onOptimistic={onOptimistic}
        onRevalidate={onRevalidate}
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
// Todo pasa por el proxy autenticado /api/attachment/:fileId (re-firma readUrl).
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const t = useT();
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        const src = `/api/attachment/${encodeURIComponent(a.file_id)}`;
        const isImage = (a.mime ?? "").startsWith("image/");
        if (isImage) {
          return (
            <a key={a.id} href={src} target="_blank" rel="noreferrer" className="block">
              <img
                src={src}
                alt={a.name ?? ""}
                loading="lazy"
                className="max-h-72 max-w-full rounded-lg border border-border object-cover"
              />
            </a>
          );
        }
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
  const { me, slug } = useContext(ChatCtx);
  const [editing, setEditing] = useState(false);
  const isAgent = m.agent_handle != null || m.sender === "ghosty";
  const isGhostyAvatar = m.agent_handle === "ghosty" || m.sender === "ghosty";
  const displayName = m.sender === "ghosty" ? "Ghosty" : m.sender;
  const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const canEdit = !!me && (me.isOwner || m.sender === me.name) && !isAgent && m.kind === "msg";
  const canDelete = !!me && (me.isOwner || m.sender === me.name) && m.kind === "msg";
  const canReact = m.kind === "msg" && !!slug;

  if (m.kind === "status") {
    return (
      <div className="flex items-center gap-2 py-1 pl-12 text-xs text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
        <span className="italic">{m.body}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className="group relative flex gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
      {isGhostyAvatar ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white">
          <img src="/ghosty.svg" alt="Ghosty" className="h-full w-full object-contain" />
        </div>
      ) : isAgent ? (
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand">
          <Bot size={20} />
        </div>
      ) : (
        <Avatar name={m.sender} avatar={m.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      )}
      {/* Acciones al hover: reaccionar · destacar · menú (copiar/fijar/editar/borrar) */}
      {m.kind === "msg" && !editing && (
        <div className="absolute right-2 top-0 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-0.5 opacity-100 shadow-sm transition md:opacity-0 md:group-hover:opacity-100">
          {canReact && <ReactButton m={m} slug={slug} />}
          <StarButton m={m} />
          <MessageActions
            m={m}
            slug={slug}
            canEdit={canEdit}
            canDelete={canDelete}
            canPin={!!canPin}
            onEdit={() => setEditing(true)}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${isAgent ? "text-brand" : "text-ink"}`}>
            {displayName}
          </span>
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
          <EditBox m={m} slug={slug} onDone={() => setEditing(false)} />
        ) : (
          m.body ? (
            <div className="text-sm text-ink">
              <Markdown body={m.body} />
            </div>
          ) : null
        )}
        {m.attachments && m.attachments.length > 0 && <AttachmentList attachments={m.attachments} />}
        {canReact && (m.reactions?.length ?? 0) > 0 && <ReactionBar m={m} slug={slug} />}
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

function ReactButton({ m, slug }: { m: Message; slug: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("Reaccionar")}
        className="rounded p-1 text-muted hover:text-ink"
      >
        <SmilePlus size={14} />
      </button>
      {open && (
        <EmojiPicker
          onPick={(e) => {
            setOpen(false);
            toggleReactionFn({ data: { slug, messageId: m.id, emoji: e } }).catch(() => {});
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// Destacar (star): marcador personal. Va por el evento `star` (ch.user) → el flag
// se sincroniza en todas mis pestañas, igual que las reacciones.
function StarButton({ m }: { m: Message }) {
  const t = useT();
  return (
    <button
      onClick={() => toggleStarFn({ data: { messageId: m.id } }).catch(() => {})}
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
}: {
  m: Message;
  slug: string;
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [receipts, setReceipts] = useState<{ sub: string; name: string; avatar: string }[] | null>(null);
  const close = () => {
    setOpen(false);
    setReceipts(null);
  };
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-surface-2";
  const showReceipts = () => {
    setReceipts([]);
    readReceiptsFn({ data: { messageId: m.id } })
      .then((rs) => setReceipts(rs))
      .catch(() => setReceipts([]));
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("Más acciones")}
        className="rounded p-1 text-muted hover:text-ink"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && receipts !== null && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
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
          <div className="fixed inset-0 z-10" onClick={close} />
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
                  togglePinFn({ data: { messageId: m.id } }).catch(() => {});
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
                  deleteMessageFn({ data: { id: m.id } }).catch(() => {});
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

function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const { emojis } = useContext(ChatCtx);
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 top-full z-20 mt-1 grid max-h-52 w-40 grid-cols-6 gap-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
        {QUICK_EMOJIS.map((e) => (
          <button key={e} onClick={() => onPick(e)} className="rounded p-1 text-base hover:bg-surface-2">
            {e}
          </button>
        ))}
        {emojis.map((e) => (
          <button
            key={e.name}
            onClick={() => onPick(`:${e.name}:`)}
            title={`:${e.name}:`}
            className="grid place-items-center rounded p-1 hover:bg-surface-2"
          >
            <img
              src={`/api/attachment/${encodeURIComponent(e.file_id)}`}
              alt={e.name}
              className="h-5 w-5 object-contain"
            />
          </button>
        ))}
      </div>
    </>
  );
}

function ReactionBar({ m, slug }: { m: Message; slug: string }) {
  const t = useT();
  const react = (e: string) =>
    toggleReactionFn({ data: { slug, messageId: m.id, emoji: e } }).catch(() => {});
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {(m.reactions ?? []).map((r) => (
        <button
          key={r.emoji}
          onClick={() => react(r.emoji)}
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

function EditBox({ m, slug, onDone }: { m: Message; slug: string; onDone: () => void }) {
  const t = useT();
  const [val, setVal] = useState(m.body);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!val.trim() || busy) return;
    setBusy(true);
    await editMessageFn({ data: { slug, id: m.id, body: val.trim() } }).catch(() => {});
    setBusy(false);
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
          disabled={busy}
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
  return (
    <div className="flex gap-3 rounded-lg px-2 py-1.5 opacity-50">
      <Avatar name={o.sender} avatar={o.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{o.sender}</span>
          <span className="text-[11px] text-muted">{t("enviando…")}</span>
        </div>
        <div className="text-sm text-ink">
          <Markdown body={o.body} />
        </div>
      </div>
    </div>
  );
}

/* ── Composer con typeahead de menciones + optimistic + @ghosty ── */
function Composer({
  slug,
  parentId,
  dmId = null,
  onOptimistic,
  onOpenThread,
  onRevalidate,
  placeholder,
}: {
  slug: string;
  parentId: number | null;
  dmId?: number | null;
  onOptimistic: (body: string) => void;
  onOpenThread?: (id: number) => void;
  onRevalidate?: () => void;
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
  // Recarga el borrador al cambiar de scope sin desmontar (p.ej. cambiar de room
  // en el Flow, que no se re-keya). Los paneles keyados (hilo/DM) ya remontan.
  useEffect(() => {
    setBody(typeof window !== "undefined" ? localStorage.getItem(draftKey) ?? "" : "");
  }, [draftKey]);
  const [sending, setSending] = useState(false);
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
    // Señal "escribiendo…" throttled a 1 cada 2s (efímera, sin DB). Solo en rooms.
    const now = Date.now();
    if (dmId == null && val && now - lastTypingPing.current > 2000) {
      lastTypingPing.current = now;
      pingTypingFn({ data: { slug } }).catch(() => {});
    }
    const upto = val.slice(0, e.target.selectionStart ?? val.length);
    const m = upto.match(/@(\w*)$/);
    if (m) {
      setMq(m[1]);
      setMSel(0);
    } else setMq(null);
  }
  function insertMention(id: string) {
    const el = bodyRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@\w*$/, `@${id} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMq(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  }

  async function submit() {
    // Adjuntos ya subidos (con fileId). Bloquea envío mientras alguno sube.
    const attachments = pending
      .filter((p) => p.fileId && !p.error)
      .map((p) => ({ fileId: p.fileId!, mime: p.mime, size: p.size, name: p.name }));
    if ((!body.trim() && attachments.length === 0) || sending || uploading) return;
    const sent = body;
    setBody("");
    setPending([]);
    if (typeof window !== "undefined") localStorage.removeItem(draftKey); // borrador consumido
    setSending(true);
    if (sent.trim()) onOptimistic(sent);
    playSelfSound(); // confirmación sonora del envío propio (distinta de las notifs)
    // nonce: para descartar el eco realtime de mi propio mensaje (ya optimista).
    const nonce = crypto.randomUUID();
    sentNonces.add(nonce);
    setTimeout(() => sentNonces.delete(nonce), 15_000); // limpia si nunca ecoa

    // ── DM: envío plano (sin hilos); @agente responde inline en el mismo DM ──
    if (dmId != null) {
      const r = await postDmMessageFn({ data: { id: dmId, body: sent, nonce, attachments } });
      onRevalidate?.();
      setSending(false);
      bodyRef.current?.focus();
      if (r?.needsAgent && r.agentHandle) {
        askDmAgentFn({ data: { id: dmId, body: sent, sender: "", handle: r.agentHandle } })
          .then(() => onRevalidate?.())
          .catch(() => onRevalidate?.());
      }
      return;
    }

    // ── Room / hilo ──
    const r = await postMessage({ data: { slug, parentId, body: sent, nonce, attachments } });
    onRevalidate?.();
    setSending(false);
    bodyRef.current?.focus();
    if (r?.needsAgent && r.agentParent != null && r.agentHandle) {
      // @agente en el flujo → abre el hilo donde responde (estado cliente).
      if (parentId === null) {
        onOpenThread?.(r.agentParent);
      }
      askAgent({ data: { slug, parentId: r.agentParent, body: sent, sender: "", handle: r.agentHandle } })
        .then(() => onRevalidate?.())
        .catch(() => onRevalidate?.());
    }
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
      className="border-t border-border p-3"
      // Respeta la home-bar/notch en móvil (viewport-fit=cover): el composer no
      // queda tapado por el inset inferior.
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
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
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title={t("Adjuntar archivo")}
          className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Paperclip size={18} />
        </button>
        <div className="relative flex-1">
          {mq !== null && matches.length > 0 && (
            <ul className="absolute bottom-full left-0 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
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
          <textarea
            ref={bodyRef}
            value={body}
            onChange={onChange}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={placeholder}
            className="min-h-[42px] w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </div>
        <button
          type="submit"
          disabled={sending || uploading}
          title={uploading ? t("Subiendo adjunto…") : undefined}
          className="min-h-[42px] shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {t("Enviar")}
        </button>
      </div>
    </form>
  );
}
