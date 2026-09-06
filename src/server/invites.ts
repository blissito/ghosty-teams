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

/**
 * ¿El workspace todavía no tiene NINGÚN usuario? Entonces el que entra es su
 * dueño (mismo criterio que usa upsertUser para poner `is_owner`).
 *
 * Se pregunta ANTES de crear la fila. El chequeo de acceso se hacía después del
 * upsert y preguntaba `isKnownUser`, que encontraba el registro recién insertado:
 * la puerta nunca se cerraba y cualquiera con identidad válida entraba a
 * cualquier workspace sabiendo el subdominio.
 */
export async function isEmptyWorkspace(): Promise<boolean> {
  const { rows } = await dbq("SELECT COUNT(*) AS n FROM gc_users");
  return Number(rows[0]?.[0] ?? 0) === 0;
}

// El invite es un LINK PERMANENTE del equipo: el mismo link sirve para todos. NO se
// "gasta" — nunca marcamos `used_by` (esa columna queda para tokens legacy). "Activo"
// = fila con `used_by IS NULL`. Cancelar = borrar; refrescar = borrar + emitir otro.
// `channelId` no null = liga de un room: además de abrir la puerta del workspace, el
// que entra queda como miembro de ese canal (lo hace auth.ts, aquí solo se reporta).
export async function consumeInvite(
  token: string,
  _sub: string
): Promise<{ ok: boolean; channelId: number | null }> {
  const { rows } = await dbq("SELECT channel_id, expires_at FROM gc_invites WHERE token = ?", [token]);
  const row = rows[0];
  if (!row) return { ok: false, channelId: null }; // cancelado o inexistente
  // Caducada = igual que cancelada. Una liga permanente es una llave del
  // workspace que se queda para siempre en el historial de WhatsApp de quien la
  // reenvió; con caducidad, lo peor que puede pasar es que alguien tenga que
  // pedirla otra vez.
  const exp = row[1] == null ? null : Number(row[1]);
  if (exp != null && exp < Math.floor(Date.now() / 1000)) return { ok: false, channelId: null };
  const raw = row[0];
  return { ok: true, channelId: raw == null ? null : Number(raw) };
}

/** Días que vive una liga nueva. 0 = sin caducidad (para volver al comportamiento
 *  viejo sin tocar código si algún cliente lo pide). */
function diasDeVida(): number {
  const v = Number(process.env.INVITE_TTL_DAYS ?? "14");
  return Number.isFinite(v) && v >= 0 ? v : 14;
}

// ── Helpers (server-only) ────────────────────────────────────────────────────
// Slack default: CUALQUIER member puede invitar. El link es per-creador (get-or-create):
// cada quien tiene el suyo, revoca/refresca solo el propio. Un token válido sin usar deja
// entrar (ver auth.ts). Antes era owner-only.
async function currentSub(): Promise<string> {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string; isOwner: boolean } }>(sessionConfig());
  const user = s.data.user;
  if (!user) throw new Error("no autenticado");
  return user.sub;
}

export async function urlFor(token: string): Promise<string> {
  const { reqOrigin } = await import("../origin.server");
  return `${await reqOrigin()}/join/${token}`;
}

// El link es per-creador Y per-destino: `channelId = null` es el del workspace, un id es
// el de ese room. El filtro por `channel_id` NO es opcional — sin él, la tarjeta de
// Ajustes del workspace devolvería la liga de un room privado (y al revés).
function scope(channelId: number | null): { sql: string; args: unknown[] } {
  return channelId == null
    ? { sql: "channel_id IS NULL", args: [] }
    : { sql: "channel_id = ?", args: [channelId] };
}

/** Fragmento SQL que descarta las caducadas. Se usa en TODAS las lecturas: una
 *  liga muerta que la tarjeta de Ajustes sigue enseñando es peor que ninguna,
 *  porque se reparte creyendo que sirve. */
const VIVA = "(expires_at IS NULL OR expires_at > unixepoch())";

