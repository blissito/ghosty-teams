import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Hash,
  Lock,
  Plus,
  Settings,
  X,
  Trash2,
  MessageSquare,
  MessagesSquare,
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
} from "lucide-react";
import { createFileRoute, notFound, Link, useRouter } from "@tanstack/react-router";
import type { Channel, Message } from "../db.server";
import {
  getChannelView,
  getChannelFlow,
  getThread,
  getChannelThreads,
  postMessage,
  askAgent,
  deleteMessageFn,
  listMentionsFn,
} from "../server/chat";

type Mention = { handle: string; name: string; avatar: string; kind: "agent" | "user" };
import { me } from "../server/auth";
import {
  createChannelFn,
  deleteChannelFn,
  getChannelMembersFn,
  addChannelMemberFn,
  removeChannelMemberFn,
  listWorkspaceUsersFn,
} from "../server/channels";

export const Route = createFileRoute("/c/$slug")({
  // El hilo y el flujo NO van en el loader (se cargan client-side con cache +
  // skeleton → abrir es instantáneo). El loader solo trae rooms + meta + user.
  loader: async ({ params }) => {
    const [view, user] = await Promise.all([
      getChannelView({ data: { slug: params.slug } }),
      me(),
    ]);
    if (!view) throw notFound();
    return { ...view, user };
  },
  component: ChannelPage,
});

type SessionUser = { sub: string; name: string; email: string; avatar: string; isOwner: boolean };
type Optimistic = { id: string; parentId: number | null; sender: string; avatar: string; body: string };

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

function useCachedQuery<K, T>(
  cache: Map<K, T>,
  key: K,
  fetcher: () => Promise<T>,
  rev: number
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
  return data;
}

