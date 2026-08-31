import { createServerFn } from "@tanstack/react-start";
import crypto from "node:crypto";
import { sessionUser } from "./chat";
import { withNamespace } from "./tenant.server";

// ── Quick-calls ──────────────────────────────────────────────────────────────
// Llamadas en vivo (audio + video + pantalla), servidas por UNA caja `livekit-svc`
// compartida por TODOS los workspaces. UI NATIVA en Teams (livekit-client). Estas
// fns devuelven los DATOS DE CONEXIÓN (token + wss + sala), no una URL. Aislamiento
// por token: room = HMAC(salt, ns:scope:id) inadivinable + namespaceado; token scoped
// a esa sala, acuñado tras verificar membresía → cero cruce de llamadas.
//
// RASTRO estilo Slack: cada call deja UN mensaje-tarjeta (kind:"status", body=JSON)
// en el timeline que se ACTUALIZA en vivo: activa (avatares + "Unirse") → terminada
// (resumen: duración + participantes). Ver CallCard en el cliente.

type CallConfig = {
  controlUrl: string; // https://sb-<id>-8088.<pubDomain> (solo server-side: /participants)
  wssUrl: string; // wss://sb-<id>-7880.<pubDomain> (señalización LiveKit, al browser)
  apiKey: string;
  apiSecret: string;
  salt: string;
  adminToken: string;
};

// El nombre FIJO de la caja de llamadas. Antes las dos URLs llevaban el `sandboxId`
// dentro, así que recrear la caja —por disco, por imagen nueva, o porque el janitor la
// recicló— obligaba a editar los secretos de Teams a mano. Studio la resuelve por este
// dominio y lo re-fija en cada arranque (`huddle-box.server.ts`).
//
// ⚠️ Son DOS nombres, y el segundo no es opcional: el panel va por el 8088 y el SFU por el
// 7880. Con uno solo la llamada se queda en "CONECTANDO…" para siempre y sin un error
// visible — le pasó a la caja de eventos en cuanto dejó de servirse por su id.
const HUDDLE_HOST = "llamadas.sandboxes.easybits.cloud";
const HUDDLE_RTC_HOST = "llamadas-rtc.sandboxes.easybits.cloud";

function callConfig(): CallConfig | null {
  // El env sigue mandando: deja apuntar a una caja concreta para depurar, y mantiene viva
  // cualquier instalación que aún lo tenga cableado.
  const controlUrl = process.env.HUDDLE_CONTROL_URL || `https://${HUDDLE_HOST}`;
  const wssUrl = process.env.HUDDLE_WSS_URL || `wss://${HUDDLE_RTC_HOST}`;
  const apiKey = process.env.LK_API_KEY;
  const apiSecret = process.env.LK_API_SECRET;
  const salt = process.env.LK_ROOM_SALT;
  const adminToken = process.env.HUDDLE_ADMIN_TOKEN || "";
  if (!controlUrl || !wssUrl || !apiKey || !apiSecret || !salt) return null;
  return { controlUrl: controlUrl.replace(/\/$/, ""), wssUrl, apiKey, apiSecret, salt, adminToken };
}

