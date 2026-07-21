// Config de la instancia (cloud-native): vive en la DB del tenant (gc_config, sqld
// namespace por workspace), NO en el compute. El wizard del owner la llena; @ghosty
// se gatea con ella. Cliente compartido y multitenant (ver dbq.server.ts).
import { dbqRaw as dbq } from "./dbq.server";

export async function getConfig(k: string): Promise<string | null> {
  const { rows } = await dbq("SELECT v FROM gc_config WHERE k = ?", [k]);
  return rows[0]?.[0] ?? null;
}

export async function getConfigMany(keys: string[]): Promise<Record<string, string | null>> {
  const placeholders = keys.map(() => "?").join(",");
  const { rows } = await dbq(`SELECT k, v FROM gc_config WHERE k IN (${placeholders})`, keys);
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  for (const r of rows) out[r[0] as string] = r[1];
  return out;
}

export async function setConfig(k: string, v: string): Promise<void> {
  await dbq(
    "INSERT INTO gc_config (k, v, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = unixepoch()",
    [k, v]
  );
}

// ¿La instancia ya tiene un agente Ghosty conectado? (gating de @ghosty)
export async function getGhostyFleet(): Promise<{ id: string; token: string } | null> {
  const c = await getConfigMany(["fleet_agent_id", "fleet_token"]);
  if (c.fleet_agent_id && c.fleet_token) {
    return { id: c.fleet_agent_id, token: c.fleet_token };
  }
  return null;
}
