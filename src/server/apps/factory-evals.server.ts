// Evals de la fábrica: el lado con I/O (ver factory-evals.ts para la rúbrica y el resumen).
//
// Un eval es un pedido más (`gt_factory_runs.kind = 'eval'`), con su hilo en el room del
// original, para que se pueda ver qué hizo el agente. Diferencias con un pedido real:
//  - nace en `building` con el plan YA firmado del original (no hay @plan ni firma);
//  - @build trabaja en `ghosty-eval/<id>`, que la plataforma crea en el commit BASE del PR
//    original (el repo como estaba antes del cambio), y NO abre PR;
//  - @check no revisa: es el juez. Recibe los dos diffs y califica con factory_eval_score;
//  - al calificar, la rama se borra y el pedido cierra en `done`. No cuenta en los números.
import { dbq } from "../../dbq.server";
import { evalBranch, type EvalConfig, type EvalResult, type EvalRow, EVAL_CRITERIA, configLabel, evalResultMarkdown } from "./factory-evals";
import type { Run } from "./factory-runs.server";

export type EvalMeta = {
  of: number;
  config: EvalConfig;
  base: string;
  originalPr: string;
  startedAt: number;
  buildDoneAt?: number;
  result?: EvalResult;
};

export async function evalMeta(runId: number): Promise<EvalMeta | null> {
  const rows = await dbq("SELECT kind, eval_json FROM gt_factory_runs WHERE id = ?", [runId]).catch(() => []);
  if (rows[0]?.kind !== "eval" || !rows[0]?.eval_json) return null;
  try {
    return JSON.parse(String(rows[0].eval_json)) as EvalMeta;
  } catch {
    return null;
  }
}

async function saveMeta(runId: number, meta: EvalMeta) {
  await dbq("UPDATE gt_factory_runs SET eval_json = ?, updated_at = unixepoch() WHERE id = ?", [JSON.stringify(meta), runId]);
}

/** Arranca un eval sobre un pedido mezclado. `sub` pone el GitHub (crear y borrar la rama). */
export async function startEval(opts: {
  sourceRunId: number;
  agent?: string | null;
  model?: string | null;
  sub: string;
  origin: string;
}): Promise<{ runId: number } | { error: string }> {
  const R = await import("./factory-runs.server");
  const src = await R.getRun(opts.sourceRunId);
  if (!src || src.status !== "done" || !src.prUrl || !src.repo) return { error: "sólo se evalúan pedidos mezclados, con su PR" };
  if (!opts.agent && !opts.model) return { error: "elige el agente o el modelo que quieres probar en @build" };
  const pr = R.parsePrUrl(src.prUrl);
  if (!pr) return { error: "el PR del pedido no es de GitHub" };
  const { githubApi, createEvalBranch } = await import("../connectors/github.server");
  const info = await githubApi(opts.sub, `/repos/${pr.repo}/pulls/${pr.number}`).catch(() => null);
  const base = info?.base?.sha ? String(info.base.sha) : null;
  if (!base) return { error: info?.error ? String(info.error) : "no pude leer el commit base del PR" };
  const plan = await R.getPlan(src.id, src.planVersion);
  if (!plan?.planMd) return { error: "el pedido no tiene plan firmado" };

  const config: EvalConfig = { role: "build", agent: opts.agent?.trim() || null, model: opts.model?.trim() || null };
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const who = (await resolvedAgents()).find((a) => a.handle === "check");
  const body =
    `🧪 **Eval del pedido #${src.id}:** «${src.title}»\n\n` +
    `- **Construye:** ${configLabel(config)}\n` +
    `- **Parte de:** el mismo plan firmado (v${src.planVersion}) y el commit base \`${base.slice(0, 7)}\` del PR original\n` +
    `- **Compara con:** ${src.prUrl}\n\n` +
    `_No abre PR: la rama se borra al calificar._`;
  const { id: rootId } = await db.postAgent(src.channelId, null, body, "msg", who?.handle ?? "check", who?.name ?? "check", "general", who?.avatar ?? "");
  const msg = await db.getMessage(rootId);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), src.channelId), { t: "message:new", msg });

  const meta: EvalMeta = { of: src.id, config, base, originalPr: src.prUrl, startedAt: Math.floor(Date.now() / 1000) };
  const rows = await dbq(
    `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, plan_version, repo, requested_by, approved_by, kind, eval_json)
     VALUES (?, ?, 'general', ?, 'building', 1, ?, ?, ?, 'eval', ?) RETURNING id`,
    [src.channelId, rootId, `Eval · ${src.title}`.slice(0, 120), src.repo, opts.sub, opts.sub, JSON.stringify(meta)],
  );
  const run = (await R.getRun(Number(rows[0].id)))!;
  const branch = evalBranch(run.id);
  await dbq("UPDATE gt_factory_runs SET branch = ? WHERE id = ?", [branch, run.id]);
  await dbq("INSERT INTO gt_factory_plans (run_id, version, plan_md, decision, decided_by) VALUES (?, 1, ?, 'approve', ?)", [run.id, plan.planMd, opts.sub]);
  // El agente/modelo del eval viaja como override del HILO: factoryTurnFor lo aplica a cada turno.
  await dbq(
    `INSERT INTO gt_factory_thread_overrides (channel_id, root_msg_id, overrides) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, root_msg_id) DO UPDATE SET overrides = excluded.overrides, updated_at = unixepoch()`,
    [
      src.channelId,
      rootId,
      JSON.stringify({ repo: src.repo, ...(config.model ? { models: { build: config.model } } : {}), ...(config.agent ? { agents: { build: config.agent } } : {}) }),
    ],
  );
  const made = await createEvalBranch(opts.sub, src.repo, branch, base);
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
      `- Trabaja SÓLO en la rama \`${branch}\`, que ya existe y parte del commit base \`${base.slice(0, 7)}\` (no de la principal). No crees otra rama.\n` +
      `- NO abras PR. Empuja tus commits a esa rama con github_push_files / github_write_file.\n` +
      `- Corre pruebas, lint y typecheck como siempre.\n` +
      `Cierra con factory_build_done (runId ${run.id}, branch ${branch}, sin pr_url).\n\n## Plan firmado\n${plan.planMd}`,
    opts.origin,
  );
  return { runId: run.id };
}

