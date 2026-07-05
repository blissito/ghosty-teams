// Estado en EasyBits DB (libSQL) — modelo Slack: canal = flujo, threads nacen
// de un mensaje (parent_id). Compute stateless, historial durable.
const BASE = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
const KEY = process.env.EASYBITS_API_KEY!;
const DB_ID = process.env.EASYBITS_DB_ID!;

type Row = Record<string, string | null>;

async function dbq(sql: string, args: unknown[] = []): Promise<Row[]> {
  const res = await fetch(`${BASE}/api/v2/databases/${DB_ID}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ sql, args }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  const { cols, rows } = (await res.json()) as { cols: string[]; rows: (string | null)[][] };
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const num = (v: string | null) => Number(v ?? 0);

export type Channel = {
  id: number;
  slug: string;
  name: string;
  is_private: number;
  icon: string | null;
  created_by?: string | null;
};

function toChannel(r: Row): Channel {
  return {
    id: num(r.id),
    slug: r.slug!,
    name: r.name!,
    is_private: num(r.is_private),
    icon: r.icon,
    created_by: r.created_by,
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "room"
  );
}
export type Message = {
  id: number;
  channel_id: number;
  parent_id: number | null;
  sender: string;
  avatar: string;
  body: string;
  kind: "msg" | "status";
  mentions_ghosty: number;
  agent_handle: string | null;
  created_at: number;
  reply_count?: number;
};

export const GHOSTY_RE = /@ghosty\b/i;

// El handle "ghosty" siempre existe (el agente del wizard). Reservado.
export const GHOSTY_HANDLE = "ghosty";

function toMessage(r: Row): Message {
  return {
    id: num(r.id),
    channel_id: num(r.channel_id),
    parent_id: r.parent_id == null ? null : num(r.parent_id),
    sender: r.sender!,
    avatar: r.avatar ?? "",
    body: r.body!,
    kind: (r.kind as "msg" | "status") ?? "msg",
    mentions_ghosty: num(r.mentions_ghosty),
    agent_handle: r.agent_handle ?? null,
    created_at: num(r.created_at),
    reply_count: r.reply_count == null ? undefined : num(r.reply_count),
  };
}

// ── Agentes (multi-agente): el "ghosty" implícito del wizard + estos extra ──
export type Agent = {
  id: number;
  handle: string;
  name: string;
  kind: "fleet" | "webhook";
  fleet_id: string | null;
  fleet_token: string | null;
  webhook_url: string | null;
  avatar: string | null;
  enabled: number;
  created_by: string | null;
};

function toAgent(r: Row): Agent {
  return {
    id: num(r.id),
    handle: r.handle!,
    name: r.name!,
    kind: (r.kind as "fleet" | "webhook") ?? "fleet",
    fleet_id: r.fleet_id,
    fleet_token: r.fleet_token,
    webhook_url: r.webhook_url,
    avatar: r.avatar,
    enabled: num(r.enabled),
    created_by: r.created_by,
  };
}

export async function listAgents(): Promise<Agent[]> {
  const rows = await dbq("SELECT * FROM gc_agents ORDER BY id");
  return rows.map(toAgent);
}

export async function getAgentByHandle(handle: string): Promise<Agent | null> {
  const rows = await dbq("SELECT * FROM gc_agents WHERE handle = ?", [handle.toLowerCase()]);
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function createAgent(input: {
  handle: string;
  name: string;
  kind: "fleet" | "webhook";
  fleetId?: string | null;
  fleetToken?: string | null;
  webhookUrl?: string | null;
  avatar?: string | null;
  createdBy: string;
}): Promise<Agent> {
  const handle = slugify(input.handle).replace(/-/g, "");
  const rows = await dbq(
    `INSERT INTO gc_agents (handle, name, kind, fleet_id, fleet_token, webhook_url, avatar, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      handle,
      input.name.slice(0, 40),
      input.kind,
      input.fleetId ?? null,
      input.fleetToken ?? null,
      input.webhookUrl ?? null,
      input.avatar ?? null,
      input.createdBy,
    ]
  );
  return toAgent(rows[0]);
}

