// Sprints de la Fábrica Agéntica: una épica con 3–8 tickets ordenados, con dependencias.
//
// El patrón es el de la industria (Factory Missions, Jira Rovo, sub-issues de Copilot):
// la persona da un OBJETIVO → @plan propone un BORRADOR editable → se aprueba con UN clic →
// la plataforma ejecuta en orden. Aprobar el sprint ES aprobar el plan de cada ticket: nadie
// vuelve a firmar ticket por ticket; @check revisa cada PR y una persona hace merge de cada
// uno, como en cualquier pedido.
//
// Quien orquesta es la PLATAFORMA, no el modelo: un ticket arranca cuando todas sus
// dependencias ya tienen merge y no hay otro ticket del sprint construyéndose (uno a la
// vez: ramas en paralelo sobre el mismo repo chocan). Las dependencias viven aquí; en Tasks
// se ven como la etiqueta «bloqueado».
import { dbq } from "../../dbq.server";

export type SprintSize = "S" | "M" | "L";
export type SprintItemInput = {
  key: string;
  title: string;
  size: SprintSize;
  dependsOn: string[];
  bodyMd: string;
  /** Pedido que este ticket CONTINÚA (su PR ya existe): no se abre otro, se le encarga a ése. */
  runId?: number | null;
  /** Issue de GitHub que este ticket resuelve: su PR lleva `Closes #N`. */
  issueNumber?: number | null;
};
export type ItemStatus = "pending" | "active" | "pr" | "merged" | "failed" | "skipped";

export const MIN_ITEMS = 3;
export const MAX_ITEMS = 8;

