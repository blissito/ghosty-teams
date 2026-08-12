import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { Menu, Radio } from "lucide-react";
import { eventFlowFn, eventPostFn } from "../server/events/chat";
import { useEventStream } from "../hooks/useEventStream";
import { EventArtifacts, EventSidebar } from "../components/EventShowcase";

// La sala del evento: el video de la caja de LiveKit embebido, y el chat al lado.
//
// ⚠️ El archivo se llama `room.$slug_.sala.tsx` con GUION BAJO en `$slug_`, y
// no es cosmético: sin él, TanStack anida esta ruta DENTRO de `room.$slug` y,
// como aquel componente no pinta ningún <Outlet/>, la sala no se renderiza nunca.
// El síntoma es de los que engañan — la URL cambia a /sala, la navegación
// "funciona", y en pantalla sigue el formulario de registro vacío, o sea que
// parece que el registro no guardó. El guion bajo saca a la hija del layout de
// la madre.
//
// Por qué embebida y no mandando a la gente a la URL de la caja: allá no existe
// el chat, ni el agente, ni queda historial. Y de paso el TICKET deja de viajar
// por la barra de direcciones — se acuña aquí, por carga de página, y sólo llega
// al `src` del iframe. Un ticket copiable es un ticket que alguien reenvía, y
// como es de un solo uso el primero que lo abra deja fuera a su dueño.

type SalaData = {
  title: string;
  mode: "webinar" | "taller";
  roomUrl: string;
  me: { name: string; isHost: boolean };
};

const loadSala = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<SalaData | { needsRegistration: true } | null> => {
    await (await import("../server/schema.server")).ensureSchema().catch(() => {});
    const db = await import("../db.server");
    const ch = await db.channelByShareSlug(data.slug);
    if (!ch || !ch.call_mode) return null;

    const { eventViewerFor, roomUrlFor } = await import("../server/events/access.server");
    const viewer = await eventViewerFor(ch);
    // Sin registro no hay sala, pero tampoco un 404: se le manda a registrarse.
    // Es el caso normal de quien abre la liga directa o vuelve días después con
    // la cookie ya vencida.
    if (!viewer) return { needsRegistration: true };

    const roomUrl = await roomUrlFor(ch, viewer);
    if (!roomUrl) return null;

    return {
      title: ch.call_title || ch.name,
      mode: ch.call_mode,
      roomUrl,
      me: { name: viewer.name, isHost: viewer.isHost },
    };
  });

