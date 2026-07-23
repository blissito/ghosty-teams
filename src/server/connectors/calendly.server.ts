// Wrapper Calendly per-user (Fase B). Resuelve el token del `sub` dado vía
// getValidToken (refresh transparente). `getSchedulingContext` es BARATO (lee lo
// guardado en connect, sin llamada a la API) → apto para inyectar en cada turno de DM.
// `listEventTypes`/`createSchedulingLink` llaman a la API (para la tool MCP, Fase B-full).
import { getValidToken } from "./oauth.server";
import { getConnectorRow } from "./store.server";

const API = "https://api.calendly.com";

// ── Contrato uniforme de conector (lo que consume el builder genérico) ───────────
// `ambientContext`: bloque BARATO que se inyecta en cada turno del DM si el usuario tiene
// el conector (sin llamadas a la API pesadas). Las capacidades ricas (disponibilidad real,
// agendar) NO van aquí —serían tools/skills que el agente invoca on-demand— para no engordar
// cada turno ni acoplar dm.ts a cada integración. Ver connectors/context.server.ts.
export async function ambientContext(sub: string, sender: string): Promise<string | null> {
  const cal = await getSchedulingContext(sub);
  if (!cal) return null;
  return (
    `[Contexto — Calendly de ${sender}: su link de agendamiento es ${cal.schedulingUrl}` +
    `${cal.timezone ? ` (zona horaria ${cal.timezone})` : ""}. Si pide agendar una llamada/reunión o su disponibilidad, comparte ESTE link.]`
  );
}

// Link de agendamiento + zona, desde el meta capturado al conectar. Sin round-trip.
export async function getSchedulingContext(
  sub: string
): Promise<{ schedulingUrl: string; name: string | null; timezone: string | null } | null> {
  const row = await getConnectorRow(sub, "calendly");
  if (!row?.access_token || !row.meta) return null;
  try {
    const m = JSON.parse(row.meta) as { scheduling_url?: string; name?: string; timezone?: string };
    if (!m.scheduling_url) return null;
    return { schedulingUrl: m.scheduling_url, name: m.name ?? null, timezone: m.timezone ?? null };
  } catch {
    return null;
  }
}

// Tipos de evento ACTIVOS del usuario (GET /event_types). Vacío si falla o sin conexión.
export async function listEventTypes(
  sub: string
): Promise<Array<{ name: string; uri: string; schedulingUrl: string; durationMin: number | null }>> {
  const [token, row] = await Promise.all([getValidToken(sub, "calendly"), getConnectorRow(sub, "calendly")]);
  if (!token || !row?.external_id) return [];
  const res = await fetch(`${API}/event_types?user=${encodeURIComponent(row.external_id)}&active=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    collection?: Array<{ name: string; uri: string; scheduling_url: string; duration: number }>;
  };
  return (j.collection ?? []).map((e) => ({
    name: e.name,
    uri: e.uri,
    schedulingUrl: e.scheduling_url,
    durationMin: e.duration ?? null,
  }));
}

// Link de agendamiento de UN solo uso para un tipo de evento (POST /scheduling_links).
export async function createSchedulingLink(sub: string, eventTypeUri: string): Promise<string | null> {
  const token = await getValidToken(sub, "calendly");
  if (!token) return null;
  const res = await fetch(`${API}/scheduling_links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_event_count: 1, owner: eventTypeUri, owner_type: "EventType" }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { resource?: { booking_url?: string } };
  return j.resource?.booking_url ?? null;
}

// ── Digest read-aware (para inyectar en DM cuando el mensaje es de agenda) ────────
// Combina link + disponibilidad (availability:read) + tipos de evento (event_types:read)
// + próximas citas (scheduled_events:read) en un bloque compacto. Cacheado por `sub`
// (5 min) → una ráfaga de mensajes de agenda no dispara la API en cada turno. Best-effort:
// cualquier parte que falle se omite; NUNCA lanza.
const DIGEST_TTL_MS = 5 * 60 * 1000;
const digestCache = new Map<string, { text: string | null; exp: number }>();
const DAY_ES: Record<string, string> = {
  monday: "lun", tuesday: "mar", wednesday: "mié", thursday: "jue",
  friday: "vie", saturday: "sáb", sunday: "dom",
};

async function fetchAvailability(token: string, userUri: string, tzFallback: string | null): Promise<string | null> {
  try {
    const res = await fetch(`${API}/user_availability_schedules?user=${encodeURIComponent(userUri)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      collection?: Array<{ default?: boolean; timezone?: string; rules?: Array<{ type?: string; wday?: string; intervals?: Array<{ from?: string; to?: string }> }> }>;
    };
    const sched = (j.collection ?? []).find((s) => s.default) ?? j.collection?.[0];
    if (!sched?.rules?.length) return null;
    const days = sched.rules
      .filter((r) => r.type === "wday" && r.wday && r.intervals?.length)
      .map((r) => `${DAY_ES[r.wday!] ?? r.wday} ${r.intervals!.map((i) => `${i.from}–${i.to}`).join(", ")}`);
    if (!days.length) return null;
    const tz = sched.timezone || tzFallback;
    return `${days.join("; ")}${tz ? ` (${tz})` : ""}`;
  } catch {
    return null;
  }
}

async function fetchUpcoming(token: string, userUri: string, tz: string | null): Promise<string | null> {
  try {
    const now = new Date(Date.now()).toISOString();
    const res = await fetch(
      `${API}/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&min_start_time=${encodeURIComponent(now)}&sort=start_time:asc&count=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { collection?: Array<{ name?: string; start_time?: string }> };
    const fmt = new Intl.DateTimeFormat("es-MX", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: tz || "UTC",
    });
    const items = (j.collection ?? [])
      .filter((e) => e.start_time)
      .map((e) => `${e.name || "Evento"} ${fmt.format(new Date(e.start_time!))}`);
    return items.length ? items.join("; ") : "sin citas próximas";
  } catch {
    return null;
  }
}

// Bloque de contexto rico para el turno. Devuelve null si no hay conexión.
export async function getSchedulingDigest(sub: string, senderLabel: string): Promise<string | null> {
  const hit = digestCache.get(sub);
  if (hit && hit.exp > Date.now()) return hit.text;
  const [ctx, token, row] = await Promise.all([
    getSchedulingContext(sub),
    getValidToken(sub, "calendly"),
    getConnectorRow(sub, "calendly"),
  ]);
  if (!ctx || !token || !row?.external_id) {
    digestCache.set(sub, { text: null, exp: Date.now() + DIGEST_TTL_MS });
    return null;
  }
  const uri = row.external_id;
  const [avail, upcoming, types] = await Promise.all([
    fetchAvailability(token, uri, ctx.timezone),
    fetchUpcoming(token, uri, ctx.timezone),
    listEventTypes(sub),
  ]);
  const lines = [`[Contexto — Calendly de ${senderLabel}:`, `• Link de agendamiento: ${ctx.schedulingUrl}`];
  if (avail) lines.push(`• Disponibilidad: ${avail}`);
  if (types.length) lines.push(`• Tipos de reunión: ${types.map((t) => `${t.name}${t.durationMin ? ` (${t.durationMin} min)` : ""}`).join(", ")}`);
  if (upcoming) lines.push(`• Próximas citas: ${upcoming}`);
  lines.push(
    `Usa ESTO para responder sobre disponibilidad/agenda del que pregunta. Para reservar, comparte el link (aún no puedes crear la cita tú mismo).]`
  );
  const text = lines.join("\n");
  digestCache.set(sub, { text, exp: Date.now() + DIGEST_TTL_MS });
  return text;
}