/** Normaliza y valida lo que manda @plan. string = por qué no. */
export function validateSprintItems(raw: unknown): SprintItemInput[] | string {
  if (!Array.isArray(raw)) return "items tiene que ser una lista";
  if (raw.length < MIN_ITEMS || raw.length > MAX_ITEMS) return `un sprint lleva de ${MIN_ITEMS} a ${MAX_ITEMS} tickets (mandaste ${raw.length}); parte lo grande o júntalo`;
  const out: SprintItemInput[] = [];
  const keys = new Set<string>();
  for (const it of raw as Record<string, unknown>[]) {
    const key = String(it?.key ?? "").trim();
    const title = String(it?.title ?? "").trim().slice(0, 120);
    const size = String(it?.size ?? "").trim().toUpperCase();
    const criteria = String(it?.criteria ?? "").trim();
    const brief = String(it?.brief ?? "").trim();
    const files = Array.isArray(it?.files) ? (it.files as unknown[]).map(String).filter(Boolean).slice(0, 20) : [];
    if (!key) return "cada ticket lleva `key` (p. ej. A, B, C)";
    if (keys.has(key)) return `la key «${key}» está repetida`;
    keys.add(key);
    if (!title) return `el ticket ${key} no tiene título`;
    if (!["S", "M", "L"].includes(size)) return `el ticket ${key}: size va como S, M o L (≤ ~3 h de agente)`;
    if (!criteria) return `el ticket ${key} necesita criterios de aceptación verificables`;
    // Un sprint de PRUEBA (títulos «t», criterios «g») creaba una tarjeta basura en el room:
    // @plan probaba el esquema mandando datos de relleno (MailMask, 2026-10-01). Mismo criterio
    // que `planRejection`: se rechaza sin crear nada.
    if (title.length < 6 || criteria.length < 15)
      return `el ticket ${key} parece de prueba (título o criterios demasiado cortos). No pruebes la tool: mándala UNA vez con el sprint real`;
    // Un ticket sin PR («Decisión: dominio y hosting», «no lleva PR») se iba a @build, que no
    // puede decidir por la persona, y trababa la fila del sprint (palmera-legal, 3-oct).
    if (/^decisi[oó]n\b/i.test(title) || /\b(no lleva|sin) PR\b/i.test(criteria))
      return `el ticket ${key} no termina en un PR: es una decisión de la persona. Quítalo del sprint y pregúntalo en el hilo`;
    const dependsOn = Array.isArray(it?.depends_on) ? [...new Set((it.depends_on as unknown[]).map((d) => String(d).trim()).filter(Boolean))] : [];
    const bodyMd =
      `# ${title}\n\n` +
      (brief ? `## Qué y cómo\n${brief}\n\n` : "") +
      `## Criterios de aceptación\n${criteria}\n` +
      (files.length ? `\n## Archivos principales\n${files.map((f) => `- \`${f}\``).join("\n")}\n` : "");
    const issue = Number(it?.issue);
    out.push({ key, title, size: size as SprintSize, dependsOn, bodyMd, issueNumber: Number.isInteger(issue) && issue > 0 ? issue : null });
  }
  for (const it of out) {
    for (const d of it.dependsOn) {
      if (d === it.key) return `el ticket ${it.key} no puede depender de sí mismo`;
      if (!keys.has(d)) return `el ticket ${it.key} depende de «${d}», que no existe`;
    }
  }
  const cycle = findCycle(out);
  if (cycle) return `dependencias en círculo: ${cycle.join(" → ")}`;
  return out;
}

/** Ciclo en el grafo de dependencias, o null. */
export function findCycle(items: { key: string; dependsOn: string[] }[]): string[] | null {
  const deps = new Map(items.map((i) => [i.key, i.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 1);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const i of items) {
    const c = visit(i.key);
    if (c) return c;
  }
  return null;
}

/** Estado del ticket según su pedido. */
export function itemStatusOf(runStatus: string | null, current: ItemStatus): ItemStatus {
  if (current === "skipped") return "skipped";
  if (!runStatus) return current === "active" ? "pending" : current;
  if (runStatus === "done") return "merged";
  if (runStatus === "cancelled") return "failed";
  if (runStatus === "pr_review") return "pr";
  return "active";
}

type PlanItem = { key: string; included: boolean; status: ItemStatus; dependsOn: string[]; bodyMd?: string };

/** Los «Archivos principales» que @plan anotó en el ticket (van en `body_md`). */
export function ticketFiles(bodyMd: string | undefined): string[] {
  const m = /## Archivos principales\n([\s\S]*?)(?:\n## |$)/.exec(bodyMd ?? "");
  if (!m) return [];
  return [...m[1].matchAll(/^- `([^`]+)`/gm)].map((x) => x[1].trim().replace(/^\.\//, "")).filter(Boolean);
}

/** ¿Tocan lo mismo? Mismo archivo, o uno es carpeta (`src/app/`) del otro. */
function overlaps(a: string[], b: string[]): boolean {
  const hit = (x: string, y: string) => x === y || (x.endsWith("/") && y.startsWith(x)) || (y.endsWith("/") && x.startsWith(y));
  return a.some((x) => b.some((y) => hit(x, y)));
}

/**
 * El siguiente ticket que arranca, o null. Reglas: nada del sprint construyéndose
 * (`active`), ningún ticket fallido esperando decisión, y todas sus dependencias con merge
 * (o quitadas). Un ticket en `pr` (esperando a una persona) no bloquea a los que no
 * dependen de él.
 */
export function nextReady(items: PlanItem[]): PlanItem | null {
  const live = items.filter((i) => i.included);
  if (live.some((i) => i.status === "active" || i.status === "failed")) return null;
  const doneKeys = new Set(items.filter((i) => i.status === "merged" || i.status === "skipped" || !i.included).map((i) => i.key));
  // Un ticket que toca los MISMOS archivos que otro con PR abierto espera a que ése se mezcle:
  // construirlo ya garantiza choques al mezclar (palmera-legal, 3-oct: i18n y lint chocaron
  // en el layout y package.json). Toma el siguiente que no se cruce; si ninguno, espera.
  const inPr = live.filter((i) => i.status === "pr").map((i) => ticketFiles(i.bodyMd));
  return (
    live.find(
      (i) =>
        i.status === "pending" &&
        i.dependsOn.every((d) => doneKeys.has(d)) &&
        !inPr.some((files) => overlaps(ticketFiles(i.bodyMd), files)),
    ) ?? null
  );
}

// ── Persistencia ─────────────────────────────────────────────────────────────

export type SprintRow = {
  id: number;
  channelId: number;
  cardMsgId: number | null;
  /** Raíz del hilo de la tarjeta (la tarjeta misma, o el hilo donde se pidió). */
  rootMsgId: number | null;
  repo: string | null;
  goal: string;
  title: string;
  status: "draft" | "active" | "done" | "cancelled";
  version: number;
  createdBy: string;
  approvedBy: string | null;
  origin: string | null;
  goalRef: string | null;
};

export type SprintItemRow = {
  id: number;
  idx: number;
  key: string;
  title: string;
  size: SprintSize;
  dependsOn: string[];
  bodyMd: string;
  included: boolean;
  taskRef: string | null;
  runId: number | null;
  status: ItemStatus;
  issueNumber: number | null;
};

const toSprint = (r: Record<string, any>): SprintRow => ({
  id: Number(r.id),
  channelId: Number(r.channel_id),
  cardMsgId: r.card_msg_id != null ? Number(r.card_msg_id) : null,
  rootMsgId: r.root_msg_id != null ? Number(r.root_msg_id) : null,
  repo: r.repo ?? null,
  goal: String(r.goal),
  title: String(r.title),
  status: r.status,
  version: Number(r.version ?? 1),
  createdBy: String(r.created_by),
  approvedBy: r.approved_by ?? null,
  origin: r.origin ?? null,
  goalRef: r.goal_ref ?? null,
});

const toItem = (r: Record<string, any>): SprintItemRow => ({
  id: Number(r.id),
  idx: Number(r.idx),
  key: String(r.key),
  title: String(r.title),
  size: r.size,
  dependsOn: (() => {
    try {
      return JSON.parse(String(r.depends_on ?? "[]"));
    } catch {
      return [];
    }
  })(),
  bodyMd: String(r.body_md),
  included: Number(r.included) === 1,
  taskRef: r.task_ref ?? null,
  runId: r.run_id != null ? Number(r.run_id) : null,
  status: r.status,
  issueNumber: r.issue_number != null ? Number(r.issue_number) : null,
});

export async function getSprint(id: number): Promise<SprintRow | null> {
  const r = await dbq("SELECT * FROM gt_factory_sprints WHERE id = ?", [id]);
  return r[0] ? toSprint(r[0]) : null;
}

export async function getSprintItems(id: number): Promise<SprintItemRow[]> {
  return (await dbq("SELECT * FROM gt_factory_sprint_items WHERE sprint_id = ? ORDER BY idx", [id])).map(toItem);
}

async function insertItems(sprintId: number, items: SprintItemInput[]): Promise<void> {
  for (const [i, it] of items.entries()) {
    await dbq(
      "INSERT INTO gt_factory_sprint_items (sprint_id, idx, key, title, size, depends_on, body_md, run_id, issue_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [sprintId, i + 1, it.key, it.title, it.size, JSON.stringify(it.dependsOn), it.bodyMd, it.runId ?? null, it.issueNumber ?? null],
    );
  }
}

/**
 * Si el repo no está «Listo para agentes» (nivel < 2), el primer ticket es prepararlo —
 * como empieza Factory— y los tickets sin dependencias pasan a depender de él.
 */
export async function withPrepFirst(sub: string, repo: string | null, items: SprintItemInput[]): Promise<SprintItemInput[]> {
  if (!repo || items.some((i) => i.key === "prep")) return items;
  const { repoReadiness, preparationPlan } = await import("./readiness.server");
  const r = await repoReadiness(sub, repo).catch(() => null);
  if (!r || "error" in r || r.level >= 2) return items;
  const { planMd, fixes } = preparationPlan(r);
  if (!fixes.length) return items;
  const prep: SprintItemInput = { key: "prep", title: `Preparar ${repo.split("/")[1] ?? repo} para agentes`, size: "S", dependsOn: [], bodyMd: planMd };
  return [prep, ...items.map((i) => (i.dependsOn.length ? i : { ...i, dependsOn: ["prep"] }))];
}

/** Crea el borrador (o reemplaza el de un sprint en borrador) y publica/refresca su tarjeta. */
export async function submitSprint(opts: {
  sprintId?: number;
  channelId: number;
  repo: string | null;
  goal: string;
  title: string;
  items: SprintItemInput[];
  createdBy: string;
  /** Hilo donde se pidió: la tarjeta va AHÍ, no como mensaje suelto en el room. */
  parentId?: number | null;
  /** Sprint ACTIVO que éste reemplaza al aprobarse. */
  replaces?: number | null;
}): Promise<SprintRow> {
  const R = await import("./factory-runs.server");
  if (opts.sprintId) {
    const cur = await getSprint(opts.sprintId);
    if (!cur) throw new Error("no existe ese sprint");
    if (cur.status !== "draft") throw new Error("ese sprint ya se aprobó: propón uno nuevo");
    await dbq("DELETE FROM gt_factory_sprint_items WHERE sprint_id = ?", [cur.id]);
    await insertItems(cur.id, opts.items);
    await dbq("UPDATE gt_factory_sprints SET title = ?, goal = ?, replaces = ?, version = version + 1, updated_at = unixepoch() WHERE id = ?", [
      opts.title,
      opts.goal,
      opts.replaces ?? null,
      cur.id,
    ]);
    void R.refreshRoom(cur.channelId);
    return (await getSprint(cur.id))!;
  }
  const rows = await dbq(
    "INSERT INTO gt_factory_sprints (channel_id, repo, goal, title, created_by, replaces) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    [opts.channelId, opts.repo, opts.goal, opts.title, opts.createdBy, opts.replaces ?? null],
  );
  const id = Number(rows[0].id);
  await insertItems(id, opts.items);
  // La tarjeta: top-level en el room de la fábrica, con la cara de @plan. Su hilo es donde se
  // conversa el sprint (pedir cambios).
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  const body = "```gt-sprint\n" + JSON.stringify({ sprintId: id }) + "\n```\n🧩 Sprint propuesto: " + opts.title;
  // En el hilo donde se pidió (si lo hay): ahí se está conversando. Antes salía como mensaje
  // suelto arriba en el room y en el hilo no se veía nada (MailMask, 2026-10-01).
  const parentId = opts.parentId ?? null;
  const { id: msgId } = await db.postAgent(opts.channelId, parentId, body, "msg", "plan", plan?.name ?? "Plan", "general", plan?.avatar ?? "");
  await dbq("UPDATE gt_factory_sprints SET card_msg_id = ?, root_msg_id = ? WHERE id = ?", [msgId, parentId ?? msgId, id]);
  const msg = await db.getMessage(msgId);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), opts.channelId), { t: "message:new", msg });
  return (await getSprint(id))!;
}

