// gc_users en la DB del tenant (sqld, namespace por workspace). Primer usuario en
// loguearse = owner. Cliente compartido y multitenant (ver dbq.server.ts).
import { dbqRaw as dbq } from "./dbq.server";

export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  avatar: string;
  /** ⚠️ LEE "puede todo", NO "es el dueño del workspace".
   *
   *  Vale `true` también para el STAFF (nosotros), que tiene poder de owner sin serlo —
   *  su `gc_users.is_owner` sigue en 0. Se hizo así porque los ~25 sitios que preguntan
   *  por permisos leen este campo: otorgar el poder en UN punto los cubre a todos sin
   *  tocarlos.
   *
   *  Para saber QUIÉN es el dueño no sirve: usa `gc_users.is_owner` de la DB
   *  (`listWorkspaceUsers` lo devuelve tal cual). Para etiquetar, `isStaff`. */
  isOwner: boolean;
  /** Nosotros dentro del espacio de un cliente. Existe SÓLO para que la etiqueta no
   *  mienta: sin él la UI diría "Owner", que es exactamente lo que no queremos ser. */
  isStaff: boolean;
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

/** ¿El usuario que acaba de entrar queda como owner del workspace?
 *
 *  Regla por defecto: el PRIMERO que entra a un workspace vacío. Sirve cuando alguien
 *  crea su propio espacio, porque necesariamente es el primero.
 *
 *  No sirve cuando le montamos el workspace a un cliente: ahí el orden de llegada es
 *  un accidente, y basta que nosotros lo abramos antes que él para quedarnos de dueños
 *  de su espacio. Para ese caso gs siembra `gc_config.intended_owner_email` al crear
 *  (ver `createWorkspace` en ghosty-studio/app/lib/workspaces.server.ts): con esa clave
 *  presente, SÓLO ese correo puede volverse owner y el orden deja de importar.
 *
 *  Sin la clave el comportamiento es el de siempre, así que los workspaces anteriores
 *  a esto no cambian. */
async function resolveIsOwner(email: string): Promise<0 | 1> {
  // El STAFF nunca se queda de dueño DE VERDAD, ni entrando primero a un espacio vacío.
  // Es justo el accidente que `intended_owner_email` vino a evitar —preparamos el
  // workspace del cliente, lo abrimos antes que él, y su espacio queda a nuestro nombre—
  // reintroducido por otra puerta. Su poder viene de `permisosDe`, no de esta columna.
  if (await isStaffEmail(email)) return 0;

  if (await isIntendedOwner(email)) return 1;

  const intended = await intendedOwnerEmail();
  // Con dueño declarado, NADIE más se vuelve owner por llegar primero.
  if (intended) return 0;

  const { rows } = await dbq("SELECT COUNT(*) FROM gc_users");
  return Number(rows[0][0]) === 0 ? 1 : 0;
}

async function intendedOwnerEmail(): Promise<string | null> {
  const cfg = await dbq("SELECT v FROM gc_config WHERE k = 'intended_owner_email'");
  return (cfg.rows[0]?.[0] as string | null)?.trim().toLowerCase() || null;
}

/** El dueño declarado de un workspace montado por nosotros. Cruza la puerta de acceso
 *  aunque no traiga invitación y aunque el workspace ya no esté vacío — si no, montarle
 *  el espacio y entrar a prepararlo lo dejaría fuera de su propio workspace. */
export async function isIntendedOwner(email: string): Promise<boolean> {
  const intended = await intendedOwnerEmail();
  return !!intended && email.trim().toLowerCase() === intended;
}

/** Nosotros (soporte) dentro del espacio de un cliente. La lista la escribe ghosty-studio
 *  —al montar el workspace o desde `/admin/tenants`— y se quita desde ahí mismo.
 *
 *  Vive en `gc_config` y no en una lista global de correos por env: el acceso es POR
 *  workspace y revocable, y así queda escrito en la DB del tenant en vez de ser una llave
 *  maestra que no aparece en ninguna pantalla.
 *
 *  ⚠️ El `Membership(STAFF)` que gs escribe en paralelo NO sirve para esto: esta puerta
 *  no consulta a gs. Es esta clave la que deja entrar. */
