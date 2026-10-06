// Evals de la fábrica: el lado con I/O (ver factory-evals.ts para la rúbrica y el resumen).
//
// Un eval es un pedido más (`gt_factory_runs.kind = 'eval'`), con su hilo en el room del
// original, para que se pueda ver qué hizo el agente. Vuelve a correr UN rol de un pedido ya
// mezclado con otro agente o modelo (override del HILO) y un juez lo califica contra lo que se
// hizo de verdad. Por rol:
//  - plan:  recibe el pedido original, entrega su plan (sin tarjeta ni firma) → juez vs el plan firmado.
//  - build: el plan firmado, en `ghosty-eval/<id>` creada en el commit BASE del PR, sin PR →
//           juez vs el PR mezclado; la rama se borra al calificar.
//  - check: revisa el PR original contra el plan firmado → juez vs la revisión humana y el
//           @check original. El juez es el @check POR DEFECTO (se quita el override antes).
// El juez es @eval si el espacio lo tiene (fijo, para comparar evals en el tiempo) y si no @check;
// califica con factory_eval_score. No cuenta en los números.
//
// Para que salga barato: el juez recibe TODO en su encargo (no explora), diffs recortados, no se
// repite un eval igual y build/check sólo sobre PRs chicos. El costo del juez también se mide.
import { dbq } from "../../dbq.server";
import { evalBranch, type EvalConfig, type EvalResult, type EvalRole, type EvalRow, configLabel, evalResultMarkdown, rubricText } from "./factory-evals";
import type { Run } from "./factory-runs.server";

export type EvalMeta = {
  of: number;
  config: EvalConfig;
  /** Commit base del PR original (sólo build). */
  base?: string;
  originalPr: string;
  startedAt: number;
  /** Cuándo el rol evaluado cerró su paso (antes `buildDoneAt`). */
  stepDoneAt?: number;
  buildDoneAt?: number;
  /** Lo que entregó el rol evaluado cuando no queda en GitHub (plan o veredicto). */
  output?: string;
  result?: EvalResult;
  costUsd?: number | null;
  models?: string[];
  /** Quién calificó y cuánto costó calificar (el juez se mide aparte del rol evaluado). */
  judge?: "eval" | "check";
  judgeCostUsd?: number | null;
};

export async function evalMeta(runId: number): Promise<EvalMeta | null> {
  const rows = await dbq("SELECT kind, eval_json FROM gt_factory_runs WHERE id = ?", [runId]).catch(() => []);
  if (rows[0]?.kind !== "eval" || !rows[0]?.eval_json) return null;
  try {
    const m = JSON.parse(String(rows[0].eval_json)) as EvalMeta;
    // Evals de antes del 28-sep: sólo build, con `buildDoneAt`.
    return { ...m, stepDoneAt: m.stepDoneAt ?? m.buildDoneAt };
  } catch {
    return null;
  }
}

async function saveMeta(runId: number, meta: EvalMeta) {
  await dbq("UPDATE gt_factory_runs SET eval_json = ?, updated_at = unixepoch() WHERE id = ?", [JSON.stringify(meta), runId]);
}

const now = () => Math.floor(Date.now() / 1000);

/** Diff por lado en el encargo del juez: suficiente para calificar y la mitad de tokens. */
const JUDGE_DIFF_CHARS = 15_000;
/** build/check sólo sobre PRs de este tamaño (additions + deletions): más grande sale caro y se parece poco a otros. */
export const EVAL_MAX_PR_LINES = 800;

/** Quién juzga: @eval si está activo; si no, @check. */
export async function judgeHandle(): Promise<"eval" | "check"> {
  const { resolvedAgents } = await import("../../agents.server");
  return (await resolvedAgents()).some((a) => a.handle === "eval") ? "eval" : "check";
}

/** ¿Ya hay un eval igual (mismo pedido, rol, agente y modelo) vivo o calificado? */
async function sameEval(sourceRunId: number, c: EvalConfig): Promise<number | null> {
  const rows = await dbq("SELECT id, eval_json FROM gt_factory_runs WHERE kind = 'eval' AND status != 'cancelled' ORDER BY id DESC LIMIT 300", []).catch(() => []);
  for (const r of rows) {
    try {
      const m = JSON.parse(String(r.eval_json)) as EvalMeta;
      if (m.of === sourceRunId && m.config.role === c.role && (m.config.agent ?? null) === (c.agent ?? null) && (m.config.model ?? null) === (c.model ?? null)) return Number(r.id);
    } catch {
      /* fila rota */
    }
  }
  return null;
}

