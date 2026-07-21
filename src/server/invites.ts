import { createServerFn } from "@tanstack/react-start";
import { dbqRaw as dbq } from "../dbq.server";

// ¿El sub ya es un usuario conocido (owner o member)? (para gating de login)
export async function isKnownUser(sub: string): Promise<boolean> {
  const { rows } = await dbq("SELECT 1 FROM gc_users WHERE sub = ?", [sub]);
  return !!rows[0];
}

// Valida y marca usado un invite (member). Devuelve true si válido.
export async function consumeInvite(token: string, sub: string): Promise<boolean> {
  const { rows } = await dbq("SELECT used_by FROM gc_invites WHERE token = ?", [token]);
  if (!rows[0]) return false;
  if (rows[0][0]) return rows[0][0] === sub; // ya usado por este mismo → ok
  await dbq("UPDATE gc_invites SET used_by = ?, used_at = unixepoch() WHERE token = ?", [sub, token]);
  return true;
}

// Owner genera un link de invitación. Requiere sesión de owner.
export const createInvite = createServerFn({ method: "POST" }).handler(async () => {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
  const user = s.data.user;
  if (!user?.isOwner) throw new Error("solo el owner invita");
  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(16).toString("hex");
  await dbq("INSERT INTO gc_invites (token, created_by) VALUES (?, ?)", [token, user.sub]);
  // Origin absoluto derivado del request (APP_URL no está seteado en prod → antes
  // salía un link relativo `/join/…` sin host). reqOrigin usa x-ghosty-origin del ingress.
  const { reqOrigin } = await import("../origin.server");
  return { url: `${await reqOrigin()}/join/${token}` };
});

// Get-or-create: reusa el último invite SIN usar del owner (link estable y
// reutilizable) o crea uno si no hay. Así Ajustes puede AUTO-mostrar el link al
// abrir sin generar un token nuevo en cada apertura. Devuelve también `regenerate`
// para forzar uno fresco (revoca el viejo dejándolo, no lo borra).
export const getInvite = createServerFn({ method: "POST" }).handler(async () => {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
  const user = s.data.user;
  if (!user?.isOwner) throw new Error("solo el owner invita");
  const { reqOrigin } = await import("../origin.server");
  const origin = await reqOrigin();
  const { rows } = await dbq(
    "SELECT token FROM gc_invites WHERE created_by = ? AND used_by IS NULL ORDER BY rowid DESC LIMIT 1",
    [user.sub]
  );
  let token = rows[0]?.[0] as string | undefined;
  if (!token) {
    const crypto = await import("node:crypto");
    token = crypto.randomBytes(16).toString("hex");
    await dbq("INSERT INTO gc_invites (token, created_by) VALUES (?, ?)", [token, user.sub]);
  }
  return { url: `${origin}/join/${token}` };
});

// Lista los links de invitación del owner (para gestionarlos: ver usados y revocar).
export const listInvitesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
  const user = s.data.user;
  if (!user?.isOwner) return [];
  const { reqOrigin } = await import("../origin.server");
  const origin = await reqOrigin();
  const { rows } = await dbq(
    "SELECT token, used_by, used_at FROM gc_invites WHERE created_by = ? ORDER BY rowid DESC LIMIT 50",
    [user.sub]
  );
  return rows.map((r) => ({
    token: r[0] as string,
    url: `${origin}/join/${r[0]}`,
    used: !!r[1],
    usedAt: r[2] != null ? Number(r[2]) : null,
  }));
});

// Revoca (elimina) un link de invitación del owner. Solo toca invites propios.
export const revokeInviteFn = createServerFn({ method: "POST" })
  .validator((d: { token: string }) => d)
  .handler(async ({ data }) => {
    const { useSession } = await import("@tanstack/react-start/server");
    const { sessionConfig } = await import("./session.server");
    const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
    const user = s.data.user;
    if (!user?.isOwner) throw new Error("solo el owner invita");
    await dbq("DELETE FROM gc_invites WHERE token = ? AND created_by = ?", [data.token, user.sub]);
    return { ok: true as const };
  });
