// gc_users en la DB del tenant (sqld, namespace por workspace). Primer usuario en
// loguearse = owner. Cliente compartido y multitenant (ver dbq.server.ts).
import { dbqRaw as dbq } from "./dbq.server";

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
  const existing = await dbq("SELECT is_owner, handle, name, avatar FROM gc_users WHERE sub = ?", [id.sub]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    let handle = row[1] as string | null;
    if (!handle) {
      handle = await ensureUniqueHandle(base, id.sub);
      await dbq("UPDATE gc_users SET handle=? WHERE sub=?", [handle, id.sub]);
    }
    // Mantén el email sincronizado con el IdP (ancla de identidad), pero NO pises
    // name/avatar: tras el primer login el perfil es EDITABLE por el usuario
    // (Ajustes → perfil, updateProfile). Sella en sesión el perfil GUARDADO, no el
    // crudo del IdP (que hoy manda name=local-part del email, avatar="").
    await dbq("UPDATE gc_users SET email=? WHERE sub=?", [id.email, id.sub]);
    const name = (row[2] as string) || id.name;
    const avatar = (row[3] as string) || id.avatar;
    return { sub: id.sub, email: id.email, name, avatar, isOwner: Number(row[0]) === 1, handle };
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

// Perfil editable por el dueño de la cuenta (Ajustes → perfil): nombre visible y
// avatar. El email lo ancla el IdP (no editable aquí). avatar vacío = quitar (null).
// upsertUser ya NO pisa estos campos en logins posteriores, así que persisten.
// ¿otro usuario (sub distinto) ya usa este display name? El authz de editar/borrar
// mensajes se apoya en `msg.sender === user.name` (identidad = string mutable, sin
// sender_sub), así que permitir dos usuarios con el MISMO nombre dejaría a uno
// editar/borrar los mensajes del otro. Comparación normalizada (trim + lower).
export async function isNameTakenByOther(sub: string, name: string): Promise<boolean> {
  const norm = name.trim().toLowerCase();
  if (!norm) return false;
  const { rows } = await dbq(
    "SELECT 1 FROM gc_users WHERE sub<>? AND lower(trim(name))=? LIMIT 1",
    [sub, norm]
  );
  return !!rows[0];
}

export async function updateProfile(
  sub: string,
  patch: { name?: string; avatar?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.name !== undefined) {
    sets.push("name=?");
    vals.push(patch.name);
  }
  if (patch.avatar !== undefined) {
    sets.push("avatar=?");
    vals.push(patch.avatar || null);
  }
  if (!sets.length) return;
  vals.push(sub);
  await dbq(`UPDATE gc_users SET ${sets.join(", ")} WHERE sub=?`, vals);
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