export async function isStaffEmail(email: string): Promise<boolean> {
  const yo = email.trim().toLowerCase();
  if (!yo) return false;

  // 1) Env GLOBAL: nosotros, en cualquier workspace y sin darnos acceso a mano. Sin el
  //    env todo el mecanismo queda apagado y el comportamiento es el de siempre — es el
  //    modo de falla correcto para algo que reparte permisos.
  const global = (process.env.STAFF_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (global.includes(yo)) return true;

  // 2) Lista POR WORKSPACE: para dar acceso puntual a alguien que no está en el env.
  //    La escribe gs desde /admin/tenants.
  try {
    const cfg = await dbq("SELECT v FROM gc_config WHERE k = 'staff_emails'");
    return ((cfg.rows[0]?.[0] as string | null) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(yo);
  } catch {
    // Un workspace sin schema todavía (recién montado) no es una negativa: es "no sé".
    // Se cae al env, que ya se comprobó arriba.
    return false;
  }
}

/** Los DOS campos de permiso de la sesión, calculados juntos.
 *
 *  ⚠️ Existe para que no puedan divergir. Se calculan en dos momentos —al hacer login
 *  (`upsertUser`) y en CADA render (`me()` en server/auth.ts, que relee el rol de la DB
 *  para que un traspaso de dueño se note sin volver a entrar)—. Si `me()` calculara esto
 *  por su cuenta y olvidara el staff, el poder se otorgaría al entrar y se perdería al
 *  primer render: sin error, sin rastro, imposible de leer desde fuera. */
export async function permisosDe(
  email: string,
  isOwnerEnDb: boolean,
): Promise<{ isOwner: boolean; isStaff: boolean }> {
  const isStaff = await isStaffEmail(email);
  return { isOwner: isOwnerEnDb || isStaff, isStaff };
}

/** Correos que pueden entrar SIN invitación, porque alguien los dio de alta a mano desde
 *  `/admin/tenants` (gs). Es la quinta puerta y la que hace que "agregar a quien sea" no
 *  tenga fricción: se escribe el correo aquí y la persona entra con su login de siempre —
 *  sin liga que mandar, sin token que caduque, sin que nadie tenga que estar presente.
 *
 *  Misma mecánica que `staff_emails` y a propósito: por workspace, revocable, y escrito en
 *  la DB del tenant en vez de en una lista global que no aparece en ninguna pantalla. La
 *  diferencia es que estos SÍ ocupan asiento — son gente del cliente, no nosotros. */
export async function isPreapprovedEmail(email: string): Promise<boolean> {
  return (await preapprovedEmails()).includes(email.trim().toLowerCase());
}

export async function preapprovedEmails(): Promise<string[]> {
  try {
    const cfg = await dbq("SELECT v FROM gc_config WHERE k = 'member_emails'");
    return ((cfg.rows[0]?.[0] as string | null) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Añade o quita un correo de la lista de preaprobados. Devuelve la lista resultante.
 *  Idempotente en los dos sentidos: agregar dos veces no duplica y quitar lo que no está
 *  no falla — este endpoint lo llama un panel donde se hace doble clic. */
export async function setPreapprovedEmail(email: string, allowed: boolean): Promise<string[]> {
  const yo = email.trim().toLowerCase();
  if (!yo) return preapprovedEmails();
  const actuales = await preapprovedEmails();
  const siguiente = allowed
    ? [...new Set([...actuales, yo])]
    : actuales.filter((e) => e !== yo);
  // `setConfig` y no SQL propio: hace el UPSERT y mantiene `updated_at`. Un UPDATE a
  // secas no escribiría nada la primera vez y el correo se perdería en silencio.
  const { setConfig } = await import("./config.server");
  await setConfig("member_emails", siguiente.join(","));
  return siguiente;
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
    const permisos = await permisosDe(id.email, Number(row[0]) === 1);
    return { sub: id.sub, email: id.email, name, avatar, handle, ...permisos };
  }
  const isOwner = await resolveIsOwner(id.email);
  const handle = await ensureUniqueHandle(base, id.sub);
  await dbq(
    "INSERT INTO gc_users (sub, email, name, avatar, is_owner, handle) VALUES (?, ?, ?, ?, ?, ?)",
    [id.sub, id.email, id.name, id.avatar, isOwner, handle]
  );
  return { ...id, handle, ...(await permisosDe(id.email, isOwner === 1)) };
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
  /** Nosotros. Aquí `isOwner` SÍ es el dueño de verdad (sale de la columna), así que los
   *  dos campos son independientes y el staff aparece como lo que es. */
  isStaff: boolean;
  statusEmoji: string | null; statusText: string | null; title: string | null; pronouns: string | null; bio: string | null;
};
export async function listWorkspaceUsers(): Promise<WorkspaceUser[]> {
  // ⚠️ `email` se SELECCIONA para detectar al staff pero NO se devuelve: este roster lo
  // recibe cualquier miembro, y hoy no expone correos. Meterlos filtraría los de todo el
  // equipo del cliente a todo el equipo del cliente.
  const { rows, cols } = await dbq(
    "SELECT sub, name, avatar, handle, is_owner, email, status_emoji, status_text, title, pronouns, bio FROM gc_users WHERE handle IS NOT NULL AND COALESCE(banned,0)=0 ORDER BY name"
  );
  const i = (c: string) => cols.indexOf(c);
  const staff = new Set<string>();
  for (const r of rows) {
    const e = (r[i("email")] as string) ?? "";
    if (e && (await isStaffEmail(e))) staff.add(e.toLowerCase());
  }
  return rows.map((r) => ({
    sub: r[i("sub")] as string,
    name: (r[i("name")] as string) ?? "",
    avatar: (r[i("avatar")] as string) ?? "",
    handle: (r[i("handle")] as string) ?? "",
    isOwner: Number(r[i("is_owner")]) === 1,
    isStaff: staff.has(((r[i("email")] as string) ?? "").toLowerCase()),
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
  // Al STAFF tampoco se le expulsa, espejo del guard que ya protege al dueño. El motivo
  // no es simetría: `isBanned` se comprueba ANTES de la puerta en `completeGhostyLogin`,
  // así que banear al creador lo dejaría fuera para siempre y sin forma de volver desde
  // dentro. Se resuelve aquí y no en el llamador porque la regla vive con la query.
  const { rows } = await dbq("SELECT email FROM gc_users WHERE sub=?", [sub]);
  const email = (rows[0]?.[0] as string | null) ?? "";
  if (email && (await isStaffEmail(email))) return;

  await dbq("UPDATE gc_users SET banned=1 WHERE sub=? AND COALESCE(is_owner,0)=0", [sub]);
}

/** Lo contrario: vuelve a dejar entrar. Es lo que hace que quitar a alguien no sea una
 *  puerta de un solo sentido — y como el ban CONSERVA la fila de `gc_users`, al levantarlo
 *  la persona vuelve con su handle, su perfil y sus mensajes intactos, sin invitación
 *  nueva. Ésa es toda la gracia de banear en vez de borrar. */
export async function restoreMember(sub: string): Promise<void> {
  await dbq("UPDATE gc_users SET banned=0 WHERE sub=?", [sub]);
}

/** Padrón COMPLETO del tenant, incluidos los expulsados y los que aún no tienen handle.
 *  `listWorkspaceUsers` no sirve para administrar: filtra justo a los que hay que ver
 *  (`banned=0` y `handle IS NOT NULL`), que son los que quieres poder devolver. */
export type AdminMember = {
  sub: string;
  email: string;
  name: string;
  avatar: string;
  isOwner: boolean;
  banned: boolean;
};
export async function listAllMembers(): Promise<AdminMember[]> {
  const { rows, cols } = await dbq(
    "SELECT sub, email, name, avatar, is_owner, COALESCE(banned,0) AS banned FROM gc_users ORDER BY COALESCE(banned,0), name",
  );
  const i = (c: string) => cols.indexOf(c);
  return rows.map((r) => ({
    sub: r[i("sub")] as string,
    email: (r[i("email")] as string) ?? "",
    name: (r[i("name")] as string) ?? "",
    avatar: (r[i("avatar")] as string) ?? "",
    isOwner: Number(r[i("is_owner")]) === 1,
    banned: Number(r[i("banned")]) === 1,
  }));
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
