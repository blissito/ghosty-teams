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

export type WakeRef = {
  sub: string;
  ns: string;
  groupId: string;
  dest: ToolDest;
  exp: number;
  /**
   * ADOPTAR un turno durable de gs en vez de abrir uno nuevo: Teams se reinició con el turno
   * a medias, gs lo siguió corriendo, y el proceso nuevo se reengancha en la MISMA burbuja
   * (repite el backlog desde el inicio para rehacerla). Ver `sweepOrphans`.
   */
  adopt?: { shellId: number; turnId: string };
};

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

// Cuándo arrancó ESTE proceso: un relevo disparado antes de esto sin `result` murió con el
// proceso anterior (deploy). Se marca para que `/busy` no lo cuente como trabajo vivo.
const PROCESS_STARTED_S = Math.floor(Date.now() / 1000);

export function armWakeups(ns: string): void {
  if (!tenants.has(ns))
    void withNamespace(ns, () =>
      dbq(`UPDATE gt_agent_wakeups SET result = 'interrumpido por reinicio' WHERE fired_at IS NOT NULL AND result IS NULL AND fired_at < ?`, [
        PROCESS_STARTED_S,
      ]),
    ).catch(() => {});
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, TICK_MS);
  timer.unref?.();
  void sweep();
}

/** Barre YA en vez de esperar al tick: un relevo entre agentes no debe tardar 30 s. */
export function kickWakeups(ns: string): void {
  armWakeups(ns);
  // Sólo ESE espacio: `sweep()` recorre todos los tenants en serie (con sus consultas por red)
  // antes de llegar a éste, y el relevo tardaba ~20 s en dispararse (MailMask #15, 5-oct).
  void withNamespace(ns, () => sweepTenant(ns)).catch(() => {});
}

/**
 * Relevos que están por salir (en `windowS` segundos) en todos los tenants de este proceso.
 * Lo suma `/busy`: entre el fin de un turno y su relevo (el empujón de la fábrica sale a los
 * 5 s) Teams parecía libre, el deploy lo reiniciaba justo ahí y el turno siguiente se quedaba
 * sin tools (502) — @build, pedido #10, 2026-10-01.
 */
export async function wakeupsDueSoon(windowS = 90): Promise<number> {
  let n = 0;
  for (const ns of Array.from(tenants)) {
    const rows = await withNamespace(ns, () =>
      // También los YA disparados que no han terminado (`result` se escribe al final): entre el
      // claim y el arranque del turno hay una ventana donde no son «por salir» ni «en vuelo», y
      // con la base lenta duró 13 s — un deploy reinició ahí y mató a @build (01-oct).
      dbq(
        `SELECT COUNT(*) AS n FROM gt_agent_wakeups
          WHERE (fired_at IS NULL AND due_at <= unixepoch() + ?)
             OR (fired_at IS NOT NULL AND result IS NULL AND fired_at > unixepoch() - 7200)`,
        [windowS],
      ),
    ).catch(() => []);
    n += Number(rows[0]?.n ?? 0);
  }
  return n;
}

async function sweep(): Promise<void> {
  // Apagándose (deploy): no se abre ningún turno nuevo. Lo toma el proceso que arranca.
  const { seEstaApagando } = await import("./shutdown.server");
  if (seEstaApagando()) return;
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
      await withNamespace(ns, () => sweepStale(ns));
    } catch {
      /* un tenant con la DB flapeando no deja sin despertadores a los demás */
    }
    sweepProduction(ns);
  }
}

// Producción (post-merge y uptime): red con timeouts de 10-15 s, así que corre APARTE del
// barrido de despertadores —no lo retrasa— y nunca dos veces encimadas por tenant.
const productionBusy = new Set<string>();
function sweepProduction(ns: string): void {
  if (productionBusy.has(ns)) return;
  productionBusy.add(ns);
  void withNamespace(ns, async () => {
    const { sweepPostMerge } = await import("./apps/post-merge.server");
    await sweepPostMerge().catch((e) => console.error("[post-merge]", e));
    const { sweepUptime } = await import("./apps/uptime.server");
    await sweepUptime().catch((e) => console.error("[uptime]", e));
  })
    .catch(() => {})
    .finally(() => productionBusy.delete(ns));
}