export async function updateAgent(
  id: number,
  patch: { name?: string; fleetId?: string; fleetToken?: string; webhookUrl?: string; enabled?: boolean }
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), args.push(patch.name.slice(0, 40)));
  if (patch.fleetId !== undefined) (sets.push("fleet_id = ?"), args.push(patch.fleetId));
  if (patch.fleetToken !== undefined) (sets.push("fleet_token = ?"), args.push(patch.fleetToken));
  if (patch.webhookUrl !== undefined) (sets.push("webhook_url = ?"), args.push(patch.webhookUrl));
  if (patch.enabled !== undefined) (sets.push("enabled = ?"), args.push(patch.enabled ? 1 : 0));
  if (!sets.length) return;
  args.push(id);
  await dbq(`UPDATE gc_agents SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function deleteAgent(id: number): Promise<void> {
  await dbq("DELETE FROM gc_agents WHERE id = ?", [id]);
}

// ── Web Push: suscripciones por usuario ──
export async function savePushSub(
  userSub: string,
  sub: { endpoint: string; p256dh: string; auth: string }
): Promise<void> {
  await dbq(
    `INSERT INTO gc_push_subs (user_sub, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_sub = excluded.user_sub, p256dh = excluded.p256dh, auth = excluded.auth`,
    [userSub, sub.endpoint, sub.p256dh, sub.auth]
  );
}

export async function deletePushSub(endpoint: string): Promise<void> {
  await dbq("DELETE FROM gc_push_subs WHERE endpoint = ?", [endpoint]);
}

export type StoredPushSub = { endpoint: string; p256dh: string; auth: string };
export async function listPushSubsForUsers(subs: string[]): Promise<StoredPushSub[]> {
  if (!subs.length) return [];
  const ph = subs.map(() => "?").join(",");
  const rows = await dbq(
    `SELECT endpoint, p256dh, auth FROM gc_push_subs WHERE user_sub IN (${ph})`,
    subs
  );
  return rows.map((r) => ({ endpoint: r.endpoint!, p256dh: r.p256dh!, auth: r.auth! }));
}

// Rooms visibles para el user: públicos, o privados donde es miembro, o todos si owner.
export async function listChannels(userSub: string, isOwner: boolean): Promise<Channel[]> {
  const rows = await dbq(
    `SELECT * FROM gc_channels
      WHERE is_private = 0 OR ? = 1
         OR id IN (SELECT channel_id FROM gc_channel_members WHERE user_sub = ?)
      ORDER BY id`,
    [isOwner ? 1 : 0, userSub]
  );
  return rows.map(toChannel);
}

export async function getChannel(slug: string): Promise<Channel | null> {
  const rows = await dbq("SELECT * FROM gc_channels WHERE slug = ?", [slug]);
  return rows[0] ? toChannel(rows[0]) : null;
}

export async function canSeeChannel(ch: Channel, userSub: string, isOwner: boolean): Promise<boolean> {
  if (ch.is_private === 0 || isOwner) return true;
  const { rows } = await dbqRaw(
    "SELECT 1 FROM gc_channel_members WHERE channel_id = ? AND user_sub = ?",
    [ch.id, userSub]
  );
  return rows.length > 0;
}

// helper que devuelve rows crudas (para EXISTS checks)
async function dbqRaw(sql: string, args: unknown[] = []) {
  const rows = await dbq(sql, args);
  return { rows };
}

// ── Rooms CRUD ──
export async function createChannel(input: {
  name: string;
  icon?: string;
  isPrivate: boolean;
  createdBy: string;
}): Promise<Channel> {
  let base = slugify(input.name);
  let slug = base;
  // slug único
  for (let i = 2; (await getChannel(slug)) != null; i++) slug = `${base}-${i}`;
  const rows = await dbq(
    `INSERT INTO gc_channels (slug, name, is_private, icon, created_by)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
    [slug, input.name.slice(0, 40), input.isPrivate ? 1 : 0, input.icon ?? null, input.createdBy]
  );
  const ch = toChannel(rows[0]);
  if (ch.is_private) await addChannelMember(ch.id, input.createdBy);
  return ch;
}

