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
  patch: { name?: string; avatar?: string; statusEmoji?: string | null; statusText?: string | null; title?: string | null; pronouns?: string | null; bio?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  const col = (name: string, v: string | null | undefined) => {
    if (v === undefined) return;
    sets.push(`${name}=?`);
    vals.push(v || null);
  };
  if (patch.name !== undefined) { sets.push("name=?"); vals.push(patch.name); }
  if (patch.avatar !== undefined) { sets.push("avatar=?"); vals.push(patch.avatar || null); }
  col("status_emoji", patch.statusEmoji);
  col("status_text", patch.statusText);
  col("title", patch.title);
  col("pronouns", patch.pronouns);
  col("bio", patch.bio);
  if (!sets.length) return;
  vals.push(sub);
  await dbq(`UPDATE gc_users SET ${sets.join(", ")} WHERE sub=?`, vals);
  // Avatar/nombre están DENORMALIZADOS en gc_messages (se sellan al enviar). Para que el
  // cambio se vea en mensajes VIEJOS también, los reescribimos por sub. (El cliente resuelve
  // por el directorio vivo, pero esto mantiene la DB coherente para fetches frescos/otros.)
  if (patch.avatar !== undefined || patch.name !== undefined) {
    const s2: string[] = []; const v2: (string | null)[] = [];
    if (patch.avatar !== undefined) { s2.push("avatar=?"); v2.push(patch.avatar || ""); }
    if (patch.name !== undefined) { s2.push("sender=?"); v2.push(patch.name); }
    v2.push(sub);
    await dbq(`UPDATE gc_messages SET ${s2.join(", ")} WHERE sender_sub=?`, v2).catch(() => {});
  }
}

// Directorio de miembros del workspace (para el mapa vivo sub→perfil del cliente: avatars
// que se actualizan en todos lados + el drawer de perfil estilo Slack).
export type WorkspaceUser = {
  sub: string; name: string; avatar: string; handle: string; isOwner: boolean;
  statusEmoji: string | null; statusText: string | null; title: string | null; pronouns: string | null; bio: string | null;
};
export async function listWorkspaceUsers(): Promise<WorkspaceUser[]> {
  const { rows, cols } = await dbq(
    "SELECT sub, name, avatar, handle, is_owner, status_emoji, status_text, title, pronouns, bio FROM gc_users WHERE handle IS NOT NULL AND COALESCE(banned,0)=0 ORDER BY name"
  );
  const i = (c: string) => cols.indexOf(c);
  return rows.map((r) => ({
    sub: r[i("sub")] as string,
    name: (r[i("name")] as string) ?? "",
    avatar: (r[i("avatar")] as string) ?? "",
    handle: (r[i("handle")] as string) ?? "",
    isOwner: Number(r[i("is_owner")]) === 1,
    statusEmoji: (r[i("status_emoji")] as string) ?? null,
    statusText: (r[i("status_text")] as string) ?? null,
    title: (r[i("title")] as string) ?? null,
    pronouns: (r[i("pronouns")] as string) ?? null,
    bio: (r[i("bio")] as string) ?? null,
  }));
}

// Búsqueda de miembros (para el DM picker a ESCALA): filtra en el server por
// handle/name/email, tope N → no baja todo el workspace. Query vacío = primeros N.
export async function searchWorkspaceUsers(query: string, limit = 25): Promise<{ sub: string; name: string; handle: string; avatar: string }[]> {
  const q = query.trim().toLowerCase().replace(/[%_]/g, "");
  const like = `%${q}%`;
  const where = q ? "AND (LOWER(handle) LIKE ? OR LOWER(name) LIKE ? OR LOWER(email) LIKE ?)" : "";
  const args = q ? [like, like, like, limit] : [limit];
  const { rows, cols } = await dbq(
    `SELECT sub, name, handle, avatar FROM gc_users WHERE handle IS NOT NULL AND COALESCE(banned,0)=0 ${where} ORDER BY name LIMIT ?`,
    args
  );
  const i = (c: string) => cols.indexOf(c);
  return rows.map((r) => ({ sub: r[i("sub")] as string, name: (r[i("name")] as string) ?? "", handle: (r[i("handle")] as string) ?? "", avatar: (r[i("avatar")] as string) ?? "" }));
}

// ¿El sub está expulsado del workspace? (el login lo checa para impedir re-entrar).
// A PRUEBA DE ERROR: si la columna `banned` aún no existe en el namespace (ensureSchema
// no corrió), NO rompas el login — trata como no-baneado (nadie baneado = seguro).
export async function isBanned(sub: string): Promise<boolean> {
  try {
    const { rows } = await dbq("SELECT COALESCE(banned,0) AS b FROM gc_users WHERE sub=?", [sub]);
    return Number((rows[0]?.[0] as unknown) ?? 0) === 1;
  } catch {
    return false;
  }
}

// Expulsa a un member (owner-only, validado en el server fn). Marca banned=1 (conserva
// su fila + mensajes; el login lo rebota). No se puede expulsar al owner.
export async function expelMember(sub: string): Promise<void> {
  await dbq("UPDATE gc_users SET banned=1 WHERE sub=? AND COALESCE(is_owner,0)=0", [sub]);
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
