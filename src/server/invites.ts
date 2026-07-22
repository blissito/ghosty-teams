import { createServerFn } from "@tanstack/react-start";

// invites.ts lo importa SettingsContent (cliente) por sus server fns; por eso NO
// puede importar `dbq.server` estáticamente (import-protection lo prohíbe en el
// bundle cliente). Import dinámico dentro del wrapper → solo se resuelve en server.
async function dbq(sql: string, args: unknown[] = []) {
  const { dbqRaw } = await import("../dbq.server");
  return dbqRaw(sql, args);
}

// ¿El sub ya es un usuario conocido (owner o member)? (para gating de login)
export async function isKnownUser(sub: string): Promise<boolean> {
  const { rows } = await dbq("SELECT 1 FROM gc_users WHERE sub = ?", [sub]);
  return !!rows[0];
}

// El invite es un LINK PERMANENTE del equipo: el mismo link sirve para todos. NO se
// "gasta" — nunca marcamos `used_by` (esa columna queda para tokens legacy). "Activo"
// = fila con `used_by IS NULL`. Cancelar = borrar; refrescar = borrar + emitir otro.
export async function consumeInvite(token: string, _sub: string): Promise<boolean> {
  const { rows } = await dbq("SELECT 1 FROM gc_invites WHERE token = ?", [token]);
  return !!rows[0]; // válido si el token existe (no fue cancelado). Multi-uso.
}

// ── Helpers (server-only) ────────────────────────────────────────────────────
async function ownerSub(): Promise<string> {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
  const user = s.data.user;
  if (!user?.isOwner) throw new Error("solo el owner invita");
  return user.sub;
}

async function urlFor(token: string): Promise<string> {
  const { reqOrigin } = await import("../origin.server");
  return `${await reqOrigin()}/join/${token}`;
}

async function activeToken(sub: string): Promise<string | null> {
  const { rows } = await dbq(
    "SELECT token FROM gc_invites WHERE created_by = ? AND used_by IS NULL ORDER BY rowid DESC LIMIT 1",
    [sub]
  );
  return (rows[0]?.[0] as string) ?? null;
}

async function mint(sub: string): Promise<string> {
  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(16).toString("hex");
  await dbq("INSERT INTO gc_invites (token, created_by) VALUES (?, ?)", [token, sub]);
  return token;
}

// ── Server fns (owner) ───────────────────────────────────────────────────────

// Lee el link permanente activo (NO crea). null = cancelado o nunca creado → la UI
// muestra el CTA "Crear link". Así "Cancelar" deja la tarjeta sin link (no se re-crea).
export const getInvite = createServerFn({ method: "GET" }).handler(async () => {
  const sub = await ownerSub();
  const token = await activeToken(sub);
  return { url: token ? await urlFor(token) : null };
});

// Get-or-create idempotente: crea el link permanente si no hay, o devuelve el actual.
export const createInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await ownerSub();
  const token = (await activeToken(sub)) ?? (await mint(sub));
  return { url: await urlFor(token) };
});

// Refresca: invalida el link actual (lo borra) y emite uno nuevo. El link viejo deja
// de resolver → útil si se filtró.
export const refreshInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await ownerSub();
  await dbq("DELETE FROM gc_invites WHERE created_by = ? AND used_by IS NULL", [sub]);
  return { url: await urlFor(await mint(sub)) };
});

// Cancela: elimina el link permanente. Nadie más puede unirse hasta crear uno nuevo.
export const revokeInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await ownerSub();
  await dbq("DELETE FROM gc_invites WHERE created_by = ? AND used_by IS NULL", [sub]);
  return { ok: true as const };
});