function callRoom(cfg: CallConfig, ns: string, scope: "room" | "dm", id: number): string {
  const h = crypto.createHmac("sha256", cfg.salt).update(`${ns}:${scope}:${id}`).digest("hex");
  return "qc_" + h.slice(0, 24);
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintToken(cfg: CallConfig, room: string, identity: string, name: string, ttlSec = 6 * 3600, metadata?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  // `metadata` (claim top-level de LiveKit) → participant.metadata en el browser. Lo
  // usamos para el avatar del user en el tile de la llamada (fallback a la inicial).
  const payload = b64url(
    JSON.stringify({
      iss: cfg.apiKey,
      sub: identity,
      name,
      ...(metadata ? { metadata } : {}),
      nbf: now - 10,
      exp: now + ttlSec,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    })
  );
  const sig = crypto.createHmac("sha256", cfg.apiSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

// Roster VIVO del SFU (nombres de display; livekit-svc /participants devuelve `name`).
// null = SFU inalcanzable (distinto de [] = vacío confirmado).
async function participantNames(cfg: CallConfig, room: string): Promise<string[] | null> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(`${cfg.controlUrl}/participants?room=${encodeURIComponent(room)}`, {
      headers: cfg.adminToken ? { authorization: `Bearer ${cfg.adminToken}` } : undefined,
      signal: ac.signal,
    }).finally(() => clearTimeout(to));
    if (!res.ok) return null;
    const j = (await res.json()) as { participants?: unknown[] };
    return Array.isArray(j.participants) ? j.participants.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return null;
  }
}

async function participantCount(cfg: CallConfig, room: string): Promise<number> {
  const names = await participantNames(cfg, room);
  return names === null ? -1 : names.length;
}

type Person = { sub: string; name: string; avatar: string };
// Descriptor para el botón "Unirse" de la tarjeta (el cliente sabe a qué unirse).
type JoinDesc =
  | { scope: "room"; slug: string; scopeId: number; label: string }
  | { scope: "dm"; dmId: number; label: string };

type ActiveCall = {
  callId: string;
  scope: "room" | "dm";
  scopeId: number;
  room: string;
  label: string;
  host: Person;
  startedAt: number;
  statusMsgId: number; // mensaje-tarjeta en el timeline (se actualiza en vivo)
  people: Person[]; // participantes distintos que entraron
  join: JoinDesc;
  ns: string; // para el reaper (fanout del quickcall:ended sin request)
  fanout: (ev: import("./bus.server").RtEvent) => void; // notifica a la audiencia
  // Subs a los que se les mandó push de "te llaman" (sin el host, sin silenciados) →
  // los mismos a los que hay que RETIRARSELA al colgar. Ver notifyCall/endCall.
  pushed: string[];
  /** Quién puso a grabar y desde cuándo. Sólo en memoria: si el proceso se reinicia, la
   *  caja sigue grabando y `watchOrphanRecording` la para sola a los 3 min de sala vacía. */
  recording?: { bySub: string; byName: string; startedAt: number };
};
const active = new Map<string, ActiveCall>(); // key: `${ns}::${scope}::${id}`
const keyOf = (ns: string, scope: "room" | "dm", id: number) => `${ns}::${scope}::${id}`;

// Reaper: la call se termina cuando el ÚLTIMO sale, pero si ese último cierra la pestaña o
// refresca, su leaveCall no alcanza a dispararse → la call queda "activa" y el banner
// "Unirse" persiste aunque no haya nadie (bug 2026-07-23). Este barrido periódico consulta
// el roster REAL del SFU de cada call viva y cierra las que quedaron en 0 (source of truth).
let reaper: ReturnType<typeof setInterval> | null = null;
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(async () => {
    if (active.size === 0) return;
    const cfg = callConfig();
    if (!cfg) return;
    const db = await import("../db.server");
    for (const [k, c] of Array.from(active.entries())) {
      // Gracia: no barras una call recién creada — el host tarda un momento en conectarse
      // al SFU (mint token → connect async); sin esto la mataríamos antes de que entre.
      if (Date.now() - c.startedAt < 15000) continue;
      try {
        const names = await participantNames(cfg, c.room);
        // ⚠️ `withNamespace` obligatorio: esto corre en un setInterval, FUERA de todo
        // request, y `endCall` escribe en la DB (`setMessageBody`). Sin atarlo,
        // `currentNamespace()` no tiene host que mirar y cae a `SQLD_NAMESPACE` — un
        // workspace real. Los messageId son autoincrementales POR TENANT, así que eso
        // sobrescribía el cuerpo de un mensaje ajeno. El `c.ns` correcto estaba aquí
        // mismo, ya usado para el push, y no se estaba usando para la DB.
        if (names !== null && names.length === 0) {
          await withNamespace(c.ns, () => endCall(db, c.fanout, c, k));
        }
      } catch { /* red flaky → reintenta en el próximo barrido */ }
    }
  }, 20000);
  reaper.unref?.(); // no mantiene vivo el proceso
}

