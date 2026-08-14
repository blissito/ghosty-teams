import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import { ChevronDown, Circle, MessageSquare, Paperclip, Volume2, VolumeX, X } from "lucide-react";
import GhostyMascot from "../components/GhostyMascot";
import { ChatCtx, ChatCtxDefaults, MessageRow, type SessionUser } from "../components/chat/message";
import type { Message, CustomEmoji, ReactionAgg } from "../db.server";
import { eventFlowFn, eventPostFn, eventReactFn } from "../server/events/chat";
import { eventModerateFn } from "../server/events/chat";
import { deleteRecordingFn, recordingFn, requestCodeFn, verifyCodeFn } from "../server/events/identity";
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
  // ⚠️ El estado de la grabación es DEL SERVIDOR, no de esta pestaña. Quien la empezó
  // puede recargar, entrar desde el teléfono, o ser otra persona distinta a la que la
  // detiene. Se refresca con el sondeo del flujo, cada 15 s.
  const [grabacion, setGrabacion] = useState<{ by: string | null; since: number } | null>(null);
  const grabando = !!grabacion;
  // La grabación ya subida. ⚠️ Sin esto, detener no entregaba NADA: el MP4 llegaba a
  // storage, la URL se guardaba en el room, y nadie la veía nunca — desde fuera era
  // indistinguible de haberla perdido.
  const [grabada, setGrabada] = useState<{ url: string; at: number | null } | null>(null);
  type Grabacion = { id: number; url: string; transcriptUrl: string | null; transcriptState: "pending" | "ready" | "none"; bytes: number; startedAt: number | null; endedAt: number; by: string | null };
  // ⚠️ TODAS, no la última. Con un solo enlace, grabar dos veces dejaba la primera sin
  // forma de abrirla aunque el archivo siguiera en storage.
  const [grabaciones, setGrabaciones] = useState<Grabacion[]>([]);
  const [listaAbierta, setListaAbierta] = useState(false);
  // Borrar una grabación es IRREVERSIBLE —el original vivía en la caja y ya no está—, así
  // que no basta un botón: se guarda cuál se va a borrar y se pregunta en un modal.
  const [porBorrar, setPorBorrar] = useState<Grabacion | null>(null);
  const [borrando, setBorrando] = useState(false);
  // Sólo importa para no disparar dos veces: quien ve el botón es el iframe, y ése ya se
  // deshabilita solo mientras la petición va en camino.
  // ⚠️ En `localStorage` y no en el servidor: apagar el sonido es del DISPOSITIVO. La misma
  // persona quiere el tic en su portátil y silencio en el teléfono que lleva en la mesa.
  // Se lee perezosamente para no tocar `window` en el render del servidor.
  const [suena, setSuena] = useState(true);
  useEffect(() => { setSuena(localStorage.getItem("room:mudo") !== "1"); }, []);
  const alternarSonido = () => {
    setSuena((v) => {
      localStorage.setItem("room:mudo", v ? "1" : "0");
      return !v;
    });
  };
  const sonando = useRef(true);
  useEffect(() => { sonando.current = suena; }, [suena]);

  const [recBusy, setRecBusy] = useState(false);
  const [online, setOnline] = useState(1);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [identificando, setIdentificando] = useState(false);
  // Las reglas se enseñan UNA vez por dispositivo. Un cartel permanente se vuelve
  // invisible en dos minutos, que es justo lo contrario de lo que hace falta.
  const [reglasVistas, setReglasVistas] = useState(true);
  useEffect(() => { setReglasVistas(localStorage.getItem("room:reglas") === "1"); }, []);
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
    // La cuenta atrás del evento se contenta con medio minuto; el cronómetro de la
    // grabación no, un reloj que salta de 30 en 30 parece detenido.
    if (!data.startsAt && !grabacion) return;
    const t = setInterval(() => setAhora(Math.floor(Date.now() / 1000)), grabacion ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [data.startsAt, grabacion]);
  const cuantoFalta = data.startsAt ? faltan(data.startsAt, ahora) : null;

  const traerNuevos = useCallback(async () => {
    try {
      const r = await eventFlowFn({ data: { slug, after: lastId.current } });
      if (!r.ok) return;
      setCanWrite(r.canWrite);
      setModero(r.canModerate);
      setGrabacion(r.recording ?? null);
      setGrabada(r.recorded ?? null);
      setGrabaciones(r.recordings ?? []);
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
      // ⚠️ El gate se lee de una ref, no del estado: este handler vive dentro del efecto
      // del stream, que no se re-suscribe al cambiar la preferencia — con el valor
      // capturado, apagar el sonido no surtía efecto hasta recargar.
      if (!sonando.current) return;
      if (tono === "mention") playMentionSound();
      else if (tono) playNotificationSound();
    }

    // El agente suena al PRIMER token, no al aparecer su caja vacía. Dedupe por id porque
    // los deltas siguen llegando durante todo el turno.
    if (ev.t === "message:delta" || ev.t === "message:body") {
      if (!agentesSonados.current.has(ev.id)) {
        agentesSonados.current.add(ev.id);
        const suyo = messages.find((m) => m.id === ev.id);
        if (suyo?.agent_handle && sonando.current) playGhostySound();
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

  // ⚠️ El BOTÓN de grabar vive DENTRO de la llamada, junto a Salir — que es donde ya
  // estaba y donde lo espera cualquiera que haya usado Meet, Zoom o Twitch. Lo que no
  // puede vivir ahí es el CAMINO: la página de la llamada sabe subir a los Files de
  // EasyBits, y aquí el destino es el storage del workspace, con transcript y con el
  // enlace publicado en el chat. Así que el iframe manda la intención y Teams la ejecuta.
  const callRef = useRef<HTMLIFrameElement>(null);
  // ⚠️ `uploading` NO es cosmético: entre Detener y el enlace pasan minutos —el MP4 pasa del
  // giga y se sube dentro de la misma petición—, y sin esta señal el botón se apagaba y no
  // volvía a decir nada. Quien acaba de detener cree que se perdió la grabación.
  const avisarIframe = useCallback((recording: boolean, error?: string, url?: string, uploading = false) => {
    callRef.current?.contentWindow?.postMessage({ t: "gs:rec:state", recording, error, url, uploading }, "*");
  }, []);

  const borrarGrabacion = useCallback(async () => {
    if (!porBorrar) return;
    setBorrando(true);
    const r = await deleteRecordingFn({ data: { slug, id: porBorrar.id } }).catch(() => ({ ok: false as const, error: "No pude borrarla." }));
    setBorrando(false);
    if (!r.ok) return setErr(r.error);
    // Se quita de la lista sin esperar al sondeo: el modal se cierra y la fila tiene que
    // haber desaparecido, o parece que no funcionó.
    setGrabaciones((v) => v.filter((x) => x.id !== porBorrar.id));
    setPorBorrar(null);
  }, [porBorrar, slug]);

  const grabar = useCallback(
    async (accion: "start" | "stop") => {
      setRecBusy(true);
      setErr(null);
      // Detener arrastra la subida del MP4 dentro de la misma petición: el iframe tiene que
      // saberlo YA, no cuando termine.
      if (accion === "stop") avisarIframe(false, undefined, undefined, true);
      try {
        const r = await recordingFn({ data: { slug, action: accion } });
        // ⚠️ El aviso al iframe va TAMBIÉN cuando falla, y con el motivo. Sin esto el botón
        // se quedaba en "iniciando…" para siempre y el error sólo aparecía en el chat, que
        // es justo donde no está mirando quien acaba de pulsar Grabar.
        if (!r.ok) {
          setErr(r.error);
          avisarIframe(grabando, r.error);
        } else {
          // Optimista con el nombre de quien pulsó: el sondeo lo confirma en segundos.
          setGrabacion(accion === "start" ? { by: me?.name ?? null, since: Math.floor(Date.now() / 1000) } : null);
          if (accion === "stop" && r.url) setGrabada({ url: r.url, at: Math.floor(Date.now() / 1000) });
          // El enlace viaja al iframe: quien pulsó Detener está mirando ESE botón, y ahí
          // es donde tiene que aparecer "guardada · abrir".
          avisarIframe(accion === "start", undefined, accion === "stop" ? r.url : undefined);
        }
      } catch {
        setErr("No pude cambiar la grabación.");
        avisarIframe(grabando, "No pude cambiar la grabación.");
      }
      setRecBusy(false);
    },
    [slug, avisarIframe, grabando, me]
  );

  // La autorización NO la decide este listener: `recordingFn` ya exige ser quien presenta.
  // Aquí sólo se filtra por procedencia, y **nunca viaja una credencial** en ninguno de los
  // dos sentidos — sólo "quiero grabar" y "se está grabando".
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!callRef.current || e.source !== callRef.current.contentWindow) return;
      const d = e.data as { t?: string; action?: "start" | "stop" };
      // Salir vive DENTRO de la llamada (había dos botones idénticos): la sala se
      // desconecta sola y avisa aquí para que además se cierre la vista.
      if (d?.t === "gs:leave") return setCallUrl(null);
      if (d?.t === "gs:rec:ask") return avisarIframe(grabando);
      if (d?.t === "gs:rec" && (d.action === "start" || d.action === "stop")) {
        void grabar(d.action);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [grabar, avisarIframe, grabando]);

  // Y al revés: si la grabación la empezó (o la detuvo) alguien MÁS, el botón de dentro de
  // la llamada tiene que enterarse. Sin esto, quien no pulsó el botón sigue viendo
  // "Grabar" y lo pulsa — y se lleva un "ya se está grabando" que no entiende.
  useEffect(() => { avisarIframe(grabando); }, [grabando, avisarIframe, callUrl]);

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
      else { adj.limpiar(); if (sonando.current) playSelfSound(); } // acuse de "salió"
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

  // Moderar. Optimista en los dos casos: el evento del bus reconcilia, y ver el mensaje
  // seguir ahí medio segundo después de borrarlo hace dudar de si el clic funcionó —
  // justo cuando quien modera está apurado.
  async function borrarMensaje(m: Message) {
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    await eventModerateFn({ data: { slug, action: "delete", messageId: m.id } }).catch(() => {});
  }
  async function expulsar(m: Message) {
    // Se van TODOS sus mensajes, no sólo el que se tocó: es lo que hace el servidor y lo
    // que espera quien expulsa.
    setMessages((prev) => prev.filter((x) => x.sender_sub !== m.sender_sub));
    await eventModerateFn({ data: { slug, action: "ban", sub: m.sender_sub ?? undefined } }).catch(() => {});
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
      // Moderación: sólo para quien presenta, y sólo sobre ESTE room.
      ...(modero ? { canModerate: true, remove: borrarMensaje, banUser: expulsar } : {}),
      // Y nada más. Reenviar, perfiles, fijar, editar, borrar y ajustes NO se pasan
      // —no se apagan—: aquí no existen, así que sus botones tampoco. Es la diferencia
      // entre una capacidad ausente y un botón muerto.
    }),
    [me, slug, emojis, pickerFor, canWrite, modero]
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
              ref={callRef}
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

          <div className="absolute right-4 top-4 flex flex-wrap items-center justify-end gap-2">
            {/* Y aquí NO hay botón, hay TESTIGO. Que se grabe sin que se note es
                exactamente lo que no puede pasar, así que el punto rojo lo ve todo el
                mundo — no sólo quien presenta, que es el único que ve el botón. */}
            {!grabacion && (grabaciones.length > 0 || grabada) && (
              <div className="relative">
                <button
                  onClick={() => {
                    // ⚠️ Antes, con UNA grabación se abría el vídeo directo — y la
                    // transcripción vive dentro de este desplegable, así que en el caso más
                    // común (una sola) NO HABÍA DÓNDE VERLA: parecía que no se había
                    // generado. El atajo se reserva para la grabación suelta sin fila.
                    if (grabaciones.length) return setListaAbierta((v) => !v);
                    if (grabada?.url) window.open(grabada.url, "_blank", "noopener");
                  }}
                  className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85"
                >
                  <Circle size={10} />
                  {grabaciones.length > 1 ? `Grabaciones (${grabaciones.length})` : "Ver la grabación"}
                </button>
                {listaAbierta && grabaciones.length > 0 && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
                    {grabaciones.map((g) => (
                      <div key={g.url} className="border-b border-border last:border-0">
                      <a
                        href={g.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setListaAbierta(false)}
                        className="block px-3 py-2 text-xs text-ink hover:bg-surface-2"
                      >
                        {/* Duración y peso: con tres grabaciones del mismo día, la hora sola
                            no dice cuál es la buena. */}
                        <span className="font-medium">
                          {new Date(g.endedAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="ml-1 text-muted">
                          {g.startedAt ? `· ${Math.max(1, Math.round((g.endedAt - g.startedAt) / 60))} min` : ""}
                          {g.bytes ? ` · ${(g.bytes / 1073741824).toFixed(2)} GB` : ""}
                        </span>
                      </a>
                      {/* El transcript llega MINUTOS después del vídeo. Decirlo es la
                          diferencia entre "está en camino" y "esto no existe" — que fue
                          justo lo que pareció la primera vez. */}
                      {/* Sólo quien modera. El borrado se lleva el vídeo Y su
                          transcripción, y no hay copia en ninguna otra parte. */}
                      {modero && (
                        <button
                          onClick={() => { setListaAbierta(false); setPorBorrar(g); }}
                          className="block w-full px-3 pb-2 text-left text-[11px] text-red-600 hover:underline"
                        >
                          Borrar
                        </button>
                      )}
                      {g.transcriptUrl ? (
                        <a
                          href={g.transcriptUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => setListaAbierta(false)}
                          className="block px-3 pb-2 text-[11px] text-brand hover:underline"
                        >
                          Transcripción
                        </a>
                      ) : (
                        <p className="px-3 pb-2 text-[11px] text-muted">
                          {g.transcriptState === "none" ? "Sin transcripción" : "Transcribiendo…"}
                        </p>
                      )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setChatAbierto((v) => !v)}
              className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85 sm:hidden"
            >
              <MessageSquare size={14} /> {chatAbierto ? "Ocultar chat" : "Chat"}
            </button>
            {/* ⚠️ Aquí había un segundo "Salir", gemelo del de la barra amarilla de la
                llamada y con el mismo efecto: abandonarla. Dos botones idénticos a dos
                centímetros invitan a pulsar el que no era. La salida vive DENTRO de la
                llamada, junto al resto de sus controles; el iframe avisa aquí para que
                además se desmonte. */}
            {grabacion && (
              <button
                // El testigo es también el freno. Antes era un adorno con
                // `pointer-events-none`, y al salir de la llamada la grabación se quedaba
                // corriendo sin NINGUNA forma de pararla: el único botón vivía dentro del
                // iframe que acababas de cerrar. Se llenaba el disco de la caja y el vídeo
                // seguía creciendo solo.
                onClick={() => { if (!recBusy) void grabar("stop"); }}
                disabled={recBusy}
                className="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
                title={grabacion.by ? `La empezó ${grabacion.by} · clic para detener` : "clic para detener"}
              >
                <Circle size={10} fill="currentColor" /> Grabando {fmtDesde(grabacion.since, ahora)}
                <span className="opacity-80">· Detener</span>
              </button>
            )}
            {/* ⚠️ Entre Detener y el enlace pasan minutos: el MP4 pasa del giga y se sube
                dentro de la misma petición. Sin este testigo, la barra se quedaba muda y
                quien detuvo daba la grabación por perdida. */}
            {recBusy && !grabacion && (
              <span className="pointer-events-none flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur">
                <Circle size={10} className="animate-pulse" fill="currentColor" /> Guardando la grabación…
              </span>
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
            <div className="flex items-center gap-1">
              {/* El icono DICE el estado sin pasar el ratón: un altavoz tachado se lee de
                  un vistazo; un "sonidos" a secas, no. */}
              <button
                onClick={alternarSonido}
                aria-label={suena ? "Silenciar el chat" : "Activar los sonidos del chat"}
                title={suena ? "Silenciar el chat" : "Activar los sonidos del chat"}
                className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
              >
                {suena ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
              <button onClick={() => setChatAbierto(false)} aria-label="Cerrar el chat" className="text-muted hover:text-ink sm:hidden">
                <X size={16} />
              </button>
            </div>
          </div>
          {!reglasVistas && (
            <Reglas
              onOk={() => {
                localStorage.setItem("room:reglas", "1");
                setReglasVistas(true);
              }}
            />
          )}
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

        {/* ⚠️ Confirmación explícita, y con lo que se pierde escrito: el MP4 original ya no
            está en la caja, así que esto no se puede deshacer ni rehacer. */}
        {porBorrar && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !borrando && setPorBorrar(null)}>
            <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-ink">¿Borrar esta grabación?</h3>
              <p className="mt-2 text-sm text-muted">
                {new Date(porBorrar.endedAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                {porBorrar.startedAt ? ` · ${Math.max(1, Math.round((porBorrar.endedAt - porBorrar.startedAt) / 60))} min` : ""}
                {porBorrar.bytes ? ` · ${(porBorrar.bytes / 1073741824).toFixed(2)} GB` : ""}
              </p>
              <p className="mt-3 text-sm text-ink">
                Se borra el vídeo y su transcripción. <strong>No se puede deshacer.</strong>
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setPorBorrar(null)}
                  disabled={borrando}
                  className="rounded-lg px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => void borrarGrabacion()}
                  disabled={borrando}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {borrando ? "Borrando…" : "Borrar"}
                </button>
              </div>
            </div>
          </div>
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
/** "05:12" desde que empezó. Un cronómetro dice que sigue viva; un "Grabando" pelado, no. */
function fmtDesde(since: number, ahora: number): string {
  const s = Math.max(0, ahora - since);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Las reglas del chat, arriba del todo, antes de leer nada.
 *
 * Es lo que hace Twitch y funciona por una razón: en un chat abierto el primer mensaje
 * desagradable ya se leyó cuando alguien lo modera. Decir de antemano qué pasa aquí evita
 * la mayoría, y deja a quien modera actuar sin parecer arbitrario.
 *
 * Se acepta una vez y no vuelve — por dispositivo, no por persona: nadie quiere volver a
 * aceptar nada por abrir el enlace en el teléfono.
 */
function Reglas({ onOk }: { onOk: () => void }) {
  return (
    <div className="mx-3 mt-3 rounded-xl border border-border bg-surface-2 p-3">
      <p className="text-xs font-semibold">Antes de escribir</p>
      <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted">
        <li>· Se vale preguntar cualquier cosa, por básica que parezca.</li>
        <li>· Nada de insultos, spam ni enlaces de promoción.</li>
        <li>· Esto es público: no pongas datos personales tuyos ni de nadie.</li>
        <li>· Si se graba la sesión, el chat NO se graba — pero queda en el room.</li>
      </ul>
      <button
        onClick={onOk}
        className="mt-2.5 w-full rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
      >
        Entendido
      </button>
    </div>
  );
}

function Mensajes({
  messages,
  bottomRef,
}: {
  messages: Message[];
  bottomRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const propio = useRef<HTMLDivElement>(null);
  const fin = bottomRef ?? propio;
  // ⚠️ El autoscroll SE PAUSA al subir, como en Twitch. Sin esto, con cien mensajes por
  // minuto releer algo es imposible: cada mensaje nuevo te devuelve al final a media
  // frase. El chat no deja de recibir — sólo deja de moverse.
  const [pegado, setPegado] = useState(true);
  const [perdidos, setPerdidos] = useState(0);

  useEffect(() => {
    if (pegado) {
      fin.current?.scrollIntoView({ behavior: "smooth" });
      setPerdidos(0);
    } else {
      setPerdidos((n) => n + 1);
    }
    // `pegado` NO va en las deps a propósito: al despegarse no hay que contar el mensaje
    // que ya estaba, y al re-pegarse ya lo hace `irAlFinal`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, fin]);

  // "Estoy abajo" con holgura de 60px: pedir el píxel exacto haría que un scroll suave sin
  // terminar, o un decimal del navegador, contaran como "se despegó".
  const alScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setPegado(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const irAlFinal = () => {
    setPegado(true);
    setPerdidos(0);
    fin.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* `thin-scroll`: la barra fina del chat de Teams. Sin ella sale la del sistema,
          gruesa y blanca, que en el panel oscuro de la sala canta muchísimo. */}
      <div ref={scroller} onScroll={alScroll} className="thin-scroll w-full flex-1 overflow-y-auto px-2 py-4">
        {messages.length === 0 && (
          <p className="px-2 text-sm text-muted">Todavía no hay mensajes. Sé quien empiece 👋</p>
        )}
        {messages.map((m, i) => (
          <MessageRow key={m.id} m={m} prev={messages[i - 1]} />
        ))}
        <div ref={fin} />
      </div>
      {!pegado && (
        <button
          onClick={irAlFinal}
          className="absolute inset-x-3 bottom-2 flex items-center justify-center gap-2 rounded-full bg-brand/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur"
        >
          <ChevronDown size={14} />
          {perdidos > 0 ? `${perdidos} ${perdidos === 1 ? "mensaje nuevo" : "mensajes nuevos"}` : "Ir al final"}
        </button>
      )}
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
