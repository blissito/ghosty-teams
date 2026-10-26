// ── Lo durable de las automatizaciones: política por room+repo+tipo, claims, tope diario ─────
// Tablas en server/schema.server.ts (gt_repo_automations, gt_automation_claims, gt_automation_budget).
import { dbq } from "../../dbq.server";
import type { AutomationKind } from "./types";
import { budgetDay, DEFAULT_CLAIM_TTL_MS, DEFAULT_DAILY_BUDGET } from "./dispatch";
import { isAutomationKind } from "./catalog";

export type RepoAutomation = {
  kind: AutomationKind;
  enabled: boolean;
  settings: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: number;
};

function parseSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Las filas que existen para ese room y repo (un tipo sin fila = apagado). */
export async function listRepoAutomations(roomId: number, repo: string): Promise<RepoAutomation[]> {
  const rows = await dbq(
    "SELECT kind, enabled, settings_json, updated_by, updated_at FROM gt_repo_automations WHERE room_id = ? AND repo = ?",
    [roomId, repo.toLowerCase()],
  );
  return rows
    .filter((r) => isAutomationKind(r.kind))
    .map((r) => ({
      kind: r.kind as AutomationKind,
      enabled: Number(r.enabled) === 1,
      settings: parseSettings(r.settings_json),
      updatedBy: r.updated_by == null ? null : String(r.updated_by),
      updatedAt: Number(r.updated_at ?? 0),
    }));
}

/** Prende/apaga un tipo y, si vienen, reemplaza sus ajustes. */
export async function setRepoAutomation(p: {
  ns: string;
  roomId: number;
  repo: string;
  kind: AutomationKind;
  enabled: boolean;
  settings?: Record<string, unknown>;
  by: string;
}): Promise<void> {
  const settings = p.settings === undefined ? null : JSON.stringify(p.settings);
  await dbq(
    `INSERT INTO gt_repo_automations (ns, room_id, repo, kind, enabled, settings_json, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(room_id, repo, kind) DO UPDATE SET enabled = excluded.enabled,
       settings_json = COALESCE(excluded.settings_json, gt_repo_automations.settings_json),
       updated_by = excluded.updated_by, updated_at = unixepoch()`,
    [p.ns, p.roomId, p.repo.toLowerCase(), p.kind, p.enabled ? 1 : 0, settings, p.by],
  );
}

/** Rooms con alguna automatización prendida para el repo, con los tipos prendidos de cada uno. */
export async function enabledByRoom(repo: string): Promise<Map<number, { kinds: Set<AutomationKind>; by: Map<AutomationKind, string | null> }>> {
  const rows = await dbq(
    "SELECT room_id, kind, updated_by FROM gt_repo_automations WHERE repo = ? AND enabled = 1",
    [repo.toLowerCase()],
  );
  const out = new Map<number, { kinds: Set<AutomationKind>; by: Map<AutomationKind, string | null> }>();
  for (const r of rows) {
    if (!isAutomationKind(r.kind)) continue;
    const id = Number(r.room_id);
    const e = out.get(id) ?? { kinds: new Set(), by: new Map() };
    e.kinds.add(r.kind);
    e.by.set(r.kind, r.updated_by == null ? null : String(r.updated_by));
    out.set(id, e);
  }
  return out;
}

export async function automationSettings(roomId: number, repo: string, kind: AutomationKind): Promise<Record<string, unknown>> {
  const [row] = await dbq(
    "SELECT settings_json FROM gt_repo_automations WHERE room_id = ? AND repo = ? AND kind = ?",
    [roomId, repo.toLowerCase(), kind],
  );
  return parseSettings(row?.settings_json);
}

/** Quién prendió la automatización (a su nombre trabaja el agente). */
export async function automationOwner(roomId: number, repo: string, kind: AutomationKind): Promise<string | null> {
  const [row] = await dbq(
    "SELECT updated_by FROM gt_repo_automations WHERE room_id = ? AND repo = ? AND kind = ? AND enabled = 1",
    [roomId, repo.toLowerCase(), kind],
  );
  return typeof row?.updated_by === "string" && row.updated_by ? row.updated_by : null;
}

/**
 * true sólo la 1.ª vez para (kind, key) dentro de `ttlMs`. Un solo statement: el upsert sólo pisa
 * una fila vencida, así que dos despachos a la par no ganan los dos.
 */
export async function claimKey(kind: AutomationKind, key: string, ttlMs = DEFAULT_CLAIM_TTL_MS): Promise<boolean> {
  const ttlS = Math.max(1, Math.round(ttlMs / 1000));
  const rows = await dbq(
    `INSERT INTO gt_automation_claims (kind, key, expires_at, claimed_at) VALUES (?, ?, unixepoch() + ?, unixepoch())
     ON CONFLICT(kind, key) DO UPDATE SET expires_at = excluded.expires_at, claimed_at = unixepoch()
       WHERE gt_automation_claims.expires_at <= unixepoch()
     RETURNING kind`,
    [kind, key, ttlS],
  );
  return rows.length > 0;
}

/** Gasta una unidad del tope diario del repo para ese tipo. false = ya no queda hoy. */
export async function spendBudget(repo: string, kind: AutomationKind, limit = DEFAULT_DAILY_BUDGET, now = Date.now()): Promise<boolean> {
  if (limit <= 0) return false;
  const rows = await dbq(
    `INSERT INTO gt_automation_budget (repo, kind, day, n) VALUES (?, ?, ?, 1)
     ON CONFLICT(repo, kind, day) DO UPDATE SET n = gt_automation_budget.n + 1 WHERE gt_automation_budget.n < ?
     RETURNING n`,
    [repo.toLowerCase(), kind, budgetDay(now), limit],
  );
  return rows.length > 0;
}
