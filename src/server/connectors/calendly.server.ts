// Wrapper Calendly per-user (Fase B). Resuelve el token del `sub` dado vía
// getValidToken (refresh transparente). `getSchedulingContext` es BARATO (lee lo
// guardado en connect, sin llamada a la API) → apto para inyectar en cada turno de DM.
// `listEventTypes`/`createSchedulingLink` llaman a la API (para la tool MCP, Fase B-full).
import { getValidToken } from "./oauth.server";
import { getConnectorRow } from "./store.server";

const API = "https://api.calendly.com";

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
