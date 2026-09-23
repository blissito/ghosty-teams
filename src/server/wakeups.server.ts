// ── Despertadores del agente: eventos que le abren un turno sin que nadie escriba ──
//
// El patrón es el de OpenClaw, Devin y las routines de Claude Code: el agente NO es un
// proceso que vive días, es una FUNCIÓN. Cada corrida es corta y termina; el estado vive en
// filas durables; y lo que lo despierta es un EVENTO ("terminó el zip que encargaste") o un
// timer durable, nunca un `setTimeout` en memoria ni un bucle de polling dentro de la caja
// (que hiberna a los 5 min y se congela a medias).
//
// Cola en DB + poll de 30 s, calcado de `reminders.server.ts`: el timer es desechable, la
// verdad son las filas de `gt_agent_wakeups`. Reiniciar el server sólo puede despertar tarde,
// nunca perder un evento.
//
// Idempotencia por `key` (`video:<jobId>`): el productor puede reintentar el POST y el agente
// se despierta UNA vez. Si hay turno en vuelo en esa conversación se DIFIERE (+60 s), no se
// encola encima ni se pisa — el mismo criterio que `ScheduledTurn` en gs.
//
// Quién produce hoy: gs, en el callback de un `VideoRun` (montaje o audio de YouTube), con la
// ruta `api/internal/agent-wake`. El `ref` que gs devuelve lo emitió ESTE tenant al abrir el
// turno (`mintWakeRef` en el streamBody), así que gs no decide a dónde va el despertador:
// sólo devuelve la capacidad que se le dio.
import crypto from "node:crypto";
import { dbq } from "../dbq.server";
import { withNamespace } from "./tenant.server";
import type { ToolDest } from "./connectors/tool-token.server";

const TICK_MS = 30_000;
const DEFER_S = 60;
const REF_TTL_S = 7 * 24 * 3600; // lo que dura la liga firmada de un entregable

export type WakeRef = { sub: string; ns: string; groupId: string; dest: ToolDest; exp: number };

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

