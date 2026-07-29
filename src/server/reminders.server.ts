// ── Recordatorios programados ───────────────────────────────────────────────
//
// Cola en DB + poll, que es como resuelven esto pg-boss, solid_queue y el scheduled
// set de Sidekiq. Lo frágil sería agendar un `setTimeout` en memoria: un reinicio se
// lo lleva. Aquí el timer es DESECHABLE — la verdad son las filas de `gc_reminders`,
// así que reiniciar el server sólo puede entregar tarde, nunca perder.
//
// El tick corre FUERA de un request, así que no hay host del cual deducir el tenant:
// cada fila guarda su `ns` y el barrido entra con `withNamespace` (tenant.server.ts).
// Los namespaces vivos se registran desde `ensureSchema` — una caja sirve a varios
// workspaces y sólo los conocemos cuando alguno hace su primer request.
import { dbq } from "../dbq.server";
import { withNamespace } from "./tenant.server";

export type Repeat = "daily" | "weekly" | "monthly";

export type Reminder = {
  id: string;
  ownerSub: string;
  channelId: number | null;
  dmId: number | null;
  topic: string;
  agentHandle: string;
  agentName: string;
  agentAvatar: string;
  text: string;
  dueAt: number;
  repeat: Repeat | null;
  tz: string;
  /** El usuario pidió que ADEMÁS le llegue por correo (se pregunta al programar). */
  email: boolean;
};

export const DEFAULT_TZ = "America/Mexico_City";
const TICK_MS = 30_000;

// ── Reloj: epoch ⇄ hora de pared en una zona ────────────────────────────────
// Sin dependencias: `Intl` sabe de husos y de horario de verano, y es lo único que
// no se desactualiza cuando un país cambia sus reglas.

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try { fmtFor(tz); return true; } catch { return false; }
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

/** La hora de pared que marca el reloj de `tz` en ese instante. */
function wallOf(ms: number, tz: string): Wall {
  const p = Object.fromEntries(fmtFor(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

/** Offset del huso EN ese instante (ms). Positivo al este de Greenwich. */
function offsetOf(ms: number, tz: string): number {
  const p = Object.fromEntries(fmtFor(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Hora de pared → epoch (segundos). Dos pasadas: la primera adivina con el offset del
 * instante equivocado, la segunda corrige. Hace falta porque el offset depende del
 * instante que estamos calculando — cerca de un cambio de horario de verano, una sola
 * pasada se va una hora.
 */
export function wallToEpoch(w: Wall, tz: string): number {
  let guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  for (let i = 0; i < 2; i++) guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - offsetOf(guess, tz);
  return Math.floor(guess / 1000);
}

/** Parsea "2026-08-01T09:00" (hora LOCAL, sin zona) → epoch en `tz`. */
export function parseLocal(when: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec((when || "").trim());
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 9, mi: m[5] ? +m[5] : 0 };
  if (w.mo < 1 || w.mo > 12 || w.d < 1 || w.d > 31 || w.h > 23 || w.mi > 59) return null;
  return wallToEpoch(w, tz);
}

/** "vie 1 de ago, 09:00" — para que el agente confirme lo que entendió. */
export function humanDate(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(epoch * 1000));
}

/** Siguiente ocurrencia de un repetitivo, calculada en su hora de pared. */
export function nextOccurrence(epoch: number, repeat: Repeat, tz: string): number {
  const w = wallOf(epoch * 1000, tz);
  if (repeat === "daily") return wallToEpoch({ ...w, d: w.d + 1 }, tz);
  if (repeat === "weekly") return wallToEpoch({ ...w, d: w.d + 7 }, tz);
  // Mensual: el 31 no existe en todos los meses. Se recorta al último día del mes
  // destino en vez de desbordar al 1 del siguiente (que es lo que hace Date.UTC solo).
  const mo = w.mo === 12 ? 1 : w.mo + 1;
  const y = w.mo === 12 ? w.y + 1 : w.y;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return wallToEpoch({ ...w, y, mo, d: Math.min(w.d, lastDay) }, tz);
}

// ── Store ───────────────────────────────────────────────────────────────────

const rid = () => `rm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function createReminder(r: Omit<Reminder, "id">): Promise<Reminder> {
  const id = rid();
  await dbq(
    `INSERT INTO gc_reminders (id, ns, owner_sub, channel_id, dm_id, topic, agent_handle, agent_name, agent_avatar, text, due_at, repeat, tz, email)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, await nsOf(), r.ownerSub, r.channelId, r.dmId, r.topic, r.agentHandle, r.agentName, r.agentAvatar, r.text, r.dueAt, r.repeat, r.tz, r.email ? 1 : 0]
  );
  return { ...r, id };
}

async function nsOf(): Promise<string> {
  const { currentNamespace } = await import("./tenant.server");
  return currentNamespace();
}

export async function listReminders(ownerSub: string): Promise<Reminder[]> {
  const rows = await dbq(
    `SELECT * FROM gc_reminders WHERE owner_sub=? AND fired_at IS NULL AND canceled_at IS NULL ORDER BY due_at LIMIT 50`,
    [ownerSub]
  );
  return rows.map(toReminder);
}

export async function cancelReminder(ownerSub: string, id: string): Promise<boolean> {
  // El owner_sub en el WHERE es el control de acceso: nadie cancela lo de otro, ni
  // aunque adivine el id.
  const rows = await dbq(
    `UPDATE gc_reminders SET canceled_at=unixepoch()
     WHERE id=? AND owner_sub=? AND fired_at IS NULL AND canceled_at IS NULL RETURNING id`,
    [id, ownerSub]
  );
  return rows.length > 0;
}

function toReminder(r: Record<string, string | null>): Reminder {
  return {
    id: r.id!,
    ownerSub: r.owner_sub!,
    channelId: r.channel_id == null ? null : Number(r.channel_id),
    dmId: r.dm_id == null ? null : Number(r.dm_id),
    topic: r.topic ?? "general",
    agentHandle: r.agent_handle!,
    agentName: r.agent_name || "Ghosty",
    agentAvatar: r.agent_avatar || "",
    text: r.text!,
    dueAt: Number(r.due_at),
    repeat: (r.repeat as Repeat | null) ?? null,
    tz: r.tz || DEFAULT_TZ,
    email: r.email === "1",
  };
}

// ── Tick ────────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Llamado desde ensureSchema: este tenant existe y su tabla está lista. */
export function armReminders(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, TICK_MS);
  timer.unref?.(); // no mantiene vivo el proceso (igual que el reaper de quick-calls)
  void sweep(); // al arrancar: lo que venció mientras el server estaba caído sale YA
}

