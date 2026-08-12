import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { MessageSquare, Radio, Video, X } from "lucide-react";
import GhostyMascot from "../components/GhostyMascot";
import { eventFlowFn, eventPostFn } from "../server/events/chat";
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

type Msg = { id: number; sender: string; body: string; created_at: number; mine: boolean; isAgent: boolean };

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
  const [chatAbierto, setChatAbierto] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

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
        <div className="fixed inset-0 z-40 bg-black">
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
                  abandona la llamada de verdad, y volver a entrar cuesta un ticket nuevo.
                  Ahora que el chat es un cajón AQUÍ MISMO, nadie necesita salirse para
                  leerlo — que era justo la confusión que este botón invitaba a cometer. */}
              <X size={14} /> Salir
            </button>
          </div>

          {/* El chat como CAJÓN sobre el video. Se superpone en vez de encoger el iframe
              porque redimensionar un iframe de LiveKit lo obliga a re-hacer su layout de
              tiles: en una llamada de verdad eso es un parpadeo cada vez que alguien abre
              o cierra el chat. */}
          <aside
            className={`absolute inset-y-0 right-0 z-10 flex w-full flex-col border-l border-white/10 bg-black/85 backdrop-blur transition-transform duration-200 sm:w-96 ${
              chatAbierto ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 text-white">
              <span className="text-sm font-semibold">Chat</span>
              <button onClick={() => setChatAbierto(false)} aria-label="Cerrar el chat" className="text-white/60 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <Mensajes messages={messages} oscuro />
            <Composer
              text={text}
              setText={setText}
              onSubmit={enviar}
              sending={sending}
              canWrite={canWrite}
              oscuro
            />
          </aside>
        </div>
      )}

      <Mensajes messages={messages} bottomRef={bottomRef} />

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
  oscuro,
}: {
  messages: Msg[];
  bottomRef?: React.RefObject<HTMLDivElement | null>;
  oscuro?: boolean;
}) {
  const propio = useRef<HTMLDivElement>(null);
  const fin = bottomRef ?? propio;
  // El cajón se monta con la conversación ya empezada: sin esto abre arriba del todo y
  // hay que bajar a mano hasta lo último, que es lo único que interesa.
  useEffect(() => { fin.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, fin]);

  return (
    <div
      className={`w-full flex-1 space-y-4 overflow-y-auto px-4 py-5 ${
        oscuro ? "text-white" : "mx-auto max-w-3xl"
      }`}
    >
      {messages.length === 0 && (
        <p className={`text-sm ${oscuro ? "text-white/60" : "text-muted"}`}>
          Todavía no hay mensajes. Sé quien empiece 👋
        </p>
      )}
      {messages.map((m) => (
        <div key={m.id} className="text-sm">
          <span className={`font-semibold ${m.isAgent ? "text-brand" : ""}`}>{m.sender}</span>
          <span className={`ml-2 text-[11px] ${oscuro ? "text-white/50" : "text-muted"}`}>
            {new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <div className="whitespace-pre-wrap break-words leading-relaxed">{m.body}</div>
        </div>
      ))}
      <div ref={fin} />
    </div>
  );
}

function Composer({
  text,
  setText,
  onSubmit,
  sending,
  canWrite,
  oscuro,
}: {
  text: string;
  setText: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  sending: boolean;
  canWrite: boolean;
  oscuro?: boolean;
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
          className={`min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 text-base outline-none focus:border-brand ${
            oscuro ? "border-white/15 bg-white/10 text-white placeholder:text-white/40" : "border-border bg-card"
          }`}
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