/** Deja el eval en la etapa del juez sin pasar por la máquina de estados de un pedido real. */
async function toJudging(run: Run): Promise<Run> {
  await dbq("UPDATE gt_factory_runs SET status = 'checking', updated_at = unixepoch() WHERE id = ?", [run.id]);
  return { ...run, status: "checking" };
}

/** Arranca un eval sobre un pedido mezclado. `sub` pone el GitHub (y la llave de los turnos). */
export async function startEval(opts: {
  sourceRunId: number;
  role: EvalRole;
  agent?: string | null;
  model?: string | null;
  sub: string;
  origin: string;
}): Promise<{ runId: number } | { error: string }> {
  const R = await import("./factory-runs.server");
  const src = await R.getRun(opts.sourceRunId);
  if (!src || src.status !== "done" || !src.prUrl || !src.repo) return { error: "sólo se evalúan pedidos con merge, con su PR" };
  if (!opts.agent && !opts.model) return { error: `elige el agente o el modelo que quieres probar en @${opts.role}` };
  const pr = R.parsePrUrl(src.prUrl);
  if (!pr) return { error: "el PR del pedido no es de GitHub" };
  const cfg0: EvalConfig = { role: opts.role, agent: opts.agent?.trim() || null, model: opts.model?.trim() || null };
  const dup = await sameEval(src.id, cfg0);
  if (dup) return { error: `ya hay un eval igual (#${dup}) de este pedido: míralo en su hilo antes de gastar otro` };
  if (opts.role !== "plan") {
    const { githubApi } = await import("../connectors/github.server");
    const info = await githubApi(opts.sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null);
    const lines = Number(info?.additions ?? 0) + Number(info?.deletions ?? 0);
    if (lines > EVAL_MAX_PR_LINES)
      return { error: `el PR original cambia ${lines} líneas: los evals de @${opts.role} son para PRs de hasta ${EVAL_MAX_PR_LINES} (salen caros y se parecen poco a otros)` };
  }
  const plan = await R.getPlan(src.id, src.planVersion);
  if (!plan?.planMd) return { error: "el pedido no tiene plan firmado" };
  const db = await import("../../db.server");

  let base: string | undefined;
  if (opts.role === "build") {
    const { githubApi } = await import("../connectors/github.server");
    const info = await githubApi(opts.sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null);
    base = info?.base?.sha ? String(info.base.sha) : undefined;
    if (!base) return { error: info?.error ? String(info.error) : "no pude leer el commit base del PR" };
  }
  const ask = opts.role === "plan" ? ((await db.getMessage(src.rootMsgId).catch(() => null))?.body ?? src.title) : null;

  const config = cfg0;
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const judge = await judgeHandle();
  // Visto en vivo (eval #7): el @check evaluado se calificó a sí mismo 5/5 antes de que llegara el
  // juez. Evaluar a @check exige un juez con OTRO handle.
  if (opts.role === "check" && judge === "check")
    return { error: "para evaluar a @check primero elige un @eval en «Equipo del espacio»: si no, @check se calificaría a sí mismo" };
  const who = (await resolvedAgents()).find((a) => a.handle === judge);
  const from =
    opts.role === "plan"
      ? "el mismo pedido original, sin ver el plan firmado"
      : opts.role === "build"
        ? `el mismo plan firmado (v${src.planVersion}) y el commit base \`${base!.slice(0, 7)}\` del PR original`
        : `el PR original contra el plan firmado (v${src.planVersion})`;
  const against = opts.role === "plan" ? "el plan que se firmó" : opts.role === "build" ? src.prUrl : "la revisión humana y la del @check original";
  const body =
    `🧪 **Eval del pedido #${src.id}:** «${src.title}»\n\n` +
    `- **Prueba a:** ${configLabel(config)}\n` +
    `- **Parte de:** ${from}\n` +
    `- **Compara con:** ${against}\n` +
    `- **Juez:** @${judge}\n\n` +
    (opts.role === "build" ? `_No abre PR: la rama se borra al calificar._` : `_No toca el repo ni el pedido original._`);
  const { id: rootId } = await db.postAgent(src.channelId, null, body, "msg", who?.handle ?? "check", who?.name ?? "check", "general", who?.avatar ?? "");
  const msg = await db.getMessage(rootId);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), src.channelId), { t: "message:new", msg });

  const meta: EvalMeta = { of: src.id, config, base, originalPr: src.prUrl, startedAt: now(), judge };
  const status = opts.role === "plan" ? "planning" : opts.role === "build" ? "building" : "checking";
  const rows = await dbq(
    // Sin pr_url a propósito, también en el de @check: con él, el sondeo de PRs y el webhook lo
    // tratarían como el pedido original (cierre al merge, previews).
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, plan_version, repo, requested_by, approved_by, kind, eval_json)
     VALUES (?, ?, 'general', ?, ?, ?, ?, ?, ?, 'eval', ?) RETURNING id`,
    [
      src.channelId,
      rootId,
      `Eval · ${src.title}`.slice(0, 120),
      status,
      opts.role === "plan" ? 0 : 1,
      src.repo,
      opts.sub,
      opts.sub,
      JSON.stringify(meta),
    ],
  );
  const run = (await R.getRun(Number(rows[0].id)))!;
  if (opts.role !== "plan")
    await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md, decision, decided_by) VALUES (?, 1, ?, 'approve', ?)", [run.id, plan.planMd, opts.sub]);
  // El agente/modelo del eval viaja como override del HILO: factoryTurnFor lo aplica a cada turno.
  await setThreadOverrides(src.channelId, rootId, {
    repo: src.repo,
    ...(config.model ? { models: { [opts.role]: config.model } } : {}),
    ...(config.agent ? { agents: { [opts.role]: config.agent } } : {}),
  });
  const origin = opts.origin;

  if (opts.role === "plan") {
    await R.handoff(
      run,
      "plan",
      opts.sub,
      "eval",
      `🧪 Esto es un EVAL: planea este pedido como si fuera real (lee el repo, sólo lectura) y entrégalo con ` +
        `factory_plan_submit (runId ${run.id}). No hay firma: al entregarlo lo califica un juez.\n\n## El pedido\n${String(ask).slice(0, 4000)}`,
      origin,
    );
    return { runId: run.id };
  }

  if (opts.role === "check") {
    await R.handoff(
      run,
      "check",
      opts.sub,
      "eval",
      `🧪 Esto es un EVAL: revisa el PR ${src.prUrl} contra el plan firmado como si fuera un pedido real. ` +
        `El PR ya tiene merge: NO comentes en GitHub ni edites nada. Lee el diff con github_pr_files; puedes correr pruebas en tu caja. ` +
        `Cierra con factory_check_verdict (runId ${run.id}): pass y hallazgos concretos (archivo:línea).\n\n## Plan firmado\n${plan.planMd}`,
      origin,
    );
    return { runId: run.id };
  }

  const branch = evalBranch(run.id);
  await dbq("UPDATE gt_factory_runs SET branch = ? WHERE id = ?", [branch, run.id]);
  const { createEvalBranch } = await import("../connectors/github.server");
  const made = await createEvalBranch(opts.sub, src.repo, branch, base!);
  if ("error" in made) {
    await R.applyEvent({ ...run, branch }, "cancel").catch(() => {});
    await R.postInThread(run, "check", `⚠️ No pude crear la rama del eval: ${made.error}`);
    return { error: made.error };
  }
  await R.handoff(
    { ...run, branch },
    "build",
    opts.sub,
    "eval",
    `🧪 Esto es un EVAL: construye el plan firmado de abajo como si fuera un pedido real, pero:\n` +
      `- Trabaja SÓLO en la rama \`${branch}\`, que ya existe y parte del commit base \`${base!.slice(0, 7)}\` (no de la principal). No crees otra rama.\n` +
      `- NO abras PR. Empuja tus commits a esa rama con github_push_files / github_write_file.\n` +
      `- Corre pruebas, lint y typecheck como siempre.\n` +
      `Cierra con factory_build_done (runId ${run.id}, branch ${branch}, sin pr_url).\n\n## Plan firmado\n${plan.planMd}`,
    origin,
  );
  return { runId: run.id };
}

