import { createServerFn } from "@tanstack/react-start";
import crypto from "node:crypto";
import { sessionUser } from "./chat";

// ── Huddles (quick calls) ────────────────────────────────────────────────────
// Llamadas en vivo estilo Slack (audio + video + pantalla), servidas por UNA sola
// caja `livekit-svc` compartida por TODOS los workspaces. El aislamiento NO viene
// de cajas separadas sino del TOKEN:
//   • room = HMAC(LK_ROOM_SALT, `${ns}:${scope}:${id}`) → inadivinable + namespaceado
//     por workspace (dos tenants con el mismo channelId nunca colisionan).
//   • el token va scoped a ESA sala (roomJoin + room=X, sin roomList/wildcard) y se
//     acuña AQUÍ, sólo tras verificar membresía. LiveKit rechaza conectar a otra
//     sala con él → cero cruce de llamadas, nadie entra donde no fue invitado.
// El /token abierto del box está cerrado en la caja compartida (LOCK_TOKEN=1), así
// que la ÚNICA forma de obtener un token es pasando por estas server fns.

type HuddleConfig = {
  controlUrl: string; // https://sb-<id>-8088.<pubDomain>  (sirve /room, /participants)
  wssUrl: string; // wss://sb-<id>-7880.<pubDomain>       (señalización LiveKit)
  apiKey: string;
  apiSecret: string;
  salt: string;
  adminToken: string; // Bearer para /participants (box en modo LOCK_TOKEN)
};

function huddleConfig(): HuddleConfig | null {
  const controlUrl = process.env.HUDDLE_CONTROL_URL;
  const wssUrl = process.env.HUDDLE_WSS_URL;
  const apiKey = process.env.LK_API_KEY;
  const apiSecret = process.env.LK_API_SECRET;
  const salt = process.env.LK_ROOM_SALT;
  const adminToken = process.env.HUDDLE_ADMIN_TOKEN || "";
  if (!controlUrl || !wssUrl || !apiKey || !apiSecret || !salt) return null;
  return { controlUrl: controlUrl.replace(/\/$/, ""), wssUrl, apiKey, apiSecret, salt, adminToken };
}

export function huddlesEnabled(): boolean {
  return huddleConfig() != null;
}

