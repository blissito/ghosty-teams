import { createServerFn } from "@tanstack/react-start";
import crypto from "node:crypto";
import { sessionUser } from "./chat";

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

function callConfig(): CallConfig | null {
  const controlUrl = process.env.HUDDLE_CONTROL_URL;
  const wssUrl = process.env.HUDDLE_WSS_URL;
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

async function participantCount(cfg: CallConfig, room: string): Promise<number> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000);
    const res = await fetch(`${cfg.controlUrl}/participants?room=${encodeURIComponent(room)}`, {
      headers: cfg.adminToken ? { authorization: `Bearer ${cfg.adminToken}` } : undefined,
      signal: ac.signal,
    }).finally(() => clearTimeout(to));
    if (!res.ok) return -1;
    const j = (await res.json()) as { participants?: unknown[] };
    return Array.isArray(j.participants) ? j.participants.filter(Boolean).length : 0;
  } catch {
    return -1;
  }
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
};
const active = new Map<string, ActiveCall>(); // key: `${ns}::${scope}::${id}`
const keyOf = (ns: string, scope: "room" | "dm", id: number) => `${ns}::${scope}::${id}`;

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
    return {
      me: person, cfg, ns, db, bus,
      scope: "room" as const,
      scopeId: ch.id,
      slug: ch.slug,
      label: ch.name,
      room,
      ringSubs,
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
    join: { scope: "dm" as const, dmId: target.dmId, label: "Llamada" } as JoinDesc,
    fanout: (ev: import("./bus.server").RtEvent) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    },
  };
}

function conn(t: Awaited<ReturnType<typeof resolveTarget>>) {
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
      };
      const scopeArg = t.scope === "room" ? { channelId: t.scopeId } : { dmId: t.scopeId };
      const { id } = await t.db.createCallStatus(scopeArg, t.me.name, t.me.avatar, cardBody(c, false));
      c.statusMsgId = id;
      active.set(k, c);
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
      // están suscritos al canal del room (el fanout de arriba solo llega a quien lo ve).
      // En DM, el fanout YA es per-user → ringSubs=[]. Nunca a mí mismo (soy el host).
      for (const sub of t.ringSubs) {
        if (sub !== t.me.sub) t.bus.publish(t.bus.ch.user(t.ns, sub), startedEv);
      }
    } else if (addPerson(c, t.me)) {
      await refreshCard(t.db, t.fanout, c);
    }
    return { callId: c.callId, ...conn(t) };
  });

// Únete a una call en curso: MI propio token scoped; agrega mi avatar a la tarjeta.
export const joinCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = active.get(keyOf(t.ns, t.scope, t.scopeId));
    if (c && addPerson(c, t.me)) await refreshCard(t.db, t.fanout, c);
    return conn(t);
  });

// Al salir: sondea la sala; si quedó vacía, colapsa la tarjeta a resumen.
export const leaveCallFn = createServerFn({ method: "POST" })
  .validator((d: Target & { alone?: boolean }) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const c = active.get(k);
    if (!c) return { ok: true as const, ended: false };
    // El cliente sabe en vivo si quedó SOLO → cierre inmediato y confiable.
    if (data.alone) {
      await endCall(t.db, t.fanout, c, k);
      return { ok: true as const, ended: true };
    }
    // Fallback: confirma vacío con reintentos (el disconnect tarda en reflejarse).
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
