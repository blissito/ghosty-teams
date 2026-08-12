import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { MessageSquare, Radio, SmilePlus, Video, X } from "lucide-react";
import GhostyMascot from "../components/GhostyMascot";
import { Avatar } from "../components/Avatar";
import { Markdown } from "../components/Markdown";
import { eventFlowFn, eventPostFn, eventReactFn } from "../server/events/chat";
import { joinCallFn, requestCodeFn, verifyCodeFn } from "../server/events/identity";
import { useEventStream } from "../hooks/useEventStream";

// Un ROOM ABIERTO: /room/<slug>. Una sola página, para todo.
//
// ⚠️ Esto reemplaza a la pareja "puerta de registro + sala" y, sobre todo, reemplaza una
// réplica del chrome de Teams con rooms inventados alrededor. Aquella réplica se sentía
// falsa porque lo era, y con cualquier workspace pudiendo abrir rooms públicos era algo
// peor que feo: unos rooms de mentira en el dominio de un cliente, con su marca, parecen
// suyos. El modelo bueno es el de Discord — al invitado se le entrega UN room y nada más,
// no una barra lateral de puertas que no puede abrir.
//
// Las tres puertas, y el orden importa:
//   · cualquiera         → LEE. Sin dar nada, sin registro, al instante.
//   · correo verificado  → escribe y entra a la transmisión.
//   · miembro con sesión → todo, sin verificar nada.
//
// Leer libre es lo que engancha: quien llega ve una conversación viva en vez de un
// formulario. El correo se pide en el momento en que la persona ya quiere participar.

type RoomInfo = {
  title: string;
  mode: "webinar" | "taller";
  callOpen: boolean;
  /** Epoch UTC, o `null` si el room no tiene hora (siempre abierto). */
  startsAt: number | null;
  brand: { logo: string | null; name: string | null };
};

/**
 * Cuánto falta, en palabras. Devuelve `null` cuando ya empezó — a partir de ahí el
 * contador estorba, y un «hace 3 h» al lado del botón de entrar sólo diría que llegaste
 * tarde a algo que sigue pasando.
 */
export function faltan(startsAt: number, ahora: number): string | null {
  const s = startsAt - ahora;
  if (s <= 0) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `en ${d} ${d === 1 ? "día" : "días"}`;
  if (h > 0) return `en ${h} h ${m} min`;
  if (m > 0) return `en ${m} min`;
  // Bajo el minuto se deja de contar en segundos: un contador corriendo hacia cero
  // promete una precisión que ningún evento cumple, y a los 0 s quedaría en ridículo si
  // alguien se retrasa dos minutos.
  return "en unos momentos";
}

const loadRoom = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<RoomInfo | null> => {
    await (await import("../server/schema.server")).ensureSchema().catch(() => {});
    const { channelByShareSlug } = await import("../db.server");
    const ch = await channelByShareSlug(data.slug);
    if (!ch || !ch.call_mode) return null;
    // La marca REAL del tenant: el visitante viene por el cliente, no por nosotros. Los
    // colores y la tipografía ya entran solos por `/api/brand-css`, que el shell inyecta
    // en todas las rutas; aquí sólo hace falta el logo y el nombre.
    const brand = await import("../server/brand.server")
      .then((m) => m.activeBrandKit())
      .then((k) => ({ logo: k?.logoUrl ?? null, name: k?.name ?? null }))
      .catch(() => ({ logo: null, name: null }));
    return {
      title: ch.call_title || ch.name,
      mode: ch.call_mode,
      callOpen: ch.call_open === 1,
      startsAt: ch.starts_at ?? null,
      brand,
    };
  });

export const Route = createFileRoute("/room/$slug")({
  loader: async ({ params }) => {
    const info = await loadRoom({ data: { slug: params.slug } });
    if (!info) throw notFound();
    return info;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? loaderData.title : "Room" },
      // Un room abierto es público, pero no es una página que queramos indexada: su
      // contenido lo escribe gente que no eligió salir en Google.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RoomAbierto,
});