async function setThreadOverrides(channelId: number, rootId: number, ov: Record<string, unknown>) {
  await dbq(
    `INSERT INTO gt_factory_thread_overrides (channel_id, root_msg_id, overrides) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, root_msg_id) DO UPDATE SET overrides = excluded.overrides, updated_at = unixepoch()`,
    [channelId, rootId, JSON.stringify(ov)],
  );
}

const judgeHead = (meta: EvalMeta, what: string) =>
  `🧪 Eres el JUEZ de un eval. No revisas para aprobar: calificas. ${what}\n` +
  `Califica la A del 1 al 5 en cada criterio de la rúbrica y di si es worse, same o better que la B. No edites nada.\n` +
  `Todo lo que necesitas está en este encargo: NO corras comandos ni explores el repo; como mucho 2 lecturas con github_read_file para una duda concreta.\n\n` +
  `## Rúbrica (claves de scores)\n${rubricText(meta.config.role)}\n\n`;

/** @build cerró un eval: se guarda el tiempo y se despierta al juez con los dos diffs. */
export async function evalBuildDone(run: Run, meta: EvalMeta, sub: string, tests: string, origin: string): Promise<{ ok: true } | { error: string }> {
  const R = await import("./factory-runs.server");
  const branch = run.branch ?? evalBranch(run.id);
  const { compareDiff, prDiff } = await import("../connectors/github.server");
  const diff = await compareDiff(sub, run.repo!, meta.base!, branch, JUDGE_DIFF_CHARS);
  if (!diff || diff === "(sin cambios)") return { error: `la rama ${branch} no tiene cambios contra el commit base: empuja tu trabajo ahí antes de cerrar` };
  const orig = R.parsePrUrl(meta.originalPr);
  const origDiff = orig ? await prDiff(sub, orig.repo, orig.number, JUDGE_DIFF_CHARS) : null;
  const next = await R.applyEvent(run, "build_done", { ci_fails: 0 });
  await saveMeta(run.id, { ...meta, stepDoneAt: now() });
  const plan = await R.getPlan(run.id, 1);
  await R.handoff(
    next,
    await judgeHandle(),
    sub,
    "calificar el eval",
    judgeHead(
      meta,
      `Dos implementaciones del MISMO plan firmado, desde el mismo commit base: la A la escribió ${configLabel(meta.config)} (rama \`${branch}\`); ` +
        `la B es la que entró de verdad con merge (${meta.originalPr}). Puedes leer archivos completos con github_read_file (ref ${branch}). ` +
        `Resultado que reporta quien construyó: ${tests.slice(0, 400)}`,
    ) +
      `## Plan firmado\n${plan?.planMd ?? "(sin plan)"}\n\n## A · ${configLabel(meta.config)}\n${diff}\n\n## B · el PR con merge\n${origDiff ?? "(no pude leer su diff)"}\n\n` +
      `Cierra con factory_eval_score (runId ${run.id}).`,
    origin,
  );
  return { ok: true };
}

