import { Component, createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileGlyph } from "../../components/FileGlyph";
import { motion} from "motion/react";
import { esChunkStale, puedeAutoRecargar } from "../../utils/reload-guard";
import {
  Hash,

  Plus,

  Trash2,
  MessageSquare,


  Wrench,






  CheckCircle2,



  Bot,


  Pin,
  PinOff,
  Star,
  MoreHorizontal,
  Link2,


  Search,
  Forward,
  ReplyAll,
  X,


  FileText,

  Download,
  Loader2,


  ChevronDown,

  Copy,
  Check,


  Table2,
  AppWindow,
  Image as ImageIcon,

  Phone,
  PhoneOff,
  Play,
  Pause,

  GitPullRequest,


} from "lucide-react";
import ConfirmModal from "../../components/ConfirmModal";
import type { Message, Attachment, Artifact, CustomEmoji } from "../../db.server";
import { forwardTargetsFn, forwardMessageFn } from "../../server/forward";
import { readReceiptsFn} from "../../server/reads";
import { SmilePlus, Pencil, ArrowLeft, Reply, Square, Ban, CircleHelp, ShieldAlert } from "lucide-react";
import { useRtSubscribe } from "../../utils/rt-bus";
import { Markdown } from "../../components/Markdown";
import { Avatar } from "../../components/Avatar";
import { unfurlLinkFn } from "../../server/unfurl";
import { registerModalEsc } from "../../utils/modal-esc";
import { useScrollLock } from "../../utils/scroll-lock";
import { type ArtifactView, viewFromAttachment } from "../../components/ArtifactPanel";
import { extractEbDoc, bubbleWithoutEbDoc, extractToolState, extractSteps, extractAlert, extractAsk, extractPermission, extractPr, extractTask, extractTests, type ToolState, type AlertCardData, type AskCardData, type PermissionCardData, type PrCardData, type TaskCardData, type TestsCardData } from "../../lib/ebdoc";
import { prCardStateFn, runCardActionFn, taskCardStateFn, runTaskCardActionFn } from "../../server/connectors";
import { answerAgentAskFn } from "../../server/agent-ask";
import { answerAcpPermissionFn } from "../../server/agent-permission";
import { ThinkingRing } from "../../components/ThinkingRing";
import { useT } from "../../i18n";

// ── El chat, en piezas COMPARTIDAS ──────────────────────────────────────────
//
// Todo esto vivía dentro de `routes/c.$slug.tsx`, que son ~10,700 líneas. Salió de ahí
// el 2026-08-11, cuando los rooms abiertos necesitaron pintar mensajes: la alternativa
// era escribir un SEGUNDO chat, y un segundo chat es un chat PEOR — sin el picker único
// de reacciones, sin los emojis del workspace, sin la pulsación larga en móvil, sin
// adjuntos. Se notó a los diez minutos de haberlo improvisado.
//
// ⚠️ Fue un movimiento PURO: no se cambió una línea de lógica. Si algo se comporta
// distinto que antes, es un bug de la extracción y no un rediseño.
//
// Lo que hizo posible moverlo es que estas piezas no reciben treinta props: leen
// `ChatCtx`. Quien las use provee ese contexto — el chat de Teams con todo, y un room
// abierto con no-ops donde no aplica (fijar, destacar, editar, perfiles…).

export type CallJoin = { scope: "room"; slug: string; scopeId: number; label: string } | { scope: "dm"; dmId: number; label: string };

export type SessionUser = { sub: string; name: string; email: string; avatar: string; isOwner: boolean; isStaff: boolean; handle: string };
// Presencia del workspace: sub → nombre + última señal REAL (no la última conexión).
// `lastActiveAt` envejece con la pestaña abierta y quieta; ver IDLE_MS en bus.server.

export type Attach = { fileId: string; mime: string; size: number; name: string; thumbFileId?: string | null; width?: number | null; height?: number | null };
// El optimista guarda su propio payload de envío → se puede reintentar tal cual.

export type Optimistic = {
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

export type ReplyTarget = { id: number; author: string; excerpt: string };

// Estados rápidos sugeridos (estilo Slack): emoji + texto, un clic los llena.

/**
 * El HOST del chat: lo que la superficie de turno le presta a estas piezas.
 *
 * ⚠️ Las capacidades son OPCIONALES a propósito, y ésa es toda la idea:
 * **método ausente = capacidad ausente = affordance escondido.** El chat de Teams las pasa
 * todas; un room abierto pasa sólo las que tienen sentido ahí y no tiene que "apagar" nada.
 *
 * Antes esto era al revés: los defaults rellenaban TODO con no-ops, así que "no puedo" y
 * "no hace nada" eran indistinguibles, y hubo que añadir una bandera `publicSurface` para
 * esconder los botones muertos. Una bandera así es un `if (esPublico)` disfrazado: crece
 * con cada superficie nueva y hay que acordarse de consultarla en cada sitio. Con métodos
 * opcionales, olvidarse tiene el efecto seguro — el botón no sale.
 *
 * Los DATOS siguen siendo obligatorios: sin `me`/`slug`/`emojis`/`users` no hay nada que
 * pintar, y un default silencioso ahí sí escondería un bug.
 */
export type ChatCtxValue = {
  me: SessionUser | null;
  slug: string;
  emojis: CustomEmoji[];
  users: Map<string, WsUser>; // directorio vivo sub→perfil (avatars/nombres/status)
  // Quote-reply: cita activa del composer (una global; solo un composer visible a la vez).
  replyTo: ReplyTarget | null;
  // Picker de reacciones GLOBAL (id del mensaje con el picker abierto, o null).
  // Uno solo a la vez (referencia Slack/Zulip): abrir otro cierra el anterior.
  pickerFor: number | null;
  // Turnos de agente en vuelo (id → estado). Sin el estado, un turno en cola se ve igual
  // que uno trabajando.
  turns: Map<number, { state: "running" | "queued"; position: number; startedAt: number }>;
  // La call en la que estoy ahora (`scope:scopeId`), para decir "En llamada" y no "Unirse".
  myCallKey: string | null;
  /**
   * Cuánto respira cada mensaje. No es una capacidad, es una VARIANTE de presentación:
   * la misma información con otra densidad.
   *
   * · `comfortable` (default) — estilo Slack: avatar, nombre arriba, cuerpo debajo. Bien
   *   para un equipo de ocho conversando.
   * · `compact` — estilo Twitch: una línea, sin avatar, nombre en color. Cabe ~4× más en
   *   pantalla, y es lo que hace legible un chat a cien mensajes por minuto. En un
   *   webinar el formato cómodo se vuelve un scroll infinito.
   */
  density?: "comfortable" | "compact";

  // ── Capacidades. Ausente = no se ofrece. ──────────────────────────────────
  react?: (m: Message, emoji: string) => void;
  star?: (m: Message) => void;
  pin?: (m: Message) => void;
  remove?: (m: Message) => Promise<void>;
  /**
   * Modero este espacio aunque el mensaje no sea mío ni yo sea dueño del workspace. Lo usa
   * el room abierto de un evento: quien presenta modera SU room y nada más.
   */
  canModerate?: boolean;
  /** Expulsar a quien escribió. Ausente = no se ofrece. */
  banUser?: (m: Message) => void;
  editMsg?: (m: Message, body: string) => void;
  retrySend?: (o: Optimistic) => void;
  discardSend?: (id: string) => void;
  setReplyTo?: (r: ReplyTarget | null) => void;
  setPickerFor?: (id: number | null) => void;
  stopTurn?: (messageId: number) => void;
  /** Abre un artefacto (pdf/imagen/doc) en el panel lateral. */
  onOpenArtifact?: (a: ArtifactView) => void;
  /** Reenviar a otro room/DM. Sin esto no hay botón de reenviar. */
  forward?: (m: Message) => void;
  /**
   * Envía `body` como respuesta del usuario en el MISMO hilo/DM que `ownerMsg`
   * (artefactos interactivos inline, ej. ask-user: un clic = enviar).
   */
  sendQuickReply?: (body: string, ownerMsg: Message) => void;
  /** Abre Ajustes como modal in-panel. */
  openPrefs?: (tab?: "general" | "agentes" | "emojis") => void;
  /** Abre el perfil (drawer) de una persona o agente. */
  openProfile?: (p: ProfileTarget) => void;
  /** Unirse a una call desde una tarjeta del timeline. */
  joinCall?: (join: CallJoin) => void;
};

/**
 * Sólo los DATOS, vacíos. No hay defaults de capacidades: eso es justamente lo que hacía
 * indistinguibles "no puedo" y "no hace nada".
 */
export const ChatCtxDefaults: ChatCtxValue = {
  me: null,
  slug: "",
  emojis: [],
  users: new Map(),
  replyTo: null,
  pickerFor: null,
  turns: new Map(),
  myCallKey: null,
};

export const ChatCtx = createContext<ChatCtxValue>(ChatCtxDefaults);

/**
 * Color estable de un nombre, al estilo Twitch: ayuda a seguir a UNA persona entre cien
 * mensajes sin llegar a leer el nombre completo.
 *
 * Se deriva del `sub` (o del nombre, si no hay) con un hash barato; el mismo remitente
 * cae siempre en el mismo tono. Se fija la saturación y la luminosidad para que ninguno
 * salga ilegible sobre el fondo — un hash suelto sobre el espacio RGB entero produce
 * grises y amarillos que no se leen.
 */
export function colorDeNombre(clave: string): string {
  let h = 0;
  for (let i = 0; i < clave.length; i++) h = (h * 31 + clave.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 62%)`;
}

// Identidad mostrada en el drawer de perfil (persona o agente).

export type ProfileTarget = { name: string; avatar?: string | null; handle?: string | null; isAgent: boolean; sub?: string | null };

// Emojis rápidos para el picker (evita una lib de ~1MB).

export const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🙌", "🔥", "👀", "✅", "💯", "🚀", "🤔", "😮"];

// Categorías del picker (estilo Slack) — set curado, sin lib de ~1MB. Cada tab
// tiene un glifo (para la barra de categorías) y su lista de emojis. El buscador
// sigue usando EMOJI_SEARCH (keywords); esto es solo el navegado por categoría.

export const EMOJI_CATEGORIES: { id: string; icon: string; label: string; emojis: string[] }[] = [
  { id: "people", icon: "🙂", label: "Personas", emojis: ["🙂","😊","😄","😁","😅","😂","🤣","😍","😘","😎","🤔","🤨","😐","🙄","😬","😴","😭","😢","😡","🤯","🥳","🤩","😱","🤗","😉","😜","🤪","🥺","😤","🫠","🤡","💀","👽","👻","🤖"] },
  { id: "gestures", icon: "👍", label: "Gestos", emojis: ["👍","👎","👏","🙌","👋","🤙","💪","🫡","🙏","🤝","🫶","👌","✌️","🤞","🫰","👊","🤛","🖐️","✋","🤚","🖖"] },
  { id: "hearts", icon: "❤️", label: "Corazones", emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝"] },
  { id: "symbols", icon: "✅", label: "Símbolos", emojis: ["✅","❌","⭐","🌟","💯","✨","💡","⚡","💥","🎯","🔥","👀","📌","⏰","✏️","🔒","💰","📈","🎨","🐛"] },
  { id: "celebrate", icon: "🎉", label: "Fiesta", emojis: ["🎉","🎊","🚀","🏆","🥇","👑","💎","🎁","🌈","☀️","🌙","❄️","🎂","🍕","☕","🍺","🌮","🍩","🥤"] },
];

// Recientes del picker: localStorage, tope 24, más nuevo primero. Módulo-cacheado
// para pintar al instante al reabrir.
let emojiRecents: string[] | null = null;

export function getEmojiRecents(): string[] {
  if (emojiRecents) return emojiRecents;
  try { emojiRecents = JSON.parse(localStorage.getItem("emoji:recents") || "[]"); } catch { emojiRecents = []; }
  return emojiRecents || [];
}

export function pushEmojiRecent(e: string) {
  const cur = getEmojiRecents().filter((x) => x !== e);
  emojiRecents = [e, ...cur].slice(0, 24);
  try { localStorage.setItem("emoji:recents", JSON.stringify(emojiRecents)); } catch { /* storage bloqueado */ }
}

// Set curado con keywords (ES+EN) para el buscador del picker — evita una lib de
// ~1MB. Al escribir filtra esto + los emojis custom; vacío muestra los rápidos.

export const EMOJI_SEARCH: { c: string; k: string }[] = [
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

// Título corto de un hilo = primera línea ÚTIL de su mensaje raíz (para los submenús).
//
// ⚠️ "Primera línea" a secas no sirve: un mensaje del agente suele empezar por la
// apertura de un fence y la lista acababa enseñando ```` ```gt-alert ```` como título —dos
// veces seguidas, indistinguibles entre sí—. Aquí se salta el andamiaje (fences y sus
// bloques enteros, encabezados vacíos, citas, viñetas) y se limpia el marcado en línea
// de la que sí tiene texto. Es sólo para la etiqueta: el `body` no se toca.

export type WsUser = {
  sub: string; name: string; avatar: string; handle: string; isOwner: boolean; isStaff: boolean;
  statusEmoji: string | null; statusText: string | null; title: string | null; pronouns: string | null; bio: string | null;
};

export function EmojiText({ code, className, noTitle }: { code: string; className?: string; noTitle?: boolean }) {
  const { emojis } = useContext(ChatCtx);
  const m = /^:([a-z0-9_]+):$/.exec(code);
  const custom = m ? emojis.find((e) => e.name === m[1]) : null;
  if (custom)
    return (
      <img
        src={`/api/attachment/${encodeURIComponent(custom.file_id)}`}
        alt={code}
        title={noTitle ? undefined : code}
        loading="lazy"
        decoding="async"
        className={className ?? "inline-block h-[1.15em] w-[1.15em] object-contain align-[-0.15em]"}
      />
    );
  return <span>{code}</span>;
}

export function Modal({
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
  // El scroll de atrás se congela: sin esto el gesto dentro del modal movía el chat.
  useScrollLock();
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
          flush ? "overflow-y-hidden" : "thin-scroll overflow-y-auto overscroll-contain p-5"
        }`}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body
  );
}

export type LinkData = { url: string; title?: string; description?: string; image?: string; site?: string; favicon?: string } | null;

export const unfurlCache = new Map<string, LinkData>();

export function LinkPreview({ url }: { url: string }) {
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
/**
 * Todas las URLs del cuerpo, deduplicadas POR DOMINIO y con tope.
 *
 * Por dominio y no por URL: cuando el agente cita cuatro páginas del mismo sitio,
 * cuatro chips iguales no informan más que uno.
 */

export function allUrls(body: string, max = 5): string[] {
  const found = body.match(/https?:\/\/[^\s<>()]+/g) ?? [];
  const porDominio = new Map<string, string>();
  for (const raw of found) {
    const u = raw.replace(/[.,;:!?)\]]+$/, "");
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!porDominio.has(host)) porDominio.set(host, u);
    } catch {
      /* URL basura → fuera */
    }
    if (porDominio.size >= max) break;
  }
  return [...porDominio.values()];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Fuentes citadas: fila de chips compactos (favicon + dominio + título corto).
 *
 * Cuando el agente responde citando varias páginas, el contenido es SU respuesta y
 * las fuentes son respaldo — cinco tarjetas grandes se comerían el mensaje. Es lo
 * que hacen Perplexity/ChatGPT, y distinto de "te comparto este link" (un link
 * solo), que sigue siendo tarjeta rica.
 */

export function SourceChip({ url }: { url: string }) {
  const [data, setData] = useState<LinkData>(unfurlCache.get(url) ?? null);
  const [sinIcono, setSinIcono] = useState(false);
  useEffect(() => {
    if (unfurlCache.has(url)) {
      setData(unfurlCache.get(url) ?? null);
      return;
    }
    let alive = true;
    unfurlLinkFn({ data: { url } })
      .then((d) => {
        unfurlCache.set(url, d);
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  const host = hostOf(url);
  // Aunque el unfurl falle (timeout, 403, no-HTML) el chip se pinta igual con su
  // dominio: una fuente que no se pudo leer no debe DESAPARECER de las fuentes.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={data?.title || url}
      className="flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs transition-colors hover:border-brand/50 hover:bg-surface-3"
    >
      {data?.favicon && !sinIcono ? (
        <img
          src={data.favicon}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setSinIcono(true)}
          className="h-3.5 w-3.5 shrink-0 rounded-sm"
        />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0 rounded-sm bg-brand/20" />
      )}
      <span className="truncate text-muted">{data?.title || host}</span>
    </a>
  );
}

export function SourceChips({ urls }: { urls: string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {urls.map((u, i) => (
        <motion.div
          key={u}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.04, 0.2), duration: 0.18 }}
        >
          <SourceChip url={u} />
        </motion.div>
      ))}
    </div>
  );
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Render de adjuntos (Fase 4): imágenes inline, resto como tarjeta con descarga.
// Imagen del chat con skeleton (shimmer) mientras carga + fade-in al listo → mata el
// pop-in feo. `decoding=async`+`loading=lazy` para no bloquear el hilo.

export function ChatImage({ src, alt, width, height }: { src: string; alt: string; width?: number | null; height?: number | null }) {
  const [loaded, setLoaded] = useState(false);
  // Con dims conocidas reservamos el alto EXACTO por aspect-ratio (patrón CLS de Slack/
  // Discord): el navegador pinta el box correcto ANTES de cargar el byte → 0 layout-shift,
  // el canal abre al fondo sin que las imágenes empujen. Sin dims (adjuntos viejos / sharp
  // ausente) caemos al placeholder min-h-40 y el ResizeObserver re-ancla al cargar.
  const hasDims = !!(width && height);
  return (
    <span
      className={`relative inline-block overflow-hidden rounded-lg border border-border ${
        // Sin dims (agente/generadas, GIF/SVG, adjuntos viejos, sharp ausente): slot FIJO
        // 240×240 → 0 layout-shift, la imagen entra con object-contain (letterbox si no calza)
        // pero el box NO crece al cargar → nada empuja. La solución de raíz es backfillear las
        // dims en el path del agente (TODO) para que caigan al camino con box exacto de abajo.
        // Con dims: los atributos width/height del <img> ya reservan el box exacto (natural).
        hasDims ? "" : "h-60 w-60 max-w-full"
      }`}
    >
      {!loaded && (
        <span className="absolute inset-0 z-10 animate-pulse bg-surface-3" aria-hidden />
      )}
      <img
        src={src}
        alt={alt}
        width={width ?? undefined}
        height={height ?? undefined}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`block object-contain transition-opacity duration-300 ${
          hasDims ? "h-auto max-h-80 w-auto max-w-full" : "h-full w-full"
        } ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </span>
  );
}

// Nota de voz: reproductor compacto con onda (waveform PTT). La onda son 64 amplitudes
// (0..100) que sintetizó el TTS (o el grabador); las pintamos como barras y las rellenamos
// según el progreso. El ogg se sirve por /api/attachment/:fileId (302 a URL firmada).

export function decodeWaveform(b64?: string | null): number[] {
  if (!b64) return [];
  try {
    const bin = atob(b64);
    const out: number[] = [];
    for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  } catch {
    return [];
  }
}

export function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VoiceNote({ src, waveform, durationMs }: { src: string; waveform?: string | null; durationMs?: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState((durationMs ?? 0) / 1000);
  const bars = useMemo(() => {
    const w = decodeWaveform(waveform);
    if (w.length) return w;
    // Sin onda → 40 barras pseudo-uniformes para no ver una caja vacía.
    return Array.from({ length: 40 }, (_, i) => 30 + 30 * Math.abs(Math.sin(i * 0.7)));
  }, [waveform]);
  const total = dur || (durationMs ?? 0) / 1000 || 0;
  const progress = total > 0 ? Math.min(1, cur / total) : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setPlaying(true); }
    else { el.pause(); setPlaying(false); }
  };
  const seek = (frac: number) => {
    const el = audioRef.current;
    if (!el || !total) return;
    el.currentTime = Math.max(0, Math.min(total, frac * total));
    setCur(el.currentTime);
  };

  return (
    <div className="flex max-w-xs items-center gap-2.5 rounded-2xl gt-card px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white transition hover:opacity-90"
        aria-label={playing ? "Pausar" : "Reproducir"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <div
        className="flex h-8 flex-1 items-center gap-[2px] cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        {bars.map((amp, i) => {
          const played = i / bars.length <= progress;
          const h = Math.max(3, (Math.min(100, amp) / 100) * 28);
          return (
            <span
              key={i}
              className={`w-[2px] shrink-0 rounded-full ${played ? "bg-brand" : "bg-border"}`}
              style={{ height: `${h}px` }}
            />
          );
        })}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted">{fmtDur(playing || cur ? cur : total)}</span>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setDur(d); }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onEnded={() => { setPlaying(false); setCur(0); }}
        className="hidden"
      />
    </div>
  );
}