/**
 * Aprobar: crea la épica y los tickets en el tablero de la fábrica (Tasks), marca el sprint
 * activo y arranca lo que ya se puede. Idempotente: un sprint ya activo no se re-crea.
 */
export async function approveSprint(id: number, sub: string, origin: string): Promise<SprintRow> {
  const claimed = await dbq(
    "UPDATE gt_factory_sprints SET status = 'active', approved_by = ?, origin = ?, updated_at = unixepoch() WHERE id = ? AND status = 'draft' RETURNING *",
    [sub, origin, id],
  );
  if (!claimed[0]) throw new Error("ese sprint ya no está en borrador");
  const items = (await getSprintItems(id)).filter((i) => i.included);
  if (!items.length) throw new Error("el sprint quedó sin tickets");
  // Reemplaza a un sprint activo: ése se cancela y lo que no arrancó se salta (si no, sus
  // tickets se abrían como PRs además de los del sprint nuevo).
  const replaces = claimed[0].replaces != null ? Number(claimed[0].replaces) : null;
  if (replaces && replaces !== id) {
    const old = await dbq("UPDATE gt_factory_sprints SET status = 'cancelled', updated_at = unixepoch() WHERE id = ? AND channel_id = ? AND status = 'active' RETURNING id", [replaces, claimed[0].channel_id]);
    if (old.length) await dbq("UPDATE gt_factory_sprint_items SET status = 'skipped' WHERE sprint_id = ? AND status = 'pending'", [replaces]);
  }
  // Tickets que continúan un pedido vivo: el alcance nuevo le llega a @build como nota, y si
  // su PR ya estaba listo se reabre en la misma rama.
  const R = await import("./factory-runs.server");
  const continued: string[] = [];
  for (const it of items) {
    if (!it.runId) continue;
    const run = await R.getRun(it.runId);
    if (!run || run.status === "done" || run.status === "cancelled") continue;
    const pr = /\/pull\/(\d+)/.exec(run.prUrl ?? "")?.[1];
    continued.push(`▶️ **El ticket ${it.idx} sigue en el pedido #${run.id}**${pr ? ` (PR #${pr})` : ""}: ${it.title} · [ver pedido](${await threadLink(run.channelId, run.rootMsgId)})`);
    await R.addNote(run.id, "@plan", `Nuevo alcance de este PR (sprint «${claimed[0].title}», ticket ${it.key}). Haz SÓLO esto; lo demás va en otros tickets:\n${it.bodyMd}`);
    if (run.status === "pr_review") await R.reopenWithNotes(run, "@plan", "", origin, { sprint: id, ticket: it.key });
    else await R.postInThread(run, "plan", `🧩 Este pedido ahora es el ticket ${it.key} del sprint «${claimed[0].title}»: @build recibe el alcance nuevo en su siguiente encargo.`);
  }
  // Visibilidad al lanzar: antes el hilo del sprint se quedaba callado hasta el confeti y cada
  // ticket abría su pedido en otro hilo (MailMask, 5-oct). Aquí se avisa cada paso.
  await announce(
    toSprint(claimed[0]),
    `🚀 **Sprint lanzado:** ${items.length} ${items.length === 1 ? "ticket" : "tickets"}, uno a la vez (en orden y según sus dependencias). Aquí aviso cuando arranca, queda listo para revisar o se mezcla cada uno.`,
  ).catch(() => {});
  // Un ticket que continúa un pedido no pasa por `startItem`: sin este renglón, el hilo del
  // sprint no enseñaba ni el pedido ni su PR (MailMask, ticket P → #24, 8-oct).
  for (const line of continued) await announce(toSprint(claimed[0]), line).catch(() => {});
  // El sprint vive en gt_factory_sprint_items: la tarjeta y /factory lo pintan de ahí (sin Tasks desde 30-sep).
  await advanceSprint(id);
  return (await getSprint(id))!;
}

/**
 * La persona pidió meter tickets pendientes del sprint en el PR de otro pedido («expande el PR
 * con lo que falta», MailMask 4-oct). Quedan atados a ese pedido: siguen su estado y no se
 * abren como PRs aparte. Devuelve los tickets que sí se absorbieron (con su cuerpo, para @build).
 */
export async function absorbItems(runId: number, keys: string[]): Promise<{ key: string; title: string; bodyMd: string }[]> {
  if (!keys.length) return [];
  const [own] = await dbq(
    "SELECT i.sprint_id FROM gt_factory_runs r JOIN gt_factory_sprint_items i ON i.id = r.sprint_item_id WHERE r.id = ?",
    [runId],
  ).catch(() => []);
  if (!own) return [];
  const got = await dbq(
    `UPDATE gt_factory_sprint_items SET run_id = ? WHERE sprint_id = ? AND status = 'pending' AND run_id IS NULL
     AND key IN (${keys.map(() => "?").join(",")}) RETURNING key, title, body_md`,
    [runId, own.sprint_id, ...keys],
  ).catch(() => []);
  if (got.length) await advanceSprint(Number(own.sprint_id)).catch(() => {});
  return got.map((r) => ({ key: String(r.key), title: String(r.title), bodyMd: String(r.body_md ?? "") }));
}

/** Relee el estado de cada ticket desde su pedido y arranca el siguiente si toca. */
export async function advanceSprint(id: number): Promise<void> {
  const sprint = await getSprint(id);
  if (!sprint || sprint.status !== "active") return;
  const R = await import("./factory-runs.server");
  const items = await getSprintItems(id);
  for (const it of items) {
    const run = it.runId ? await R.getRun(it.runId) : null;
    const st = itemStatusOf(run?.status ?? null, it.status);
    if (st !== it.status) {
      // Condicional: con dos ticks a la vez, sólo quien hace el cambio lo anuncia.
      const moved = await dbq("UPDATE gt_factory_sprint_items SET status = ? WHERE id = ? AND status = ? RETURNING id", [st, it.id, it.status]);
      it.status = st;
      if (moved.length && run && it.included) {
        const line = ticketLine(st, it, items.filter((i) => i.included).length, run.prUrl, await threadLink(run.channelId, run.rootMsgId));
        if (line) await announce(sprint, line).catch(() => {});
      }
    }
  }
  const live = items.filter((i) => i.included);
  if (live.length && live.every((i) => i.status === "merged" || i.status === "skipped")) {
    const done = await dbq("UPDATE gt_factory_sprints SET status = 'done', updated_at = unixepoch() WHERE id = ? AND status = 'active' RETURNING id", [id]);
    if (done.length) await announce(sprint, "```gt-fx\n" + JSON.stringify({ fx: "confetti" }) + "\n```\n🎉 **Sprint terminado:** " + sprint.title);
    void R.refreshRoom(sprint.channelId);
    return;
  }
  const next = nextReady(items);
  if (next) {
    const it = items.find((i) => i.key === next.key)!;
    // Claim: sólo quien lo mueve de pending a active lo arranca (dos ticks a la vez).
    const got = await dbq("UPDATE gt_factory_sprint_items SET status = 'active' WHERE id = ? AND status = 'pending' RETURNING id", [it.id]);
    if (got.length) await startItem(sprint, it, items).catch(async (e) => {
      console.error("[sprint] no pude arrancar el ticket", e);
      await dbq("UPDATE gt_factory_sprint_items SET status = 'pending' WHERE id = ?", [it.id]);
    });
  }
  void R.refreshRoom(sprint.channelId);
}

/** Publica en el hilo de la tarjeta del sprint. */
async function announce(sprint: SprintRow, body: string): Promise<void> {
  const parent = sprint.rootMsgId ?? sprint.cardMsgId;
  if (!parent) return;
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  const { id } = await db.postAgent(sprint.channelId, parent, body, "msg", "plan", plan?.name ?? "Plan", "general", plan?.avatar ?? "");
  const msg = await db.getMessage(id);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), sprint.channelId), { t: "message:new", msg });
}