// Body de la tarjeta (JSON que parsea CallCard en el cliente).
function cardBody(c: ActiveCall, ended: boolean): string {
  return JSON.stringify({
    call: {
      v: 1,
      state: ended ? "ended" : "active",
      host: c.host,
      people: c.people,
      startedAt: c.startedAt,
      durationSec: ended ? Math.round((Date.now() - c.startedAt) / 1000) : null,
      join: c.join,
    },
  });
}

function addPerson(c: ActiveCall, me: Person): boolean {
  if (c.people.some((p) => p.sub === me.sub)) return false;
  c.people.push({ sub: me.sub, name: me.name, avatar: me.avatar });
  return true;
}

async function refreshCard(
  db: typeof import("../db.server"),
  fanout: (ev: import("./bus.server").RtEvent) => void,
  c: ActiveCall
): Promise<void> {
  const body = cardBody(c, false);
  await db.setMessageBody(c.statusMsgId, body);
  fanout({ t: "message:body", id: c.statusMsgId, body });
}

// Cierra una call: quita del mapa, avisa quickcall:ended y COLAPSA la tarjeta a
// resumen (terminada · duración · N personas).
async function endCall(
  db: typeof import("../db.server"),
  fanout: (ev: import("./bus.server").RtEvent) => void,
  c: ActiveCall,
  k: string
): Promise<void> {
  active.delete(k);
  fanout({ t: "quickcall:ended", scope: c.scope, scopeId: c.scopeId, callId: c.callId });
  // Retira el "te llaman" del sistema: sin esto queda una notificación muerta que al
  // tocarla no lleva a ninguna llamada (requireInteraction = persiste hasta cerrarla).
  if (c.pushed.length) {
    const { notify } = await import("./notify.server");
    notify(
      { kind: "call-end", recipients: c.pushed, title: "", body: "", url: "/", tag: `call:${c.callId}` },
      c.ns
    ).catch(() => {});
    c.pushed = [];
  }
  try {
    const body = cardBody(c, true);
    await db.setMessageBody(c.statusMsgId, body);
    fanout({ t: "message:body", id: c.statusMsgId, body });
  } catch {
    /* el mensaje ya no existe → ignora */
  }
}

type Target = { scope: "room"; slug: string } | { scope: "dm"; dmId: number };

async function resolveTarget(target: Target) {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const cfg = callConfig();
  if (!cfg) throw new Error("llamadas no disponibles");
  const db = await import("../db.server");
  const bus = await import("./bus.server");
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace();
  const person: Person = { sub: me.sub, name: me.name, avatar: me.avatar };

  if (target.scope === "room") {
    const ch = await db.getChannel(target.slug);
    if (!ch) throw new Error("canal no encontrado");
    if (!(await db.canSeeChannel(ch, me.sub, !!me.isOwner))) throw new Error("no eres miembro de este canal");
    const room = callRoom(cfg, ns, "room", ch.id);
    // Miembros a "timbrar" per-user (aviso de llamada entrante estés donde estés): en un
    // room PRIVADO, sus miembros explícitos; en uno público, [] (no timbramos a todo el
    // workspace — el card por el canal del room basta; híbrido "room = menos intrusivo").
    const ringSubs =
      ch.is_private === 0 ? [] : (await db.getChannelMemberSubs(ch.id).catch(() => [] as string[]));
    // Audiencia del PUSH de llamada (distinta de ringSubs, que es el timbre por SSE):
    // aquí SÍ entra el room público — el evento SSE sólo lo ve startedBy tiene la pestaña
    // abierta, y el reporte del 2026-07-27 era justo ese: "si estoy en otra ventana no
    // veo la llamada". Público = todo el workspace; privado = sus miembros.
    const audience = ch.is_private === 0
      ? (await import("../users.server")).listUsers().then((us) => us.map((u) => u.sub))
      : Promise.resolve(ringSubs);
    return {
      me: person, cfg, ns, db, bus,
      scope: "room" as const,
      scopeId: ch.id,
      slug: ch.slug,
      label: ch.name,
      room,
      ringSubs,
      audience: await audience,
      join: { scope: "room" as const, slug: ch.slug, scopeId: ch.id, label: ch.name } as JoinDesc,
      fanout: (ev: import("./bus.server").RtEvent) => bus.publish(bus.ch.room(ns, ch.id), ev),
    };
  }

  // DM
  if (!(await db.isDmMember(target.dmId, me.sub))) throw new Error("no eres parte de esta conversación");
  if (await db.getDmAgentHandle(target.dmId)) throw new Error("sin llamadas con agentes"); // aún
  const members = await db.getDmMembers(target.dmId);
  const room = callRoom(cfg, ns, "dm", target.dmId);
  return {
    me: person, cfg, ns, db, bus,
    scope: "dm" as const,
    scopeId: target.dmId,
    slug: undefined as string | undefined,
    label: "Llamada",
    room,
    ringSubs: [] as string[], // el fanout del DM YA va a los user-channels de los miembros
    audience: members,
    join: { scope: "dm" as const, dmId: target.dmId, label: "Llamada" } as JoinDesc,
    fanout: (ev: import("./bus.server").RtEvent) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    },
  };
}

