// Uptime propio, sin terceros: las URLs que un room vigila (`gt_uptime_checks`).
//
// El tick de wakeups llama `sweepUptime` y cada URL se mira cada 60 s con `guardedGet` (nunca
// IPs internas, sigue redirecciones). Se CAE a la 2ª falla seguida —una sola es ruido de red—
// y entonces se publica un 🔴 top-level en el room y @plan investiga por el mismo camino que
// las alertas de monitoreo (`enqueueAlertInvestigation`: una vez por día y huella). Cuando
// vuelve, 🟢 en el hilo del 🔴. Una caída avisa UNA vez, por larga que sea.
//
// Las URLs las agregan las tools (`uptime_add`), la UI de /factory y, solo, el `homepage` del
// repo al conectarlo a un room o en su primer post-merge.
import { dbq } from "../../dbq.server";
import type { ConnectorTool } from "../connectors/impl";
import type { ToolDest } from "../connectors/tool-token.server";

export const MAX_CHECKS_PER_ROOM = 10;
const CHECK_EVERY_S = 60;
const CHECK_TIMEOUT_MS = 10_000;

export type UptimeState = { state: "up" | "down"; fails: number };

/** Arriba = contestó con < 400 (tras redirecciones). Un error de red o timeout es caído. */
export const isUp = (status: number | null): boolean => status != null && status < 400;

/**
 * La máquina de estados: up → (1 falla, sigue up) → 2ª falla seguida: down + aviso →
 * (sigue cayendo: sin aviso) → primera respuesta buena: up + «volvió».
 */
export function uptimeStep(prev: UptimeState, ok: boolean): { next: UptimeState; event: "down" | "recovered" | null } {
  if (ok) return { next: { state: "up", fails: 0 }, event: prev.state === "down" ? "recovered" : null };
  const fails = prev.fails + 1;
  if (prev.state === "up" && fails >= 2) return { next: { state: "down", fails }, event: "down" };
  return { next: { state: prev.state, fails }, event: null };
}

/** `https://www.denik.me/` → `denik.me`; con ruta, `denik.me/planes`. */
export function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