/**
 * Arranca un ticket como pedido: raíz con la cara de @plan, plan v1 = el ticket, aprobado
 * de una vez por quien aprobó el sprint, y la estafeta de siempre a @build.
 */
async function startItem(sprint: SprintRow, it: SprintItemRow, all: SprintItemRow[]): Promise<void> {
  const R = await import("./factory-runs.server");
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const plan = (await resolvedAgents()).find((a) => a.handle === "plan");
  const approver = sprint.approvedBy ?? sprint.createdBy;
  const n = all.filter((i) => i.included).length;
  const rootBody = `🧩 **${sprint.title} · ticket ${it.idx} de ${n}:** ${it.title}`;
  const { id: rootId } = await db.postAgent(sprint.channelId, null, rootBody, "msg", "plan", plan?.name ?? "Plan", "general", plan?.avatar ?? "");
  const rootMsg = await db.getMessage(rootId);
  if (rootMsg) bus.publish(bus.ch.room(await currentNamespace(), sprint.channelId), { t: "message:new", msg: rootMsg });

  const rows = await dbq(
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, kind, task_ref, sprint_item_id, issue_number)
     VALUES (?, ?, 'general', ?, 'planning', ?, ?, 'sprint', ?, ?, ?) RETURNING id`,
    [sprint.channelId, rootId, it.title, sprint.repo, sprint.createdBy, it.taskRef, it.id, it.issueNumber],
  );
  let run = (await R.getRun(Number(rows[0].id)))!;
  await dbq("UPDATE gt_factory_sprint_items SET run_id = ? WHERE id = ?", [run.id, it.id]);
  run = await R.applyEvent(run, "plan_submitted", { plan_version: 1 });
  await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md) VALUES (?, 1, ?)", [run.id, it.bodyMd]);
  const msgId = await R.postInThread(run, "plan", R.planCardFence(run.id, 1));
  if (msgId) await dbq("UPDATE gt_factory_plans SET msg_id = ? WHERE run_id = ? AND version = 1", [msgId, run.id]);
  await R.ensureRunCard(run);
  await announce(sprint, `▶️ **Arrancó el ticket ${it.idx} de ${n}:** ${it.title} · [ver pedido](${await threadLink(sprint.channelId, rootId)})`).catch(() => {});
  const who = (await dbq("SELECT name FROM gc_users WHERE sub = ?", [approver]).catch(() => []))[0]?.name ?? "Quien aprobó el sprint";
  // El crítico del plan revisa el ticket antes de construir; al pasar se aprueba solo con quien
  // aprobó el sprint (`finishCritique`). Sin @check (o si no arranca), como antes: de una vez.
  const critic = await R.startCritique(run, 1, sprint.origin ?? "", { sub: approver, who: String(who) }).catch(() => false);
  if (!critic) await R.decide({ run, version: 1, decision: "approve", sub: approver, who: String(who), origin: sprint.origin ?? "" });
}

/** Del pedido al sprint: cualquier cambio de un pedido de sprint puede destrabar el siguiente. */
export async function onSprintRunChanged(runId: number): Promise<void> {
  // El sprint que lo creó y cualquiera con un ticket atado a él (ticket que continúa o absorbe su PR).
  const rows = await dbq(
    `SELECT i.sprint_id FROM gt_factory_runs r JOIN gt_factory_sprint_items i ON i.id = r.sprint_item_id WHERE r.id = ?
     UNION SELECT sprint_id FROM gt_factory_sprint_items WHERE run_id = ?`,
    [runId, runId],
  ).catch(() => []);
  for (const r of rows) await advanceSprint(Number(r.sprint_id));
}

/** Ticket fallido (PR cerrado sin merge): reintentarlo desde cero o quitarlo del sprint. */
export async function resolveFailedItem(sprintId: number, itemId: number, action: "retry" | "skip"): Promise<void> {
  const got = await dbq(
    `UPDATE gt_factory_sprint_items SET status = ?, run_id = CASE WHEN ? = 'retry' THEN NULL ELSE run_id END
     WHERE id = ? AND sprint_id = ? AND status = 'failed' RETURNING id`,
    [action === "retry" ? "pending" : "skipped", action, itemId, sprintId],
  );
  if (!got.length) throw new Error("ese ticket no está esperando decisión");
  await advanceSprint(sprintId);
}

/**
 * «Dejar como issue»: abre en GitHub el issue de un ticket (con su plan) y lo guarda en el ticket.
 * Si después se incluye y se construye, su PR lleva `Closes #N`. Idempotente.
 */
export async function createItemIssue(sprintId: number, itemId: number, sub: string): Promise<number> {
  const sprint = await getSprint(sprintId);
  if (!sprint?.repo) throw new Error("el sprint no tiene repo");
  const it = (await getSprintItems(sprintId)).find((i) => i.id === itemId);
  if (!it) throw new Error("no existe ese ticket");
  if (it.issueNumber) return it.issueNumber;
  const { allTools } = await import("../connectors/github.server");
  const tool = allTools().find((t) => t.name === "github_create_issue");
  if (!tool) throw new Error("GitHub no está conectado");
  const r = (await tool.handler(sub, {
    repo: sprint.repo,
    title: it.title,
    body: it.bodyMd.replace(/^# .*\n+/, "") + `\n\n---\nDel sprint #${sprint.id} de la fábrica: ${sprint.title}`,
  })) as { number?: number; error?: string } | null;
  const n = Number(r?.number);
  if (!Number.isInteger(n) || n <= 0) throw new Error(r?.error ? String(r.error) : "GitHub no abrió el issue");
  await dbq("UPDATE gt_factory_sprint_items SET issue_number = ? WHERE id = ? AND sprint_id = ?", [n, it.id, sprint.id]);
  return n;
}

/** Liga relativa al hilo de un pedido (para los avisos del sprint). */
async function threadLink(channelId: number, rootMsgId: number): Promise<string> {
  const db = await import("../../db.server");
  const ch = await db.getChannelById(channelId).catch(() => null);
  return ch ? `/c/${ch.slug}?thread=${rootMsgId}` : "";
}

/** El renglón que el hilo del sprint recibe cuando un ticket cambia de estado (null = no se avisa). */
export function ticketLine(st: ItemStatus, it: { idx: number; title: string }, n: number, prUrl: string | null, link: string): string | null {
  const head = `ticket ${it.idx} de ${n}`;
  const pedido = link ? ` · [ver pedido](${link})` : "";
  if (st === "pr") return `🔎 **Listo para revisar, ${head}:** ${it.title}${prUrl ? ` · [PR](${prUrl})` : ""}${pedido}`;
  if (st === "merged") return `✅ **Merge hecho, ${head}:** ${it.title}${pedido}`;
  if (st === "failed") return `⚠️ **Se canceló el ${head}:** ${it.title}. Decide en la tarjeta: «Reintentar» o «Quitar del sprint».${pedido}`;
  return null;
}
