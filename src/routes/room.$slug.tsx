import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { Circle, MessageSquare, Paperclip, Square, X } from "lucide-react";
import GhostyMascot from "../components/GhostyMascot";
import { ChatCtx, ChatCtxDefaults, MessageRow, type SessionUser } from "../components/chat/message";
import type { Message, CustomEmoji, ReactionAgg } from "../db.server";
import { eventFlowFn, eventPostFn, eventReactFn } from "../server/events/chat";
import { recordingFn, requestCodeFn, verifyCodeFn } from "../server/events/identity";
import { useEventStream } from "../hooks/useEventStream";
import { shouldChime } from "../lib/chime";
import { DropOverlay, useAdjuntos, useFileDrop } from "../components/chat/adjuntos";
import { playGhostySound, playMentionSound, playNotificationSound, playSelfSound } from "../utils/notificationSound";

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
  /** La grabación, si la hay. Quien llega tarde suele venir sólo por esto. */
  recordingUrl: string | null;
  /**
   * La URL de la llamada, YA FIRMADA, cuando quien abre puede entrar.
   *
   * ⚠️ Se acuña en el LOADER y no al pulsar. Con el minteo en el cliente siempre había
   * un hueco —medio segundo de pantalla intermedia mientras iba y volvía la llamada—, y
   * ese paso es justo el que sobra: se llega a la llamada, no a una antesala.
   * El ticket dura 120 s y aquí se usa en el mismo instante, así que le sobra de largo.
   */
  callUrl: string | null;
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
    // Sólo si la llamada está abierta Y quien abre puede entrar (miembro, o invitado con
    // el correo verificado). Un anónimo recibe `null` y su puerta es el chat.
    let callUrl: string | null = null;
    if (ch.call_open === 1) {
      const { eventViewerFor, roomUrlFor } = await import("../server/events/access.server");
      const viewer = await eventViewerFor(ch).catch(() => null);
      if (viewer) callUrl = await roomUrlFor(ch, viewer).catch(() => null);
    }
    return {
      title: ch.call_title || ch.name,
      mode: ch.call_mode,
      callOpen: ch.call_open === 1,
      startsAt: ch.starts_at ?? null,
      recordingUrl: ch.call_recording_url ?? null,
      brand,
      callUrl,
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


function RoomAbierto() {
  const data = Route.useLoaderData();
  const { slug } = Route.useParams();
  const router = useRouter();

  const [messages, setMessages] = useState<Message[]>([]);
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [me, setMe] = useState<{ sub: string; name: string } | null>(null);
  // Picker de reacciones GLOBAL: uno solo abierto a la vez. Es el estado que mi versión
  // improvisada no tenía, y por eso salían dos menús a la vez.
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [modero, setModero] = useState(false);
  const [grabando, setGrabando] = useState(false);
  const [recBusy, setRecBusy] = useState(false);
  const [online, setOnline] = useState(1);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [identificando, setIdentificando] = useState(false);
  const [callUrl, setCallUrl] = useState<string | null>(data.callUrl);
  // Nace ABIERTO: el chat es la mitad de para qué existe el room, y esconderlo por
  // defecto obliga a descubrirlo. En móvil se abre encima, así que ahí arranca cerrado
  // para no tapar el video nada más entrar.
  const [chatAbierto, setChatAbierto] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 640
  );
  const [err, setErr] = useState<string | null>(null);
  // Adjuntos: la MISMA subida del chat de Teams. `roomSlug` le dice al endpoint de qué
  // room es el invitado, que es de donde salen su cuota y sus límites.
  const adj = useAdjuntos({ roomSlug: slug });
  const { dragOver, handlers: dropHandlers } = useFileDrop((files) => {
    if (!canWrite) return setIdentificando(true);
    adj.addFiles(files);
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  // Mi `sub`, para saber si una reacción que llega por el bus es mía. Lo devuelve el
  // propio toggle: no hace falta pedirlo aparte.
  const miSub = useRef<string | null>(null);
  // Ids del agente a los que ya se les sonó: los deltas llegan sin parar y sin esto el
  // turno entero sería un redoble.
  const agentesSonados = useRef<Set<number>>(new Set());

  // El reloj avanza cada 30 s, no cada segundo: lo que se pinta son minutos, así que un
  // tick por segundo serían 60 renders para cambiar nada.
  const [ahora, setAhora] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!data.startsAt) return;
    const t = setInterval(() => setAhora(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, [data.startsAt]);
  const cuantoFalta = data.startsAt ? faltan(data.startsAt, ahora) : null;

  const traerNuevos = useCallback(async () => {
    try {
      const r = await eventFlowFn({ data: { slug, after: lastId.current } });
      if (!r.ok) return;
      setCanWrite(r.canWrite);
      setModero(r.canModerate);
      setEmojis(r.emojis ?? []);
      setMe(r.me ?? null);
      miSub.current = r.me?.sub ?? null;
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

    // Sonido, con la MISMA regla que el chat de Teams (`lib/chime.ts`): no suena lo mío,
    // ni la cáscara vacía del agente, ni lo que tengo delante.
    //
    // ⚠️ `activeScope` es `false` a propósito cuando la pestaña está oculta y `true` sólo
    // si la persona está mirando ESTA página. En un room no hay varios scopes que
    // distinguir —hay uno—, así que "estoy en el scope" es literalmente "la pestaña está
    // visible". Sin esto, un webinar de 100 personas sonaría en cada mensaje aunque lo
    // estés leyendo.
    if (ev.t === "message:new") {
      const visible = typeof document !== "undefined" && document.visibilityState === "visible";
      const tono = shouldChime(ev.msg, {
        miSub: miSub.current,
        miHandle: null, // un invitado no tiene @handle: sólo le suenan las grupales
        activeScope: visible,
        mutes: new Set<string>(),
      });
      if (tono === "mention") playMentionSound();
      else if (tono) playNotificationSound();
    }

    // El agente suena al PRIMER token, no al aparecer su caja vacía. Dedupe por id porque
    // los deltas siguen llegando durante todo el turno.
    if (ev.t === "message:delta" || ev.t === "message:body") {
      if (!agentesSonados.current.has(ev.id)) {
        agentesSonados.current.add(ev.id);
        const suyo = messages.find((m) => m.id === ev.id);
        if (suyo?.agent_handle) playGhostySound();
      }
    }
    // ⚠️ Una reacción se aplica AQUÍ, sobre el estado, y no re-pidiendo el flujo: el
    // sondeo va con `after`, o sea que sólo trae mensajes NUEVOS. Reaccionar a algo de
    // hace un minuto no cambia ningún id, así que por esa vía no llegaría nunca.
    if (ev.t === "reaction") {
      const { messageId, emoji, op, count, userSub } = ev;
      return setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          const actuales = m.reactions ?? [];
          const otras = actuales.filter((x) => x.emoji !== emoji);
          if (count <= 0) return { ...m, reactions: otras };
          const previa = actuales.find((x) => x.emoji === emoji);
          // `mine` sólo cambia si el evento es MÍO; el de otra persona no puede alterar
          // si yo reaccioné o no.
          const mine = userSub === miSub.current ? op === "add" : !!previa?.mine;
          const rs: ReactionAgg[] = [...otras, { emoji, count, mine, subs: previa?.subs ?? [] }];
          return { ...m, reactions: rs };
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

  async function grabar() {
    setRecBusy(true);
    setErr(null);
    try {
      const r = await recordingFn({ data: { slug, action: grabando ? "stop" : "start" } });
      if (!r.ok) setErr(r.error);
      else setGrabando(!grabando);
    } catch {
      setErr("No pude cambiar la grabación.");
    }
    setRecBusy(false);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    const files = adj.listos();
    // Con adjunto, el texto puede ir vacío: mandar una foto sin comentario es normal.
    if ((!body && !files.length) || sending || adj.subiendo) return;
    // Escribir es el momento en que se pide el correo — no antes. La persona ya redactó su
    // mensaje: se le guarda y se manda en cuanto se identifique.
    if (!canWrite) return setIdentificando(true);
    setSending(true);
    setText("");
    try {
      const r = await eventPostFn({ data: { slug, body, attachments: files } });
      if (!r.ok) setErr(r.error);
      else { adj.limpiar(); playSelfSound(); } // acuse de "salió", como en el chat
      await traerNuevos();
    } catch {
      setText(body); // perder lo que alguien acaba de escribir es de lo que más molesta
    }
    setSending(false);
  }

  // `MessageRow` pide `react(m, emoji)` por contexto; aquí se traduce a la server fn del
  // room. Optimista: esperar el round-trip para ver tu propio 👏 se siente roto, y el
  // evento del bus lo reconcilia con el conteo autoritativo.
  async function reaccionar(m: Message, emoji: string) {
    if (!canWrite) return setIdentificando(true);
    setMessages((prev) =>
      prev.map((x) => {
        if (x.id !== m.id) return x;
        const actuales = x.reactions ?? [];
        const previa = actuales.find((r) => r.emoji === emoji);
        const otras = actuales.filter((r) => r.emoji !== emoji);
        if (previa?.mine) {
          const bajada: ReactionAgg[] =
            previa.count <= 1 ? otras : [...otras, { ...previa, count: previa.count - 1, mine: false }];
          return { ...x, reactions: bajada };
        }
        const subida: ReactionAgg[] = [
          ...otras,
          { emoji, count: (previa?.count ?? 0) + 1, mine: true, subs: previa?.subs ?? [] },
        ];
        return { ...x, reactions: subida };
      })
    );
    try {
      await eventReactFn({ data: { slug, messageId: m.id, emoji } });
    } catch {
      // Se recupera solo: el siguiente sondeo trae el conteo de verdad.
    }
  }

  // ⚠️ El CONTEXTO es lo que hace que aquí se pinte el chat DE VERDAD y no una copia.
  // Lo que un room abierto no tiene se apaga con no-ops: fijar, destacar, editar,
  // reenviar, hilos, perfiles y ajustes son cosas de miembros. `MessageRow` ya sabe
  // esconder lo que no puede hacer.
  const ctx = useMemo(
    () => ({
      ...ChatCtxDefaults,
      me: me ? ({ sub: me.sub, name: me.name, avatar: "", isOwner: false } as SessionUser) : null,
      slug,
      emojis,
      react: reaccionar,
      // Uno solo abierto a la vez: es el estado que faltaba cuando esto era una copia,
      // y por eso salían dos menús de reacción a la vez.
      pickerFor,
      setPickerFor,
      // Compacto: una línea por mensaje, como Twitch. Un webinar a cien mensajes por
      // minuto en formato Slack es un scroll donde no se sigue nada.
      density: "compact" as const,
      // Y nada más. Reenviar, perfiles, fijar, editar, borrar y ajustes NO se pasan
      // —no se apagan—: aquí no existen, así que sus botones tampoco. Es la diferencia
      // entre una capacidad ausente y un botón muerto.
    }),
    [me, slug, emojis, pickerFor, canWrite]
  );

  return (
    <ChatCtx.Provider value={ctx}>
      {/* UNA SOLA VISTA: el escenario a la izquierda y el chat a la derecha, siempre.
          Antes había dos páginas —una de sólo chat y otra a pantalla completa al entrar a
          la llamada— y sobraba: quien llega a un evento viene a las dos cosas a la vez.
          Lo que cambia al entrar no es la página, es lo que ocupa el escenario. */}
      <div className="flex h-dvh bg-surface">
        {/* El escenario. Con llamada, negro; sin ella, superficie normal — con el logo
            del cliente encima, un fondo negro se come los logos oscuros. */}
        <main className={`relative flex min-w-0 flex-1 flex-col ${callUrl ? "bg-black" : "bg-surface-2"}`}>
          {callUrl ? (
            /* La URL llega YA FIRMADA desde el loader, así que el lobby de LiveKit está
               en el primer pintado: no hay antesala propia, ni spinner, ni un paso de más.
               ⚠️ Eso significa que abrir la página DESPIERTA la caja. El interruptor
               `call_open` del dueño es la forma de que eso no ocurra. */
            <iframe
              src={callUrl}
              title={data.title}
              className="h-full w-full border-0"
              allow="camera; microphone; display-capture; autoplay; fullscreen; speaker-selection"
              allowFullScreen
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-5 p-6 text-center">
              {data.brand.logo ? (
                <img src={data.brand.logo} alt={data.brand.name ?? ""} className="h-9 w-auto max-w-[180px] object-contain" />
              ) : (
                <GhostyMascot className="h-10 w-10" />
              )}
              <div>
                <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{data.title}</h1>
                {data.startsAt && (
                  <p className="mt-2 text-sm text-muted">
                    {/* En el reloj de QUIEN MIRA: un evento se anuncia a gente de varias
                        zonas horarias, y la hora del dueño es la equivocada para el resto. */}
                    {new Date(data.startsAt * 1000).toLocaleString([], {
                      weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
                    })}
                    {cuantoFalta && <span className="ml-1 font-medium text-brand">· {cuantoFalta}</span>}
                  </p>
                )}
              </div>
              {/* Sin botón: la puerta es el CHAT. Al intentar escribir se pide el correo,
                  y con él verificado la llamada llega ya montada en la siguiente carga. */}
              <p className="max-w-xs text-sm text-muted">
                {data.recordingUrl
                  ? "Grabación del evento."
                  : !data.callOpen
                    ? "La llamada no está abierta ahora mismo."
                    : "Escribe en el chat para entrar a la llamada."}
              </p>
              {err && <p className="text-xs text-red-400">{err}</p>}
            </div>
          )}

          <div className="absolute right-4 top-4 flex items-center gap-2">
            {/* Grabar es de QUIEN MODERA: es una acción sobre la sesión de todos, y su
                rastro queda publicado. El punto rojo va SIEMPRE visible mientras graba —
                que se grabe sin que se note es exactamente lo que no puede pasar. */}
            {modero && callUrl && (
              <button
                onClick={grabar}
                disabled={recBusy}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur disabled:opacity-60 ${
                  grabando ? "bg-red-600 text-white" : "bg-black/70 text-white hover:bg-black/85"
                }`}
              >
                {grabando ? <Square size={12} fill="currentColor" /> : <Circle size={12} fill="currentColor" className="text-red-500" />}
                {recBusy ? "…" : grabando ? "Detener y guardar" : "Grabar"}
              </button>
            )}
            <button
              onClick={() => setChatAbierto((v) => !v)}
              className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85 sm:hidden"
            >
              <MessageSquare size={14} /> {chatAbierto ? "Ocultar chat" : "Chat"}
            </button>
            {callUrl && (
              <button
                onClick={() => setCallUrl(null)}
                className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85"
              >
                {/* ⚠️ "Salir" y no "volver al chat": esto DESMONTA el iframe, o sea que
                    abandona la llamada, y volver a entrar cuesta un ticket nuevo. Con el
                    chat siempre al lado, nadie necesita salirse para leerlo. */}
                <X size={14} /> Salir
              </button>
            )}
          </div>
        </main>

        {/* En MÓVIL no hay ancho que repartir: ahí se superpone, porque partir 380px en
            dos deja el video del tamaño de un sello y el chat ilegible. */}
        <aside
          {...dropHandlers}
          className={`${chatAbierto ? "flex" : "hidden"} absolute inset-y-0 right-0 z-10 w-full flex-col border-l border-border bg-surface sm:relative sm:z-0 sm:flex sm:w-80 sm:shrink-0 lg:w-96`}
        >
          <DropOverlay show={dragOver} />
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <span className="text-sm font-semibold">Chat</span>
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {online} por aquí
              </p>
            </div>
            <button onClick={() => setChatAbierto(false)} aria-label="Cerrar el chat" className="text-muted hover:text-ink sm:hidden">
              <X size={16} />
            </button>
          </div>
          <Mensajes messages={messages} bottomRef={bottomRef} />
          {err && callUrl && <p className="px-4 pb-1 text-xs text-red-400">{err}</p>}
          {/* El aviso va ANTES de escribir, con su acción al lado. Dejar teclear y
              sorprender al enviar es peor: ya redactaste el mensaje cuando te enteras. */}
          {!canWrite && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
              <p className="min-w-0 flex-1 text-xs text-muted">
                Para escribir y entrar a la llamada necesitamos tu correo.
              </p>
              <button
                onClick={() => setIdentificando(true)}
                className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white"
              >
                Identificarme
              </button>
            </div>
          )}
          {adj.pendientes.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-2">
              {adj.pendientes.map((p) => (
                <div key={p.localId} className="relative">
                  {p.previewUrl ? (
                    <img src={p.previewUrl} alt={p.name} className="h-14 w-14 rounded-lg object-cover" />
                  ) : (
                    <div className="grid h-14 w-14 place-items-center rounded-lg border border-border bg-card px-1 text-center text-[9px] leading-tight text-muted">
                      {p.name.slice(0, 18)}
                    </div>
                  )}
                  {/* Subiendo / falló: el estado va ENCIMA de la miniatura, no en un texto
                      aparte — con varios archivos, un texto no dice cuál es cuál. */}
                  {p.uploading && <div className="absolute inset-0 grid place-items-center rounded-lg bg-black/50 text-[10px] text-white">…</div>}
                  {p.error && <div className="absolute inset-0 grid place-items-center rounded-lg bg-red-900/70 text-[10px] text-white">error</div>}
                  <button
                    onClick={() => adj.quitar(p.localId)}
                    aria-label="Quitar"
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-surface-3 text-xs text-ink shadow"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <Composer
            text={text}
            setText={setText}
            onSubmit={enviar}
            sending={sending || adj.subiendo}
            canWrite={canWrite}
            onFiles={(f) => (canWrite ? adj.addFiles(f) : setIdentificando(true))}
            hayAdjuntos={adj.pendientes.length > 0}
          />
          <footer className="shrink-0 pb-2 text-center text-[11px] text-muted">
            <a href="https://ghosty.studio" target="_blank" rel="noreferrer" className="hover:text-brand">
              Hecho con Ghosty Teams
            </a>
          </footer>
        </aside>

        {identificando && (
          <Identificarse
            slug={slug}
            onListo={() => {
              setIdentificando(false);
              setCanWrite(true);
              // Re-corre el loader con la cookie recién sembrada: vuelve con la URL de la
              // llamada ya firmada, así que quien acaba de verificar aterriza DENTRO sin
              // recargar ni pulsar nada.
              void router.invalidate();
            }}
            onCerrar={() => setIdentificando(false)}
          />
        )}
      </div>
    </ChatCtx.Provider>
  );
}

/**
 * La lista de mensajes. Se usa en la página y dentro del cajón de la llamada, con la MISMA
 * fuente de datos: si fueran dos listas separadas, una se quedaría atrás en cuanto alguien
 * escribiera durante la transmisión, que es justo cuando más se escribe.
 */
/**
 * La conversación, con el MISMO `MessageRow` que el chat de Teams.
 *
 * ⚠️ Aquí hubo un chat improvisado durante unas horas —lista de texto, avatar a mano,
 * seis emojis inventados— y se notó enseguida: dos selectores de reacción abiertos a la
 * vez, sin click-outside, sin los emojis del workspace, sin adjuntos. Cada detalle que
 * el chat de Teams ya tenía resuelto había que volver a resolverlo, peor.
 *
 * Por eso `MessageRow` y compañía se sacaron a `components/chat/message.tsx`: lo que se
 * ve aquí es el chat de verdad, con las capacidades que no aplican apagadas desde el
 * contexto (fijar, destacar, editar, hilos, perfiles).
 */
function Mensajes({
  messages,
  bottomRef,
}: {
  messages: Message[];
  bottomRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const propio = useRef<HTMLDivElement>(null);
  const fin = bottomRef ?? propio;
  useEffect(() => { fin.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, fin]);

  return (
    <div className="w-full flex-1 overflow-y-auto px-2 py-4">
      {messages.length === 0 && (
        <p className="px-2 text-sm text-muted">Todavía no hay mensajes. Sé quien empiece 👋</p>
      )}
      {messages.map((m, i) => (
        <MessageRow key={m.id} m={m} prev={messages[i - 1]} />
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
  onFiles,
  hayAdjuntos,
}: {
  text: string;
  setText: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  sending: boolean;
  canWrite: boolean;
  onFiles: (files: FileList | File[]) => void;
  hayAdjuntos: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <form onSubmit={onSubmit} className="shrink-0 px-4 pb-3 pt-1">
      <div className="flex gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = ""; // sin esto, elegir el MISMO archivo dos veces no dispara change
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Adjuntar"
          className="shrink-0 rounded-xl border border-border px-3 text-muted hover:text-brand"
        >
          <Paperclip size={16} />
        </button>
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
          disabled={sending || (!text.trim() && !hayAdjuntos)}
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