type Reaccion = { emoji: string; count: number; mine: boolean };
type Msg = {
  id: number; sender: string; avatar: string; body: string; created_at: number;
  mine: boolean; isAgent: boolean; reactions: Reaccion[];
};

/** Las de un vistazo. Un selector completo de emoji es otra pieza; esto cubre el 90%. */
const RAPIDAS = ["👏", "🔥", "❤️", "😂", "🤔", "👍"];

function RoomAbierto() {
  const data = Route.useLoaderData();
  const { slug } = Route.useParams();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [online, setOnline] = useState(1);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [identificando, setIdentificando] = useState(false);
  const [callUrl, setCallUrl] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  // Nace ABIERTO: el chat es la mitad de para qué existe el room, y esconderlo por
  // defecto obliga a descubrirlo. En móvil se abre encima, así que ahí arranca cerrado
  // para no tapar el video nada más entrar.
  const [chatAbierto, setChatAbierto] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 640
  );
  const [err, setErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  // Mi `sub`, para saber si una reacción que llega por el bus es mía. Lo devuelve el
  // propio toggle: no hace falta pedirlo aparte.
  const miSub = useRef<string | null>(null);

  // El reloj avanza cada 30 s, no cada segundo: lo que se pinta son minutos, así que un
  // tick por segundo serían 60 renders para cambiar nada.
  const [ahora, setAhora] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!data.startsAt) return;
    const t = setInterval(() => setAhora(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, [data.startsAt]);
  const cuantoFalta = data.startsAt ? faltan(data.startsAt, ahora) : null;
  const yaEmpezo = !!data.startsAt && !cuantoFalta;

  const traerNuevos = useCallback(async () => {
    try {
      const r = await eventFlowFn({ data: { slug, after: lastId.current } });
      if (!r.ok) return;
      setCanWrite(r.canWrite);
      if (!r.messages.length) return;
      lastId.current = r.messages[r.messages.length - 1].id;
      setMessages((prev) => {
        // El stream y el sondeo pueden traer el MISMO mensaje. Sin deduplicar por id, sale
        // dos veces.
        const vistos = new Set(prev.map((m) => m.id));
        return [...prev, ...r.messages.filter((m) => !vistos.has(m.id))].slice(-200);
      });
    } catch {
      /* un sondeo perdido se recupera en el siguiente */
    }
  }, [slug]);

  useEventStream(slug, (ev) => {
    if (ev.t === "event:presence") return setOnline(ev.count);
    // ⚠️ Una reacción se aplica AQUÍ, sobre el estado, y no re-pidiendo el flujo: el
    // sondeo va con `after`, o sea que sólo trae mensajes NUEVOS. Reaccionar a algo de
    // hace un minuto no cambia ningún id, así que por esa vía no llegaría nunca.
    if (ev.t === "reaction") {
      const { messageId, emoji, op, count, userSub } = ev;
      return setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          const otras = m.reactions.filter((x) => x.emoji !== emoji);
          if (count <= 0) return { ...m, reactions: otras };
          const previa = m.reactions.find((x) => x.emoji === emoji);
          // `mine` sólo cambia si el evento es MÍO; el de otra persona no puede alterar
          // si yo reaccioné o no.
          const mine = userSub === miSub.current ? op === "add" : !!previa?.mine;
          return { ...m, reactions: [...otras, { emoji, count, mine }] };
        })
      );
    }
    if (ev.t === "message:new" || ev.t === "message:body" || ev.t === "message:edited" || ev.t === "refresh") {
      void traerNuevos();
    }
  });

  // El sondeo se queda como RED del stream (un hueco de SSE, la red del móvil cambiando de
  // antena, un deploy). `after` hace que sólo pida lo que le falta.
  useEffect(() => {
    let vivo = true;
    const tick = () => { if (vivo) void traerNuevos(); };
    tick();
    const t = setInterval(tick, 15000);
    return () => { vivo = false; clearInterval(t); };
  }, [traerNuevos]);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    // Escribir es el momento en que se pide el correo — no antes. La persona ya redactó su
    // mensaje: se le guarda y se manda en cuanto se identifique.
    if (!canWrite) return setIdentificando(true);
    setSending(true);
    setText("");
    try {
      const r = await eventPostFn({ data: { slug, body } });
      if (!r.ok) setErr(r.error);
      await traerNuevos();
    } catch {
      setText(body); // perder lo que alguien acaba de escribir es de lo que más molesta
    }
    setSending(false);
  }

  async function reaccionar(messageId: number, emoji: string) {
    if (!canWrite) return setIdentificando(true);
    // Optimista: la reacción se pinta al instante y el evento del bus la reconcilia con
    // el conteo autoritativo. Esperar el round-trip para ver tu propio 👏 se siente roto.
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const previa = m.reactions.find((x) => x.emoji === emoji);
        const otras = m.reactions.filter((x) => x.emoji !== emoji);
        if (previa?.mine) {
          return previa.count <= 1
            ? { ...m, reactions: otras }
            : { ...m, reactions: [...otras, { emoji, count: previa.count - 1, mine: false }] };
        }
        return { ...m, reactions: [...otras, { emoji, count: (previa?.count ?? 0) + 1, mine: true }] };
      })
    );
    try {
      await eventReactFn({ data: { slug, messageId, emoji } });
    } catch {
      // Se recupera solo: el siguiente sondeo trae el conteo de verdad.
    }
  }

  async function entrarALlamada() {
    if (!canWrite) return setIdentificando(true);
    setCallBusy(true);
    setErr(null);
    try {
      // El ticket se acuña AHORA: dura 120 s y es de un solo uso. Acuñarlo al cargar la
      // página lo dejaría muerto para quien lleva media hora leyendo.
      const r = await joinCallFn({ data: { slug } });
      if (r.ok) setCallUrl(r.url);
      else setErr(r.error);
    } catch {
      setErr("No pude abrir la sala. Intenta de nuevo.");
    }
    setCallBusy(false);
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        {data.brand.logo ? (
          <img src={data.brand.logo} alt={data.brand.name ?? ""} className="h-7 w-auto max-w-[140px] object-contain" />
        ) : (
          <GhostyMascot className="h-7 w-7" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{data.title}</h1>
            <Radio size={13} className="shrink-0 text-brand" />
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {online} por aquí
            </span>
            {data.startsAt && (
              <>
                <span aria-hidden className="text-muted/50">·</span>
                {/* La hora se pinta en el reloj de QUIEN MIRA, no en el del dueño: un
                    webinar se anuncia a gente de varias zonas horarias. */}
                <span>
                  {new Date(data.startsAt * 1000).toLocaleString([], {
                    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
                  })}
                </span>
                {cuantoFalta && <span className="font-medium text-brand">· {cuantoFalta}</span>}
              </>
            )}
          </p>
        </div>
        {data.callOpen && !callUrl && (
          <button
            onClick={entrarALlamada}
            disabled={callBusy}
            // A la hora del evento el botón deja de ser un detalle de la cabecera: es lo
            // que la gente vino a hacer. Antes de la hora se queda discreto para no
            // invitar a despertar la caja media hora antes de tiempo.
            className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium disabled:opacity-60 ${
              yaEmpezo || !data.startsAt
                ? "bg-brand text-sm text-white"
                : "border border-border bg-transparent text-xs text-muted hover:text-ink"
            }`}
          >
            <Video size={14} />
            {callBusy ? "Abriendo la sala…" : "Entrar a la transmisión"}
          </button>
        )}
      </header>

      {/* El video sólo existe DESPUÉS de pulsar. Nunca se pre-carga: la caja puede estar
          dormida y pedirle algo la despierta — no se despierta porque alguien pase por
          aquí, sólo porque alguien entre de verdad.
          ⚠️ A PANTALLA COMPLETA, y no en una franja arriba del chat. En una franja, el
          lobby de LiveKit —vista previa de cámara, dos selectores, nombre y el botón de
          entrar— no cabe: quedaba cortado por abajo y **el botón de entrar era
          inalcanzable**, con lo que la sala parecía rota justo en el paso que importa.
          Entrar a la transmisión es un MODO, no un panel. */}
      {callUrl && (
        <div className="fixed inset-0 z-40 flex bg-black">
          {/* El video y el chat CONVIVEN: el chat le quita ancho a la transmisión en vez
              de taparla. Es lo que un webinar necesita —la gente pregunta mientras mira—,
              y un panel encima obliga a elegir entre las dos cosas.
              Contrapartida asumida: al abrirlo o cerrarlo, LiveKit re-hace su grid de
              tiles. Se paga una vez por clic, y el chat se queda abierto casi siempre. */}
          <div className="relative min-w-0 flex-1">
            <iframe
              src={callUrl}
              title={data.title}
              className="h-full w-full border-0"
              allow="camera; microphone; display-capture; autoplay; fullscreen; speaker-selection"
              allowFullScreen
            />

            <div className="absolute right-4 top-4 flex items-center gap-2">
              <button
                onClick={() => setChatAbierto((v) => !v)}
                className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85"
              >
                <MessageSquare size={14} /> {chatAbierto ? "Ocultar chat" : "Chat"}
              </button>
              <button
                onClick={() => setCallUrl(null)}
                className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85"
              >
                {/* ⚠️ Dice "salir" y no "volver al chat" porque esto DESMONTA el iframe: se
                    abandona la llamada de verdad, y volver a entrar cuesta un ticket
                    nuevo. Con el chat al lado, nadie necesita salirse para leerlo — que
                    era justo la confusión que este botón invitaba a cometer. */}
                <X size={14} /> Salir
              </button>
            </div>
          </div>

          {/* En MÓVIL no hay ancho que repartir: ahí sí se superpone, porque partir 380px
              en dos deja el video del tamaño de un sello y el chat ilegible. */}
          <aside
            // Superficies NORMALES del producto, no un negro forzado: con el tema claro, el
            // texto del markdown (`text-ink`) quedaba negro sobre negro.
            className={`${chatAbierto ? "flex" : "hidden"} absolute inset-y-0 right-0 z-10 w-full flex-col border-l border-border bg-surface sm:relative sm:z-0 sm:w-80 sm:shrink-0 lg:w-96`}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">Chat</span>
              <button onClick={() => setChatAbierto(false)} aria-label="Cerrar el chat" className="text-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <Mensajes messages={messages} onReaccionar={reaccionar} />
            <Composer
              text={text}
              setText={setText}
              onSubmit={enviar}
              sending={sending}
              canWrite={canWrite}
            />
          </aside>
        </div>
      )}

      <Mensajes messages={messages} bottomRef={bottomRef} onReaccionar={reaccionar} />

      {err && <p className="px-4 pb-1 text-center text-xs text-red-400">{err}</p>}

      <div className="mx-auto w-full max-w-3xl shrink-0">
        <Composer text={text} setText={setText} onSubmit={enviar} sending={sending} canWrite={canWrite} />
      </div>

      <footer className="shrink-0 pb-3 text-center text-[11px] text-muted">
        <a href="https://ghosty.studio" target="_blank" rel="noreferrer" className="hover:text-brand">
          Hecho con Ghosty Teams
        </a>
      </footer>

      {identificando && (
        <Identificarse
          slug={slug}
          onListo={() => {
            setIdentificando(false);
            setCanWrite(true);
          }}
          onCerrar={() => setIdentificando(false)}
        />
      )}
    </div>
  );
}

/**
 * La lista de mensajes. Se usa en la página y dentro del cajón de la llamada, con la MISMA
 * fuente de datos: si fueran dos listas separadas, una se quedaría atrás en cuanto alguien
 * escribiera durante la transmisión, que es justo cuando más se escribe.
 */
function Mensajes({
  messages,
  bottomRef,
  onReaccionar,
}: {
  messages: Msg[];
  bottomRef?: React.RefObject<HTMLDivElement | null>;
  onReaccionar: (messageId: number, emoji: string) => void;
}) {
  const propio = useRef<HTMLDivElement>(null);
  const fin = bottomRef ?? propio;
  // El panel de la llamada se monta con la conversación ya empezada: sin esto abre arriba
  // del todo y hay que bajar a mano hasta lo último, que es lo único que interesa.
  useEffect(() => { fin.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, fin]);

  return (
    <div className="w-full flex-1 space-y-3 overflow-y-auto px-4 py-5">
      {messages.length === 0 && (
        <p className="text-sm text-muted">Todavía no hay mensajes. Sé quien empiece 👋</p>
      )}
      {messages.map((m, i) => {
        // Agrupación estilo Slack: mensajes seguidos de la misma persona dentro de ~5 min
        // se colapsan y no repiten avatar ni nombre. Sin esto, quien escribe tres líneas
        // seguidas ocupa media pantalla con su propia cara.
        const prev = messages[i - 1];
        const junto =
          !!prev && prev.sender === m.sender && prev.isAgent === m.isAgent && m.created_at - prev.created_at < 300;
        return (
          <div key={m.id} className={`flex gap-2.5 ${junto ? "mt-0.5" : ""}`}>
            <div className="w-8 shrink-0">
              {!junto && <Avatar name={m.sender} avatar={m.avatar || undefined} className="h-8 w-8" />}
            </div>
            <div className="min-w-0 flex-1">
              {!junto && (
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-semibold ${m.isAgent ? "text-brand" : ""}`}>{m.sender}</span>
                  {m.isAgent && (
                    <span className="rounded bg-brand/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-brand">
                      Agente
                    </span>
                  )}
                  <span className="text-[11px] text-muted">
                    {new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              )}
              {/* El MISMO renderizador que el chat de Teams: negritas, listas, código,
                  enlaces y emojis. Antes era texto pelado, y el agente contesta en
                  markdown — o sea que sus respuestas llegaban con los asteriscos a la
                  vista. */}
              <div className="text-sm leading-relaxed">
                <Markdown body={m.body} />
              </div>
              <Reacciones msg={m} onReaccionar={onReaccionar} />
            </div>
          </div>
        );
      })}
      <div ref={fin} />
    </div>
  );
}