/**
 * Despierta la caja del SFU antes de entregar el token.
 *
 * ⚠️ **Un WebSocket NO despierta una caja dormida.** El proxy del host resume la VM cuando
 * le llega una petición HTTP normal; el upgrade a WS de `livekit-client` no la resume, así
 * que el navegador se estrella contra una caja apagada. Y el fallo engaña al máximo: el
 * turno del servidor sale PERFECTO —la tarjeta se crea, suenan los timbres, salen los
 * correos de "X está llamando"— y startedBy llamó ve un escueto "No se pudo abrir la llamada".
 * O sea que parece un fallo del cliente cuando es una caja que hay que tocar por HTTP.
 * Pasó el 2026-08-19: la caja llevaba semanas dormida porque nadie llamaba.
 *
 * `/health` lo contesta el PROXY, pero da igual: lo que despierta la VM es que la petición
 * llegue, no quién la conteste.
 *
 * ⚠️ **Se ESPERA, no es fire-and-forget.** Sin esperar queda una carrera: si el resume
 * tarda más que lo que el navegador tarda en negociar el WS, el primer intento falla
 * igual — y ese primer intento es justo el caso que esto viene a arreglar. Esperar sale
 * casi gratis porque el coste real sólo lo paga la caja DORMIDA: despierta contesta en
 * ~450 ms (medido contra la caja de producción, no estimado).
 *
 * El tope son 6 s: un resume mide ~1.8 s, así que con holgura de sobra, y por encima de
 * eso más vale entregar el token y dejar que el cliente lo intente que dejar a alguien
 * mirando un botón muerto. Por eso el `catch` sigue devolviendo control en vez de lanzar:
 * un fallo aquí casi siempre significa que la caja YA estaba despierta.
 */
async function despertarSfu(cfg: CallConfig): Promise<void> {
  await fetch(`${cfg.controlUrl}/health`, { signal: AbortSignal.timeout(6000) }).catch(() => {});
}

async function conn(t: Awaited<ReturnType<typeof resolveTarget>>) {
  await despertarSfu(t.cfg);
  return {
    token: mintToken(t.cfg, t.room, t.me.sub, t.me.name, undefined, JSON.stringify({ avatar: t.me.avatar || "" })),
    wss: t.cfg.wssUrl,
    room: t.room,
    name: t.me.name,
  };
}