export async function updateChannel(
  id: number,
  patch: { name?: string; icon?: string | null; isPrivate?: boolean }
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), args.push(patch.name.slice(0, 40)));
  if (patch.icon !== undefined) (sets.push("icon = ?"), args.push(patch.icon));
  if (patch.isPrivate !== undefined) (sets.push("is_private = ?"), args.push(patch.isPrivate ? 1 : 0));
  if (!sets.length) return;
  args.push(id);
  await dbq(`UPDATE gc_channels SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function deleteChannel(id: number): Promise<void> {
  await dbq("DELETE FROM gc_messages WHERE channel_id = ?", [id]);
  await dbq("DELETE FROM gc_channel_members WHERE channel_id = ?", [id]);
  await dbq("DELETE FROM gc_channels WHERE id = ?", [id]);
}

export async function listChannelMembers(channelId: number): Promise<string[]> {
  const rows = await dbq("SELECT user_sub FROM gc_channel_members WHERE channel_id = ?", [channelId]);
  return rows.map((r) => r.user_sub!);
}

export async function addChannelMember(channelId: number, userSub: string): Promise<void> {
  await dbq(
    "INSERT INTO gc_channel_members (channel_id, user_sub) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [channelId, userSub]
  );
}

export async function removeChannelMember(channelId: number, userSub: string): Promise<void> {
  await dbq("DELETE FROM gc_channel_members WHERE channel_id = ? AND user_sub = ?", [channelId, userSub]);
}

export async function getUserSubByEmail(email: string): Promise<string | null> {
  const rows = await dbq("SELECT sub FROM gc_users WHERE email = ?", [email.trim().toLowerCase()]);
  return rows[0]?.sub ?? null;
}

export type MemberInfo = { sub: string; name: string; email: string; avatar: string };
export async function listChannelMembersInfo(channelId: number): Promise<MemberInfo[]> {
  const rows = await dbq(
    `SELECT u.sub, u.name, u.email, u.avatar
       FROM gc_channel_members m JOIN gc_users u ON u.sub = m.user_sub
      WHERE m.channel_id = ?`,
    [channelId]
  );
  return rows.map((r) => ({ sub: r.sub!, name: r.name ?? "", email: r.email ?? "", avatar: r.avatar ?? "" }));
}

// Flujo principal del canal: mensajes top-level (parent_id NULL) + nº de respuestas.
export async function listChannelFlow(channelId: number): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.*, (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL
      ORDER BY m.created_at ASC`,
    [channelId]
  );
  return rows.map(toMessage);
}

// Todos los hilos del canal (mensajes raíz que tienen respuestas) — para no
// enterrarlos. Ordenados por actividad reciente.
export async function listThreadRoots(channelId: number): Promise<Message[]> {
  const rows = await dbq(
    `SELECT m.*,
            (SELECT COUNT(*) FROM gc_messages c WHERE c.parent_id = m.id) AS reply_count,
            (SELECT MAX(created_at) FROM gc_messages c WHERE c.parent_id = m.id) AS last_at
       FROM gc_messages m
      WHERE m.channel_id = ? AND m.parent_id IS NULL
        AND EXISTS (SELECT 1 FROM gc_messages c WHERE c.parent_id = m.id)
      ORDER BY last_at DESC`,
    [channelId]
  );
  return rows.map(toMessage);
}

// Borra un mensaje. Si es raíz de hilo, borra también sus respuestas.
export async function deleteMessage(id: number): Promise<void> {
  await dbq("DELETE FROM gc_messages WHERE id = ? OR parent_id = ?", [id, id]);
}

export async function getMessage(id: number): Promise<Message | null> {
  const rows = await dbq("SELECT * FROM gc_messages WHERE id = ?", [id]);
  return rows[0] ? toMessage(rows[0]) : null;
}

// Un hilo: las respuestas de un mensaje.
export async function listThread(parentId: number): Promise<Message[]> {
  const rows = await dbq(
    "SELECT * FROM gc_messages WHERE parent_id = ? ORDER BY created_at ASC",
    [parentId]
  );
  return rows.map(toMessage);
}

export async function createMessage(input: {
  channelId: number;
  parentId: number | null;
  sender: string;
  avatar?: string;
  body: string;
  agentHandle?: string | null; // qué agente fue mencionado (null = ninguno)
}): Promise<{ id: number }> {
  const handle = input.agentHandle ?? null;
  const rows = await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, avatar, body, kind, mentions_ghosty, agent_handle)
     VALUES (?, ?, ?, ?, ?, 'msg', ?, ?) RETURNING id`,
    [input.channelId, input.parentId, input.sender, input.avatar ?? "", input.body, handle ? 1 : 0, handle]
  );
  return { id: num(rows[0].id) };
}

// Un agente postea (respuesta o status "pensando") en el mismo contexto.
// sender = nombre visible del agente; agentHandle marca el mensaje como suyo.
export async function postAgent(
  channelId: number,
  parentId: number | null,
  body: string,
  kind: "msg" | "status",
  agentHandle: string,
  sender: string
): Promise<void> {
  await dbq(
    `INSERT INTO gc_messages (channel_id, parent_id, sender, body, kind, mentions_ghosty, agent_handle)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [channelId, parentId, sender, body, kind, agentHandle]
  );
}

// Borra los "pensando…" (status) de un contexto — al llegar la respuesta real.
export async function clearStatus(channelId: number, parentId: number | null): Promise<void> {
  if (parentId == null) {
    await dbq(
      "DELETE FROM gc_messages WHERE channel_id = ? AND parent_id IS NULL AND kind = 'status'",
      [channelId]
    );
  } else {
    await dbq(
      "DELETE FROM gc_messages WHERE channel_id = ? AND parent_id = ? AND kind = 'status'",
      [channelId, parentId]
    );
  }
}