/** La capacidad que viaja a gs con cada turno: a quién despertar y dónde. */
export function mintWakeRef(r: Omit<WakeRef, "exp">): string {
  const payload = Buffer.from(
    JSON.stringify({ ...r, exp: Math.floor(Date.now() / 1000) + REF_TTL_S }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(`wake.${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyWakeRef(ref: string): WakeRef | null {
  const [payload, sig] = (ref || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(`wake.${payload}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<WakeRef>;
    if (!p.sub || !p.ns || !p.groupId || !p.dest || !p.exp) return null;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p as WakeRef;
  } catch {
    return null;
  }
}

export type Wakeup = {
  id: string;
  key: string;
  ref: string;
  cause: string;
  text: string;
  origin: string;
  dueAt: number;
};

/** Encola (idempotente por `key`). Devuelve false si ya existía. */
export async function enqueueWakeup(w: Omit<Wakeup, "id" | "dueAt"> & { dueAt?: number }): Promise<boolean> {
  const id = crypto.randomUUID();
  const rows = await dbq(
    `INSERT OR IGNORE INTO gt_agent_wakeups (id, key, ref, cause, text, origin, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [id, w.key, w.ref, w.cause, w.text, w.origin, w.dueAt ?? Math.floor(Date.now() / 1000)],
  );
  return rows.length > 0;
}

// ── El tick ──────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function armWakeups(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, TICK_MS);
  timer.unref?.();
  void sweep();
}

async function sweep(): Promise<void> {
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
    } catch {
      /* un tenant con la DB flapeando no deja sin despertadores a los demás */
    }
  }
}

async function sweepTenant(ns: string): Promise<void> {
  const rows = await dbq(
    `SELECT * FROM gt_agent_wakeups WHERE fired_at IS NULL AND due_at <= unixepoch() ORDER BY due_at LIMIT 10`,
  );
  for (const row of rows) {
    const w: Wakeup = {
      id: String(row.id), key: String(row.key), ref: String(row.ref), cause: String(row.cause),
      text: String(row.text), origin: String(row.origin ?? ""), dueAt: Number(row.due_at),
    };
    const ref = verifyWakeRef(w.ref);
    if (!ref) {
      await dbq(`UPDATE gt_agent_wakeups SET fired_at=unixepoch(), result='ref inválido o caducado' WHERE id=?`, [w.id]);
      continue;
    }
    // Turno en vuelo en esa conversación → se difiere. `startTurn` interrumpe el turno
    // anterior del mismo invocador, y aquí el invocador es el mismo: pisarlo tiraría trabajo.
    const turns = await import("./turns.server");
    if (turns.hasOwnInflight(ref.groupId, ref.sub)) {
      await dbq(`UPDATE gt_agent_wakeups SET due_at=unixepoch()+? WHERE id=?`, [DEFER_S, w.id]);
      continue;
    }
    // CLAIM atómico antes de correr: dos ticks traslapados no abren dos turnos.
    const claimed = await dbq(
      `UPDATE gt_agent_wakeups SET fired_at=unixepoch() WHERE id=? AND fired_at IS NULL RETURNING id`,
      [w.id],
    );
    if (!claimed.length) continue;
    try {
      await fire(ns, w, ref);
      await dbq(`UPDATE gt_agent_wakeups SET result='ok' WHERE id=?`, [w.id]);
    } catch (e) {
      await dbq(`UPDATE gt_agent_wakeups SET result=? WHERE id=?`, [String((e as Error)?.message ?? e).slice(0, 500), w.id]);
    }
  }
}

/** Abre el turno donde se pidió el trabajo, con un mensaje de PLATAFORMA (no de la persona). */
async function fire(ns: string, w: Wakeup, ref: WakeRef): Promise<void> {
  const db = await import("../db.server");
  const bus = await import("./bus.server");
  const { resolvedAgents, runAgentTurn } = await import("../agents.server");
  const handle = ref.dest.handle ?? "";
  const agent = (await resolvedAgents()).find((a) => a.handle === handle);
  const name = agent?.name ?? ref.dest.name ?? "Ghosty";
  const avatar = agent?.avatar ?? ref.dest.avatar ?? "";
  const dest = ref.dest;

  // Igual que un turno programado en gs: el agente sabe que lo despertó la plataforma y que
  // si no hay nada que entregar contesta `OK` (y un `OK` no genera push).
  // ⚠️ Salvo la revisión de una alerta (`alert:`): ahí «es ruido» ES la respuesta, y con la
  // salida del `OK` el agente la tomaba y el hilo de la alerta quedaba vacío (medido).
  const text =
    `⏰ Turno programado por la plataforma (${w.cause}). ${w.text}` +
    (w.key.startsWith("alert:") ? "" : `\nSi no hay nada nuevo que entregar, contesta exactamente: OK`);

  let shellId: number | null = null;
  const publish = (ev: Record<string, unknown>) => {
    if (dest.dmId != null) {
      void db.getDmMembers(dest.dmId).then((subs) => {
        for (const sub of subs) bus.publish(bus.ch.user(ns, sub), ev as never);
      });
    } else if (dest.channelId != null) {
      bus.publish(bus.ch.room(ns, dest.channelId), ev as never);
    }
  };

  const { id, reply } = await runAgentTurn({
    agent,
    handle,
    groupId: ref.groupId,
    sender: "Ghosty Studio",
    text,
    invokerSub: ref.sub,
    originOverride: w.origin || undefined,
    dest: { ...dest, handle, name, avatar },
    createShell: async () => {
      let mid: number;
      if (dest.dmId != null) {
        mid = (await db.postDmAgent(dest.dmId, "", "msg", handle, name, avatar)).id;
      } else if (dest.channelId != null) {
        mid = (await db.postAgent(dest.channelId, dest.parentId ?? null, "", "msg", handle, name, dest.topic ?? "general", avatar)).id;
      } else {
        throw new Error("destino sin dm ni canal");
      }
      shellId = mid;
      const shell = await db.getMessage(mid);
      if (shell) publish({ t: "message:new", msg: shell });
      return mid;
    },
    emitDelta: (mid, chunk) =>
      publish({ t: "message:delta", id: mid, chunk, channelId: dest.channelId ?? null, parentId: dest.parentId ?? null, dmId: dest.dmId ?? null }),
    emitBody: (mid, body) => publish({ t: "message:body", id: mid, body }),
  });

  const finalBody = reply.trim();
  // Una línea por despertador: sin ella, un turno que no dejó burbuja es indistinguible de
  // uno que no corrió (costó una tarde con la revisión de alertas de #soporte).
  console.log(`[wake] ${w.key} agent=${agent ? handle : "∅"} id=${id} shell=${shellId} reply=${JSON.stringify(finalBody.slice(0, 120))}`);
  // Un `OK` es "nada que entregar": no se deja burbuja. Igual que en gs.
  if (!finalBody || finalBody === "OK") {
    if (shellId != null) await db.deleteMessage(shellId).catch(() => {});
    return;
  }
  // Archivos y notas de voz entregados en el turno (```eb-file``` / ```eb-audio```): el
  // mismo tratamiento que un turno normal. Sin esto el video/mp3 que motivó el
  // despertador se quedaba sin tarjeta.
  const { attachDeliveryFences } = await import("./delivery-fences.server");
  const delivered = await attachDeliveryFences(id, finalBody, dest);
  const body = delivered?.body ?? finalBody;
  await db.setMessageBody(id, body);
  publish({ t: "message:body", id, body });
  if (delivered?.attached) publish({ t: "refresh", channelId: dest.channelId ?? null, parentId: dest.parentId ?? null, dmId: dest.dmId ?? null });
}