export function downFor(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export type UptimeCheck = {
  id: number;
  channelId: number;
  url: string;
  createdBy: string;
  state: "up" | "down";
  fails: number;
  lastStatus: number | null;
  lastMs: number | null;
  lastCheckAt: number | null;
  downSince: number | null;
  alertRootId: number | null;
};

const toCheck = (r: Record<string, any>): UptimeCheck => ({
  id: Number(r.id),
  channelId: Number(r.channel_id),
  url: String(r.url),
  createdBy: String(r.created_by),
  state: r.state === "down" ? "down" : "up",
  fails: Number(r.fails ?? 0),
  lastStatus: r.last_status == null ? null : Number(r.last_status),
  lastMs: r.last_ms == null ? null : Number(r.last_ms),
  lastCheckAt: r.last_check_at == null ? null : Number(r.last_check_at),
  downSince: r.down_since == null ? null : Number(r.down_since),
  alertRootId: r.alert_root_id == null ? null : Number(r.alert_root_id),
});

export async function listUptimeChecks(channelId: number): Promise<UptimeCheck[]> {
  const rows = await dbq("SELECT * FROM gt_uptime_checks WHERE channel_id = ? ORDER BY id", [channelId]);
  return rows.map(toCheck);
}

/** Agrega una URL al room. Lanza con el motivo (guard de red, tope) en español. */
export async function addUptimeCheck(channelId: number, raw: string, sub: string): Promise<UptimeCheck> {
  const { assertMonitorUrl } = await import("../connectors/net-guard.server");
  const url = await assertMonitorUrl(raw);
  const current = await listUptimeChecks(channelId);
  const dup = current.find((c) => c.url === url);
  if (dup) return dup;
  if (current.length >= MAX_CHECKS_PER_ROOM) throw new Error(`este room ya vigila ${MAX_CHECKS_PER_ROOM} URLs; quita una antes`);
  const [row] = await dbq(
    "INSERT INTO gt_uptime_checks (channel_id, url, created_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING *",
    [channelId, url, sub],
  );
  return row ? toCheck(row) : (await listUptimeChecks(channelId)).find((c) => c.url === url)!;
}

export async function removeUptimeCheck(channelId: number, id: number): Promise<boolean> {
  const rows = await dbq("DELETE FROM gt_uptime_checks WHERE channel_id = ? AND id = ? RETURNING id", [channelId, id]);
  return rows.length > 0;
}

/**
 * La URL de producción de un repo: su `homepage` en GitHub. `http://denik.me` se sube a https
 * si contesta por ahí; si no, se deja como está. null si el repo no declara una.
 */
export async function repoHomepage(sub: string, repo: string): Promise<string | null> {
  const { githubApi } = await import("../connectors/github.server");
  const r = await githubApi(sub, `/repos/${repo}`);
  const raw = typeof r?.homepage === "string" ? r.homepage.trim() : "";
  if (!raw) return null;
  const { assertMonitorUrl, guardedGet } = await import("../connectors/net-guard.server");
  const url = await assertMonitorUrl(raw).catch(() => null);
  if (!url) return null;
  if (url.startsWith("http://")) {
    const https = url.replace(/^http:/, "https:");
    const ok = await guardedGet(https, { timeoutMs: CHECK_TIMEOUT_MS }).then((x) => x.status < 500).catch(() => false);
    if (ok) return https;
  }
  return url;
}

/** Alta automática: si el room no vigila nada todavía, vigila esta URL. Nunca lanza. */
export async function ensureFirstMonitor(channelId: number, url: string | null, sub: string): Promise<void> {
  if (!url) return;
  try {
    const [n] = await dbq("SELECT COUNT(*) AS n FROM gt_uptime_checks WHERE channel_id = ?", [channelId]);
    if (Number(n?.n ?? 0) > 0) return;
    await addUptimeCheck(channelId, url, sub);
  } catch (e) {
    console.error(`[uptime] alta automática ${url}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Al conectar un repo a un room: su `homepage` como primer monitor. Best-effort, en segundo plano. */
export async function autoMonitorRepo(channelId: number, repo: string, sub: string): Promise<void> {
  try {
    await ensureFirstMonitor(channelId, await repoHomepage(sub, repo), sub);
  } catch {
    /* sin homepage o sin GitHub: no hay nada que vigilar */
  }
}

// ── El barrido ───────────────────────────────────────────────────────────────

/** Quién avisa: @plan si existe (es quien investiga), si no el primer agente del espacio. */
async function watcherAgent(): Promise<{ handle: string; name: string; avatar: string }> {
  const { resolvedAgents } = await import("../../agents.server");
  const agents = await resolvedAgents();
  const a = agents.find((x) => x.handle === "plan") ?? agents[0];
  return a ? { handle: a.handle, name: a.name, avatar: a.avatar } : { handle: "ghosty", name: "Ghosty", avatar: "" };
}

/** Base pública del tenant para el turno de la investigación (fuera de un request no hay host). */
async function tenantOrigin(): Promise<string> {
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug().catch(() => null);
  return slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : "";
}

async function checkOne(c: UptimeCheck): Promise<void> {
  const { guardedGet } = await import("../connectors/net-guard.server");
  const now = Math.floor(Date.now() / 1000);
  let status: number | null = null;
  let ms: number | null = null;
  let error = "";
  try {
    const r = await guardedGet(c.url, { timeoutMs: CHECK_TIMEOUT_MS });
    status = r.status;
    ms = r.ms;
  } catch (e) {
    error = e instanceof Error && e.name === "TimeoutError" ? "no contestó en 10 s" : e instanceof Error ? e.message : String(e);
  }
  const { next, event } = uptimeStep({ state: c.state, fails: c.fails }, isUp(status));
  await dbq(
    `UPDATE gt_uptime_checks SET state = ?, fails = ?, last_status = ?, last_ms = ?, last_check_at = ?,
       down_since = CASE WHEN ? = 'down' THEN COALESCE(down_since, ?) ELSE NULL END
     WHERE id = ?`,
    [next.state, next.fails, status, ms, now, next.state, now, c.id],
  );
  if (!event) return;

  const { currentNamespace } = await import("../tenant.server");
  const ns = await currentNamespace();
  const who = await watcherAgent();
  const ref = { ns, channelId: c.channelId, topic: "general", ...who, ownerSub: c.createdBy };
  const { publishAsAgent, enqueueAlertInvestigation } = await import("../hooks/generic-alert.server");
  const label = urlLabel(c.url);
  if (event === "down") {
    const why = status != null ? `HTTP ${status}` : error || "sin respuesta";
    const id = await publishAsAgent(ref, `🔴 **${label} no responde** (${why}) · ${c.url}`);
    if (!id) return;
    await dbq("UPDATE gt_uptime_checks SET alert_root_id = ? WHERE id = ?", [id, c.id]);
    await enqueueAlertInvestigation({
      ref,
      alert: {
        source: "uptime",
        title: `${label} no responde (${why})`,
        body: `El monitor de uptime del room falló dos veces seguidas (cada ${CHECK_EVERY_S} s). Revisa el deploy más reciente y los logs del servicio.`,
        status: "firing",
        link: c.url,
        eventId: "",
        key: `uptime:${c.channelId}:${c.url}`,
      },
      alertMessageId: id,
      origin: await tenantOrigin(),
    });
    return;
  }
  const since = c.downSince ?? now;
  await publishAsAgent(ref, `🟢 **${label} volvió** tras ${downFor(now - since)}`, c.alertRootId);
  await dbq("UPDATE gt_uptime_checks SET alert_root_id = NULL WHERE id = ?", [c.id]);
}

/** Lo llama el tick de wakeups. Todas las URLs vencidas en paralelo; una que truena no frena a las demás. */
export async function sweepUptime(): Promise<void> {
  const rows = await dbq(
    `SELECT u.* FROM gt_uptime_checks u JOIN gc_channels c ON c.id = u.channel_id
     WHERE COALESCE(c.archived, 0) = 0 AND (u.last_check_at IS NULL OR u.last_check_at <= unixepoch() - ?)
     ORDER BY u.last_check_at LIMIT 50`,
    [CHECK_EVERY_S - 5],
  ).catch(() => []);
  const results = await Promise.allSettled(rows.map((r) => checkOne(toCheck(r))));
  for (const r of results) if (r.status === "rejected") console.error("[uptime]", r.reason);
}

// ── Tools del agente ─────────────────────────────────────────────────────────

export function uptimeTools(dest: ToolDest | null): ConnectorTool[] {
  const soloCanal = { ok: false, error: "El uptime se vigila por room, no en un DM." };
  const view = (c: UptimeCheck) => ({
    id: c.id,
    url: c.url,
    state: c.state,
    lastStatus: c.lastStatus,
    lastMs: c.lastMs,
    lastCheckAt: c.lastCheckAt,
    downSince: c.downSince,
  });
  return [
    {
      name: "uptime_add",
      description:
        "Vigila una URL de producción desde ESTE room: se revisa cada 60 s y, si falla dos veces seguidas, se " +
        "avisa aquí con 🔴 y @plan investiga; cuando vuelve, 🟢 en el mismo hilo. Úsalo cuando pidan 'vigila " +
        `denik.me/planes', 'avísame si se cae'. Máximo ${MAX_CHECKS_PER_ROOM} por room; sólo dominios públicos.`,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "URL a vigilar (p.ej. 'https://denik.me/planes')" } },
        required: ["url"],
      },
      handler: async (sub, a) => {
        if (!dest?.channelId || dest.dmId) return soloCanal;
        try {
          return { ok: true, check: view(await addUptimeCheck(dest.channelId, String(a.url ?? ""), sub)) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: "uptime_list",
      description: "Lista las URLs que vigila este room: estado (up/down), último código HTTP, latencia y desde cuándo está caída.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        if (!dest?.channelId || dest.dmId) return soloCanal;
        return { ok: true, checks: (await listUptimeChecks(dest.channelId)).map(view) };
      },
    },
    {
      name: "uptime_remove",
      description: "Deja de vigilar una URL de este room por su id (ver uptime_list). Confirma con el usuario antes de quitarla.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "id del monitor (ver uptime_list)" } },
        required: ["id"],
      },
      handler: async (_sub, a) => {
        if (!dest?.channelId || dest.dmId) return soloCanal;
        const removed = await removeUptimeCheck(dest.channelId, Number(a.id));
        return removed ? { ok: true, removed: Number(a.id) } : { ok: false, error: "no hay un monitor con ese id en este room" };
      },
    },
  ];
}