// Inicia (o se une a) una call: crea el rastro/tarjeta la 1ª vez, agrega participante,
// avisa a la audiencia y devuelve MI conexión.
export const startCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    let c = active.get(k);
    if (!c) {
      c = {
        callId: crypto.randomUUID(),
        scope: t.scope,
        scopeId: t.scopeId,
        room: t.room,
        label: t.label,
        host: t.me,
        startedAt: Date.now(),
        statusMsgId: 0,
        people: [t.me],
        join: t.join,
        ns: t.ns,
        fanout: t.fanout,
        pushed: [],
      };
      const scopeArg = t.scope === "room" ? { channelId: t.scopeId } : { dmId: t.scopeId };
      const { id } = await t.db.createCallStatus(scopeArg, t.me.name, t.me.avatar, cardBody(c, false));
      c.statusMsgId = id;
      active.set(k, c);
      ensureReaper();
      const msg = await t.db.getMessage(id);
      if (msg) t.fanout({ t: "message:new", msg });
      const startedEv = {
        t: "quickcall:started" as const,
        scope: c.scope,
        scopeId: c.scopeId,
        slug: t.slug,
        callId: c.callId,
        host: c.host,
        label: c.label,
        startedAt: c.startedAt,
      };
      t.fanout(startedEv);
      // Timbre per-user "estés donde estés": para rooms privados, a los miembros que NO
      // están suscritos al canal del room (el fanout de arriba solo llega a startedBy lo ve).
      // En DM, el fanout YA es per-user → ringSubs=[]. Nunca a mí mismo (soy el host).
      for (const sub of t.ringSubs) {
        if (sub !== t.me.sub) t.bus.publish(t.bus.ch.user(t.ns, sub), startedEv);
      }
      // Notificación de SISTEMA (Web Push). El evento SSE de arriba sólo existe mientras
      // haya pestaña abierta y mirando; sin esto una llamada no se ve con la app cerrada
      // ni en segundo plano. TTL corto + urgency alta viven en notify.server.
      // Best-effort: nunca bloquea ni tumba el inicio de la llamada.
      void (async () => {
        try {
          const targets = await t.db.filterMutedOut(
            t.audience.filter((s) => s && s !== t.me.sub),
            t.scope,
            t.scopeId
          );
          if (!targets.length) return;
          c!.pushed = targets;
          const { notify } = await import("./notify.server");
          await notify(
            {
              kind: "call",
              recipients: targets,
              title: `${t.me.name} está llamando`,
              body: t.scope === "room" ? `Llamada en #${t.label}` : "Llamada directa",
              url: t.slug ? `/c/${t.slug}` : "/",
              tag: `call:${c!.callId}`,
            },
            t.ns
          );
        } catch {
          /* la llamada ya está viva; el push es un extra */
        }
      })();
    } else if (addPerson(c, t.me)) {
      await refreshCard(t.db, t.fanout, c);
    }
    // ⚠️ `await` obligatorio: esparcir una Promise da `{}` y TypeScript NO se queja —el
    // spread de un objeto es legal y una Promise es un objeto—, así que se habría
    // devuelto una conexión sin `token` ni `wss` y la llamada fallaría en el cliente
    // exactamente igual que el bug que esto arregla.
    return { callId: c.callId, ...(await conn(t)) };
  });

// Únete a una call en curso: MI propio token scoped; agrega mi avatar a la tarjeta.
export const joinCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = active.get(keyOf(t.ns, t.scope, t.scopeId));
    if (c && addPerson(c, t.me)) await refreshCard(t.db, t.fanout, c);
    return await conn(t);
  });

