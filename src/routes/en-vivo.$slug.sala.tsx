import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { eventFlowFn, eventPostFn } from "../server/events/chat";

// La sala del evento: el video de la caja de LiveKit embebido, y el chat al lado.
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

export const Route = createFileRoute("/en-vivo/$slug/sala")({
  loader: async ({ params }) => {
    const d = await loadSala({ data: { slug: params.slug } });
    if (!d) throw notFound();
    if ("needsRegistration" in d) throw redirect({ to: "/en-vivo/$slug", params: { slug: params.slug } });
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
  const [openChat, setOpenChat] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  // Sondeo y no SSE: el stream de Teams exige sesión de miembro, y abrirlo a
  // invitados obligaría a tocar justo la puerta que este módulo evita tocar.
  // Con una sesión de una tarde, un GET cada 4 s es más barato que ese riesgo.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await eventFlowFn({ data: { slug, after: lastId.current } });
        if (!alive || !r.ok || !r.messages.length) return;
        lastId.current = r.messages[r.messages.length - 1].id;
        setMessages((prev) => [...prev, ...r.messages].slice(-200));
      } catch {
        /* un sondeo perdido se recupera en el siguiente */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [slug]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await eventPostFn({ data: { slug, body } });
      const r = await eventFlowFn({ data: { slug, after: lastId.current } });
      if (r.ok && r.messages.length) {
        lastId.current = r.messages[r.messages.length - 1].id;
        setMessages((prev) => [...prev, ...r.messages].slice(-200));
      }
    } catch {
      // Se devuelve el texto al campo: perder lo que alguien acaba de escribir
      // por un fallo de red es de las cosas que más molestan de un chat.
      setText(body);
    }
    setSending(false);
  }

  return (
    <div className="h-dvh flex flex-col md:flex-row bg-[var(--color-bg)]">
      <div className="flex-1 min-h-0 relative">
        {/* `allow` explícito: sin él el navegador bloquea cámara y micrófono
            dentro del iframe y la sala parece rota sin decir por qué. */}
        <iframe
          src={data.roomUrl}
          title={data.title}
          className="w-full h-full border-0"
          allow="camera; microphone; display-capture; autoplay; fullscreen; speaker-selection"
          allowFullScreen
        />
        <button
          onClick={() => setOpenChat((v) => !v)}
          className="md:hidden absolute top-3 right-3 rounded-full bg-black/70 text-white px-4 py-2 text-sm font-medium"
        >
          {openChat ? "Ver sala" : "Chat"}
        </button>
      </div>

      <aside
        className={`${openChat ? "flex" : "hidden"} md:flex w-full md:w-80 lg:w-96 shrink-0 flex-col border-t md:border-t-0 md:border-l border-[var(--color-border)] bg-[var(--color-card)]`}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="font-semibold text-sm truncate">{data.title}</div>
          <div className="text-xs text-[var(--color-muted)]">
            {data.me.name}{data.me.isHost ? " · moderas" : ""}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <p className="text-xs text-[var(--color-muted)]">Aún no hay mensajes. Saluda 👋</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="text-sm">
              <span className={`font-medium ${m.isAgent ? "text-[var(--color-accent)]" : ""}`}>{m.sender}</span>
              <span className="text-[10px] text-[var(--color-muted)] ml-2">
                {new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={send} className="p-3 border-t border-[var(--color-border)] flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe un mensaje…"
            maxLength={1000}
            className="flex-1 min-w-0 rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-base"
          />
          <button
            type="submit" disabled={sending || !text.trim()}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </aside>
    </div>
  );
}