/** @plan entregó su plan en un eval: se guarda (sin tarjeta ni firma) y se despierta al juez. */
export async function evalPlanDone(run: Run, meta: EvalMeta, sub: string, planMd: string, origin: string): Promise<void> {
  const R = await import("./factory-runs.server");
  await saveMeta(run.id, { ...meta, stepDoneAt: now(), output: planMd.slice(0, 20000) });
  const judging = await toJudging(run);
  const src = await R.getRun(meta.of);
  const signed = src ? await R.getPlan(src.id, src.planVersion) : null;
  await R.handoff(
    judging,
    await judgeHandle(),
    sub,
    "calificar el eval",
    judgeHead(
      meta,
      `Dos planes para el MISMO pedido: la A la escribió ${configLabel(meta.config)}; la B es el plan que se firmó ` +
        `(v${src?.planVersion ?? "?"}: ${Math.max(0, (src?.planVersion ?? 1) - 1)} corrección(es) antes de firmarse; @check le regresó el PR ${src?.loops ?? 0} vez/veces).`,
    ) + `## A · ${configLabel(meta.config)}\n${planMd}\n\n## B · el plan firmado\n${signed?.planMd ?? "(no encontré el plan)"}\n\nCierra con factory_eval_score (runId ${run.id}).`,
    origin,
  );
}

/** El @check evaluado dio su veredicto: se guarda y se despierta al juez (el @check por defecto). */
export async function evalCheckDone(run: Run, meta: EvalMeta, sub: string, pass: boolean, findings: string, origin: string): Promise<void> {
  const R = await import("./factory-runs.server");
  const output = `${pass ? "✅ pasa" : "❌ no pasa"}\n${findings}`.slice(0, 8000);
  await saveMeta(run.id, { ...meta, stepDoneAt: now(), output });
  const src = await R.getRun(meta.of);
  // El juez de un eval de @check siempre es @eval (lo exige startEval).
  const judge = meta.judge ?? "eval";
  const pr = R.parsePrUrl(meta.originalPr);
  const { prDiff } = await import("../connectors/github.server");
  const diff = pr ? await prDiff(sub, pr.repo, pr.number, JUDGE_DIFF_CHARS) : null;
  const orig = await dbq("SELECT verdict_json, first_review_state, loops FROM gt_factory_runs WHERE id = ?", [meta.of]).catch(() => []);
  let origFindings = "";
  try {
    origFindings = orig[0]?.verdict_json ? String(JSON.parse(String(orig[0].verdict_json)).findings ?? "") : "";
  } catch {
    origFindings = "";
  }
  const human = orig[0]?.first_review_state ? String(orig[0].first_review_state) : "sin review (merge directo)";
  await R.handoff(
    run,
    judge,
    sub,
    "calificar el eval",
    judgeHead(
      meta,
      `Dos revisiones del MISMO PR (${meta.originalPr}) contra el mismo plan: la A la hizo ${configLabel(meta.config)}; la B es la del @check original. ` +
        `Lo que pasó de verdad: @check le regresó el PR a @build ${orig[0]?.loops ?? src?.loops ?? 0} vez/veces antes de aprobarlo, ` +
        `la primera revisión humana fue «${human}» y el PR tuvo merge.`,
    ) +
      `## El PR\n${diff ?? "(no pude leer su diff)"}\n\n## A · ${configLabel(meta.config)}\n${output}\n\n## B · el @check original (al aprobar)\n${origFindings || "(sin hallazgos guardados)"}\n\n` +
      `Cierra con factory_eval_score (runId ${run.id}).`,
    origin,
  );
}