// Todo pasa por el proxy autenticado /api/attachment/:fileId (re-firma readUrl).
/**
 * Portada del adjunto: la MINIATURA si existe, el glifo si no.
 *
 * Enseñar la primera página resuelve lo que ningún ícono resolvió — se probó con
 * glifo, con etiqueta de texto y con SVG, y siempre quedaba la duda de qué
 * documento era. Con la portada no hay nada que interpretar.
 */

export function FilePreview({ a }: { a: Attachment }) {
  const [rota, setRota] = useState(false);
  if (!a.thumb_file_id || rota) return <FileGlyph mime={a.mime} name={a.name} />;
  return (
    <img
      src={`/api/attachment/${encodeURIComponent(a.thumb_file_id)}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setRota(true)}
      // Proporción de hoja y altura FIJA: la burbuja no debe brincar cuando la
      // imagen aterriza. Si la miniatura no carga, cae al glifo.
      className="h-12 w-9 shrink-0 rounded border border-border bg-surface object-cover object-top"
    />
  );
}

/**
 * Tarjeta de un documento CON portada. Formato vertical, la página arriba y el
 * nombre en una franja abajo — como Drive o Slack.
 *
 * La primera versión metía la portada en el hueco del ícono (36×48px). Ahí la
 * miniatura no sirve para nada: a ese tamaño no se distingue de un glifo, que
 * era justo el problema que veníamos a resolver. Una portada tiene que leerse.
 *
 * Sin portada se conserva la fila compacta de siempre (`FileRow`): una tarjeta
 * grande con un ícono en el centro sería puro aire.
 */

export function FileCard({ a, onOpen, title }: { a: Attachment; onOpen: () => void; title: string }) {
  const [rota, setRota] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-44 overflow-hidden rounded-xl gt-card text-left transition hover:border-brand"
      title={title}
    >
      {/* Altura fija y `object-top`: se ve el encabezado del documento (que es lo
          que lo identifica) y la burbuja no brinca al aterrizar la imagen. */}
      <span className="block h-32 w-full overflow-hidden border-b border-border bg-surface">
        {rota ? (
          <span className="flex h-full items-center justify-center">
            <FileGlyph mime={a.mime} name={a.name} />
          </span>
        ) : (
          <img
            src={`/api/attachment/${encodeURIComponent(a.thumb_file_id!)}`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setRota(true)}
            className="h-full w-full object-cover object-top transition group-hover:scale-[1.02]"
          />
        )}
      </span>
      <span className="block px-2.5 py-2">
        <span className="block truncate text-sm text-ink">{a.name ?? "Archivo"}</span>
        <span className="block text-[11px] text-muted">{fmtBytes(a.size)}</span>
      </span>
    </button>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
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
              onClick={onOpenArtifact ? () => onOpenArtifact(view) : undefined}
              className="block cursor-pointer"
              title={t("Abrir en panel")}
            >
              <ChatImage src={inlineSrc} alt={a.name ?? ""} width={a.width} height={a.height} />
            </button>
          );
        }
        // PDF y Office (docx/xlsx/pptx) → card que abre el VISOR en el panel lateral
        // (preview mammoth / tabla xlsx), no descarga. La descarga vive en el header del panel.
        if (view?.kind === "pdf" || view?.kind === "office") {
          // Con portada → tarjeta grande (se ve el documento). Sin portada →
          // fila compacta con glifo, que es todo lo que hay que enseñar.
          if (a.thumb_file_id) {
            return (
              <FileCard
                key={a.id}
                a={a}
                onOpen={() => onOpenArtifact?.(view)}
                title={t("Abrir en panel")}
              />
            );
          }
          return (
            <button
              key={a.id}
              type="button"
              onClick={onOpenArtifact ? () => onOpenArtifact(view) : undefined}
              className="group flex max-w-xs items-center gap-2.5 rounded-lg gt-card px-3 py-2 text-left transition hover:border-brand"
              title={t("Abrir en panel")}
            >
              <FilePreview a={a} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{a.name ?? t("Archivo")}</span>
                <span className="block text-[11px] text-muted">{fmtBytes(a.size)}</span>
              </span>
            </button>
          );
        }
        // Audio (nota de voz) → burbuja con reproductor + onda (waveform PTT).
        if (view?.kind === "audio") {
          return <VoiceNote key={a.id} src={src} waveform={a.waveform} durationMs={a.duration_ms} />;
        }
        // Otros archivos (docx, zip, etc.) → descarga directa, sin visor.
        return (
          <a
            key={a.id}
            href={src}
            target="_blank"
            rel="noreferrer"
            download={a.name ?? undefined}
            className="group flex max-w-xs items-center gap-2.5 rounded-lg gt-card px-3 py-2 transition hover:border-brand"
          >
            <FileGlyph mime={a.mime} name={a.name} />
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

export function stripMdName(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [texto](url) → texto
    .replace(/`+/g, "") // `código`
    .replace(/\*+/g, "") // **negrita** *cursiva* (y marcadores sueltos/truncados)
    .replace(/~~/g, "") // ~~tachado~~
    .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2") // __negrita__ (respeta a_b)
    .trim();
}

export function defaultArtifactTitle(kind: string): string {
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

export const ARTIFACT_KIND_META: Record<string, { embed?: boolean; labelKey: string }> = {
  doc: { labelKey: "Documento" },
  sheet: { labelKey: "Hoja de cálculo" },
  html: { embed: true, labelKey: "Vista previa" },
  // Un artefacto HTML no se descarga: se ABRE y corre. Sin esta entrada caía al
  // default y la card decía "Descargar", que es lo único que no hace.
  artifact: { labelKey: "Artefacto interactivo" },
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

export function artifactToView(a: Artifact): ArtifactView {
  const title = a.title ?? "";
  // `messageId` no es decorativo en un doc: es el `key` del editor en el panel, y
  // tiene que coincidir con el que usa el borrador para que al cerrarse el fence el
  // editor NO se remonte. Sin él, el swap borrador→doc se vería como un parpadeo.
  // `versionId` (la FILA de gc_artifacts): el panel enseña la versión del MENSAJE que
  // abriste, no la última. La lectura en voz alta la sintetiza el servidor, así que sin
  // esto leería la viva mientras en pantalla hay otra.
  if (a.kind === "doc") return { kind: "doc", title, documentId: a.url, md: a.md ?? "", messageId: a.messageId, versionId: a.id };
  if (a.kind === "sheet") return { kind: "sheet", title, documentId: a.url, csv: a.md ?? "" };
  if (a.kind === "artifact") return { kind: "artifact", title, documentId: a.url, html: a.md ?? "", src: a.src ?? "", messageId: a.messageId, versionId: a.id };
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
export class ArtifactBoundary extends Component<
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
    // Un chunk que ya no existe (deploy nuevo) NO es un fallo de datos: el cache no tiene
    // la culpa y "Volver al room" no lo cura — al reabrir vuelve a pedir el mismo hash
    // muerto. Lo único que sirve es recargar, que trae el HTML nuevo. Normalmente lo
    // atrapa antes el listener de `vite:preloadError`; esto cubre el import perezoso que
    // revienta ya DENTRO del render (React.lazy), donde el evento no llega a tiempo.
    if (esChunkStale(err)) {
      if (puedeAutoRecargar()) window.location.reload();
      return;
    }
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

export function bindAuListener() {
  if (auListenerBound || typeof document === "undefined") return;
  auListenerBound = true;
  document.addEventListener("keydown", (e) => activeAsk?.handle(e));
}
// Estado persistido (sobrevive revalidate): respondida (opción elegida) / descartada.

export function readAuState(id: number): { answered?: string; dismissed?: boolean } {
  if (typeof localStorage === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(`askuser:${id}`) || "{}"); } catch { return {}; }
}

export function writeAuState(id: number, s: { answered?: string; dismissed?: boolean }) {
  try { localStorage.setItem(`askuser:${id}`, JSON.stringify(s)); } catch {}
}

// ── Tarjeta de alerta (Sentry) ────────────────────────────────────────────────
//
// El clic NO llama a ningún endpoint de acción: manda al canal el texto que el SERVIDOR
// puso en `action.send`, que lleva la @mención. O sea que el turno del agente nace de un
// mensaje de una persona, como cualquier otro — la alerta en sí nunca lo despierta.
//
// Se recuerda el clic (localStorage, por mensaje) porque un canal con alertas necesita
// mostrar qué ya se atendió; si no, dos personas piden el mismo fix.

export function readAlertState(id: number): { asked?: string } {
  try { return JSON.parse(localStorage.getItem(`alert:${id}`) || "{}"); } catch { return {}; }
}

export function writeAlertState(id: number, s: { asked?: string }) {
  try { localStorage.setItem(`alert:${id}`, JSON.stringify(s)); } catch {}
}

/**
 * El agente PREGUNTA y espera.
 *
 * Es la única tarjeta con un turno DETENIDO al otro lado: mientras nadie conteste, el agente
 * está parado y su caja no puede hibernar. Por eso el estado se persiste por mensaje —volver
 * al hilo tiene que mostrar lo que ya se respondió— y por eso los botones desaparecen después:
 * un "Sí" que se puede pulsar dos veces sugiere que la primera no contó.
 *
 * Sirve para los dos protocolos: el `TASK_STATE_INPUT_REQUIRED` de A2A y el
 * `session/request_permission` de ACP son el mismo gesto con distinto nombre.
 */
/**
 * Lo respondido se recuerda por MENSAJE y no por tarea: volver al hilo tiene que enseñar lo
 * que ya se contestó, aunque la tarea del agente haya terminado hace rato.
 */
const ASK_KEY = "gt-ask-answers";

function readAskState(msgId: number): string | null {
  try {
    return (JSON.parse(localStorage.getItem(ASK_KEY) || "{}") as Record<string, string>)[msgId] ?? null;
  } catch {
    return null;
  }
}

function writeAskState(msgId: number, label: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(ASK_KEY) || "{}") as Record<string, string>;
    all[msgId] = label;
    localStorage.setItem(ASK_KEY, JSON.stringify(all));
  } catch {
    /* sin storage, la tarjeta simplemente no recuerda */
  }
}

export function AskCard({ msgId, a }: { msgId: number; a: AskCardData }) {
  const t = useT();
  const [respondido, setRespondido] = useState<string | null>(() => readAskState(msgId));
  const [enviando, setEnviando] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Sin opciones declaradas, sí/no: es lo que un agente pregunta el 90% de las veces, y
  // obligarlo a declararlas sólo haría que muchas preguntas llegaran sin botones.
  const opciones = a.options.length
    ? a.options
    : [
        { id: "yes", label: t("Sí"), tone: "ok" },
        { id: "no", label: t("No"), tone: undefined },
      ];

  async function responder(id: string, label: string) {
    if (enviando || respondido) return;
    setEnviando(id);
    setErr(null);
    try {
      await answerAgentAskFn({ data: { handle: a.handle, groupId: a.groupId, taskId: a.taskId, answer: id } });
      setRespondido(label);
      writeAskState(msgId, label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("no se pudo responder"));
      setEnviando(null);
    }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5">
      <div className="flex gap-2.5 px-3 py-2.5">
        <div className="mt-0.5 shrink-0 text-amber-500" aria-hidden>
          <CircleHelp size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">{a.question}</p>
          {respondido ? (
            <p className="mt-1.5 text-xs text-muted">
              {t("Respondiste")} <span className="font-medium text-ink">{respondido}</span>
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {opciones.map((o: { id: string; label: string; tone?: string }) => (
                <button
                  key={o.id}
                  disabled={!!enviando}
                  onClick={() => responder(o.id, o.label)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    o.tone === "ok"
                      ? "border-emerald-600 text-emerald-600 hover:bg-emerald-600/10"
                      : o.tone === "danger"
                        ? "border-border text-red-500 hover:bg-red-500/10"
                        : "border-border text-ink hover:bg-surface-3"
                  }`}
                >
                  {enviando === o.id ? t("enviando…") : o.label}
                </button>
              ))}
            </div>
          )}
          {err && <p className="mt-1.5 text-xs text-red-500">{err}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * El agente está DETENIDO pidiendo autorización — `session/request_permission` de ACP.
 *
 * No es la tarjeta de pregunta con otro color. Una pregunta se puede ignorar y el hilo sigue;
 * aquí hay un turno parado que no avanza hasta que alguien actúe, y a los cinco minutos se
 * rechaza solo. Las dos cosas están dichas en la tarjeta a propósito: la regla del silencio
 * existía desde que se cableó y hasta ahora sólo la conocía el código.
 */
const PERM_KEY = "gt-perm-answers";

function readPermState(msgId: number): string | null {
  try {
    return (JSON.parse(localStorage.getItem(PERM_KEY) || "{}") as Record<string, string>)[msgId] ?? null;
  } catch {
    return null;
  }
}

function writePermState(msgId: number, label: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(PERM_KEY) || "{}") as Record<string, string>;
    all[msgId] = label;
    localStorage.setItem(PERM_KEY, JSON.stringify(all));
  } catch {
    /* sin storage, la tarjeta simplemente no recuerda */
  }
}

export function PermissionCard({ msgId, p }: { msgId: number; p: PermissionCardData }) {
  const t = useT();
  const [resuelto, setResuelto] = useState<string | null>(() => readPermState(msgId));
  const [vencida, setVencida] = useState(false);
  const [enviando, setEnviando] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function autorizar(id: string, label: string) {
    if (enviando || resuelto || vencida) return;
    setEnviando(id);
    setErr(null);
    try {
      const r = await answerAcpPermissionFn({ data: { askId: p.askId, optionId: id } });
      if (!r.ok) {
        // Alguien más contestó, o pasaron los cinco minutos. Es información, no una falla.
        setVencida(true);
        setEnviando(null);
        return;
      }
      setResuelto(label);
      writePermState(msgId, label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("no se pudo responder"));
      setEnviando(null);
    }
  }

  const decidido = resuelto || vencida;

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-violet-500/40 bg-violet-500/5">
      <div className="flex gap-2.5 px-3 py-2.5">
        <div className="mt-0.5 shrink-0 text-violet-500" aria-hidden>
          <ShieldAlert size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-violet-500">
            {t("Pide autorización")}
          </p>
          <p className="mt-0.5 text-sm text-ink">{p.title}</p>
          {resuelto ? (
            <p className="mt-1.5 text-xs text-muted">
              {t("Autorizado")} <span className="font-medium text-ink">{resuelto}</span>
            </p>
          ) : vencida ? (
            <p className="mt-1.5 text-xs text-muted">{t("Ya no esperaba respuesta")}</p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.options.map((o) => (
                  <button
                    key={o.id}
                    disabled={!!enviando}
                    onClick={() => autorizar(o.id, o.label)}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                      o.tone === "ok"
                        ? "border-emerald-600 text-emerald-600 hover:bg-emerald-600/10"
                        : o.tone === "danger"
                          ? "border-border text-red-500 hover:bg-red-500/10"
                          : "border-border text-ink hover:bg-surface-3"
                    }`}
                  >
                    {enviando === o.id ? t("enviando…") : o.label}
                  </button>
                ))}
              </div>
              {/* El turno está parado esperando esto, y el silencio tiene consecuencia. */}
              <p className="mt-1.5 text-xs text-muted">
                {t("El agente está detenido. Si nadie contesta, se rechaza.")}
              </p>
            </>
          )}
          {err && !decidido && <p className="mt-1.5 text-xs text-red-500">{err}</p>}
        </div>
      </div>
    </div>
  );
}