/**
 * Las reacciones de un mensaje, y el atajo para poner una.
 *
 * El selector rápido aparece al pasar el ratón (y en móvil, con el botón "+", porque ahí
 * no hay hover y sin eso reaccionar sería imposible en la mitad de los dispositivos).
 */
function Reacciones({ msg, onReaccionar }: { msg: Msg; onReaccionar: (id: number, emoji: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const puestas = [...msg.reactions].sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

  return (
    <div className="group/react mt-1 flex flex-wrap items-center gap-1">
      {puestas.map((r) => (
        <button
          key={r.emoji}
          onClick={() => onReaccionar(msg.id, r.emoji)}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition ${
            r.mine ? "border-brand bg-brand/15 text-brand" : "border-border bg-card text-muted hover:border-brand/50"
          }`}
        >
          <span>{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          onClick={() => setAbierto((v) => !v)}
          aria-label="Reaccionar"
          className={`rounded-full border border-border px-1.5 py-0.5 text-xs text-muted hover:border-brand/50 hover:text-brand ${
            puestas.length ? "" : "opacity-0 group-hover/react:opacity-100 focus:opacity-100"
          }`}
        >
          <SmilePlus size={13} />
        </button>
        {abierto && (
          <div className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-full border border-border bg-card p-1 shadow-lg">
            {RAPIDAS.map((e) => (
              <button
                key={e}
                onClick={() => { onReaccionar(msg.id, e); setAbierto(false); }}
                className="rounded-full px-1.5 py-0.5 text-base hover:bg-surface-2"
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  text,
  setText,
  onSubmit,
  sending,
  canWrite,
}: {
  text: string;
  setText: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  sending: boolean;
  canWrite: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="shrink-0 px-4 pb-3 pt-1">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={canWrite ? "Escribe un mensaje…" : "Escribe para participar…"}
          maxLength={1000}
          // ⚠️ `text-base` y no `text-sm`: por debajo de 16px, iOS hace zoom al enfocar un
          // campo y NO vuelve. Es la misma razón por la que styles.css conserva uno de sus
          // pocos `!important`.
          className="min-w-0 flex-1 rounded-xl border border-border bg-card px-3.5 py-2.5 text-base outline-none focus:border-brand"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}

/**
 * Nombre + correo → código de 6 dígitos → dentro.
 *
 * ⚠️ Código y no liga mágica: una liga abre una PESTAÑA NUEVA y quien la pulsa pierde el
 * room donde estaba leyendo. En un evento en vivo es justo el peor momento. El código se
 * pega aquí mismo y la persona no se mueve de la página.
 */
function Identificarse({ slug, onListo, onCerrar }: { slug: string; onListo: () => void; onCerrar: () => void }) {
  const [paso, setPaso] = useState<"datos" | "codigo">("datos");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // El reenvío se ofrece a los 30 s: antes de eso, el correo casi siempre está en camino y
  // un segundo código sólo confunde (llega el viejo, y el que sirve es el nuevo).
  const [puedeReenviar, setPuedeReenviar] = useState(false);

  useEffect(() => {
    if (paso !== "codigo") return;
    setPuedeReenviar(false);
    const t = setTimeout(() => setPuedeReenviar(true), 30000);
    return () => clearTimeout(t);
  }, [paso]);

  async function pedirCodigo(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await requestCodeFn({ data: { slug, name, email } });
      if (r.ok) setPaso("codigo");
      else setErr(r.error);
    } catch {
      setErr("No pude mandarte el código. Intenta de nuevo.");
    }
    setBusy(false);
  }

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await verifyCodeFn({ data: { slug, email, code } });
      if (r.ok) onListo();
      else setErr(r.error);
    } catch {
      setErr("No pude confirmarlo. Intenta de nuevo.");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">
              {paso === "datos" ? "Preséntate para participar" : "Revisa tu correo"}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {paso === "datos"
                ? "Leer es libre. Para escribir y entrar a la transmisión necesitamos saber quién eres."
                : `Te mandamos un código de 6 dígitos a ${email}. Míralo también en spam.`}
            </p>
          </div>
          <button onClick={onCerrar} aria-label="Cerrar" className="shrink-0 text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        {paso === "datos" ? (
          <form onSubmit={pedirCodigo} className="space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tu nombre"
              autoFocus
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="tu@correo.com"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand"
            />
            {err && <p className="text-xs text-red-400">{err}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy ? "Mandando…" : "Mandarme el código"}
            </button>
          </form>
        ) : (
          <form onSubmit={confirmar} className="space-y-3">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              autoFocus
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-center text-2xl tracking-[0.4em] outline-none focus:border-brand"
            />
            {err && <p className="text-xs text-red-400">{err}</p>}
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="w-full rounded-lg bg-brand py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy ? "Comprobando…" : "Entrar"}
            </button>
            <button
              type="button"
              onClick={() => pedirCodigo()}
              disabled={!puedeReenviar || busy}
              className="w-full text-xs text-muted hover:text-brand disabled:opacity-50"
            >
              {puedeReenviar ? "Mandar otro código" : "Mandar otro código (espera unos segundos)"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