/** @build cerró un eval: se guarda el tiempo y se despierta al juez con los dos diffs. */
export async function evalBuildDone(run: Run, meta: EvalMeta, sub: string, tests: string, origin: string): Promise<{ ok: true } | { error: string }> {
  const R = await import("./factory-runs.server");
  const branch = run.branch ?? evalBranch(run.id);
  const { compareDiff, prDiff } = await import("../connectors/github.server");
  const repo = run.repo!;
  const diff = await compareDiff(sub, repo, meta.base, branch);
  if (!diff || diff === "(sin cambios)") return { error: `la rama ${branch} no tiene cambios contra el commit base: empuja tu trabajo ahí antes de cerrar` };
  const orig = R.parsePrUrl(meta.originalPr);
  const origDiff = orig ? await prDiff(sub, orig.repo, orig.number) : null;
  const next = await R.applyEvent(run, "build_done", { ci_fails: 0 });
  await saveMeta(run.id, { ...meta, buildDoneAt: Math.floor(Date.now() / 1000) });
  const plan = await R.getPlan(run.id, 1);
  const rubric = Object.entries(EVAL_CRITERIA)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  await R.handoff(
    next,
    "check",
    sub,
    "calificar el eval",
    `🧪 Eres el JUEZ de un eval. No revisas para aprobar: calificas. Dos implementaciones del MISMO plan firmado, ` +
      `desde el mismo commit base: la A la escribió ${configLabel(meta.config)} (rama \`${branch}\`); la B es la que se mezcló de verdad (${meta.originalPr}).\n` +
      `Califica la A del 1 al 5 en cada criterio y di si es worse, same o better que la B. Puedes leer archivos completos con github_read_file (ref ${branch}). ` +
      `No edites nada. Resultado que reporta quien construyó: ${tests.slice(0, 400)}\n\n` +
      `## Rúbrica\n${rubric}\n\n## Plan firmado\n${plan?.planMd ?? "(sin plan)"}\n\n## A · ${configLabel(meta.config)}\n${diff}\n\n## B · el PR mezclado\n${origDiff ?? "(no pude leer su diff)"}\n\n` +
      `Cierra con factory_eval_score (runId ${run.id}).`,
    origin,
  );
  return { ok: true };
}

/** El juez calificó: se guarda, se borra la rama y el eval cierra. */
export async function evalScored(run: Run, meta: EvalMeta, result: EvalResult, sub: string): Promise<void> {
  const R = await import("./factory-runs.server");
  await saveMeta(run.id, { ...meta, result });
  const { deleteEvalBranch } = await import("../connectors/github.server");
  if (run.repo && run.branch) await deleteEvalBranch(sub, run.repo, run.branch).catch(() => false);
  const passed = await R.applyEvent(run, "check_pass").catch(() => null);
  if (passed) await R.applyEvent(passed, "close").catch(() => null);
  await R.postInThread(run, "check", evalResultMarkdown(meta.config, result));
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
      out.push({ config: m.config, result: m.result ?? null, buildSeconds: m.buildDoneAt ? m.buildDoneAt - m.startedAt : null });
    } catch {
      /* fila rota: no cuenta */
    }
  }
  return out;
}