export function AlertCard({ msgId, a, onAct }: { msgId: number; a: AlertCardData; onAct: (send: string) => void }) {
  const t = useT();
  const [asked, setAsked] = useState<string | null>(readAlertState(msgId).asked ?? null);

  const grave = a.level === "fatal" || a.level === "error";
  const franja = a.level === "fatal" ? "bg-red-600" : a.level === "error" ? "bg-red-500" : a.level === "warning" ? "bg-amber-500" : "bg-brand";
  const nivel = a.level === "fatal" ? t("Fatal") : a.level === "warning" ? t("Aviso") : a.level === "info" ? t("Info") : t("Error");
  // `substatus` lo afirma Sentry (nuevo / escalando / en curso). Nada inferido aquí.
  const estado = a.substatus === "new" ? t("Nuevo") : a.substatus === "escalating" ? t("Escalando") : "";

  // Los conteos llevan separador de miles: "12483 eventos" se lee mal y es justo la
  // queja de formato que la propia gente de Sentry levantó sobre sus notificaciones.
  const n = (v: number) => v.toLocaleString();
  // Dos líneas por SIGNIFICADO, no por desbordamiento: dónde pasó y cuánto pesa. Una sola
  // línea larga acaba envolviéndose donde toque y deja huérfano un "· development" con el
  // separador al frente — el corte lo decide el ancho de la ventana, que no significa nada.
  const where = [a.project, a.file && a.fn ? `${a.file} → ${a.fn}` : a.file || a.fn].filter(Boolean);
  const scale = [
    a.count != null ? (a.count === 1 ? t("1 evento") : t("{n} eventos", { n: n(a.count) })) : "",
    a.users != null ? (a.users === 1 ? t("1 usuario") : t("{n} usuarios", { n: n(a.users) })) : "",
    a.env,
  ].filter(Boolean);

  const act = (send: string) => {
    setAsked(send);
    writeAlertState(msgId, { asked: send });
    onAct(send);
  };

  return (
    <div className="mt-0.5 flex max-w-xl overflow-hidden rounded-lg gt-card">
      <div className={`w-1 shrink-0 ${franja}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${grave ? "text-red-500" : "text-amber-500"} border border-current`}>
            {nivel}
          </span>
          {estado ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">{estado}</span>
          ) : null}
          {a.shortId ? <span className="font-mono text-[11px] text-muted">{a.shortId}</span> : null}
        </div>
        <p className="text-sm font-semibold leading-snug text-ink">{a.title}</p>
        {where.length ? (
          <p className="mt-1 truncate font-mono text-[11.5px] text-muted">{where.join("  ·  ")}</p>
        ) : null}
        {scale.length ? (
          <p className="truncate font-mono text-[11.5px] text-muted">{scale.join("  ·  ")}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {a.actions.map((x, i) => (
            <button
              key={i}
              type="button"
              disabled={!!asked}
              onClick={() => act(x.send)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                asked === x.send
                  ? "border-brand bg-brand/10 text-ink"
                  : asked
                    ? "border-border text-muted"
                    : i === 0
                      ? "border-brand text-brand hover:bg-brand/10"
                      : "border-border text-ink hover:bg-surface-3"
              }`}
            >
              {asked === x.send ? `✓ ${x.label}` : x.label}
            </button>
          ))}
          {a.url ? (
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-3"
            >
              {t("Ver en Sentry")}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Tarjeta de pull request: el pie accionable de una reseña.
 *
 * ⚠️ Sus botones NO mandan texto al chat como los de `AlertCard` — llaman a la API de
 * GitHub con las credenciales de QUIEN HACE CLIC (`runCardActionFn`). Aprobar por la vía
 * del chat costaría un turno entero del agente para una llamada HTTP, y metería al modelo
 * a decidir si de verdad aprueba.
 *
 * ⚠️ Nuestro agente abre los PRs **como el usuario** (token user-to-server), no con una
 * identidad de bot propia. O sea que quien pidió el cambio NO puede aprobar su propio PR
 * —GitHub lo prohíbe— y el botón sólo sirve para OTRA persona del canal. El error se
 * explica tal cual cuando pasa, en vez de dejar un fallo mudo.
 */
// Tarjeta de TAREA. Gemela de PrCard, y con las mismas dos reglas que costaron aprender:
// el estado se lee de Tasks al pintar (guardarlo en el mensaje lo dejaría diciendo "En curso"
// para siempre), y los botones llaman a la API con las credenciales de QUIEN HACE CLIC en vez
// de mandar texto al chat, que despertaría al agente por un clic.

export function TaskCard({ task, channelId, parentId }: { task: TaskCardData; channelId: number; parentId: number | null }) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [st, setSt] = useState<any>(null);
  const [comentando, setComentando] = useState(false);
  const [texto, setTexto] = useState("");
  // Confirmar la acción es parte del patrón: sin acuse, quien comenta no sabe si salió.
  const [notaT, setNotaT] = useState("");

  const refresca = useCallback(() => {
    taskCardStateFn({ data: { id: task.id, channelId } })
      .then(setSt)
      .catch(() => {});
  }, [task.id, channelId]);
  useEffect(() => { refresca(); }, [refresca]);
  // Se suscribe ELLA MISMA: revalidar la ruta no basta si el componente no se desmonta.
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresca();
    },
  });

  const act = async (action: string, extra?: { column?: string; body?: string }) => {
    if (busy) return;
    setBusy(action);
    setErr("");
    try {
      const r = await runTaskCardActionFn({
        data: { action, id: task.id, channelId, parentId: parentId ?? undefined, ...extra },
      });
      if (!r.ok) setErr(r.error);
      else refresca();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  // Lo que diga Tasks AHORA gana sobre lo que el modelo escribió en el fence: entre que se
  // generó el mensaje y se mira, alguien pudo mover la tarea.
  const column = st?.column || task.column;
  const done = st?.done ?? column.toLowerCase() === "done";
  const assignee = st?.assignee || task.assignee;
  const url = st?.url || task.url;
  const board = st?.board || task.board;

  const prio =
    task.priority === "urgent" ? "text-red-500"
    : task.priority === "high" ? "text-amber-500"
    : task.priority === "low" ? "text-muted"
    : "text-ink";

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] text-muted">{board}</span>
        <span className="font-mono text-[11px] font-bold text-ink">#{task.id}</span>
        {task.priority ? <span className={`ml-auto font-mono text-[11px] ${prio}`}>{task.priority}</span> : null}
      </div>
      <div className="p-3">
        {/* Cerrada = tachada, igual que en el tablero. Es lo único que queda del estado
            "Done" ahora que cerrar dejó de ser un botón: se ve, no se pregona. */}
        <p className={`text-sm font-semibold leading-snug ${done ? "text-muted line-through" : "text-ink"}`}>
          {task.title}
        </p>
        <p className="mt-1 truncate font-mono text-[11.5px] text-muted">
          {[column, assignee ? `@${assignee}` : "", task.due].filter(Boolean).join("  \u00b7  ")}
        </p>

        {/* Los botones siguen a Jira y a Linear, que lideran con COMENTAR y ASIGNAR: eso es
            lo que pasa muchas veces durante las semanas que una tarea vive. Cerrar pasa una
            vez y casi nunca desde el chat, así que va dentro del selector de estado y no
            como la llamada a la acción de una tarea recién creada. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => setComentando((v) => !v)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${comentando ? "border-brand bg-brand/10 text-brand" : "border-brand text-brand hover:bg-brand/10"}`}
          >
            {t("Comentar")}
          </button>
          {!st?.mine ? (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act("task_assign_me")}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-3 disabled:opacity-50"
            >
              {busy === "task_assign_me" ? "\u2026" : t("Asignarme")}
            </button>
          ) : null}
          {/* Las columnas REALES del tablero. Antes iba "Done" cableado por nombre, así que
              un tablero renombrado se quedaba sin poder cerrar. */}
          {(st?.columns ?? []).length > 1 ? (
            <select
              disabled={!!busy}
              value={column}
              onChange={(e) => act("task_move", { column: e.target.value })}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-ink transition hover:bg-surface-3 disabled:opacity-50"
              aria-label={t("Estado")}
            >
              {(st.columns as string[]).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-3"
            >
              {t("Abrir en Tasks")}
            </a>
          ) : null}
          {/* Ni Jira ni Linear enseñan los comentarios DENTRO de la tarjeta —sería un hilo
              dentro de otro hilo—: muestran cuántos hay y llevan al sitio donde se leen. */}
          {st?.comments ? (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">
              <MessageSquare size={12} />
              {st.comments}
            </span>
          ) : null}
          {/* El PR con su REFERENCIA y pulsable, no un contador: "⑂ 1" dice que hay algo
              pero no qué ni lleva a ningún lado. Colores de GitHub — rojo es "cerrado sin
              mergear", no "error". */}
          {(st?.links ?? []).map((l: any) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.url}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-medium transition hover:bg-surface-3 ${
                l.state === "merged"
                  ? "border-violet-500/50 text-violet-500"
                  : l.state === "closed"
                    ? "border-red-500/50 text-red-500"
                    : l.state === "open"
                      ? "border-emerald-600/50 text-emerald-600"
                      : "border-border text-muted"
              }`}
            >
              <GitPullRequest size={12} />
              {l.ref ?? l.url.replace(/^https?:\/\//, "").slice(0, 28)}
            </a>
          ))}
        </div>
        {comentando ? (
          <div className="mt-2 flex items-start gap-1.5">
            <textarea
              autoFocus
              rows={2}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                // Enter envía; Shift+Enter salta de línea. Es lo que ya hace el composer del
                // chat, y lo que la gente intenta sin pensarlo.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const b = texto.trim();
                  if (b) act("task_comment", { body: b }).then(() => (setTexto(""), setComentando(false), setNotaT(t("Comentario añadido."))));
                }
              }}
              placeholder={t("Comentario para la tarea…")}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
            />
            <button
              type="button"
              disabled={!!busy || !texto.trim()}
              onClick={() => act("task_comment", { body: texto.trim() }).then(() => (setTexto(""), setComentando(false), setNotaT(t("Comentario añadido."))))}
              className="rounded-md border border-brand px-2.5 py-1.5 text-xs font-medium text-brand transition hover:bg-brand/10 disabled:opacity-40"
            >
              {busy === "task_comment" ? "\u2026" : t("Enviar")}
            </button>
          </div>
        ) : null}
        {notaT ? <p className="mt-2 text-[11.5px] text-muted">{notaT}</p> : null}
        {err ? <p className="mt-2 text-[11.5px] leading-snug text-red-500">{err}</p> : null}
      </div>
    </div>
  );
}

/**
 * Resultado de una corrida de tests (```gt-tests```). La única del molde SIN botones:
 * un resultado no se acciona, se lee — el diagnóstico del agente va en la prosa de
 * arriba y aquí quedan los números verificables (comando, conteos, fallos).
 */

export function TestsCard({ data }: { data: TestsCardData }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const failed = data.failed ?? 0;
  const ok = failed === 0;
  const counts = [
    data.passed != null ? `${data.passed} ${t("pasaron")}` : "",
    failed ? `${failed} ${t("fallaron")}` : "",
    data.skipped ? `${data.skipped} ${t("saltados")}` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className={`text-[13px] font-bold ${ok ? "text-emerald-600" : "text-red-500"}`}>{ok ? "✓" : "✗"}</span>
        {/* El sha liga al commit EXACTO que se probó — es el dato verificable de la corrida. */}
        {data.sha ? (
          <a
            href={`https://github.com/${data.repo}/commit/${data.sha}`}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-[11px] text-muted hover:text-brand hover:underline"
          >
            {data.repo}
            {data.ref ? `@${data.ref}` : ""}
          </a>
        ) : (
          <span className="truncate font-mono text-[11px] text-muted">
            {data.repo}
            {data.ref ? `@${data.ref}` : ""}
          </span>
        )}
        {data.duration != null ? <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{data.duration}s</span> : null}
      </div>
      <div className="p-3">
        <p className={`text-sm font-semibold leading-snug ${ok ? "text-ink" : "text-red-500"}`}>
          {counts || (ok ? t("Suite en verde") : t("Suite en rojo"))}
        </p>
        {data.command ? <p className="mt-1 truncate font-mono text-[11.5px] text-muted">$ {data.command}</p> : null}
        {data.failures.length ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs font-medium text-brand hover:underline"
            >
              {open ? t("Ocultar fallos") : `${t("Ver fallos")} (${data.failures.length})`}
            </button>
            {open ? (
              <ul className="mt-1.5 space-y-1.5">
                {data.failures.map((f, i) => (
                  <li key={i} className="rounded-md border border-border bg-surface px-2 py-1.5">
                    <p className="break-words font-mono text-[11.5px] font-semibold text-ink">{f.test}</p>
                    {/* Anclado al código, como las anotaciones de Actions: el fallo se abre
                        JUNTO a la línea que lo provoca, no en un log aparte. */}
                    {f.path ? (
                      <a
                        href={`https://github.com/${data.repo}/blob/${data.sha || data.ref || "main"}/${f.path}${f.line ? `#L${f.line}` : ""}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 block truncate font-mono text-[11px] text-brand hover:underline"
                      >
                        {f.path}
                        {f.line ? `:${f.line}` : ""}
                      </a>
                    ) : null}
                    {f.message ? (
                      <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{f.message}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PrCard({ pr, channelId, parentId, prosa }: { pr: PrCardData; channelId: number; parentId: number | null; prosa: string }) {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [nota, setNota] = useState("");
  const [st, setSt] = useState<any>(null);

  // El estado se pide a GITHUB, no se guarda aquí. Así lo ve todo el equipo —no sólo quien
  // hizo clic— y es correcto aunque alguien apruebe desde github.com sin tocar la tarjeta.
  const refresca = useCallback(() => {
    prCardStateFn({ data: { repo: pr.repo, number: pr.number } })
      .then(setSt)
      .catch(() => {});
  }, [pr.repo, pr.number]);
  useEffect(() => { refresca(); }, [refresca]);
  useRtSubscribe({
    onEvent: (ev) => {
      if (ev.t === "refresh" && ev.channelId === channelId) refresca();
    },
  });

  const act = async (action: string) => {
    if (busy) return;
    setBusy(action);
    setErr("");
    try {
      const r = await runCardActionFn({
        data: {
          action,
          repo: pr.repo,
          number: pr.number,
          body: pr.verdict,
          comments: pr.comments,
          channelId,
          parentId: parentId ?? undefined,
        },
      });
      if (!r.ok) setErr(r.error);
      // Si GitHub rechazó los anclajes, el análisis SÍ se publicó pero como texto plano.
      // Callarlo dejaría creer que los comentarios quedaron junto al código.
      else if ("degradado" in r && r.degradado)
        setErr(t("Se publicó, pero GitHub no aceptó las líneas: los comentarios quedaron en un solo bloque."));
      // Mergear cierra la tarea que colgaba del PR. Se DICE: mover algo del tablero sin
      // avisar es la clase de magia que hace desconfiar de la herramienta.
      else if ("tarea" in r && r.tarea) {
        setNota(t("Se mergeó y la tarea {ref} pasó a Done.", { ref: String(r.tarea) }));
        refresca();
      }
      // ⚠️ NO se manda un mensaje al chat para anunciarlo. La primera versión lo hacía y
      // DESPERTABA AL AGENTE: un turno entero por un clic, justo lo que la acción directa
      // venía a evitar. El estado se relee de GitHub, que es donde vive la verdad.
      else refresca();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  // ¿La prosa del mensaje ya contiene el veredicto? Se compara un prefijo normalizado:
  // el modelo lo reformula un poco, así que una igualdad exacta no serviría.
  const yaDicho = (() => {
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9áéíóúñ ]+/gi, " ").replace(/\s+/g, " ").trim();
    const v = norm(pr.verdict);
    return v.length > 25 && norm(prosa).includes(v.slice(0, 40));
  })();

  const checks =
    pr.checks === "success"
      ? { txt: t("CI en verde"), cls: "text-emerald-500" }
      : pr.checks === "failure"
        ? { txt: t("CI en rojo"), cls: "text-red-500" }
        : pr.checks === "pending"
          ? { txt: t("CI corriendo"), cls: "text-amber-500" }
          : null;

  // Un cierre NO es un éxito y no puede pintarse del mismo verde que una aprobación: fue
  // justo lo que se vio mal en la primera prueba ("✓ Rechazado" en verde).
  const resumen = (() => {
    if (!st || st.connected === false || st.unknown) return null;
    if (st.state === "merged") return { txt: t("Mergeado"), cls: "border-violet-500 bg-violet-500/10 text-violet-500" };
    if (st.state === "closed") return { txt: t("Cerrado sin mergear"), cls: "border-border bg-surface-3 text-muted" };
    if (st.blockers?.length)
      return { txt: t("Cambios pedidos por {quien}", { quien: st.blockers.join(", ") }), cls: "border-amber-500 bg-amber-500/10 text-amber-600" };
    if (st.approvers?.length)
      return { txt: t("Aprobado por {quien}", { quien: st.approvers.join(", ") }), cls: "border-emerald-600 bg-emerald-600/10 text-emerald-600" };
    return null;
  })();

  const botones = st?.soyElAutor
    ? [
        // GitHub sólo permite un review de tipo COMMENT sobre lo tuyo. Sin esto la tarjeta
        // era un callejón sin salida en el caso más común del equipo.
        { action: "pr_comment", label: t("Comentar"), tono: "border-brand text-brand hover:bg-brand/10" },
        { action: "pr_reject", label: t("Rechazar"), tono: "border-border text-red-500 hover:bg-red-500/10" },
      ]
    : [
        { action: "pr_approve", label: t("Aprobar"), tono: "border-emerald-600 text-emerald-600 hover:bg-emerald-600/10" },
        { action: "pr_request_changes", label: t("Pedir cambios"), tono: "border-border text-ink hover:bg-surface-3" },
        { action: "pr_reject", label: t("Rechazar"), tono: "border-border text-red-500 hover:bg-red-500/10" },
      ];
  // Mientras GitHub no conteste no se pintan botones: ofrecer "Aprobar" en un PR ya
  // cerrado sólo sirve para que el clic falle.
  const puedeActuar = st?.connected && st?.actionable;

  return (
    <div className="mt-1.5 max-w-xl overflow-hidden rounded-lg gt-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] text-muted">{pr.repo}</span>
        <span className="font-mono text-[11px] font-bold text-ink">#{pr.number}</span>
        {pr.additions != null || pr.deletions != null ? (
          <span className="ml-auto font-mono text-[11px]">
            {pr.additions != null ? <span className="text-emerald-500">+{pr.additions}</span> : null}{" "}
            {pr.deletions != null ? <span className="text-red-500">−{pr.deletions}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="p-3">
        {pr.title ? <p className="text-sm font-semibold leading-snug text-ink">{pr.title}</p> : null}
        <p className="mt-1 truncate font-mono text-[11.5px] text-muted">
          {[
            pr.author ? `@${pr.author}` : "",
            pr.files != null ? (pr.files === 1 ? t("1 archivo") : t("{n} archivos", { n: String(pr.files) })) : "",
          ]
            .filter(Boolean)
            .join("  ·  ")}
          {checks ? <span className={checks.cls}>{"  ·  " + checks.txt}</span> : null}
        </p>
        {/* El veredicto sólo se pinta si la prosa de arriba NO lo dijo ya. El agente suele
            repetirlo casi literal, y leerlo dos veces seguidas hace que la tarjeta parezca
            un eco en vez de un pie accionable. Se compara por el arranque, normalizado. */}
        {pr.verdict && !yaDicho ? <p className="mt-2 text-[13px] leading-snug text-ink">{pr.verdict}</p> : null}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {resumen ? (
            <span className={`rounded-md border px-2.5 py-1 text-xs font-medium ${resumen.cls}`}>{resumen.txt}</span>
          ) : null}
          {/* Mergear sólo cuando YA está aprobado y CI no está en rojo. Sin esa compuerta
              es un pie de bala: un botón de merge junto a un check en rojo se pulsa solo. */}
          {puedeActuar && st?.approvers?.length && pr.checks !== "failure" ? (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act("pr_merge")}
              className="rounded-md border border-violet-500 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-500 transition hover:bg-violet-500/20 disabled:opacity-50"
            >
              {busy === "pr_merge" ? "…" : t("Mergear")}
            </button>
          ) : null}
          {puedeActuar && !resumen
            ? botones.map((b) => (
                <button
                  key={b.action}
                  type="button"
                  disabled={!!busy}
                  onClick={() => act(b.action)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${b.tono}`}
                >
                  {busy === b.action ? "…" : b.label}
                </button>
              ))
            : null}
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-3"
          >
            {t("Ver en GitHub")}
          </a>
          {/* El staging de ESTE PR, si el agente levantó uno. La liga va completa (lleva
              su llave de acceso): recortarla la dejaría inservible. */}
          {pr.preview ? (
            <a
              href={pr.preview}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand/10"
            >
              {t("Ver la preview")}
            </a>
          ) : null}
        </div>
        {st?.connected === false ? (
          <p className="mt-2 text-[11.5px] text-muted">{t("Conecta tu GitHub en Ajustes para poder aprobar desde aquí.")}</p>
        ) : null}
        {puedeActuar && !resumen && st?.soyElAutor ? (
          <p className="mt-2 text-[11.5px] text-muted">
            {t("Este PR es tuyo: GitHub no deja aprobar ni pedir cambios en el propio. Que lo revise alguien más del equipo.")}
          </p>
        ) : null}
        {pr.comments.length ? (
          <p className="mt-2 text-[11.5px] text-muted">
            {pr.comments.length === 1
              ? t("Lleva 1 comentario anclado a su línea.")
              : t("Lleva {n} comentarios anclados a su línea.", { n: String(pr.comments.length) })}
          </p>
        ) : null}
        {nota ? <p className="mt-2 text-[11.5px] leading-snug text-violet-500">{nota}</p> : null}
        {err ? <p className="mt-2 text-[11.5px] leading-snug text-red-500">{err}</p> : null}
      </div>
    </div>
  );
}

export function AskUserCard({
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
    <div ref={containerRef} className="mt-1.5 max-w-md rounded-xl gt-card p-3">
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

export function ArtifactCard({ artifact, ownerMsg }: { artifact: Artifact; ownerMsg: Message }) {
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
        onPick={(opt) => sendQuickReply?.(opt, ownerMsg)}
      />
    );
  }
  const isDoc = view.kind === "doc";
  const isOffice = view.kind === "office";
  const isSheet = view.kind === "sheet";
  const isPdf = view.kind === "pdf";
  // ¿El agente TODAVÍA lo está escribiendo? La tarjeta aparece al ABRIRSE el documento, no
  // al cerrarse, así que con un escrito largo se quedaba minutos ofreciendo "Descargar" algo
  // a medias — y un botón así se lee como *entregado*. La señal es el fence del mensaje que
  // la produjo: mientras siga abierto, sigue escribiendo. Al terminar, el body persistido ya
  // no trae fence (`bubbleWithoutEbDoc` los corta) → vuelve a ser una tarjeta normal.
  // ⚠️ DOS condiciones, y hacen falta las dos. El fence abierto dice "va a medias", pero un
  // turno cortado deja el fence abierto PARA SIEMPRE y la tarjeta se quedaba diciendo
  // "escribiendo…" sobre algo que ya nadie escribe. La segunda condición es la que manda:
  // sólo puede estar escribiéndose si hay un turno VIVO para ese mensaje.
  const { turns: turnosVivos } = useContext(ChatCtx);
  const escribiendo = (() => {
    if (!turnosVivos.has(ownerMsg.id)) return false;
    const d = extractEbDoc(ownerMsg.body ?? "");
    return !!d && !d.closed;
  })();
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
    ? `${t("Hoja de cálculo")} · XLSX`
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
  // Sheet: descarga XLSX (mismo formato que el panel — /api/doc-xlsx convierte el CSV
  // fuente con SheetJS). Antes bajaba .csv acá y .xlsx en el panel → card decía "CSV"
  // pero salía XLSX (mislabel). Fetch same-origin → blob → download con nombre .xlsx.
  const downloadSheet = async () => {
    if (!isSheet) return;
    const href = `/api/doc-xlsx/${encodeURIComponent(view.documentId)}?name=${encodeURIComponent(rawTitle || "hoja")}`;
    const r = await fetch(href);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(rawTitle || "hoja").replace(/[^\w.\- ]/g, "_")}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  return (
    <div className="group mt-1.5 flex max-w-md items-center gap-3 rounded-xl gt-card p-2 pr-2.5 transition hover:border-brand/50">
      <button
        type="button"
        onClick={onOpenArtifact ? () => onOpenArtifact(view) : undefined}
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
            ) : view.kind === "artifact" || view.kind === "html" ? (
              // Ventana, no hoja: lo que hay detrás es algo que CORRE, no un archivo.
              <AppWindow size={20} />
            ) : (
              <FileText size={20} />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1">
          {/* DOS líneas, no `truncate`: lo que distingue un documento de otro suele estar al
              FINAL del nombre («… — Predio NAYARIT»), así que cortar a una línea dejaba dos
              dictámenes distintos viéndose idénticos y daba miedo pensar que era el mismo
              archivo reescrito (2026-08-03). El `title` deja el nombre completo al pasar. */}
          <span
            className="block text-sm font-medium text-ink [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
            title={displayTitle}
          >
            {displayTitle}
          </span>
          <span className="block text-[11px] text-muted">{subtitle}</span>
        </span>
      </button>
      {escribiendo ? (
        <span className="flex shrink-0 items-center gap-1.5 px-2 text-xs italic text-muted">
          <Loader2 size={12} className="animate-spin" />
          {t("escribiendo…")}
        </span>
      ) : isSheet ? (
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

// ── Tarjeta de quick-call en el timeline (estilo Slack) ──────────────────────
// Nace del mensaje kind:"status" cuyo body es el JSON de la call (quick-calls.ts).
// Activa: verde, avatares en vivo + "Unirse". Terminada: colapsa a resumen (dur · N).

export type CallCardData = {
  state: "active" | "ended";
  host: { name: string; avatar: string };
  people: { sub: string; name: string; avatar: string }[];
  startedAt: number;
  durationSec: number | null;
  join: CallJoin;
};

export function parseCallCard(body: string | null | undefined): CallCardData | null {
  if (!body || body[0] !== "{") return null;
  try {
    const j = JSON.parse(body);
    return j?.call?.v === 1 ? (j.call as CallCardData) : null;
  } catch {
    return null;
  }
}

export function CallCard({ data, msg }: { data: CallCardData; msg: Message }) {
  const t = useT();
  const { joinCall, myCallKey, me, remove } = useContext(ChatCtx);
  const [confirmDel, setConfirmDel] = useState(false);
  const live = data.state === "active";
  // Una llamada TERMINADA es rastro y se puede borrar como cualquier mensaje. Authz igual
  // que en el menú del mensaje: dueño del room o quien la inició (el status nace con
  // sender_sub NULL, así que el chequeo del server cae al nombre — mismo criterio).
  const canDelete = !live && !!me && (me.isOwner || msg.sender === me.name);
  const key = data.join.scope === "room" ? `room:${data.join.scopeId}` : `dm:${data.join.dmId}`;
  const mine = myCallKey === key;
  const n = data.people.length;
  const dur = data.durationSec != null ? (data.durationSec < 60 ? `${data.durationSec}s` : `${Math.round(data.durationSec / 60)} min`) : null;
  return (
    <>
    <div
      className={
        "group my-1.5 ml-11 flex max-w-md items-center gap-3 rounded-2xl border px-3.5 py-3 " +
        (live ? "border-brand/30 bg-gradient-to-br from-brand/10 to-transparent" : "border-border bg-surface-2")
      }
    >
      <div className={"grid h-10 w-10 shrink-0 place-items-center rounded-full " + (live ? "bg-brand/15 text-brand" : "bg-surface-3 text-muted")}>
        {live ? <Phone size={18} /> : <PhoneOff size={18} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-ink">{live ? t("Llamada en curso") : t("Llamada terminada")}</span>
          {live && <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand" />}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="flex -space-x-2">
            {data.people.slice(0, 5).map((p) => (
              <Avatar key={p.sub} name={p.name} avatar={p.avatar} className={"h-6 w-6 ring-2 ring-surface-2 " + (live ? "" : "opacity-70")} />
            ))}
            {n > 5 && (
              <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted ring-2 ring-surface-2">+{n - 5}</span>
            )}
          </div>
          <span className="text-xs text-muted">
            {dur ? dur + " · " : ""}
            {n} {n === 1 ? t("persona") : t("personas")}
          </span>
        </div>
      </div>
      {live &&
        (mine ? (
          <span className="shrink-0 rounded-full border border-brand/40 bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand">{t("En llamada")}</span>
        ) : (
          <button
            onClick={() => joinCall?.(data.join)}
            className="shrink-0 rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-brand-fg transition hover:opacity-90 active:scale-95"
          >
            {t("Unirse")}
          </button>
        ))}
      {canDelete && (
        <button
          type="button"
          title={t("Eliminar")}
          aria-label={t("Eliminar")}
          onClick={() => setConfirmDel(true)}
          className="shrink-0 rounded-lg p-1.5 text-muted opacity-100 transition hover:bg-red-500/10 hover:text-red-500 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
    {confirmDel && (
      <ConfirmModal
        title={t("Eliminar registro de llamada")}
        body={t("Esto no se puede deshacer.")}
        confirmLabel={t("Eliminar")}
        danger
        onCancel={() => setConfirmDel(false)}
        onConfirm={() => remove?.(msg)}
      />
    )}
    </>
  );
}

/**
 * La cáscara de un turno de agente: pensando, o esperando su lugar en la cola.
 *
 * Antes eran N burbujas de "pensando…" idénticas — mandar tres mensajes seguidos parecía
 * levantar tres agentes cuando en realidad es UNO con tres turnos serializados. Y no había
 * forma de cortar ninguno: un turno largo sólo se podía esperar.
 *
 * El reloj corre en el cliente: un turno que escribe un artefacto pasa minutos sin emitir
 * un solo evento, y sin ver el tiempo eso es indistinguible de un cuelgue (nos pasó hoy).
 */

/**
 * Lo que Ghosty dice mientras trabaja, rotando cada 8s.
 *
 * Un "pensando…" fijo durante dos minutos se lee como un cuelgue, y en un turno que sólo
 * edita no corre ninguna tool, así que no hay checklist que mirar: la línea es todo lo que
 * hay. Las frases DICEN algo (leer, ordenar, revisar) en vez de ser palabras sueltas de
 * relleno, porque el objetivo es que la espera se entienda, no que sea graciosa.
 *
 * Y cambian por UMBRALES de tiempo, que es lo que recomienda la práctica de UX para esperas
 * largas: no rotar más rápido, sino reaccionar a que la persona lleva rato esperando. Un
 * indicador sin texto aguanta bien por debajo de 10s; de ahí en adelante hay que decir algo,
 * y pasado el minuto y medio lo único que tranquiliza es reconocer la espera.
 */

export const FRASES_TRABAJANDO = [
  "leyendo con calma…",
  "atando cabos…",
  "ordenando las ideas…",
  "buscando la palabra justa…",
  "hilando el argumento…",
  "midiendo cada palabra…",
  "revisando dos veces…",
  "poniendo cada cosa en su sitio…",
  "consultando mis notas…",
  "afinando la redacción…",
];

export const FRASES_LARGAS = [
  "sigo aquí, esto lleva su rato…",
  "no lo dejo a medias, dame un momento…",
  "es un documento largo; voy con cuidado…",
  "casi, no quiero equivocarme…",
  "prefiero tardar y que salga bien…",
];

/** Pasados dos minutos, reconocer la espera abiertamente y decir que se puede cortar. */

export const FRASES_MUY_LARGAS = [
  "esto es de los trabajos grandes; sigo…",
  "va largo, pero avanza — puedes detenerme si quieres…",
  "sigo trabajando; no se ha perdido nada…",
  "un escrito así toma su tiempo; aquí estoy…",
];

/**
 * Frase estable para (mensaje, segundos): sin timers propios y sin dos burbujas al unísono.
 *
 * 6s por frase, no 3: a 3 se lee como un parpadeo nervioso y no da tiempo a leerla, que es
 * justo lo contrario de lo que buscamos (que la espera se entienda).
 */

export const ROTACION_S = 8;

export function fraseTrabajando(id: number, secs: number): string {
  const lista = secs >= 120 ? FRASES_MUY_LARGAS : secs >= 35 ? FRASES_LARGAS : FRASES_TRABAJANDO;
  return lista[(id + Math.floor(secs / ROTACION_S)) % lista.length];
}
/** Reloj vivo del turno. Devuelve `null` mientras no haya turno registrado. */

export function useTurnElapsed(id: number) {
  const { turns } = useContext(ChatCtx);
  const info = turns.get(id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!info) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [info?.startedAt]);
  if (!info) return null;
  const secs = Math.max(0, Math.round((now - info.startedAt) / 1000));
  return {
    info,
    secs,
    elapsed: secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`,
  };
}

/** Cuadrado de reproductor: el gesto universal de "para esto". */

export function StopTurnButton({ id, className = "" }: { id: number; className?: string }) {
  const t = useT();
  const { stopTurn } = useContext(ChatCtx);
  return (
    <button
      type="button"
      onClick={() => stopTurn?.(id)}
      aria-label={t("Detener")}
      title={t("Detener")}
      className={`grid size-5 place-items-center rounded-full border border-border text-muted transition hover:border-red-400/50 hover:text-red-400 ${className}`}
    >
      <Square size={9} className="fill-current" />
    </button>
  );
}

/**
 * Detener un turno que YA ESCRIBIÓ algo.
 *
 * `AgentPending` —que es donde vivía el único botón de Detener— sólo se pinta mientras la
 * cáscara está vacía: al primer token desaparece, y con él la única salida. Justo el turno
 * que se cuelga a media respuesta (narró un paso y se quedó ahí) era el que no se podía
 * parar. Se veía como que la app se trabó sin razón, porque el trabajo ya empezado no
 * ofrecía ninguna manija.
 *
 * Se pinta sólo mientras el turno sigue registrado en vuelo; al llegar el body final el
 * mapa `turns` se vacía y esta línea se va sola.
 */

export function TurnLiveFooter({ id }: { id: number }) {
  const t = useT();
  const e = useTurnElapsed(id);
  if (!e || e.info.state === "queued") return null;
  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-muted">
      <ThinkingRing size={12} />
      {/* La frase, no sólo el anillo: en cuanto llega el primer paso, lo último en pantalla
          es prosa idéntica a una respuesta final y un cronómetro sin texto no se lee como
          estado. Con motores lentos el turno parecía terminado durante minutos. */}
      <span className="italic">{t(fraseTrabajando(id, e.secs))}</span>
      <span className="tabular-nums opacity-60">{e.elapsed}</span>
      <StopTurnButton id={id} />
      {/* A los 2 minutos el silencio deja de leerse como "está pensando" y empieza a
          leerse como "se trabó": se dice qué hacer en vez de dejar a la persona
          adivinando si esperar. */}
      {e.secs >= 120 ? (
        <span className="italic opacity-70">{t("¿Se tardó de más? Puedes detenerlo.")}</span>
      ) : null}
    </div>
  );
}

export function AgentPending({ id }: { id: number }) {
  const t = useT();
  const { turns } = useContext(ChatCtx);
  const info = turns.get(id);
  const e = useTurnElapsed(id);
  const secs = e?.secs ?? 0;
  const elapsed = e?.elapsed ?? "";
  const queued = info?.state === "queued";
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted">
      <ThinkingRing size={16} />
      <span className="italic">
        {queued
          ? t("en espera · {n}º de la fila").replace("{n}", String(info!.position))
          : t(fraseTrabajando(id, secs))}
      </span>
      {info ? <span className="tabular-nums opacity-60">{elapsed}</span> : null}
      {info ? <StopTurnButton id={id} /> : null}
    </div>
  );
}

export function MessageRow({
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
  const {
    me, slug, emojis, users, pickerFor, turns, density,
    // Capacidades: las que falten hacen desaparecer su botón, no lo dejan muerto.
    onOpenArtifact, openProfile, sendQuickReply,
    react, setReplyTo, forward, editMsg, star, pin, remove, canModerate,
  } = useContext(ChatCtx);
  const [editing, setEditing] = useState(false);
  // Mientras un popover de la barra (reaccionar/⋯) esté abierto, la barra NO debe
  // desaparecer al perder el hover del row (si no, el popover se vuelve inclicable).
  const [menuOpen, setMenuOpen] = useState(false);
  // TÁCTIL: la barra se abre con PULSACIÓN LARGA, no siempre visible.
  //
  // Antes en móvil estaba `opacity-100` fija, así que TODOS los mensajes llevaban
  // su barra encima y la pantalla se llenaba de íconos repetidos — imposible leer
  // la conversación. Es lo que se ve en cuanto abres el chat en el teléfono.
  //
  // La convención en táctil es la pulsación larga (WhatsApp, Telegram, Slack,
  // Discord): sin hover no hay forma de "acercarse" a un mensaje, así que la
  // intención se declara manteniendo el dedo.
  const [pressed, setPressed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const onTouchStart = () => {
    cancelPress();
    // 450ms: por debajo se dispara al hacer scroll; por encima se siente lento.
    pressTimer.current = setTimeout(() => setPressed(true), 450);
  };
  const barVisible = menuOpen || pressed || pickerFor === m.id; // ⋯, pulsación larga o picker de esta fila

  // Cerrar al tocar fuera. Sin esto la barra abierta por pulsación larga se queda
  // pegada y volvemos al problema original, sólo que en una fila en vez de todas.
  useEffect(() => {
    if (!pressed) return;
    const fuera = (e: Event) => {
      const row = document.getElementById(`msg-${m.id}`);
      if (row && !row.contains(e.target as Node)) setPressed(false);
    };
    // `capture` para enterarnos aunque el destino detenga la propagación.
    document.addEventListener("touchstart", fuera, true);
    return () => document.removeEventListener("touchstart", fuera, true);
  }, [pressed, m.id]);
  // OJO: agent_handle también se setea en el mensaje HUMANO que TAGEA a un agente
  // (createMessage guarda mentions_ghosty=1). El reply DEL agente lo hace postAgent
  // con mentions_ghosty=0. Así, "es del agente" = tiene handle Y no es una mención.
  const isAgent = (m.agent_handle != null && m.mentions_ghosty === 0) || m.sender === "ghosty";
  const isGhostyAvatar = isAgent && (m.agent_handle === "ghosty" || m.sender === "ghosty");
  // Personas: resuelve nombre/avatar del DIRECTORIO VIVO por sub (fallback al denormalizado
  // del mensaje) → editar tu avatar se ve en mensajes viejos también, como Slack. Agentes
  // conservan su propio nombre/avatar (no están en el directorio de personas).
  // Invitado de un evento abierto. El `sub` lo acuña el servidor con el prefijo `guest:`
  // (events/guest.server.ts), así que es una marca fiable: el cliente nunca lo elige.
  const isGuest = !isAgent && !!m.sender_sub?.startsWith("guest:");
  const dirUser = !isAgent && m.sender_sub ? users.get(m.sender_sub) : undefined;
  const displayName = isAgent && m.sender === "ghosty" ? "Ghosty" : (dirUser?.name || m.sender);
  const avatarSrc = dirUser?.avatar || m.avatar;
  const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Hora compacta (24h, sin am/pm) para el gutter angosto de mensajes agrupados: "18:47"
  // cabe en w-9 (36px) en UNA línea → no wrappea a 2 líneas (lo que inflaba el alto de la
  // fila y descuadraba el spacing) ni se corta. Los headers (no-agrupados) siguen con `time`.
  const timeShort = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const canEdit = !!me && (me.isOwner || m.sender === me.name) && !isAgent && m.kind === "msg";
  const canDelete = !!me && (me.isOwner || canModerate || m.sender === me.name) && m.kind === "msg";
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
    // Tarjeta de quick-call (body = JSON) → tarjeta rica estilo Slack.
    const card = parseCallCard(m.body);
    if (card) return <CallCard data={card} msg={m} />;
    // Rastro viejo (texto "📞 …") — compat con mensajes previos a la tarjeta.
    if (m.body?.startsWith("📞")) {
      const ended = m.body.includes("terminada");
      const text = m.body.replace(/^📞\s*/, "");
      return (
        <div className="flex items-center gap-2 py-1 pl-11 text-xs">
          {ended ? <PhoneOff size={14} className="shrink-0 text-muted" /> : <Phone size={14} className="shrink-0 text-brand" />}
          <span className={ended ? "text-muted" : "font-medium text-ink"}>{text}</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2.5 py-1 pl-11 text-xs text-muted">
        <ThinkingRing size={20} />
        <span className="italic">{m.body || t("Pensando…")}</span>
      </div>
    );
  }

  // ── Variante COMPACTA (estilo Twitch) ────────────────────────────────────────
  //
  // Una línea por mensaje: hora, insignias, nombre en color, y el cuerpo a continuación.
  // Cabe ~4× más en pantalla que el formato cómodo, y ésa es toda la razón: en un webinar
  // con cien personas el avatar de cada mensaje convierte la conversación en un scroll
  // infinito donde no se sigue nada.
  //
  // No es un renderer aparte: reusa `Markdown`, `AttachmentList`, `ReactionBar`, la barra
  // de acciones y las tarjetas. Lo único que cambia es cómo se ordena.
  if (density === "compact" && m.kind === "msg") {
    const colorNombre = isAgent ? undefined : colorDeNombre(m.sender_sub || m.sender || "");
    return (
      <div
        id={`msg-${m.id}`}
        onTouchStart={onTouchStart}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        onTouchCancel={cancelPress}
        className={`group relative rounded px-2 py-[3px] text-sm leading-snug transition-colors hover:bg-surface-2 ${pressed ? "bg-surface-2" : ""}`}
      >
        {/* La barra de acciones es la MISMA que en el formato cómodo; sólo cambia dónde
            se ancla. Sin esto, reaccionar en compacto sería otro camino que mantener. */}
        {!editing && (
          <div
            className={`absolute right-1 top-0 z-20 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-0.5 shadow-sm transition ${
              barVisible ? "opacity-100" : "pointer-events-none opacity-0 md:pointer-events-auto md:group-hover:opacity-100"
            }`}
          >
            {canReact && react && <ReactButton m={m} />}
            {setReplyTo && <ReplyButton m={m} author={displayName} />}
            {forward && <ForwardButton m={m} />}
            {canEdit && editMsg && <EditButton onEdit={() => setEditing(true)} />}
            {(star || pin || remove) && (
              <MessageActions m={m} slug={slug} canDelete={canDelete} canPin={!!canPin} onOpenChange={setMenuOpen} />
            )}
          </div>
        )}

        {editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          <>
            {/* `[&>*]:inline` mete el markdown en el mismo renglón que el nombre. Con
                contenido rico (una tabla, una tarjeta) vuelve a comportarse como bloque,
                que es lo correcto: eso no cabe en una línea de todos modos. */}
            <span suppressHydrationWarning className="mr-1.5 select-none text-[11px] tabular-nums text-muted/70">
              {timeShort}
            </span>
            {isAgent && (
              <span className="mr-1 rounded bg-brand/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-brand">
                {t("Agente")}
              </span>
            )}
            {isGuest && (
              <span
                title={t("Entró por la liga del evento")}
                className="mr-1 rounded bg-amber-500/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-amber-600"
              >
                {t("Invitado")}
              </span>
            )}
            <span className={`font-semibold ${isAgent ? "text-brand" : ""}`} style={colorNombre ? { color: colorNombre } : undefined}>
              {displayName}
            </span>
            <span className="mr-1 text-muted">:</span>
            <span className="[&>*]:inline [&_p]:inline [&_p]:m-0">
              <Markdown body={bubbleWithoutEbDoc(m.body)} emojis={emojis} onImage={onOpenArtifact ? (src, alt) => onOpenArtifact({ kind: "image", title: alt || "Imagen", src }) : undefined} />
            </span>
            {(() => {
              const ts = extractToolState(m.body);
              return ts ? <ToolGroup tools={ts} vivo={turns.has(m.id)} /> : null;
            })()}
            {m.attachments && m.attachments.length > 0 && <AttachmentList attachments={m.attachments} />}
            <ReactionBar m={m} />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      id={`msg-${m.id}`}
      // Táctil: mantener el dedo abre la barra; soltar, mover (scroll) o tocar
      // fuera la cierra. En puntero no interviene — ahí manda el hover de siempre.
      onTouchStart={onTouchStart}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
      onPointerDown={(e) => { if (e.pointerType !== "touch") setPressed(false); }}
      className={`group relative flex items-start gap-3 rounded-lg px-2 transition-colors hover:bg-surface-2 ${grouped ? "py-px" : "mt-2 py-0.5"} ${pressed ? "bg-surface-2" : ""}`}
    >
      {grouped ? (
        // Agrupado: sin avatar. Gutter angosto que muestra la hora SOLO al hover (Slack).
        // suppressHydrationWarning: la hora se formatea en la ZONA HORARIA del que
        // renderiza — el SSR (UTC) escribía "18:49" y el cliente "12:49" → mismatch de
        // hidratación EN CADA MENSAJE (React error #418): React tiraba el HTML del SSR y
        // re-renderizaba todo el flujo en el cliente, que es por qué el room aparecía
        // "mensaje a mensaje". El texto del cliente es el correcto; toleramos la diferencia.
        <div suppressHydrationWarning className="w-9 shrink-0 select-none whitespace-nowrap pt-0.5 text-right text-[10px] leading-5 tabular-nums text-muted opacity-0 group-hover:opacity-100">
          {timeShort}
        </div>
      ) : (
      /* Avatar clickable → perfil (persona o agente). */
      <button
        // Sin `openProfile` no hay perfil que abrir (un room abierto no tiene directorio),
        // así que el avatar deja de ofrecerse como botón: sin cursor, sin hover y sin
        // tooltip. Un clic que no hace nada es peor que no poder hacer clic.
        onClick={openProfile ? () => openProfile({ name: displayName, avatar: avatarSrc, handle: m.agent_handle ?? (isGhostyAvatar ? "ghosty" : null), isAgent, sub: isAgent ? null : m.sender_sub }) : undefined}
        className={`shrink-0 rounded-lg transition ${openProfile ? "hover:opacity-80" : "cursor-default"}`}
        title={openProfile ? t("Ver perfil") : undefined}
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
            barVisible ? "opacity-100" : "pointer-events-none opacity-0 md:pointer-events-auto md:group-hover:opacity-100"
          }`}
        >
          {/* Orden: emoji → hilo → flechas (responder, reenviar) → editar (propio) → ⋯.
              Copiar y destacar viven ahora en el menú ⋯. */}
          {canReact && react && <ReactButton m={m} />}
          {showThreadLink && onOpenThread && !m.reply_count && <ThreadReplyButton onOpen={() => onOpenThread(m.id)} />}
          {setReplyTo && <ReplyButton m={m} author={displayName} />}
          {forward && <ForwardButton m={m} />}
          {canEdit && editMsg && <EditButton onEdit={() => setEditing(true)} />}
          {/* El menú ⋯ agrupa copiar, destacar, fijar y borrar. Sale si hay al menos una
              de esas capacidades; si no, sería un menú vacío. */}
          {(star || pin || remove) && (
            <MessageActions
              m={m}
              slug={slug}
              canDelete={canDelete}
              canPin={!!canPin}
              onOpenChange={setMenuOpen}
            />
          )}
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
          {isGuest ? (
            // Alguien de FUERA del workspace: entró por la liga de un evento abierto y no
            // tiene cuenta ni ocupa asiento. Con 100 desconocidos escribiendo en un room
            // del cliente, el equipo tiene que distinguirlos de un vistazo — si no, un
            // nombre cualquiera en el flujo se lee como si fuera un compañero.
            <span
              title={t("Entró por la liga del evento")}
              className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-amber-600"
            >
              {t("Invitado")}
            </span>
          ) : null}
          <span suppressHydrationWarning className="text-[11px] text-muted">{time}</span>
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
        {/* Reenviado (forward): rótulo sutil estilo WhatsApp sobre el cuerpo. */}
        {m.forwarded_from ? (
          <div className="mb-0.5 flex items-center gap-1 text-xs italic text-muted">
            <Forward size={12} className="shrink-0" /> {t("Reenviado")}
            <span className="not-italic">· {m.forwarded_from}</span>
          </div>
        ) : null}
        {/* Quote-reply: cita del mensaje al que responde (sobre el cuerpo, clic → salta). */}
        {m.quoted_excerpt ? <QuotedCitation m={m} /> : null}
        {editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          m.body ? (
            <div className="text-sm text-ink">
              {(() => {
                const ts = extractToolState(m.body);
                return ts ? <ToolGroup tools={ts} vivo={turns.has(m.id)} /> : null;
              })()}
              {(() => {
                const st = extractSteps(m.body);
                return st ? <StepList steps={st} emojis={emojis} /> : null;
              })()}
              {(() => {
                const al = extractAlert(m.body);
                return al ? <AlertCard msgId={m.id} a={al} onAct={(send) => sendQuickReply?.(send, m)} /> : null;
              })()}
              {(() => {
                // Pregunta del agente: hay un turno DETENIDO al otro lado esperando esta
                // respuesta, así que la tarjeta va antes que el texto y no como pie.
                const ask = extractAsk(m.body);
                return ask ? <AskCard msgId={m.id} a={ask} /> : null;
              })()}
              {(() => {
                // Permiso de ACP. Va aparte de la pregunta y no como una variante suya: aquí
                // el turno no está esperando una preferencia, está esperando que lo dejen
                // actuar — y si nadie contesta, se rechaza solo.
                const perm = extractPermission(m.body);
                return perm ? <PermissionCard msgId={m.id} p={perm} /> : null;
              })()}
              {/* Con tarjeta de alerta el bubble se calla: la línea de texto plano que
                  acompaña al fence es el RESPALDO (citas, buscador, notificación), y
                  repetirla debajo de la tarjeta sería decir dos veces lo mismo. */}
              {!extractAlert(m.body) && bubbleWithoutEbDoc(m.body).trim() ? (
              <Markdown
                body={bubbleWithoutEbDoc(m.body)}
                artifactUrl={m.artifact?.url}
                onOpenArtifact={m.artifact && onOpenArtifact ? () => onOpenArtifact(artifactToView(m.artifact!)) : undefined}
                onImage={onOpenArtifact ? (src, alt) => onOpenArtifact({ kind: "image", title: alt || "Imagen", src }) : undefined}
                emojis={emojis}
                onMention={(h) => {
                  // Clic en @mención → abre el perfil de esa persona (Slack: hovercard con
                  // Message). Resuelve por handle en el directorio vivo; grupos (@all…) no matchean.
                  const u = [...users.values()].find((x) => x.handle.toLowerCase() === h.toLowerCase());
                  if (u) openProfile?.({ name: u.name, avatar: u.avatar, handle: u.handle, isAgent: false, sub: u.sub });
                }}
              />
              ) : null}
              {(() => {
                // Va DESPUES de la prosa, no antes: la resena es el contenido y la
                // tarjeta es su pie accionable. Al reves se lee como si el PR fuera el
                // mensaje y la resena un apendice.
                const pr = extractPr(m.body);
                return pr ? <PrCard pr={pr} channelId={m.channel_id ?? 0} parentId={m.parent_id ?? m.id} prosa={bubbleWithoutEbDoc(m.body)} /> : null;
              })()}
              {(() => {
                const tk = extractTask(m.body);
                return tk ? <TaskCard task={tk} channelId={m.channel_id ?? 0} parentId={m.parent_id ?? m.id} /> : null;
              })()}
              {(() => {
                const ts = extractTests(m.body);
                return ts ? <TestsCard data={ts} /> : null;
              })()}
              {/* El turno sigue vivo aunque ya haya texto: la salida tiene que seguir
                  a la vista (ver TurnLiveFooter). */}
              {isAgent ? <TurnLiveFooter id={m.id} /> : null}
            </div>
          ) : isAgent && !m.attachments?.length && !m.artifact ? (
            // Caja caliente: cáscara del agente aún sin texto → indicador inline (la fila
            // con avatar+nombre ya está arriba y PERMANECE). Se reemplaza al primer token.
            // Con adjunto/artefacto (p.ej. nota de voz SIN texto) NO es "pensando": el body
            // queda vacío a propósito y el contenido baja como adjunto → mostrar solo eso.
            <AgentPending id={m.id} />
          ) : null
        )}
        {/* UN link = "te comparto esto" → tarjeta rica. VARIOS = "en esto me basé"
            → fila de chips. Si el mensaje trae artefacto, manda el artefacto. */}
        {!editing && m.body && !m.artifact && (() => {
          const urls = allUrls(bubbleWithoutEbDoc(m.body));
          if (urls.length === 0) return null;
          return urls.length === 1 ? <LinkPreview url={urls[0]} /> : <SourceChips urls={urls} />;
        })()}
        {m.attachments && m.attachments.length > 0 && <AttachmentList attachments={m.attachments} />}
        {m.artifact && (
          <ArtifactBoundary
            key={m.artifact.url}
            fallback={
              <div className="mt-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
                {t("No se pudo mostrar el artefacto.")}
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

// Burbuja de herramientas estilo Claude Code: tarjeta colapsable con el estado real de
// cada tool del turno (⏳/✓/✕). Los subagentes concurrentes (mismo label, n>1) muestran
// su conteo. Abierta mientras trabaja, se colapsa sola al terminar (salvo toggle manual).
/**
 * Los pasos que el agente narró mientras trabajaba.
 *
 * Va con palomita en vez de viñeta: una viñeta es "un elemento de una lista", y
 * esto es "esto ya lo hice". El ícono se dibuja aparte del texto (no como
 * carácter dentro de la línea) para que quede alineado con la primera renglón
 * aunque el paso ocupe varias líneas.
 */

export function StepList({ steps, emojis }: { steps: string[]; emojis?: { name: string; file_id: string }[] }) {
  return (
    <ul className="mb-2 space-y-1.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2 text-muted">
          <span className="mt-[3px] shrink-0 text-brand" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="9" className="fill-brand/10" />
              <path
                d="M6 10.4l2.6 2.6L14 7.6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="min-w-0 flex-1 [&_p]:m-0">
            <Markdown body={s} emojis={emojis} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ToolGroup({ tools, vivo = true }: { tools: ToolState[]; vivo?: boolean }) {
  // Las etiquetas las arma el SERVER en español y viajan dentro del cuerpo del
  // mensaje. Como el i18n de Teams usa el texto fuente COMO clave, pasarlas por
  // t() basta para que se traduzcan igual que el resto de la UI — sin cambiar el
  // formato del bloque ni tocar los mensajes ya guardados.
  //
  // Una tool sin traducción (las humanizadas: "generate image") sale tal cual, que
  // es lo correcto: es el nombre real de la herramienta, no una frase nuestra.
  const tr = useT();
  // ⚠️ Sólo puede haber algo CORRIENDO si el turno sigue vivo. El estado se pinta desde el
  // cuerpo del mensaje, que conserva la foto de mitad del stream: sin esta condición, un
  // turno que terminó (o que se cortó) dejaba el círculo girando para siempre — la barra
  // decía "terminó" y la burbuja seguía animando (2026-08-03).
  const anyRunning = vivo && tools.some((t) => t.status === "running");
  const fallidas = tools.filter((t) => t.status === "error").length;
  // ⚠️ El orden importa y estaba al revés: `anyError` ganaba sobre `anyRunning`, así que
  // en cuanto UNA herramienta fallaba el header se quedaba con el ✗ para siempre —
  // incluso con el agente trabajando. Dos daños:
  //
  //   - Se perdía el ÚNICO indicador permanente de "sigue trabajando" que hay durante un
  //     turno largo. El usuario veía un tache quieto y lo leía como "ya terminó, y mal".
  //   - Un fallo de quince decía que los quince fallaron. Visto el 2026-08-03: 14 tools
  //     bien y un `fetch_url`, y el grupo entero en rojo.
  //
  // Trabajar es un estado, fallar es un resultado: mientras haya algo corriendo, manda el
  // estado. Y sólo se pinta ✗ si fallaron TODAS; si fallaron algunas, va la palomita con
  // la cuenta al lado, que es lo que de verdad pasó.
  const overall: ToolState["status"] = anyRunning
    ? "running"
    : fallidas === tools.length && fallidas > 0
      ? "error"
      : "done";
  // Abierta por default (el usuario quiere ver las tools sin tener que expandir cada vez).
  // Se queda como la deje: si la colapsa, respeta su elección para ese mensaje.
  const [open, setOpen] = useState(true);
  const icon = (s: ToolState["status"], sz = 13) =>
    s === "error" ? (
      <X size={sz} className="shrink-0 text-red-500" />
    ) : s === "done" ? (
      <Check size={sz} className="shrink-0 text-emerald-500" />
    ) : (
      <ThinkingRing size={sz} />
    );
  const total = tools.reduce((n, t) => n + (t.n ?? 1), 0);
  // UNA herramienta → una sola línea, sin colapsable (el header y la fila expandida
  // dirían lo mismo = info repetida). El ×n y el detalle van en esa línea.
  if (tools.length === 1) {
    const t = tools[0];
    return (
      <div className="mb-1.5 flex max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs">
        <Wrench size={12} className="shrink-0 text-muted" />
        {icon(t.status, 12)}
        <span className={`truncate ${t.status === "error" ? "text-red-500" : "text-ink"}`}>{tr(t.label)}</span>
        {t.detail ? <span className="truncate font-mono text-[10px] text-muted/70">· {t.detail}</span> : null}
        {t.n && t.n > 1 ? <span className="shrink-0 text-[10px] text-muted/70">×{t.n}</span> : null}
      </div>
    );
  }
  const summary = `${total} ${total === 1 ? "herramienta" : "herramientas"}`;
  return (
    <div className="mb-1.5 max-w-md overflow-hidden rounded-lg border border-border bg-surface-2/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-surface-3/40"
      >
        <Wrench size={12} className="shrink-0 text-muted" />
        <span className="truncate font-medium text-ink">{summary}</span>
        {icon(overall, 12)}
        {/* Los fallos no se esconden, pero tampoco secuestran el header: van como cuenta
            al lado del estado. Sin esto, cambiar el ✗ por la palomita habría TAPADO que
            algo salió mal, que es peor que exagerarlo. */}
        {fallidas > 0 && fallidas < tools.length ? (
          <span className="shrink-0 text-[10px] text-red-500">
            {fallidas} {fallidas === 1 ? "falló" : "fallaron"}
          </span>
        ) : null}
        <ChevronDown size={14} className={`ml-auto shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          {tools.map((t, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
              {icon(t.status)}
              <span className={t.status === "error" ? "text-red-500" : "text-muted"}>{tr(t.label)}</span>
              {t.detail ? <span className="truncate font-mono text-[10px] text-muted/70">· {t.detail}</span> : null}
              {t.n && t.n > 1 ? <span className="text-[10px] text-muted/70">×{t.n}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Extracto de texto plano de un mensaje para la cita (quita fences gt-tools/eb-doc/código,
// markdown básico, y colapsa espacios). Espejo de quoteExcerpt del server.

export function plainExcerpt(body: string): string {
  const s = (body || "")
    .replace(/```gt-tools[\s\S]*?```/g, "")
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

export function QuotedCitation({ m }: { m: Message }) {
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

export function ThreadReplyButton({ onOpen }: { onOpen: () => void }) {
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

export function ReplyButton({ m, author }: { m: Message; author: string }) {
  const t = useT();
  const { setReplyTo } = useContext(ChatCtx);
  return (
    <button
      onClick={() => setReplyTo?.({ id: m.id, author, excerpt: plainExcerpt(m.body) })}
      title={t("Responder")}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
    >
      <Reply size={14} />
    </button>
  );
}

export function ReactButton({ m }: { m: Message }) {
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
      const target = e.target as HTMLElement;
      // El panel vive en un portal (fuera de wrapRef) → excluirlo por su marca para no
      // cerrar al hacer click DENTRO del picker (si no, el pick nunca registraba).
      if (target.closest?.("[data-emoji-picker]")) return;
      if (wrapRef.current && !wrapRef.current.contains(target)) setPickerFor?.(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerFor?.(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setPickerFor]);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        onClick={() => setPickerFor?.(open ? null : m.id)}
        title={t("Reaccionar")}
        className={`rounded p-1 transition ${open ? "text-brand" : "text-muted hover:text-ink"}`}
      >
        <SmilePlus size={14} />
      </button>
      {open && (
        <EmojiPicker
          anchorRef={btnRef}
          onPick={(e) => {
            setPickerFor?.(null);
            react?.(m, e);
          }}
        />
      )}
    </div>
  );
}

// Destacar (star): marcador personal. Va por el evento `star` (ch.user) → el flag
// se sincroniza en todas mis pestañas, igual que las reacciones.
// Rápida: reenviar (abre el selector de destino). Reemplaza a copiar en la barra.

/**
 * Reenviar. El botón NO se abre su propio modal: llama al host.
 *
 * Antes se lo abría solo, y entonces "puede reenviar" no era una capacidad sino un dato
 * implícito del componente — había que apagarlo desde fuera con una bandera. Delegando al
 * host, la superficie que no sabe reenviar simplemente no pasa `forward`, y el botón no
 * existe. El modal (`ForwardModal`) lo monta quien sí puede.
 */
export function ForwardButton({ m }: { m: Message }) {
  const t = useT();
  const { forward } = useContext(ChatCtx);
  if (!forward) return null;
  return (
    <button onClick={() => forward(m)} title={t("Reenviar")} className="rounded p-1 text-muted hover:text-ink">
      {/* ReplyAll = doble flecha curva (apunta a la izq); la volteo → doble flecha curva
          a la DERECHA = el ícono clásico de reenviar. */}
      <ReplyAll size={15} className="-scale-x-100" />
    </button>
  );
}

// Rápida: editar (solo mensajes propios). Reemplaza a destacar en la barra.

export function EditButton({ onEdit }: { onEdit: () => void }) {
  const t = useT();
  return (
    <button onClick={onEdit} title={t("Editar")} className="rounded p-1 text-muted hover:text-ink">
      <Pencil size={14} />
    </button>
  );
}

// Menú "⋯" de acciones de mensaje: copiar enlace, fijar (owner/creador), editar, borrar.

export function MessageActions({
  m,
  slug,
  canDelete,
  canPin,
  onOpenChange,
}: {
  m: Message;
  slug: string;
  canDelete: boolean;
  canPin: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const { pin, remove, star, banUser } = useContext(ChatCtx);
  const [open, setOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);
  const [dropUp, setDropUp] = useState(false); // último mensaje: abre hacia arriba (no se corta)
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
        onClick={() =>
          setOpen((o) => {
            // Al ABRIR, decide dirección: si abajo no cabe el menú (~260px), lo abrimos
            // hacia ARRIBA → el ⋯ del último mensaje ya no se corta contra el composer.
            if (!o && wrapRef.current) {
              const r = wrapRef.current.getBoundingClientRect();
              setDropUp(window.innerHeight - r.bottom < 260);
            }
            return !o;
          })
        }
        title={t("Más acciones")}
        className="rounded p-1 text-muted hover:text-ink"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && receipts !== null && (
        <>
          <div className={`absolute right-0 z-20 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
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
          <div className={`absolute right-0 z-20 w-48 rounded-lg border border-border bg-surface p-1 shadow-lg ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
            {/* Copiar el TEXTO del mensaje (antes era acción rápida). */}
            <button
              className={item}
              onClick={() => {
                navigator.clipboard?.writeText(m.body ?? "").catch(() => {});
                close();
              }}
            >
              <Copy size={14} className="text-muted" /> {t("Copiar mensaje")}
            </button>
            {/* Destacar (antes era acción rápida). */}
            <button className={item} onClick={() => { star?.(m); close(); }}>
              <Star size={14} className={m.starred ? "text-amber-500" : "text-muted"} fill={m.starred ? "currentColor" : "none"} />
              {m.starred ? t("Quitar destacado") : t("Destacar")}
            </button>
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
                  pin?.(m);
                  close();
                }}
              >
                {m.pinned ? <PinOff size={14} className="text-muted" /> : <Pin size={14} className="text-muted" />}
                {m.pinned ? t("Desfijar") : t("Fijar en el room")}
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
            {banUser && m.kind === "msg" && (
              <button
                className={`${item} text-red-500 hover:bg-red-500/10`}
                onClick={() => {
                  close();
                  setConfirmBan(true);
                }}
              >
                <Ban size={14} /> {t("Expulsar del room")}
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
          onConfirm={() => remove?.(m)}
        />
      )}
      {confirmBan && (
        <ConfirmModal
          title={t("Expulsar del room")}
          // Se dice lo que hace de verdad: el veto es por correo (sobrevive a borrar la
          // cookie) y se le borran sus mensajes, porque dejar el rastro es media expulsión.
          body={t("No podrá volver a escribir y se borrarán sus mensajes de este room.")}
          confirmLabel={t("Expulsar")}
          danger
          onCancel={() => setConfirmBan(false)}
          onConfirm={() => {
            banUser?.(m);
            setConfirmBan(false);
          }}
        />
      )}
    </div>
  );
}

// Reenviar (forward WhatsApp): elige un canal o DM y re-publica el mensaje COMPLETO ahí.
// Busca en vivo; un clic reenvía y confirma. Fuente de destinos = forwardTargetsFn (canales
// visibles + DMs del usuario).

export function ForwardModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const t = useT();
  const [targets, setTargets] = useState<{ channels: { slug: string; name: string; icon: string | null }[]; dms: { id: number; name: string; avatar: string }[] } | null>(null);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState<string | null>(null); // key del destino en curso
  const [done, setDone] = useState<string | null>(null); // nombre del destino reenviado
  useEffect(() => {
    forwardTargetsFn().then(setTargets).catch(() => setTargets({ channels: [], dms: [] }));
  }, []);
  const ql = q.trim().toLowerCase();
  const channels = (targets?.channels ?? []).filter((c) => !ql || c.name.toLowerCase().includes(ql));
  const dms = (targets?.dms ?? []).filter((d) => !ql || d.name.toLowerCase().includes(ql));
  const send = async (key: string, to: { slug: string } | { dmId: number }, name: string) => {
    if (sending) return;
    setSending(key);
    try {
      await forwardMessageFn({ data: { messageId: message.id, to } });
      setDone(name);
      setTimeout(onClose, 900);
    } catch {
      setSending(null);
      alert(t("No se pudo reenviar. Intenta de nuevo."));
    }
  };
  return (
    <Modal onClose={onClose}>
      <div className="flex max-h-[70vh] w-[min(92vw,26rem)] flex-col">
        <h3 className="mb-1 text-sm font-semibold text-ink">{t("Reenviar mensaje")}</h3>
        {done ? (
          <div className="grid place-items-center gap-2 py-10 text-center">
            <Check size={28} className="text-brand" />
            <span className="text-sm text-ink">{t("Reenviado a {name}", { name: done })}</span>
          </div>
        ) : (
          <>
            <div className="relative mb-2">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("Buscar canal o persona…")}
                className="w-full rounded-lg border border-border bg-surface py-2 pl-8 pr-3 text-sm text-ink outline-none focus:border-brand"
              />
            </div>
            <div className="thin-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {targets == null ? (
                <div className="grid place-items-center py-8"><Loader2 size={18} className="animate-spin text-muted" /></div>
              ) : channels.length === 0 && dms.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted">{t("Sin destinos")}</p>
              ) : (
                <>
                  {channels.length > 0 && <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{t("Canales")}</p>}
                  {channels.map((c) => {
                    const key = `c:${c.slug}`;
                    return (
                      <button key={key} disabled={!!sending} onClick={() => send(key, { slug: c.slug }, c.name)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-ink transition hover:bg-surface-2 disabled:opacity-50">
                        <Hash size={15} className="shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {sending === key ? <Loader2 size={14} className="animate-spin text-brand" /> : null}
                      </button>
                    );
                  })}
                  {dms.length > 0 && <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{t("Directos")}</p>}
                  {dms.map((d) => {
                    const key = `d:${d.id}`;
                    return (
                      <button key={key} disabled={!!sending} onClick={() => send(key, { dmId: d.id }, d.name)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-ink transition hover:bg-surface-2 disabled:opacity-50">
                        <Avatar name={d.name} avatar={d.avatar} className="h-6 w-6 shrink-0 text-[10px]" />
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        {sending === key ? <Loader2 size={14} className="animate-spin text-brand" /> : null}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Confirmación destructiva reutilizable (borrar mensaje/hilo/room). Overlay centrado
// con backdrop; ESC = cancelar, Enter = confirmar. Estilo alineado a la app.
// ConfirmModal vive ahora en components/ConfirmModal (lo comparte el panel de
// documentos, que necesita el mismo diálogo destructivo). Se re-exporta el nombre para
// no tocar los usos de este archivo.

// Barra de mensajes fijados del room (header). Clic → salta al mensaje.

export function EmojiPicker({ onPick, anchorRef }: { onPick: (e: string) => void; anchorRef?: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const { emojis, openPrefs } = useContext(ChatCtx);
  // Con anchor → portal a body en posición `fixed`, calculada desde el rect del trigger,
  // con flip arriba/abajo según el espacio → NUNCA lo recorta el scroller `overflow-y-auto`
  // (que sí clippeaba el panel `absolute` en mensajes intermedios). Sin anchor → absolute
  // (uso legacy en el editor de perfil, dentro de un contenedor sin overflow).
  const portaled = !!anchorRef;
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchorRef?.current) return;
    const W = 256; // w-64
    const compute = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 6;
      const left = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8);
      const spaceBelow = window.innerHeight - r.bottom;
      // ~360px de alto máximo del panel → si no cabe abajo, ancla por arriba del trigger.
      if (spaceBelow < 360 && r.top > spaceBelow) {
        setPos({ left, bottom: window.innerHeight - r.top + gap });
      } else {
        setPos({ left, top: r.bottom + gap });
      }
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);
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

  // Portal → oculto hasta tener posición (evita un flash en 0,0 en el 1er paint).
  if (portaled && !pos) return null;
  const panel = (
    <div
      data-emoji-picker
      className={
        portaled
          ? "fixed z-[70] w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
          : "absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
      }
      style={portaled && pos ? { left: pos.left, top: pos.top, bottom: pos.bottom } : undefined}
    >
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
        onClick={() => openPrefs?.("emojis")}
        className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-xs text-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <Plus size={13} /> {t("Añadir emoji")}
      </button>
    </div>
  );
  return portaled ? createPortal(panel, document.body) : panel;
}

export function ReactionBar({ m }: { m: Message }) {
  const t = useT();
  const { react, users, me } = useContext(ChatCtx);
  // Tooltip de hover = quién reaccionó (nombres del directorio vivo; yo primero). Cae a
  // "Toggle reacción" si aún no hay subs (mensaje viejo sin recargar / evento en vuelo).
  const reactorsTitle = (r: NonNullable<Message["reactions"]>[number]) => {
    const subs = r.subs ?? [];
    const names = subs
      .map((s) => (s === me?.sub ? me?.name : users.get(s)?.name))
      .filter((n): n is string => !!n);
    // Un sub que no está en el directorio vivo (agente, alguien que ya salió) se caía
    // en silencio: el chip decía 3 y el tooltip nombraba 2. Se cuenta como "N más".
    const faltan = subs.length - names.length;
    if (faltan > 0) names.push(faltan === 1 ? t("alguien más") : `${faltan} ${t("más")}`);
    if (!names.length) return t("Toggle reacción");
    // "Ana, Luis y Pau reaccionaron con :party_blob:" — el emoji al final, como Slack.
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} ${t("y")} ${names[names.length - 1]}`;
    const verb = names.length === 1 ? t("reaccionó con") : t("reaccionaron con");
    return `${list} ${verb} ${r.emoji}`;
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {(m.reactions ?? []).map((r) => (
        <button
          key={r.emoji}
          onClick={() => react?.(m, r.emoji)}
          title={reactorsTitle(r)}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition ${
            r.mine
              ? "border-brand bg-brand/15 text-brand"
              : "border-border bg-surface-2 text-muted hover:border-brand"
          }`}
        >
          <EmojiText code={r.emoji} noTitle />
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

export function EditBox({ m, onDone }: { m: Message; onDone: () => void }) {
  const t = useT();
  const { editMsg } = useContext(ChatCtx);
  const [val, setVal] = useState(m.body);
  // `autoFocus` enfoca pero deja el caret en 0, así que al editar el cursor aparecía
  // ANTES de la primera letra y escribir metía el texto al revés. Se coloca a mano al
  // final, que es donde lo pone cualquier chat cuando editas.
  const caja = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  function save() {
    if (!val.trim()) return;
    editMsg?.(m, val.trim()); // optimista: patch local + server en bg, cierra al instante
    onDone();
  }
  return (
    <div className="mt-1">
      <textarea
        ref={caja}
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
        {/* Neutro (bg-ink = negro en claro / blanco en oscuro), NO brand: el color de marca
            se reserva para el botón de ENVIAR principal del composer. */}
        <button
          onClick={save}
          disabled={!val.trim()}
          className="rounded bg-ink px-2 py-0.5 font-semibold text-surface transition hover:opacity-90 disabled:opacity-50"
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

// ¿El mensaje optimista debe AGRUPARSE con el anterior (real u optimista)? Espeja la
// lógica de MessageRow → el optimista nace YA agrupado (sin header) igual que quedará el
// real → sin el "brinco" de header que aparece y desaparece al reconciliar.
