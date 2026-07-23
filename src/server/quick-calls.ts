import { createServerFn } from "@tanstack/react-start";
import crypto from "node:crypto";
import { sessionUser } from "./chat";

// ── Quick-calls ──────────────────────────────────────────────────────────────
// Llamadas en vivo (audio + video + pantalla), servidas por UNA caja `livekit-svc`
// compartida por TODOS los workspaces. La UI es NATIVA en Teams (livekit-client en
// el browser) → estas fns devuelven los DATOS DE CONEXIÓN (token + wss + sala), no
// una URL. Aislamiento por token:
//   • room = HMAC(LK_ROOM_SALT, `${ns}:${scope}:${id}`) → inadivinable + namespaceado
//     por workspace (dos tenants con el mismo id nunca colisionan).
//   • token scoped a ESA sala (roomJoin + room=X, sin roomList/wildcard) acuñado AQUÍ
//     tras verificar membresía. LiveKit rechaza otra sala → cero cruce de llamadas.
// El box está en modo LOCK_TOKEN (su /token abierto está cerrado) → el único emisor
// de tokens es este server.

type CallConfig = {
  controlUrl: string; // https://sb-<id>-8088.<pubDomain>  (solo server-side: /participants)
  wssUrl: string; // wss://sb-<id>-7880.<pubDomain>        (señalización LiveKit, al browser)
  apiKey: string;
  apiSecret: string;
  salt: string;
  adminToken: string; // Bearer para /participants (box en LOCK_TOKEN)
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

// Nombre de sala: determinista por (ns, scope, id), namespaceado e inadivinable.
function callRoom(cfg: CallConfig, ns: string, scope: "room" | "dm", id: number): string {
  const h = crypto.createHmac("sha256", cfg.salt).update(`${ns}:${scope}:${id}`).digest("hex");
  return "qc_" + h.slice(0, 24);
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Access token LiveKit (JWT HS256). Scoped a UNA sala; sin roomList/roomAdmin.
function mintToken(cfg: CallConfig, room: string, identity: string, name: string, ttlSec = 6 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: cfg.apiKey,
      sub: identity,
      name,
      nbf: now - 10,
      exp: now + ttlSec,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    })
  );
  const sig = crypto.createHmac("sha256", cfg.apiSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

// ¿Cuánta gente hay en la sala? (banner + auto-cierre). Box en LOCK_TOKEN → admin.
async function participantCount(cfg: CallConfig, room: string): Promise<number> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000); // nunca colgar el server
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

// Llamada activa (efímera, en memoria, por tenant). Se pierde en restart del proceso
// (la llamada vive en el SFU) → solo se cae el banner; self-heal por participantCount.
type ActiveCall = {
  callId: string;
  scope: "room" | "dm";
  scopeId: number;
  room: string;
  label: string;
  host: { sub: string; name: string; avatar: string };
  startedAt: number;
  statusMsgId: number; // mensaje-rastro (📞) en el timeline; se actualiza al colgar
  joiners: Set<string>; // subs distintos que entraron (para el conteo del rastro)
};
const active = new Map<string, ActiveCall>(); // key: `${ns}::${scope}::${id}`
const keyOf = (ns: string, scope: "room" | "dm", id: number) => `${ns}::${scope}::${id}`;

// Cierra una call: quita del mapa, avisa quickcall:ended y ACTUALIZA el rastro del
// timeline con duración + nº de participantes (estilo Slack).
async function endCall(
  db: typeof import("../db.server"),
  fanout: (ev: import("./bus.server").RtEvent) => void,
  c: ActiveCall,
  k: string
): Promise<void> {
  active.delete(k);
  fanout({ t: "quickcall:ended", scope: c.scope, scopeId: c.scopeId, callId: c.callId });
  try {
    const secs = Math.round((Date.now() - c.startedAt) / 1000);
    const dur = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
    const n = c.joiners.size;
    const body = `📞 Llamada terminada · ${dur} · ${n} ${n === 1 ? "persona" : "personas"}`;
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

  if (target.scope === "room") {
    const ch = await db.getChannel(target.slug);
    if (!ch) throw new Error("canal no encontrado");
    if (!(await db.canSeeChannel(ch, me.sub, !!me.isOwner))) throw new Error("no eres miembro de este canal");
    const room = callRoom(cfg, ns, "room", ch.id);
    return {
      me, cfg, ns, db, bus,
      scope: "room" as const,
      scopeId: ch.id,
      label: ch.name,
      room,
      fanout: (ev: import("./bus.server").RtEvent) => bus.publish(bus.ch.room(ns, ch.id), ev),
    };
  }

  // DM
  if (!(await db.isDmMember(target.dmId, me.sub))) throw new Error("no eres parte de esta conversación");
  if (await db.getDmAgentHandle(target.dmId)) throw new Error("sin llamadas con agentes"); // aún
  const members = await db.getDmMembers(target.dmId);
  const room = callRoom(cfg, ns, "dm", target.dmId);
  return {
    me, cfg, ns, db, bus,
    scope: "dm" as const,
    scopeId: target.dmId,
    label: "Llamada",
    room,
    fanout: (ev: import("./bus.server").RtEvent) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    },
  };
}

// Datos de conexión para el cliente nativo (livekit-client).
function conn(t: Awaited<ReturnType<typeof resolveTarget>>) {
  return { token: mintToken(t.cfg, t.room, t.me.sub, t.me.name), wss: t.cfg.wssUrl, room: t.room, name: t.me.name };
}

// Inicia una llamada: marca activa, avisa a la audiencia (banner) y devuelve MI conexión.
export const startCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    let c = active.get(k);
    if (!c) {
      // Rastro persistente en el timeline (se actualiza al colgar).
      const scopeArg = t.scope === "room" ? { channelId: t.scopeId } : { dmId: t.scopeId };
      const { id: statusMsgId } = await t.db.createCallStatus(scopeArg, t.me.name, t.me.avatar, `📞 ${t.me.name} inició una llamada`);
      c = {
        callId: crypto.randomUUID(),
        scope: t.scope,
        scopeId: t.scopeId,
        room: t.room,
        label: t.label,
        host: { sub: t.me.sub, name: t.me.name, avatar: t.me.avatar },
        startedAt: Date.now(),
        statusMsgId,
        joiners: new Set([t.me.sub]),
      };
      active.set(k, c);
      const msg = await t.db.getMessage(statusMsgId);
      if (msg) t.fanout({ t: "message:new", msg });
      t.fanout({
        t: "quickcall:started",
        scope: c.scope,
        scopeId: c.scopeId,
        callId: c.callId,
        host: c.host,
        label: c.label,
        startedAt: c.startedAt,
      });
    } else {
      c.joiners.add(t.me.sub);
    }
    return { callId: c.callId, ...conn(t) };
  });

// Únete a una llamada en curso: MI propio token scoped (no se comparten tokens).
export const joinCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const c = active.get(keyOf(t.ns, t.scope, t.scopeId));
    if (c) c.joiners.add(t.me.sub); // cuenta al que se une (para el rastro)
    return conn(t);
  });

// Al salir: sondea la sala; si quedó vacía, marca ended + limpia el banner.
export const leaveCallFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const c = active.get(k);
    if (!c) return { ok: true as const, ended: false };
    // Confirma vacío con reintentos: el disconnect del que sale tarda ~1-3s en
    // reflejarse en el SFU. Solo cerramos si OBSERVAMOS 0 (si quedan otros nunca
    // llega a 0 → el banner se mantiene). Fire-and-forget desde el cliente.
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

// Llamada activa del scope (banner en carga/refresh). Self-heal: SFU vacío → ended.
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
