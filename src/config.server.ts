// Config de la instancia (cloud-native): vive en EasyBits DB (gc_config),
// NO en el compute. El wizard del owner la llena; @ghosty se gatea con ella.
const BASE = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
const KEY = process.env.EASYBITS_API_KEY!;
const DB_ID = process.env.EASYBITS_DB_ID!;

async function dbq(sql: string, args: unknown[] = []) {
  const res = await fetch(`${BASE}/api/v2/databases/${DB_ID}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ sql, args }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  return (await res.json()) as { cols: string[]; rows: (string | null)[][] };
}

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