// Pedidos de la fábrica colgados (30 min sin actividad): cada 5 min por tenant, no en cada tick.
const lastStale = new Map<string, number>();
async function sweepStale(ns: string): Promise<void> {
  if (Date.now() - (lastStale.get(ns) ?? 0) < 5 * 60_000) return;
  lastStale.set(ns, Date.now());
  const turns = await import("./turns.server");
  const live = turns.allLiveTurnStates(ns);
  const pending = await dbq(`SELECT key FROM gt_agent_wakeups WHERE fired_at IS NULL`).catch(() => []);
  const { sweepStaleRuns } = await import("./apps/factory-runs.server");
  await sweepStaleRuns(
    (run) =>
      live.some((t) => t.channelId === run.channelId && t.parentId === run.rootMsgId) ||
      pending.some((w) => String(w.key).startsWith(`factory:${run.id}:`) || String(w.key).startsWith(`handoff:${run.channelId}:${run.rootMsgId}:`)),
  );
}

async function sweepTenant(ns: string): Promise<void> {
  const rows = await dbq(
    `SELECT * FROM gt_agent_wakeups WHERE fired_at IS NULL AND due_at <= unixepoch() ORDER BY due_at LIMIT 10`,
  );
  const { freshOrigin } = await import("./tenant.server");
  for (const row of rows) {
    const w: Wakeup = {
      id: String(row.id), key: String(row.key), ref: String(row.ref), cause: String(row.cause),
      // Con el slug ACTUAL: un encargo guardado antes de renombrar el espacio apuntaba al host
      // viejo y sus tools daban 403 (abogados → palmera-legal, 3-oct). Cubre todo lo que se
      // encola con un origin copiado de otro encargo (relevos, retomar, nudge, CI, choques).
      text: String(row.text), origin: await freshOrigin(String(row.origin ?? "")), dueAt: Number(row.due_at),
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
export async function fire(ns: string, w: Wakeup, ref: WakeRef): Promise<void> {
  const firedAt = Date.now();
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
  // ⚠️ Salvo la revisión de una alerta (`alert:`): ahí «es ruido» ES la respuesta. Y no basta
  // con quitar la cláusula: el prompt de gs (`tools-dispatch.server.ts`) le enseña al agente
  // que TODO mensaje que empiece con «⏰ Turno programado» se contesta «OK» si no hay nada
  // nuevo. Con esa marca contestaba «OK» y el hilo de la alerta quedaba vacío (medido 3 veces).
  // La estafeta de la Software Factory (`factory:`) tampoco lleva la cláusula del OK: es un
  // encargo con trabajo seguro (construir, revisar, rehacer el plan), no una revisión que
  // pueda salir vacía.
  const text = w.key.startsWith("alert:")
    ? `🔎 Alerta de la plataforma para revisar. ${w.text}`
    : w.key.startsWith("factory:")
      ? `🏭 Encargo de la Software Factory (${w.cause}). ${w.text}`
      : w.key.startsWith("handoff:")
        ? w.text
        // Turno programado desde el CLI (`api/internal/schedule-turn`): el encargo tal cual, como
        // si alguien lo mencionara a esa hora. Sin la cláusula del OK: se programa para que hable.
        : w.key.startsWith("sched:turn:")
          ? `⏰ Turno que programó ${w.cause} para esta hora en este hilo:\n\n${w.text}`
        : `⏰ Turno programado por la plataforma (${w.cause}). ${w.text}\nSi no hay nada nuevo que entregar, contesta exactamente: OK`;
  // Relevo entre agentes (`agent-handoff.server.ts`): llega con el pedido original del hilo y
  // sus adjuntos, porque el relevado corre en su memoria del room y ése pedido no lo vio.
  const handoff = w.key.startsWith("handoff:")
    ? await (await import("./agent-handoff.server")).handoffTurnInput(dest.parentId ?? null, w.cause, w.text)
    : null;

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

  // El turno de un despertador se REGISTRA igual que uno de chat (2026-10-01): sin fila en
  // gt_turns, un corte de infra lo dejaba como burbuja vacía para siempre — ni el barrido lo
  // cerraba, ni «Retomar» lo encontraba, ni la barra del pedido podía detenerlo.
  const turns = await import("./turns.server");
  const controller = new AbortController();
  const channelSlug = dest.channelId != null ? ((await db.getChannelById(dest.channelId).catch(() => null))?.slug ?? null) : null;
  let registeredId: number | null = null;
  const register = (mid: number) => {
    if (registeredId === mid) return;
    registeredId = mid;
    // Latencia del relevo: de vencido a disparado, y de disparado a la burbuja del agente.
    if (w.key.startsWith("factory:"))
      console.log(`[lat] ${w.key} vencido→disparo ${Math.round(firedAt / 1000) - w.dueAt}s · disparo→burbuja ${Date.now() - firedAt}ms`);
    // La clave del despertador viaja con el turno: si se adopta tras un reinicio, la fábrica
    // sigue reconociéndolo como su relevo (`afterFactoryTurn` lee la clave).
    void turns.setTurnDurable(mid, { wakeKey: w.key });
    turns.registerTurn({
      ns, messageId: mid, groupId: ref.groupId, invokerSub: ref.sub, controller,
      // Sin esto la barra de «Trabajando ahora» nunca se enteraba de los turnos de un
      // despertador (relevos de la fábrica, handoffs): corrían sin fila (MailMask #12, 5-oct).
      announce: (st) => publish({ t: "turn", ...st }),
      channelId: dest.channelId ?? null, parentId: dest.parentId ?? null, dmId: dest.dmId ?? null,
      dest: { ...dest, handle, name, avatar },
      publicChannel: false,
      agent: name, avatar,
      tarea: (handoff?.text ?? text).slice(0, 60),
      body: handoff?.text ?? text, slug: channelSlug ?? undefined, shellId: mid,
      attachments: [], handle, origin: w.origin || undefined,
    });
  };

  // Adopción tras un reinicio: la fila vuelve a `running` (con latido y la clave) ANTES del
  // primer frame. Si Teams se reinicia otra vez en ese hueco, el barrido la ve huérfana y encola
  // la siguiente adopción; antes quedaba `expired` y el turno se perdía (palmera-legal #9, 4-oct).
  if (ref.adopt) {
    // Tope: un turno que se corta una y otra vez no se encadena para siempre.
    if ((w.key.match(/:adopt/g) ?? []).length > 4) {
      const msg = "⚠️ Este turno se cortó demasiadas veces por reinicios. Menciona al agente para que retome.";
      await db.setMessageBody(ref.adopt.shellId, msg).catch(() => {});
      publish({ t: "message:body", id: ref.adopt.shellId, body: msg });
      return;
    }
    register(ref.adopt.shellId);
  }
  // El cuerpo se guarda mientras corre (como en chat): quien recarga a media obra ve lo que lleva
  // el rol, y un corte no deja la burbuja vacía. El paso actual va al estado del turno (tarjeta).
  const bf = await import("./body-flush.server");
  const flusher = bf.makeBodyFlusher();
  const { id, reply } = await runAgentTurn({
    signal: controller.signal,
    onShell: register,
    agent,
    handle,
    groupId: ref.groupId,
    sender: "Ghosty Studio",
    text: handoff?.text ?? text,
    parts: handoff?.parts,
    invokerSub: ref.sub,
    originOverride: w.origin || undefined,
    dest: { ...dest, handle, name, avatar },
    // Adopción: el turno sigue vivo en gs y su burbuja ya existe — se reusa y se rehace entera
    // con el backlog (no se crea otra).
    ...(ref.adopt ? { durableResume: ref.adopt.turnId } : {}),
    createShell: async () => {
      if (ref.adopt) {
        shellId = ref.adopt.shellId;
        // El backlog de gs se repite desde el frame 0 y lo reemplaza; mientras, no queda vacío.
        const wait = "_Retomando tras un reinicio…_";
        await db.setMessageBody(shellId, wait).catch(() => {});
        publish({ t: "message:body", id: shellId, body: wait });
        return shellId;
      }
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
    emitBody: (mid, body) => {
      publish({ t: "message:body", id: mid, body });
      flusher.offer(mid, body);
      const p = bf.stepOfBody(body);
      if (p) turns.setTurnStep(ns, mid, p);
    },
  }).finally(async () => {
    if (shellId != null) await flusher.flush(shellId).catch(() => {});
    if (registeredId != null) {
      const stopped = turns.turnState(ns, registeredId)?.state === "stopped";
      turns.finishTurn(ns, registeredId);
      // `finishTurn` no anuncia el fin (en chat lo hace `avisarFinDeTurno`); aquí el cuerpo ya
      // quedó guardado, así que se cierra la fila de la barra.
      if (!stopped) publish({ t: "turn", id: registeredId, state: "done", position: 1, startedAt: Date.now() });
    }
  });

  const finalBody = reply.trim();
  // Una línea por despertador: sin ella, un turno que no dejó burbuja es indistinguible de
  // uno que no corrió (costó una tarde con la revisión de alertas de #soporte).
  console.log(`[wake] ${w.key} agent=${agent ? handle : "∅"} id=${id} shell=${shellId} reply=${JSON.stringify(finalBody.slice(0, 120))}`);
  // Software Factory: si el rol terminó su turno SIN cerrar su paso, la corrida se quedaría
  // atorada en silencio (visto 2026-09-24: @build acabó y nunca llamó factory_build_done).
  if (w.key.startsWith("factory:")) {
    const { afterFactoryTurn } = await import("./apps/factory-runs.server");
    void afterFactoryTurn(w, ref, finalBody).catch(() => {});
  }
  // La cadena sigue: si el relevado menciona a otro agente (o le regresa el turno a quien lo
  // llamó), ése se despierta igual. El tope por hilo vive en `handoffFromReply`.
  let handoffNotice = "";
  if (handoff && dest.channelId != null) {
    const { handoffFromReply } = await import("./agent-handoff.server");
    const channel = await db.getChannelById(dest.channelId).catch(() => null);
    if (channel) {
      handoffNotice = await handoffFromReply({
        ns, channel, parentId: dest.parentId ?? null, topic: dest.topic ?? "general",
        fromHandle: handle, fromName: name, reply: finalBody, invokerSub: ref.sub, origin: w.origin,
      }).catch(() => "");
    }
  }
  // Un `OK` es "nada que entregar": no se deja burbuja. Igual que en gs.
  // «(sin respuesta)» es el relleno de `runAgentTurn` para un turno que no dijo nada: en un
  // despertador no se deja como burbuja (palmera-legal, 3-oct: un @check de 2 s quedó así en el
  // hilo). `afterFactoryTurn` ya recibió la respuesta tal cual y empuja al rol igual.
  // El crítico del plan (`-critic`) tampoco deja burbuja: su resultado ya lo dice la tarjeta del
  // plan (estado y sugerencias); su respuesta repetía lo mismo y decía «Aprobé» (MailMask #18, 8-oct).
  if (!finalBody || finalBody === "OK" || finalBody === "(sin respuesta)" || ref.groupId.endsWith("-critic")) {
    if (shellId != null) await db.deleteMessage(shellId).catch(() => {});
    return;
  }
  // Archivos y notas de voz entregados en el turno (```eb-file``` / ```eb-audio```): el
  // mismo tratamiento que un turno normal. Sin esto el video/mp3 que motivó el
  // despertador se quedaba sin tarjeta.
  const { attachDeliveryFences } = await import("./delivery-fences.server");
  const delivered = await attachDeliveryFences(id, finalBody, dest);
  // Un @persona en la respuesta le avisa (push/correo), como en un turno de chat. Los turnos de
  // despertador (estafeta de la fábrica, relevos, programados) no lo hacían: @build le pidió los
  // datos del equipo a Oswaldo y a su celular no llegó nada (palmera-legal, 4-oct).
  let gapNotice = "";
  if (dest.channelId != null) {
    const channel = await db.getChannelById(dest.channelId).catch(() => null);
    if (channel) {
      const { notificarMencionesDelAgente } = await import("./mentions.server");
      const app = agent?.backend?.kind === "fleet" ? { agentId: agent.backend.id, sessionId: ref.groupId } : undefined;
      gapNotice = await notificarMencionesDelAgente(ns, channel, finalBody, name, { app, parentId: dest.parentId ?? null }).catch(() => "");
    }
  }
  const body = [delivered?.body ?? finalBody, handoffNotice, gapNotice].filter(Boolean).join("\n\n");
  await db.setMessageBody(id, body);
  publish({ t: "message:body", id, body });
  if (delivered?.attached) publish({ t: "refresh", channelId: dest.channelId ?? null, parentId: dest.parentId ?? null, dmId: dest.dmId ?? null });
}