function ChannelPage() {
  const { channels, channel, user } = Route.useLoaderData();
  // Hilo abierto = ESTADO CLIENTE (no URL) → abre instantáneo, sin revalidar el router.
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
  const [rev, setRev] = useState(0);
  const revalidate = () => setRev((r) => r + 1);
  // Flujo del room: cacheado → volver a un room es instantáneo (sin skeleton si ya se vio).
  const messages = useCachedQuery(
    flowCache,
    channel.slug,
    () => getChannelFlow({ data: { slug: channel.slug } }),
    rev
  );
  // Al cambiar de room, cierra paneles.
  useEffect(() => {
    setOpenThreadId(null);
    setShowThreads(false);
  }, [channel.slug]);
  // Al reconciliar el flujo, limpia optimistic de flujo (los de hilo se limpian solos).
  useEffect(() => {
    if (messages) setOptimistic((o) => o.filter((x) => x.parentId !== null));
  }, [messages]);
  const addOptimistic = (parentId: number | null, body: string) =>
    setOptimistic((o) => [
      ...o,
      {
        id: `${Date.now()}-${o.length}`,
        parentId,
        sender: user?.name ?? "tú",
        avatar: user?.avatar ?? "",
        body,
      },
    ]);
  const clearOptimistic = (parentId: number | null) =>
    setOptimistic((o) => o.filter((x) => x.parentId !== parentId));
  // Clic en el origen del hilo → cierra el drawer y scrollea al mensaje en el room (estilo Slack).
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
    <div className="flex h-screen bg-surface text-ink">
      <Sidebar channels={channels} active={channel.slug} user={user} />
      <Flow
        channel={channel}
        messages={messages}
        optimistic={optimistic.filter((o) => o.parentId === null)}
        onOptimistic={addOptimistic}
        onOpenThread={setOpenThreadId}
        onShowThreads={() => setShowThreads(true)}
        onRevalidate={revalidate}
      />
      <AnimatePresence initial={false}>
        {showThreads && (
          <ThreadsListPanel
            key="threads-list"
            channel={channel}
            isOwner={!!user?.isOwner}
            rev={rev}
            onRevalidate={revalidate}
            onOpenThread={(id) => {
              setOpenThreadId(id);
              setShowThreads(false);
            }}
            onClose={() => setShowThreads(false)}
          />
        )}
        {openThreadId != null && (
          <ThreadPanel
            key={openThreadId}
            channel={channel}
            threadId={openThreadId}
            rev={rev}
            optimistic={optimistic.filter((o) => o.parentId === openThreadId)}
            onOptimistic={addOptimistic}
            onReloaded={() => clearOptimistic(openThreadId)}
            onRevalidate={revalidate}
            onGoToOrigin={goToOrigin}
            onClose={() => setOpenThreadId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Sidebar: Rooms + notificación + identidad ── */
function Sidebar({
  channels,
  active,
  user,
}: {
  channels: Channel[];
  active: string;
  user: SessionUser | null;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsSlug, setSettingsSlug] = useState<string | null>(null);
  const canManage = (c: Channel) => user?.isOwner || c.created_by === user?.sub;

  return (
    <aside className="flex w-60 flex-col border-r border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <img src="/ghosty.svg" alt="" className="h-7 w-7" />
        <span className="font-semibold">Ghosty Teams</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 pb-1 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Rooms</p>
          <button
            onClick={() => setCreateOpen(true)}
            title="Crear room"
            className="rounded p-0.5 text-muted transition hover:text-brand"
          >
            <Plus size={17} />
          </button>
        </div>
        {channels.map((c) => (
          <div key={c.id} className="group flex items-center">
            <Link
              to="/c/$slug"
              params={{ slug: c.slug }}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                c.slug === active ? "bg-brand/15 font-medium text-ink" : "text-muted hover:bg-surface-3 hover:text-ink"
              }`}
            >
              <RoomIcon name={c.icon} size={17} className="shrink-0" />
              <span className="truncate">{c.name}</span>
              {c.is_private ? <Lock size={13} className="ml-auto shrink-0 text-muted" /> : null}
            </Link>
            {canManage(c) && (
              <button
                onClick={() => setSettingsSlug(c.slug)}
                title="Ajustes del room"
                className="p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
              >
                <Settings size={15} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mx-2 mb-2 rounded-xl border border-border bg-surface p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <img src="/ghosty.svg" alt="" className="h-4 w-4" /> Ghosty está aquí
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Escribe <span className="text-brand">@ghosty</span> en cualquier mensaje.
        </p>
      </div>

      <Link
        to="/settings"
        className="flex items-center gap-2 border-t border-border p-3 hover:bg-surface-3"
      >
        <Avatar name={user?.name} avatar={user?.avatar} className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{user?.name ?? "—"}</p>
          <p className="truncate text-xs text-muted">{user?.isOwner ? "Owner" : "Miembro"}</p>
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
            onClose={() => setSettingsSlug(null)}
            onChanged={() => router.invalidate()}
            onDeleted={() => {
              setSettingsSlug(null);
              router.invalidate();
              router.navigate({ to: "/c/$slug", params: { slug: "general" } });
            }}
          />
        )}
      </AnimatePresence>
    </aside>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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
        className="w-full max-w-sm rounded-2xl border border-border bg-surface-2 p-5 text-ink"
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
      setErr(e instanceof Error ? e.message : "error");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="mb-3 font-semibold">Crear room</h2>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder="nombre del room"
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <p className="mb-1 text-xs text-muted">Icono</p>
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
        <span>Privado (solo miembros invitados)</span>
      </label>
      {err && <p className="mb-3 text-sm text-red-400">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
          Cancelar
        </button>
        <button
          onClick={create}
          disabled={busy || !name.trim()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
    </Modal>
  );
}

function RoomSettingsModal({
  slug,
  onClose,
  onChanged,
  onDeleted,
}: {
  slug: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [members, setMembers] = useState<{ sub: string; name: string; email: string; avatar: string }[] | null>(null);
  const [users, setUsers] = useState<{ sub: string; handle: string; name: string; email: string; avatar: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setErr(e instanceof Error ? e.message : "error");
    }
    setBusy(false);
  }
  async function remove(sub: string) {
    await removeChannelMemberFn({ data: { slug, sub } }).catch(() => {});
    setMembers((m) => (m ? m.filter((x) => x.sub !== sub) : m));
    onChanged();
  }
  async function del() {
    if (!confirm("¿Eliminar este room y todos sus mensajes?")) return;
    await deleteChannelFn({ data: { slug } }).catch(() => {});
    onDeleted();
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="mb-3 font-semibold">Ajustes del room</h2>
      <p className="mb-1 text-xs font-medium text-muted">Miembros (rooms privados)</p>
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
            placeholder="nombre, @handle o email"
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
          />
        </div>
        <button
          onClick={() => invite()}
          disabled={busy}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          Invitar
        </button>
      </div>
      {err && <p className="mb-2 text-sm text-red-400">{err}</p>}
      <div className="mb-4 max-h-40 space-y-1 overflow-y-auto">
        {members === null ? (
          <p className="text-sm text-muted">Cargando…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted">Sin miembros aún (público = todos).</p>
        ) : (
          members.map((m) => (
            <div key={m.sub} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-3">
              <Avatar name={m.name} avatar={m.avatar} className="h-6 w-6" />
              <span className="min-w-0 flex-1 truncate text-sm">{m.email || m.name}</span>
              <button onClick={() => remove(m.sub)} className="text-xs text-muted hover:text-brand">
                sacar
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex justify-between">
        <button onClick={del} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-400/10">
          <Trash2 size={15} /> Eliminar room
        </button>
        <button onClick={onClose} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg">
          Listo
        </button>
      </div>
    </Modal>
  );
}

/* ── Flujo del canal ── */
function Flow({
  channel,
  messages,
  optimistic,
  onOptimistic,
  onOpenThread,
  onShowThreads,
  onRevalidate,
}: {
  channel: Channel;
  messages: Message[] | null;
  optimistic: Optimistic[];
  onOptimistic: (parentId: number | null, body: string) => void;
  onOpenThread: (id: number) => void;
  onShowThreads: () => void;
  onRevalidate: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = messages?.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [count, optimistic.length]);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <RoomIcon name={channel.icon} size={18} className="shrink-0 text-muted" />
          <div className="min-w-0">
            <h2 className="font-semibold leading-tight text-ink">{channel.name}</h2>
            <p className="text-xs text-muted">
              Escribe aquí · responde en hilo a cualquier mensaje · tagea{" "}
              <span className="text-brand">@ghosty</span>
            </p>
          </div>
        </div>
        <button
          onClick={onShowThreads}
          title="Ver todos los hilos"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-brand hover:text-ink"
        >
          <MessagesSquare size={15} /> Hilos
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
        {messages === null ? (
          <ThreadSkeleton />
        ) : messages.length === 0 && optimistic.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">
            Sé el primero en escribir en {channel.name}.
          </p>
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} m={m} onOpenThread={onOpenThread} showThreadLink />
          ))
        )}
        {optimistic.map((o) => (
          <OptimisticRow key={o.id} o={o} />
        ))}
      </div>
      <Composer
        slug={channel.slug}
        parentId={null}
        onOptimistic={onOptimistic}
        onOpenThread={onOpenThread}
        onRevalidate={onRevalidate}
        placeholder={`Mensaje a #${channel.name}…`}
      />
    </section>
  );
}

/* ── Panel de hilo (derecha) — carga client-side con skeleton, slide-in ── */
function ThreadPanel({
  channel,
  threadId,
  rev,
  optimistic,
  onOptimistic,
  onReloaded,
  onRevalidate,
  onGoToOrigin,
  onClose,
}: {
  channel: Channel;
  threadId: number;
  rev: number;
  optimistic: Optimistic[];
  onOptimistic: (parentId: number | null, body: string) => void;
  onReloaded: () => void;
  onRevalidate: () => void;
  onGoToOrigin: (id: number) => void;
  onClose: () => void;
}) {
  // Cacheado por threadId → reabrir el mismo hilo es instantáneo (sin skeleton).
  const data = useCachedQuery(
    threadCache,
    threadId,
    () => getThread({ data: { messageId: threadId } }),
    rev
  );
  useEffect(() => {
    if (data) onReloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <SlidePanel>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <RoomIcon name={channel.icon} size={15} className="shrink-0 text-muted" />
          <div className="min-w-0">
            <h2 className="font-semibold leading-tight text-ink">Hilo</h2>
            <p className="truncate text-xs text-muted">{channel.name}</p>
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-muted transition hover:text-ink" title="Cerrar hilo">
          <X size={18} />
        </button>
      </header>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
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
                  ↑ Ver en el room
                </button>
              </div>
            )}
            <div className="my-2 border-t border-border pt-1 text-center text-[11px] text-muted">
              {data.replies.length} {data.replies.length === 1 ? "respuesta" : "respuestas"}
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
        placeholder="Responder en el hilo…"
      />
    </SlidePanel>
  );
}

// Panel lateral que anima su ANCHO (no solo x) → al cerrar, el flujo rellena el
// hueco de forma continua (flex), sin el salto de golpe. Contenido a ancho fijo.
function SlidePanel({ children, width = 380 }: { children: React.ReactNode; width?: number }) {
  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 42 }}
      className="shrink-0 overflow-hidden border-l border-border bg-surface-2"
    >
      <div className="flex h-full flex-col" style={{ width }}>
        {children}
      </div>
    </motion.aside>
  );
}

/* ── Panel de LISTADO de hilos (Zulip discipline: no enterrarlos) ── */
function ThreadsListPanel({
  channel,
  isOwner,
  rev,
  onRevalidate,
  onOpenThread,
  onClose,
}: {
  channel: Channel;
  isOwner: boolean;
  rev: number;
  onRevalidate: () => void;
  onOpenThread: (id: number) => void;
  onClose: () => void;
}) {
  const threads = useCachedQuery(
    threadsCache,
    channel.slug,
    () => getChannelThreads({ data: { slug: channel.slug } }),
    rev
  );

  async function del(id: number) {
    await deleteMessageFn({ data: { id } }).catch(() => {});
    threadCache.delete(id);
    onRevalidate();
  }

  return (
    <SlidePanel width={360}>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessagesSquare size={16} className="shrink-0 text-muted" />
          <div className="min-w-0">
            <h2 className="font-semibold leading-tight text-ink">Hilos</h2>
            <p className="truncate text-xs text-muted">{channel.name}</p>
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-muted transition hover:text-ink" title="Cerrar">
          <X size={18} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        {!threads ? (
          <ThreadSkeleton />
        ) : threads.length === 0 ? (
          <p className="mt-8 text-center text-sm text-muted">
            Aún no hay hilos. Responde en hilo a un mensaje para crear el primero.
          </p>
        ) : (
          threads.map((t) => (
            <div key={t.id} className="group flex items-start gap-1 rounded-lg hover:bg-surface-3">
              <button
                onClick={() => onOpenThread(t.id)}
                className="min-w-0 flex-1 px-3 py-2 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-ink">
                    {t.agent_handle === "ghosty" || t.sender === "ghosty" ? (
                      <img src="/ghosty.svg" alt="" className="h-3.5 w-3.5 shrink-0" />
                    ) : t.agent_handle ? (
                      <Bot size={14} className="shrink-0 text-brand" />
                    ) : null}
                    <span className="truncate">{t.body.slice(0, 40)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
                    <MessageSquare size={12} /> {t.reply_count ?? 0}
                  </span>
                </div>
                <p className="truncate text-xs text-muted">por {t.sender}</p>
              </button>
              {isOwner && (
                <button
                  onClick={() => del(t.id)}
                  title="Eliminar hilo"
                  className="p-2 text-muted opacity-0 transition group-hover:opacity-100 hover:text-brand"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </SlidePanel>
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

function MessageRow({
  m,
  onOpenThread,
  showThreadLink,
}: {
  m: Message;
  onOpenThread?: (id: number) => void;
  showThreadLink?: boolean;
}) {
  const isAgent = m.agent_handle != null || m.sender === "ghosty";
  const isGhostyAvatar = m.agent_handle === "ghosty" || m.sender === "ghosty";
  const displayName = m.sender === "ghosty" ? "Ghosty" : m.sender;
  const time = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (m.kind === "status") {
    return (
      <div className="flex items-center gap-2 py-1 pl-12 text-xs text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
        <span className="italic">{m.body}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className="group flex gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
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
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${isAgent ? "text-brand" : "text-ink"}`}>
            {displayName}
          </span>
          <span className="text-[11px] text-muted">{time}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-ink">{renderBody(m.body)}</p>
        {showThreadLink && onOpenThread && (
          <div className="mt-1 flex items-center gap-3 text-xs">
            {m.reply_count ? (
              <button
                onClick={() => onOpenThread(m.id)}
                className="flex items-center gap-1.5 font-medium text-brand hover:underline"
              >
                <MessageSquare size={13} /> {m.reply_count} {m.reply_count === 1 ? "respuesta" : "respuestas"}
              </button>
            ) : (
              <button
                onClick={() => onOpenThread(m.id)}
                className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
              >
                Responder en hilo
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OptimisticRow({ o }: { o: Optimistic }) {
  return (
    <div className="flex gap-3 rounded-lg px-2 py-1.5 opacity-50">
      <Avatar name={o.sender} avatar={o.avatar} className="mt-0.5 h-9 w-9 !rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">{o.sender}</span>
          <span className="text-[11px] text-muted">enviando…</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-ink">{renderBody(o.body)}</p>
      </div>
    </div>
  );
}

function renderBody(body: string) {
  return body.split(/(@\w+)/g).map((chunk, i) =>
    /^@\w+$/.test(chunk) ? (
      <span key={i} className="rounded bg-brand/15 px-1 font-medium text-brand">
        {chunk}
      </span>
    ) : (
      <span key={i}>{chunk}</span>
    )
  );
}

/* ── Composer con typeahead de menciones + optimistic + @ghosty ── */
function Composer({
  slug,
  parentId,
  onOptimistic,
  onOpenThread,
  onRevalidate,
  placeholder,
}: {
  slug: string;
  parentId: number | null;
  onOptimistic: (parentId: number | null, body: string) => void;
  onOpenThread?: (id: number) => void;
  onRevalidate?: () => void;
  placeholder: string;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const mentions = useMentions();
  const [mq, setMq] = useState<string | null>(null);
  const [mSel, setMSel] = useState(0);
  const matches =
    mq === null ? [] : mentions.filter((a) => a.handle.startsWith(mq.toLowerCase()));

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setBody(val);
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
    if (!body.trim() || sending) return;
    const sent = body;
    setBody("");
    setSending(true);
    onOptimistic(parentId, sent);
    const r = await postMessage({ data: { slug, parentId, body: sent } });
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
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2">
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
                    {a.kind === "agent" ? (
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
          disabled={sending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}