// Al salir: sondea la sala; si quedó vacía, colapsa la tarjeta a resumen.
export const leaveCallFn = createServerFn({ method: "POST" })
  .validator((d: Target & { alone?: boolean }) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const c = active.get(k);
    if (!c) return { ok: true as const, ended: false };
    // Termina SOLO si el SFU confirma que no queda NADIE más que yo. NO confiamos en el
    // hint `alone` del cliente a secas: un REFRESH dispara alone=true aunque el otro siga
    // dentro → antes eso mataba la call, y al volver se recreaba SIN los que seguían (card
    // "1 persona" sin ti). Verdad = roster del SFU, quitando UNA instancia de mi propio
    // nombre (el disconnect del que sale tarda en reflejarse).
    const names = await participantNames(t.cfg, t.room);
    if (names !== null) {
      const rest = [...names];
      const mine = rest.indexOf(t.me.name);
      if (mine >= 0) rest.splice(mine, 1);
      if (rest.length === 0) {
        await endCall(t.db, t.fanout, c, k);
        return { ok: true as const, ended: true };
      }
      return { ok: true as const, ended: false }; // queda alguien → la call sigue viva
    }
    // SFU inalcanzable → fallback previo: confía en el hint + reintentos de conteo.
    if (data.alone) {
      await endCall(t.db, t.fanout, c, k);
      return { ok: true as const, ended: true };
    }
    for (let i = 0; i < 5; i++) {
      const n = await participantCount(t.cfg, t.room);
      if (n === 0) {
        await endCall(t.db, t.fanout, c, k);
        return { ok: true as const, ended: true };
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return { ok: true as const, ended: false };
  });

// Call activa del scope (banner en carga/refresh). Self-heal: SFU vacío → ended.
export const getActiveCallFn = createServerFn({ method: "GET" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const c = active.get(k);
    if (!c) return null;
    const n = await participantCount(t.cfg, t.room);
    if (n === 0) {
      await endCall(t.db, t.fanout, c, k);
      return null;
    }
    return { callId: c.callId, host: c.host, label: c.label, startedAt: c.startedAt, participants: n < 0 ? null : n };
  });

// ── Grabación de la llamada ──────────────────────────────────────────────────
// La caja ya sabía grabar —ffmpeg, chromium y whisper llevan horneados desde siempre— y
// nadie se lo pedía. Esto es el cable, no la máquina.
//
// ⚠️ Sólo graba startedBy INICIÓ la llamada. Es la misma regla que "sólo detiene su turno startedBy
// lo pidió": grabar a un grupo es una acción sobre esas personas, no una preferencia de
// startedBy pasaba por ahí. Y por eso el testigo rojo lo ve todo el mundo.

/**
 * ¿La caja que sirve las llamadas es la misma que Studio va a poner a grabar?
 *
 * Sin `HUDDLE_CONTROL_URL` sí lo es: los dos lados caen al mismo dominio fijo. Con el env
 * puesto, sólo si apunta a ese mismo host — el env existe para depurar y para la ventana
 * de migración, y durante ella grabar sería grabar otra sala.
 */
function configPointsAtRecordingBox(): boolean {
  const env = process.env.HUDDLE_CONTROL_URL;
  if (!env) return true;
  try {
    return new URL(env).host === HUDDLE_HOST;
  } catch {
    return false;
  }
}

/** Quien inició la llamada. `null` si no hay llamada viva. */
function callOfTarget(t: Awaited<ReturnType<typeof resolveTarget>>): ActiveCall | null {
  return active.get(keyOf(t.ns, t.scope, t.scopeId)) ?? null;
}

export const startCallRecordingFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = callOfTarget(t);
    if (!c) return { ok: false as const, error: "No hay ninguna llamada activa" };
    if (c.host.sub !== t.me.sub) return { ok: false as const, error: "Sólo startedBy inició la llamada puede grabar" };
    if (c.recording) return { ok: true as const, recording: true, startedAt: c.recording.startedAt };

    // ⚠️ La grabación la pide Studio, que resuelve la caja por su DOMINIO FIJO. Si esta
    // instancia todavía habla con una caja distinta por `HUDDLE_CONTROL_URL`, grabaríamos
    // en una sala VACÍA de otra caja: el turno saldría en verde, el testigo rojo se
    // encendería, y al parar entregaríamos un MP4 de dos horas de nada. Es exactamente el
    // fallo mudo que hay que negarse a cometer, así que se comprueba y se dice.
    if (!configPointsAtRecordingBox()) {
      return {
        ok: false as const,
        error: "Grabación no disponible: esta instancia apunta a otra caja de llamadas (HUDDLE_CONTROL_URL)",
      };
    }

    const { startCallRecording } = await import("./call-recording.server");
    try {
      await startCallRecording(c.room, c.label);
    } catch (e) {
      // El motivo, tal cual. Un "no pude grabar" a secas manda a mirar la cámara cuando el
      // problema es que la caja no tiene disco o está despertando.
      return { ok: false as const, error: (e as Error).message || "No pude empezar a grabar" };
    }
    c.recording = { bySub: t.me.sub, byName: t.me.name, startedAt: Math.floor(Date.now() / 1000) };
    // El testigo rojo es para TODOS los que están dentro, no sólo para startedBy pulsó.
    t.fanout({ t: "quickcall:recording", scope: c.scope, scopeId: c.scopeId, recording: true });
    return { ok: true as const, recording: true, startedAt: c.recording.startedAt };
  });

