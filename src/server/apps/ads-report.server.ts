// El reporte automático de Ghosty Ads: a las 9:00 y 21:00 (CDMX, configurable) la plataforma
// publica en el room de anuncios un `gt-ads-report` con el embudo de cada campaña activa
// (insights de Meta + leads del tablero) y avisa con `notify()`. Si nada cambió desde el
// último, se calla: un reporte igual al anterior es ruido.
//
// No despierta a ningún agente (no hay nada que pensar: son números). Tick y claim atómico
// calcados de `factory-schedules.server.ts`.
import { dbq } from "../../dbq.server";
import { withNamespace } from "../tenant.server";
import { nextReportAt, normalizeHours, REPORT_DEFAULT } from "./ads-report-time";
import { reportDigest, type Funnel } from "./ads-proposal";
import type { Campaign } from "./ads-campaigns.server";

const TICK_MS = 60_000;

export type AdsSchedule = { enabled: boolean; hours: number[]; tz: string; nextAt: number | null };

export type AdsReportItem = { id: number; title: string; status: string; funnel: Funnel; threadId: number | null };
export type AdsReportData = { at: number; items: AdsReportItem[] };

export async function getSchedule(): Promise<AdsSchedule> {
  const r = (await dbq("SELECT * FROM gt_ads_schedule WHERE id = 1", []).catch(() => []))[0];
  if (!r) return { enabled: false, hours: [...REPORT_DEFAULT.hours], tz: REPORT_DEFAULT.tz, nextAt: null };
  let hours: unknown = [];
  try {
    hours = JSON.parse(String(r.hours));
  } catch {
    /* default */
  }
  return { enabled: !!r.enabled, hours: normalizeHours(hours), tz: String(r.tz), nextAt: r.next_at != null ? Number(r.next_at) : null };
}

export async function saveSchedule(patch: { enabled: boolean; hours?: number[] }, ownerSub: string, tz?: string): Promise<number | null> {
  const cur = await getSchedule();
  const hours = normalizeHours(patch.hours ?? cur.hours);
  const zone = tz || cur.tz || REPORT_DEFAULT.tz;
  const next = patch.enabled ? nextReportAt(hours, zone, Math.floor(Date.now() / 1000)) : null;
  await dbq(
    `INSERT INTO gt_ads_schedule (id, enabled, hours, tz, next_at, owner_sub, updated_at) VALUES (1, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, hours = excluded.hours, tz = excluded.tz,
       next_at = excluded.next_at, owner_sub = excluded.owner_sub, updated_at = unixepoch()`,
    [patch.enabled ? 1 : 0, JSON.stringify(hours), zone, next, ownerSub],
  );
  return next;
}

// ── El tick ──────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Llamado desde ensureSchema: este tenant existe y su tabla está lista. */
export function armAdsReports(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => {
    void sweep();
  }, TICK_MS);
  timer.unref?.();
}

async function sweep(): Promise<void> {
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
    } catch {
      /* un tenant caído no deja sin reporte a los demás */
    }
  }
}

async function sweepTenant(ns: string): Promise<void> {
  const rows = await dbq("SELECT * FROM gt_ads_schedule WHERE id = 1 AND enabled = 1 AND next_at IS NOT NULL AND next_at <= unixepoch()", []).catch(() => []);
  const r = rows[0];
  if (!r) return;
  const s = await getSchedule();
  const next = nextReportAt(s.hours, s.tz, Math.floor(Date.now() / 1000));
  // CLAIM atómico: sólo quien mueve `next_at` publica (dos ticks traslapados, un reporte).
  const claimed = await dbq("UPDATE gt_ads_schedule SET next_at = ? WHERE id = 1 AND next_at = ? RETURNING id", [next, r.next_at]);
  if (!claimed.length) return;
  await runReport(ns, { force: false }).catch((e) => console.error("[ads] reporte", e));
}

/**
 * Arma y publica el reporte. `force` = publicarlo aunque no haya cambios (el botón «Correr
 * ahora» de /ads). Devuelve qué pasó para decírselo a quien lo pidió.
 */