export const Route = createFileRoute("/room/$slug_/sala")({
  loader: async ({ params }) => {
    const d = await loadSala({ data: { slug: params.slug } });
    if (!d) throw notFound();
    if ("needsRegistration" in d) throw redirect({ to: "/room/$slug", params: { slug: params.slug } });
    return d;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} — en vivo` : "En vivo" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Sala,
});

type ChatMsg = { id: number; sender: string; body: string; created_at: number; mine: boolean; isAgent: boolean };

function Sala() {
  const data = Route.useLoaderData();
  const { slug } = Route.useParams();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(true);
  const [online, setOnline] = useState(1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  // Trae lo que falte desde `lastId`. Es a la vez el catch-up del arranque, la red del
  // sondeo y lo que se llama cuando el stream avisa de algo que no trae cuerpo.
  const traerNuevos = useCallback(async () => {
    try {
      const r = await eventFlowFn({ data: { slug, after: lastId.current } });
      if (!r.ok || !r.messages.length) return;
      lastId.current = r.messages[r.messages.length - 1].id;
      setMessages((prev) => {
        // El SSE y el sondeo pueden traer el MISMO mensaje: el stream lo entrega al
        // instante y el sondeo lo vuelve a pedir si su `after` iba atrasado. Sin
        // deduplicar por id, un mensaje aparecía dos veces.
        const vistos = new Set(prev.map((m) => m.id));
        return [...prev, ...r.messages.filter((m) => !vistos.has(m.id))].slice(-200);
      });
    } catch {
      /* un sondeo perdido se recupera en el siguiente */
    }
  }, [slug]);

  // Tiempo real. El sondeo se QUEDA, cada 15 s en vez de cada 4: es la red por si el
  // stream tiene un hueco (la VM suspendida, un deploy, la red del móvil cambiando de
  // antena), y `after` hace que sólo pida lo que le falta. Bajar de 4 s a 15 s con SSE
  // encima es menos tráfico y aun así más rápido.
  useEventStream(slug, (ev) => {
    if (ev.t === "event:presence") {
      setOnline(ev.count);
      return;
    }
    // Todo lo que toca el flujo se resuelve pidiendo lo nuevo, en vez de reconstruir el
    // mensaje desde el evento: el `msg` del bus y lo que devuelve `eventFlowFn` no tienen
    // la misma forma (`mine`, `isAgent`), y mantener dos mapeos que no divergan cuesta
    // más que un GET.
    if (ev.t === "message:new" || ev.t === "message:body" || ev.t === "message:edited" || ev.t === "refresh") {
      void traerNuevos();
    }
  });

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) void traerNuevos(); };
    tick();
    const t = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [traerNuevos]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await eventPostFn({ data: { slug, body } });
      await traerNuevos();
    } catch {
      // Se devuelve el texto al campo: perder lo que alguien acaba de escribir
      // por un fallo de red es de las cosas que más molestan de un chat.
      setText(body);
    }
    setSending(false);
  }

  return (
    <div className="h-dvh flex bg-surface overflow-hidden">
      {/* ── Sidebar de escaparate ──────────────────────────────────────────
          En MÓVIL nace oculta y es un cajón: quien entra a un webinar desde el
          teléfono viene a ver el video, y una barra de adorno comiéndose media
          pantalla convierte el escaparate en un estorbo. */}
      <aside
        className={`${navOpen ? "flex" : "hidden"} md:flex absolute md:relative inset-y-0 left-0 z-30 w-60 shrink-0 flex-col border-r border-border`}
      >
        <EventSidebar eventName={data.title} online={online} />
      </aside>
      {navOpen && (
        <button
          aria-label="Cerrar menú"
          onClick={() => setNavOpen(false)}
          className="md:hidden fixed inset-0 z-20 bg-black/40"
        />
      )}

      {/* ── El room del evento: lo único vivo ───────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Abrir menú"
            className="md:hidden rounded-lg p-1.5 text-muted hover:bg-surface-2"
          >
            <Menu size={18} />
          </button>
          <Radio size={16} className="shrink-0 text-brand" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{data.title}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className="truncate">{data.me.name}{data.me.isHost ? " · moderas" : ""}</span>
              {/* Presencia de la SALA, no del workspace: la señal de que hay alguien
                  más del otro lado, que es justo lo que no se sabe al entrar por una
                  liga. Nunca sale de aquí un nombre del equipo del cliente. */}
              <span aria-hidden className="text-muted/50">·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {online} en la sala
              </span>
            </div>
          </div>
          <button
            onClick={() => setVideoOpen((v) => !v)}
            className="ml-auto shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2"
          >
            {videoOpen ? "Ocultar video" : "Ver video"}
          </button>
        </header>

        {/* El video vive DENTRO del room, colapsable. Se desmonta al ocultarlo a
            propósito: dejarlo montado mantendría la conexión de LiveKit —y el
            micrófono— viva detrás de un `display:none`. */}
        {videoOpen && (
          <div className="relative shrink-0 border-b border-border bg-black" style={{ height: "min(52vh, 460px)" }}>
            {/* `allow` explícito: sin él el navegador bloquea cámara y micrófono
                dentro del iframe y la sala parece rota sin decir por qué. */}
            <iframe
              src={data.roomUrl}
              title={data.title}
              className="h-full w-full border-0"
              allow="camera; microphone; display-capture; autoplay; fullscreen; speaker-selection"
              allowFullScreen
            />
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {messages.length === 0 && (
            <p className="text-xs text-muted">Aún no hay mensajes. Saluda 👋</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="text-sm">
              <span className={`font-medium ${m.isAgent ? "text-brand" : ""}`}>{m.sender}</span>
              <span className="ml-2 text-[10px] text-muted">
                {new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe un mensaje…"
            maxLength={1000}
            className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-base"
          />
          <button
            type="submit" disabled={sending || !text.trim()}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </main>

      {/* Panel derecho sólo en pantallas anchas: en un portátil estrecho le robaría
          espacio a lo que sí funciona. */}
      <aside className="hidden w-64 shrink-0 xl:block">
        <EventArtifacts />
      </aside>
    </div>
  );
}