export const stopCallRecordingFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = callOfTarget(t);
    if (!c) return { ok: false as const, error: "No hay ninguna llamada activa" };
    if (c.host.sub !== t.me.sub) return { ok: false as const, error: "Sólo startedBy inició la llamada puede detener la grabación" };
    if (!c.recording) return { ok: false as const, error: "No se está grabando" };

    const { stopCallRecording, saveCallRecording } = await import("./call-recording.server");
    const startedBy = c.recording.byName;
    // Se marca como parada ANTES de esperar la subida: parar y subir un MP4 de dos horas
    // tarda, y dejar el testigo rojo encendido mientras tanto hace que alguien vuelva a
    // pulsar y se lleve un "no se está grabando" con la grabación a medio guardar.
    c.recording = undefined;
    t.fanout({ t: "quickcall:recording", scope: c.scope, scopeId: c.scopeId, recording: false });

    let r: Awaited<ReturnType<typeof stopCallRecording>>;
    try {
      r = await stopCallRecording();
    } catch (e) {
      return { ok: false as const, error: (e as Error).message || "No pude detener la grabación" };
    }
    await saveCallRecording(
      { scope: c.scope, scopeId: c.scopeId, channelId: c.scope === "room" ? c.scopeId : 0 },
      r,
      startedBy,
      c.label
    ).catch((e) => console.error("[call-rec] no pude guardar la fila:", e));

    // Y se ANUNCIA en el chat, igual que en el room de eventos: lo publica startedBy detuvo,
    // con su nombre, no un "sistema" anónimo — un mensaje sin cara se lee como spam.
    //
    // ⚠️ Sólo en un room: un DM no tiene `channel_id` donde colgar el mensaje, y startedBy
    // paró ya recibe la URL en la respuesta.
    //
    // ⚠️ Y en su propio try/catch: que falle avisar no puede tumbar el guardado, porque la
    // grabación YA está a salvo en storage.
    if (c.scope === "room") {
      try {
        const minutos = r.startedAt ? Math.max(1, Math.round(Date.now() / 1000 / 60 - r.startedAt / 60)) : null;
        const { id: mid } = await t.db.createMessage({
          channelId: c.scopeId,
          parentId: null,
          sender: t.me.name,
          senderSub: t.me.sub,
          avatar: t.me.avatar || "",
          body: `🎬 Grabación lista${minutos ? ` (${minutos} min)` : ""} — [ver o descargar](${r.url})\n\n_El enlace caduca en 7 días._`,
        });
        const msg = await t.db.getMessage(mid);
        if (msg) t.fanout({ t: "message:new", msg });
      } catch (e) {
        console.error("[call-rec] no pude anunciar la grabación:", e);
      }
    }
    return { ok: true as const, url: r.url, transcriptUrl: r.transcriptUrl };
  });

/** Para pintar el testigo al entrar a una llamada que ya se está grabando. */
export const getCallRecordingFn = createServerFn({ method: "GET" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = callOfTarget(t);
    if (!c?.recording) return null;
    return { by: c.recording.byName, startedAt: c.recording.startedAt, canStop: c.host.sub === t.me.sub };
  });