// Nombre de sala: determinista por (ns, scope, id), namespaceado e inadivinable.
function huddleRoom(cfg: HuddleConfig, ns: string, scope: "room" | "dm", id: number): string {
  const h = crypto.createHmac("sha256", cfg.salt).update(`${ns}:${scope}:${id}`).digest("hex");
  return "hud_" + h.slice(0, 24);
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Access token LiveKit (JWT HS256) — misma forma de claim que el mintToken del box
// (templates/livekit-svc/server.mjs). Scoped a UNA sala; sin roomList/roomAdmin.
function mintToken(cfg: HuddleConfig, room: string, identity: string, name: string, ttlSec = 6 * 3600): string {
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

// URL del /room del box con el token scoped + WSS explícito + tema gs ligero.
function joinUrl(cfg: HuddleConfig, room: string, token: string, displayName: string, label: string): string {
  const q = new URLSearchParams({
    room,
    token,
    ws: cfg.wssUrl,
    theme: "gs",
    identity: displayName,
    label,
  });
  return `${cfg.controlUrl}/room?${q.toString()}`;
}

// ¿Cuánta gente hay en la sala? (para banner + auto-cierre). El box está en modo
// LOCK_TOKEN → /participants exige Bearer ADMIN_TOKEN.
async function participantCount(cfg: HuddleConfig, room: string): Promise<number> {
  try {
    const res = await fetch(`${cfg.controlUrl}/participants?room=${encodeURIComponent(room)}`, {
      headers: cfg.adminToken ? { authorization: `Bearer ${cfg.adminToken}` } : undefined,
    });
    if (!res.ok) return -1; // desconocido (no forzamos "vacío")
    const j = (await res.json()) as { participants?: unknown[] };
    return Array.isArray(j.participants) ? j.participants.filter(Boolean).length : 0;
  } catch {
    return -1;
  }
}

// Huddle activo (efímero, en memoria, por tenant). Se pierde en restart del proceso
// (la llamada en sí sobrevive: vive en el SFU) → sólo se cae el banner, self-heal
// en la siguiente carga vía participantCount. Durabilidad no hace falta en MVP.
type ActiveHuddle = {
  huddleId: string;
  scope: "room" | "dm";
  scopeId: number;
  room: string;
  label: string;
  host: { sub: string; name: string; avatar: string };
  startedAt: number;
};
const active = new Map<string, ActiveHuddle>(); // key: `${ns}::${scope}::${id}`
const keyOf = (ns: string, scope: "room" | "dm", id: number) => `${ns}::${scope}::${id}`;

// Resuelve el target (canal por slug / DM por id): verifica membresía, devuelve el
// contexto (ns, scopeId, label amable, sala, fanout del evento) o lanza si no autorizado.
type Target = { scope: "room"; slug: string } | { scope: "dm"; dmId: number };

async function resolveTarget(target: Target) {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const cfg = huddleConfig();
  if (!cfg) throw new Error("huddles no disponibles");
  const db = await import("../db.server");
  const bus = await import("./bus.server");
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace();

  if (target.scope === "room") {
    const ch = await db.getChannel(target.slug);
    if (!ch) throw new Error("canal no encontrado");
    if (!(await db.canSeeChannel(ch, me.sub, !!me.isOwner))) throw new Error("no eres miembro de este canal");
    const room = huddleRoom(cfg, ns, "room", ch.id);
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
  // Sin llamadas con agentes de la flota (aún): un DM 1:1 con un agente no tiene call.
  if (await db.getDmAgentHandle(target.dmId)) throw new Error("sin llamadas con agentes");
  const members = await db.getDmMembers(target.dmId);
  const room = huddleRoom(cfg, ns, "dm", target.dmId);
  return {
    me, cfg, ns, db, bus,
    scope: "dm" as const,
    scopeId: target.dmId,
    label: "Huddle",
    room,
    fanout: (ev: import("./bus.server").RtEvent) => {
      for (const sub of members) bus.publish(bus.ch.user(ns, sub), ev);
    },
  };
}

// Inicia un huddle: acuña MI token scoped, marca el huddle activo y avisa a la
// audiencia (banner "Unirse") vía el bus. Devuelve MI URL de entrada.
export const startHuddleFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    let h = active.get(k);
    if (!h) {
      h = {
        huddleId: crypto.randomUUID(),
        scope: t.scope,
        scopeId: t.scopeId,
        room: t.room,
        label: t.label,
        host: { sub: t.me.sub, name: t.me.name, avatar: t.me.avatar },
        startedAt: Date.now(),
      };
      active.set(k, h);
      t.fanout({
        t: "huddle:started",
        scope: h.scope,
        scopeId: h.scopeId,
        huddleId: h.huddleId,
        host: h.host,
        label: h.label,
        startedAt: h.startedAt,
      });
    }
    const token = mintToken(t.cfg, t.room, t.me.sub, t.me.name);
    return { huddleId: h.huddleId, url: joinUrl(t.cfg, t.room, token, t.me.name, t.label) };
  });

// Únete a un huddle en curso: acuña MI propio token scoped (no se comparten tokens)
// y devuelve MI URL. La membresía se re-verifica aquí.
export const joinHuddleFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const token = mintToken(t.cfg, t.room, t.me.sub, t.me.name);
    return { url: joinUrl(t.cfg, t.room, token, t.me.name, t.label) };
  });

// Al salir: sondea la sala; si quedó vacía, marca ended + avisa (limpia el banner).
export const leaveHuddleFn = createServerFn({ method: "POST" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const h = active.get(k);
    if (!h) return { ok: true as const, ended: false };
    const n = await participantCount(t.cfg, t.room);
    if (n === 0) {
      active.delete(k);
      t.fanout({ t: "huddle:ended", scope: h.scope, scopeId: h.scopeId, huddleId: h.huddleId });
      return { ok: true as const, ended: true };
    }
    return { ok: true as const, ended: false };
  });

// Huddle activo del scope (para pintar el banner en carga/refresh). Self-heal: si
// el SFU reporta la sala vacía, lo damos por terminado y limpiamos.
export const getActiveHuddleFn = createServerFn({ method: "GET" })
  .validator((d: Target) => d)
  .handler(async ({ data }) => {
    const t = await resolveTarget(data);
    const k = keyOf(t.ns, t.scope, t.scopeId);
    const h = active.get(k);
    if (!h) return null;
    const n = await participantCount(t.cfg, t.room);
    if (n === 0) {
      active.delete(k);
      t.fanout({ t: "huddle:ended", scope: h.scope, scopeId: h.scopeId, huddleId: h.huddleId });
      return null;
    }
    return {
      huddleId: h.huddleId,
      host: h.host,
      label: h.label,
      startedAt: h.startedAt,
      participants: n < 0 ? null : n,
    };
  });
