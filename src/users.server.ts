// gc_users en EasyBits DB. Primer usuario en loguearse = owner.
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

export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  avatar: string;
  isOwner: boolean;
  handle: string;
};

function slugHandle(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "user"
  );
}

// Handle único para tagging (@handle). Base = local-part del email o el nombre.
async function ensureUniqueHandle(base: string, ownSub: string): Promise<string> {
  const b = slugHandle(base);
  let h = b;
  for (let i = 2; ; i++) {
    const { rows } = await dbq("SELECT sub FROM gc_users WHERE handle = ?", [h]);
    if (!rows[0] || rows[0][0] === ownSub) return h;
    h = `${b}${i}`;
  }
}

export async function upsertUser(id: {
  sub: string;
  email: string;
  name: string;
  avatar: string;
}): Promise<SessionUser> {
  const base = id.email.split("@")[0] || id.name;
  const existing = await dbq("SELECT is_owner, handle FROM gc_users WHERE sub = ?", [id.sub]);
  if (existing.rows[0]) {
    let handle = existing.rows[0][1] as string | null;
    if (!handle) {
      handle = await ensureUniqueHandle(base, id.sub);
      await dbq("UPDATE gc_users SET handle=? WHERE sub=?", [handle, id.sub]);
    }
    await dbq("UPDATE gc_users SET email=?, name=?, avatar=? WHERE sub=?", [
      id.email,
      id.name,
      id.avatar,
      id.sub,
    ]);
    return { ...id, isOwner: Number(existing.rows[0][0]) === 1, handle };
  }
  // Primer usuario de la instancia → owner.
  const { rows } = await dbq("SELECT COUNT(*) FROM gc_users");
  const isOwner = Number(rows[0][0]) === 0 ? 1 : 0;
  const handle = await ensureUniqueHandle(base, id.sub);
  await dbq(
    "INSERT INTO gc_users (sub, email, name, avatar, is_owner, handle) VALUES (?, ?, ?, ?, ?, ?)",
    [id.sub, id.email, id.name, id.avatar, isOwner, handle]
  );
  return { ...id, isOwner: isOwner === 1, handle };
}

export type MentionUser = { sub: string; handle: string; name: string; email: string; avatar: string };
export async function listUsers(): Promise<MentionUser[]> {
  const { rows, cols } = await dbq(
    "SELECT sub, handle, name, email, avatar FROM gc_users WHERE handle IS NOT NULL ORDER BY name"
  );
  const idx = (c: string) => cols.indexOf(c);
  return rows.map((r) => ({
    sub: r[idx("sub")] as string,
    handle: (r[idx("handle")] as string) ?? "",
    name: (r[idx("name")] as string) ?? "",
    email: (r[idx("email")] as string) ?? "",
    avatar: (r[idx("avatar")] as string) ?? "",
  }));
}

// Subs de usuarios cuyos @handle aparecen (para push). Excluye a excludeSub.
export async function resolveMentionedUserSubs(handles: string[], excludeSub: string): Promise<string[]> {
  if (!handles.length) return [];
  const ph = handles.map(() => "?").join(",");
  const { rows } = await dbq(
    `SELECT sub FROM gc_users WHERE handle IN (${ph}) AND sub != ?`,
    [...handles.map((h) => h.toLowerCase()), excludeSub]
  );
  return rows.map((r) => r[0] as string);
}