export async function activeToken(sub: string, channelId: number | null = null) {
  const s = scope(channelId);
  const { rows } = await dbq(
    `SELECT token FROM gc_invites WHERE created_by = ? AND used_by IS NULL AND ${VIVA} AND ${s.sql} ORDER BY rowid DESC LIMIT 1`,
    [sub, ...s.args]
  );
  return (rows[0]?.[0] as string) ?? null;
}

export async function mint(sub: string, channelId: number | null = null): Promise<string> {
  const crypto = await import("node:crypto");
  const token = crypto.randomBytes(16).toString("hex");
  const dias = diasDeVida();
  const exp = dias > 0 ? Math.floor(Date.now() / 1000) + dias * 86400 : null;
  await dbq("INSERT INTO gc_invites (token, created_by, channel_id, expires_at) VALUES (?, ?, ?, ?)", [
    token,
    sub,
    channelId,
    exp,
  ]);
  return token;
}

// La liga de un ROOM es del ROOM, no de quien la creó: el owner y el creador del canal
// administran la misma. (La del workspace sí es per-creador — ahí cada quien reparte la
// suya y revoca sólo la propia.) Si fuera per-creador, dos personas que administran el
// mismo room verían ligas distintas y "Cancelar" dejaría viva la del otro.
export async function roomToken(channelId: number): Promise<string | null> {
  const { rows } = await dbq(
    `SELECT token FROM gc_invites WHERE channel_id = ? AND used_by IS NULL AND ${VIVA} ORDER BY rowid DESC LIMIT 1`,
    [channelId]
  );
  return (rows[0]?.[0] as string) ?? null;
}

export async function dropRoomTokens(channelId: number): Promise<void> {
  await dbq("DELETE FROM gc_invites WHERE channel_id = ? AND used_by IS NULL", [channelId]);
}

export async function dropTokens(sub: string, channelId: number | null = null): Promise<void> {
  const s = scope(channelId);
  await dbq(`DELETE FROM gc_invites WHERE created_by = ? AND used_by IS NULL AND ${s.sql}`, [
    sub,
    ...s.args,
  ]);
}

/** Cuándo caduca esta liga (epoch en segundos). `null` = no caduca (filas
 *  anteriores a la caducidad, o `INVITE_TTL_DAYS=0`). */
export async function expiryOf(token: string): Promise<number | null> {
  const { rows } = await dbq("SELECT expires_at FROM gc_invites WHERE token = ?", [token]);
  const v = rows[0]?.[0];
  return v == null ? null : Number(v);
}

// ── Server fns (owner) ───────────────────────────────────────────────────────

// Lee el link permanente activo (NO crea). null = cancelado o nunca creado → la UI
// muestra el CTA "Crear link". Así "Cancelar" deja la tarjeta sin link (no se re-crea).
export const getInvite = createServerFn({ method: "GET" }).handler(async () => {
  const sub = await currentSub();
  const token = await activeToken(sub);
  // La fecha se devuelve para PINTARLA: una liga que caduca sin decirlo se
  // reparte igual y deja a alguien fuera sin explicación.
  return { url: token ? await urlFor(token) : null, expiresAt: token ? await expiryOf(token) : null };
});

// Get-or-create idempotente: crea el link permanente si no hay, o devuelve el actual.
export const createInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await currentSub();
  const token = (await activeToken(sub)) ?? (await mint(sub));
  return { url: await urlFor(token), expiresAt: await expiryOf(token) };
});

// Refresca: invalida el link actual (lo borra) y emite uno nuevo. El link viejo deja
// de resolver → útil si se filtró.
export const refreshInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await currentSub();
  await dropTokens(sub);
  const token = await mint(sub);
  return { url: await urlFor(token), expiresAt: await expiryOf(token) };
});

// Cancela: elimina el link permanente. Nadie más puede unirse hasta crear uno nuevo.
export const revokeInvite = createServerFn({ method: "POST" }).handler(async () => {
  const sub = await currentSub();
  await dropTokens(sub);
  return { ok: true as const };
});