export async function runReport(ns: string, opts: { force: boolean }): Promise<{ posted: boolean; reason?: string }> {
  const { isInstalled, getAppConfig } = await import("./installed.server");
  if (!(await isInstalled("ads").catch(() => false))) return { posted: false, reason: "Ghosty Ads no está instalada" };
  const cfg = await getAppConfig<{ roomId?: number }>("ads");
  if (!cfg?.roomId) return { posted: false, reason: "Ghosty Ads no tiene room" };
  const C = await import("./ads-campaigns.server");
  const all = await dbq("SELECT id FROM gt_ads_campaigns WHERE status IN ('active','paused')", []).catch(() => []);
  const now = Date.now();
  const campaigns: Campaign[] = [];
  for (const row of all) {
    let c = await C.getCampaign(Number(row.id));
    if (!c) continue;
    // Pasó su fecha de fin: Meta ya dejó de entregarla. Se marca terminada (no toca Meta).
    const end = Date.parse(c.proposal.endTime ?? "");
    if (Number.isFinite(end) && end < now) {
      c = await C.applyAdsEvent(c, "end").catch(() => c);
      continue;
    }
    if (c.status === "active") campaigns.push(c);
  }
  if (!campaigns.length) return { posted: false, reason: "no hay campañas activas" };
  const { byId, error } = await C.funnels(campaigns);
  if (error && !byId.size) return { posted: false, reason: error };
  const items: AdsReportItem[] = campaigns
    .filter((c) => byId.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, status: c.status, funnel: byId.get(c.id)!, threadId: c.rootMsgId }));
  const digest = reportDigest(items);
  const prev = (await dbq("SELECT last_digest FROM gt_ads_schedule WHERE id = 1", []).catch(() => []))[0]?.last_digest ?? null;
  if (!opts.force && prev === digest) return { posted: false, reason: "nada cambió desde el último reporte" };
  const data: AdsReportData = { at: Math.floor(now / 1000), items };
  const saved = await dbq("INSERT INTO gt_ads_reports (channel_id, data_json) VALUES (?, ?) RETURNING id", [cfg.roomId, JSON.stringify(data)]);
  const reportId = Number(saved[0]?.id);
  const msgId = await C.postAsAds(cfg.roomId, null, "```gt-ads-report\n" + JSON.stringify({ reportId }) + "\n```");
  if (!msgId) return { posted: false, reason: "no pude publicar en el room" };
  await dbq("UPDATE gt_ads_schedule SET last_digest = ? WHERE id = 1", [digest]).catch(() => {});
  await notifyReport(ns, cfg.roomId, campaigns, items).catch(() => {});
  return { posted: true };
}

async function notifyReport(ns: string, roomId: number, campaigns: { requestedBy: string; approvedBy: string | null }[], items: AdsReportItem[]) {
  const owner = (await dbq("SELECT owner_sub FROM gt_ads_schedule WHERE id = 1", []).catch(() => []))[0]?.owner_sub;
  const recipients = [...new Set([owner, ...campaigns.flatMap((c) => [c.requestedBy, c.approvedBy])].filter(Boolean) as string[])];
  if (!recipients.length) return;
  const db = await import("../../db.server");
  const room = await db.getChannelById(roomId);
  const { mxn } = await import("./ads-proposal");
  const spend = items.reduce((a, i) => a + i.funnel.spend, 0);
  const qualified = items.reduce((a, i) => a + i.funnel.qualified, 0);
  const { notify } = await import("../notify.server");
  await notify(
    {
      kind: "ads",
      recipients,
      title: `Ghosty Ads · ${items.length} ${items.length === 1 ? "campaña activa" : "campañas activas"}`,
      body: `Gasto ${mxn(spend)} · ${qualified} ${qualified === 1 ? "lead calificado" : "leads calificados"}${qualified ? ` · ${mxn(Math.round((spend / qualified) * 100) / 100)} por calificado` : ""}`,
      url: room ? `/c/${room.slug}` : "/ads",
      tag: `ads-report:${Math.floor(Date.now() / 1000)}`,
    },
    ns,
  );
}

/** Un reporte publicado (para su tarjeta). */
export async function getReport(id: number): Promise<{ channelId: number; data: AdsReportData } | null> {
  const r = (await dbq("SELECT channel_id, data_json FROM gt_ads_reports WHERE id = ?", [id]).catch(() => []))[0];
  if (!r) return null;
  try {
    return { channelId: Number(r.channel_id), data: JSON.parse(String(r.data_json)) as AdsReportData };
  } catch {
    return null;
  }
}