/** Costo en gs de una conversación de este eval (sufijo de `agentGroupId`). null si gs no contesta o no hay turnos. */
async function groupCost(suffix: string): Promise<{ costUsd: number; models: string[] } | null> {
  try {
    const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
    const base = await nativeRuntimeBase();
    if (!base) return null;
    const { currentNamespace } = await import("../tenant.server");
    const body = JSON.stringify({ suffixes: [suffix] });
    const res = await fetch(`${base}/api/v2/usage/groups`, { method: "POST", headers: partnerHeaders(body, await currentNamespace()), body, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { groups?: Record<string, { costUsd: number; models: string[]; turns: number }> };
    const g = j.groups?.[suffix];
    return g && g.turns ? { costUsd: g.costUsd, models: g.models } : null;
  } catch {
    return null;
  }
}

/** La conversación del juez: @eval, o @check (en otra conversación si también es el evaluado). */
export const judgeSuffix = (runId: number, judge: "eval" | "check") => `-${judge}-factory-${runId}`;

/** El juez calificó: se guarda (con el costo del rol), se borra la rama si hay y el eval cierra. */
export async function evalScored(run: Run, meta: EvalMeta, result: EvalResult, sub: string, judge: "eval" | "check"): Promise<void> {
  const R = await import("./factory-runs.server");
  const cost = await groupCost(`-${meta.config.role}-factory-${run.id}`);
  await saveMeta(run.id, { ...meta, result, costUsd: cost?.costUsd ?? null, models: cost?.models ?? [], judge });
  if (meta.config.role === "build" && run.repo && run.branch) {
    const { deleteEvalBranch } = await import("../connectors/github.server");
    await deleteEvalBranch(sub, run.repo, run.branch).catch(() => false);
  }
  await dbq("UPDATE gt_factory_runs SET status = 'done', updated_at = unixepoch() WHERE id = ?", [run.id]);
  void R.refreshRoom(run.channelId);
  await R.postInThread(run, judge, evalResultMarkdown(meta.config, result, cost?.costUsd ?? null, cost?.models));
  // El costo del JUEZ se sabe cuando su turno termina y el worker lo reporta: se pide después.
  const suffix = judgeSuffix(run.id, judge);
  // Fuera del request no hay tenant: sin `withNamespace` todo lo del timer fallaba en silencio
  // (así se quedó el #8 sin costo del juez).
  const { currentNamespace, withNamespace } = await import("../tenant.server");
  const ns = await currentNamespace();
  setTimeout(() => {
    void withNamespace(ns, async () => {
      const jc = await groupCost(suffix);
      const now = await evalMeta(run.id);
      if (jc && now) await saveMeta(run.id, { ...now, judgeCostUsd: jc.costUsd });
    }).catch(() => {});
  }, 120_000);
}

/** Evals de un room para la tabla de la página. */
export async function evalRows(channelId: number): Promise<EvalRow[]> {
  const rows = await dbq("SELECT eval_json FROM gt_factory_runs WHERE channel_id = ? AND kind = 'eval' AND status != 'cancelled' ORDER BY id DESC LIMIT 300", [
    channelId,
  ]).catch(() => []);
  const out: EvalRow[] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(String(r.eval_json)) as EvalMeta;
      const done = m.stepDoneAt ?? m.buildDoneAt;
      out.push({ config: m.config, result: m.result ?? null, seconds: done ? done - m.startedAt : null, costUsd: m.costUsd ?? null, judgeCostUsd: m.judgeCostUsd ?? null });
    } catch {
      /* fila rota: no cuenta */
    }
  }
  return out;
}