async function sweep(): Promise<void> {
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
    } catch {
      // Un tenant con la DB flapeando no puede dejar sin recordatorios a los demás;
      // sus filas siguen pendientes y el próximo tick reintenta.
    }
  }
}

async function sweepTenant(ns: string): Promise<void> {
  const rows = await dbq(
    `SELECT * FROM gc_reminders WHERE fired_at IS NULL AND canceled_at IS NULL AND due_at <= unixepoch() ORDER BY due_at LIMIT 20`
  );
  for (const row of rows) {
    const r = toReminder(row);
    // CLAIM atómico antes de entregar: el UPDATE condicional es lo que impide un
    // recordatorio doble si algún día hay dos procesos, o si un tick se traslapa con
    // el siguiente porque la entrega tardó.
    const claimed = await dbq(
      `UPDATE gc_reminders SET fired_at=unixepoch() WHERE id=? AND fired_at IS NULL RETURNING id`,
      [r.id]
    );
    if (!claimed.length) continue;
    try {
      await deliver(ns, r);
    } catch {
      /* entregado a medias > entregado dos veces: no se des-marca */
    }
    if (r.repeat) {
      const next = nextOccurrence(r.dueAt, r.repeat, r.tz);
      await createReminder({ ...r, dueAt: next }).catch(() => {});
    }
  }
}

async function deliver(ns: string, r: Reminder): Promise<void> {
  const db = await import("../db.server");
  const bus = await import("./bus.server");
  const users = await import("../users.server");

  // Se menciona a quien lo pidió: en un canal compartido el recordatorio es de alguien.
  const all = await users.listUsers().catch(() => []);
  const owner = all.find((u) => u.sub === r.ownerSub);
  const who = owner?.handle ? `@${owner.handle}` : "";
  const body = `⏰ **Recordatorio**${who ? ` — ${who}` : ""}\n\n${r.text}`;

  if (r.dmId != null) {
    const { id } = await db.postDmAgent(r.dmId, body, "msg", r.agentHandle, r.agentName, r.agentAvatar);
    const msg = await db.getMessage(id);
    for (const sub of await db.getDmMembers(r.dmId)) {
      if (msg) bus.publish(bus.ch.user(ns, sub), { t: "message:new", msg });
    }
  } else if (r.channelId != null) {
    const { id } = await db.postAgent(r.channelId, null, body, "msg", r.agentHandle, r.agentName, r.topic, r.agentAvatar);
    const msg = await db.getMessage(id);
    if (msg) bus.publish(bus.ch.room(ns, r.channelId), { t: "message:new", msg });
  } else {
    return;
  }

  // Push/email: el recordatorio sirve justamente cuando NO tienes la pestaña abierta.
  const { notify } = await import("./notify.server");
  await notify({
    kind: "reminder",
    recipients: [r.ownerSub],
    title: "⏰ Recordatorio",
    body: r.text,
    url: "/",
    // Correo sólo si lo pidió para ESTE recordatorio; si no, manda su preferencia global.
    forceEmail: r.email,
  }, ns).catch(() => {});
}
