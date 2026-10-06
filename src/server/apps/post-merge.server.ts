// Después del merge: confirmar que el PR llegó bien a producción (`gt_post_merge`).
//
// Patrón de las fábricas de Stripe y Ramp: se verifica en producción y se avisa SÓLO si algo
// falla; el éxito se marca sin ruido (✅ en el «PR #N mezclado» y un renglón en la bitácora del
// pedido). El webhook (`api.internal.github-event`) sólo ENCOLA; todo el trabajo de red corre
// aquí, en el tick de wakeups:
//   1. `merge_commit_sha` del PR.
//   2. Los runs de Actions de ese sha (`event=push`, rama por defecto). Mientras alguno corra,
//      se espera (tope 30 min). Uno en failure/cancelled → aviso en el hilo con la liga al log y
//      un `deploy_failed` en la bitácora del pedido (`onDeployFailed`).
//   3. Todo verde → smoke: GET al `homepage` del repo y a las URLs de uptime del room (15 s).
//      Falla un 5xx, un timeout o un 404 en `/`.
//   4. Sin workflows en ese sha (repo sin deploy por Actions): sólo la smoke, a los 3 min.
import { dbq } from "../../dbq.server";

const POLL_S = 30;
const NO_WORKFLOW_GRACE_S = 3 * 60;
const MAX_WAIT_S = 30 * 60;
const SMOKE_TIMEOUT_MS = 15_000;

export type WorkflowRun = { name: string; status: string; conclusion: string | null; html_url: string };

export type DeployVerdict =
  | { kind: "running" }
  | { kind: "timeout"; name: string; url: string }
  | { kind: "failed"; name: string; url: string; conclusion: string }
  | { kind: "green" }
  | { kind: "none" };

const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/**
 * Qué dicen los runs de Actions del sha mezclado, `elapsed` segundos después del merge. Un run
 * caído gana aunque otros sigan corriendo: el aviso no tiene por qué esperar. Sin runs se
 * espera la gracia de 3 min (Actions tarda unos segundos en registrarlos) y luego es `none`.
 */
export function deployVerdict(runs: WorkflowRun[], elapsed: number): DeployVerdict {
  const failed = runs.find((r) => r.status === "completed" && FAILED.has(String(r.conclusion)));
  if (failed) return { kind: "failed", name: failed.name, url: failed.html_url, conclusion: String(failed.conclusion) };
  const live = runs.find((r) => r.status !== "completed");
  if (live) return elapsed >= MAX_WAIT_S ? { kind: "timeout", name: live.name, url: live.html_url } : { kind: "running" };
  if (!runs.length) return elapsed >= NO_WORKFLOW_GRACE_S ? { kind: "none" } : { kind: "running" };
  return { kind: "green" };
}

export type SmokeOutcome = { status: number } | { error: string };

/** null = pasó; si no, el motivo corto para el aviso. 404 sólo cuenta en la raíz del sitio. */
export function smokeVerdict(url: string, outcome: SmokeOutcome): string | null {
  if ("error" in outcome) return outcome.error;
  if (outcome.status >= 500) return `HTTP ${outcome.status}`;
  let root = false;
  try {
    root = new URL(url).pathname === "/";
  } catch {
    /* URL rara: sin raíz que exigir */
  }
  if (outcome.status === 404 && root) return "HTTP 404";
  return null;
}

/** De quién son las credenciales de GitHub del repo en ese room. */
async function repoSub(channelId: number, repo: string): Promise<string | null> {
  const [row] = await dbq("SELECT connected_by FROM gt_room_repos WHERE channel_id = ? AND LOWER(repo) = LOWER(?)", [channelId, repo]).catch(() => []);
  return row?.connected_by ? String(row.connected_by) : null;
}

/** Encola la vigilancia de un PR mezclado en un room. Idempotente (un reintento del webhook no duplica). */
export async function enqueuePostMerge(opts: {
  channelId: number;
  parentId: number | null;
  noticeMsgId: number | null;
  repo: string;
  pr: number;
  fallbackSub?: string | null;
}): Promise<void> {
  const sub = (await repoSub(opts.channelId, opts.repo)) ?? opts.fallbackSub ?? null;
  if (!sub) return;
  await dbq(
    `INSERT OR IGNORE INTO gt_post_merge (channel_id, parent_id, repo, pr, sub, next_at, notice_msg_id)
     VALUES (?, ?, ?, ?, ?, unixepoch() + ?, ?)`,
    [opts.channelId, opts.parentId, opts.repo.toLowerCase(), opts.pr, sub, POLL_S, opts.noticeMsgId],
  );
}

type Row = {
  id: number;
  channelId: number;
  parentId: number | null;
  repo: string;
  pr: number;
  mergeSha: string | null;
  sub: string;
  startedAt: number;
  noticeMsgId: number | null;
};

/** Publica en el hilo con la cara de quien dio el aviso del merge (o @check si no se sabe). */
async function postThread(row: Row, body: string): Promise<void> {
  const db = await import("../../db.server");
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const notice = row.noticeMsgId ? await db.getMessage(row.noticeMsgId) : null;
  let who = notice?.agent_handle ? { handle: notice.agent_handle, name: notice.sender, avatar: notice.avatar } : null;
  if (!who) {
    const { resolvedAgents } = await import("../../agents.server");
    const agents = await resolvedAgents();
    const a = agents.find((x) => x.handle === "check") ?? agents[0];
    who = a ? { handle: a.handle, name: a.name, avatar: a.avatar } : { handle: "ghosty", name: "Ghosty", avatar: "" };
  }
  const { id } = await db.postAgent(row.channelId, row.parentId, body, "msg", who.handle, who.name, notice?.topic ?? "general", who.avatar);
  const msg = await db.getMessage(id);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), row.channelId), { t: "message:new", msg });
}

async function finish(row: Row, state: "ok" | "failed" | "timeout", result: string): Promise<void> {
  await dbq("UPDATE gt_post_merge SET state = ?, result = ? WHERE id = ?", [state, result.slice(0, 500), row.id]);
}

async function step(row: Row): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - row.startedAt;
  const later = (s: number) => dbq("UPDATE gt_post_merge SET next_at = ? WHERE id = ?", [now + s, row.id]);
  const { githubApi } = await import("../connectors/github.server");

  // Sin GitHub (sesión vencida, repo sin acceso) se reintenta hasta el tope y se suelta callado:
  // no hay nada que decirle al room que no sepa ya el conector.
  const repoInfo = await githubApi(row.sub, `/repos/${row.repo}`);
  if (repoInfo?.error) {
    if (elapsed >= MAX_WAIT_S) return finish(row, "timeout", `GitHub: ${repoInfo.error}`);
    return void (await later(60));
  }
  let sha = row.mergeSha;
  if (!sha) {
    const pr = await githubApi(row.sub, `/repos/${row.repo}/pulls/${row.pr}`);
    sha = typeof pr?.merge_commit_sha === "string" ? pr.merge_commit_sha : null;
    if (!sha) return elapsed >= MAX_WAIT_S ? finish(row, "timeout", "sin merge_commit_sha") : void (await later(60));
    await dbq("UPDATE gt_post_merge SET merge_sha = ? WHERE id = ?", [sha, row.id]);
  }
  const branch = encodeURIComponent(String(repoInfo?.default_branch ?? "main"));
  const actions = await githubApi(row.sub, `/repos/${row.repo}/actions/runs?head_sha=${sha}&event=push&branch=${branch}&per_page=50`);
  const runs: WorkflowRun[] = Array.isArray(actions?.workflow_runs) ? actions.workflow_runs : [];
  const verdict = deployVerdict(runs, elapsed);

  if (verdict.kind === "running") return void (await later(POLL_S));
  if (verdict.kind === "timeout") {
    await postThread(row, `⏳ El deploy de #${row.pr} sigue corriendo en «${verdict.name}» tras 30 min; dejo de vigilarlo · [ver run](${verdict.url})`);
    return finish(row, "timeout", verdict.name);
  }
  if (verdict.kind === "failed") {
    const R = await import("./factory-runs.server");
    await R.onDeployFailed(row.repo, row.pr, row.channelId, { sha, workflow: verdict.name, url: verdict.url, conclusion: verdict.conclusion }).catch(() => {});
    await postThread(row, `⚠️ El deploy de #${row.pr} falló en «${verdict.name}» · [ver log](${verdict.url})`);
    return finish(row, "failed", `${verdict.name}: ${verdict.conclusion}`);
  }

  // Verde (o sin workflows): smoke contra producción.
  const U = await import("./uptime.server");
  const homepage = await U.repoHomepage(row.sub, row.repo).catch(() => null);
  await U.ensureFirstMonitor(row.channelId, homepage, row.sub);
  const urls = Array.from(new Set([homepage, ...(await U.listUptimeChecks(row.channelId)).map((c) => c.url)].filter((u): u is string => !!u)));
  const { guardedGet } = await import("../connectors/net-guard.server");
  const fails: string[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const outcome: SmokeOutcome = await guardedGet(url, { timeoutMs: SMOKE_TIMEOUT_MS })
        .then((r) => ({ status: r.status }))
        .catch((e) => ({ error: e instanceof Error && e.name === "TimeoutError" ? "no contestó en 15 s" : e instanceof Error ? e.message : String(e) }));
      const why = smokeVerdict(url, outcome);
      if (why) fails.push(`${U.urlLabel(url)} (${why})`);
    }),
  );
  if (fails.length) {
    const deploy = verdict.kind === "green" ? "se desplegó" : "entró con merge";
    await postThread(row, `⚠️ #${row.pr} ${deploy}, pero producción no responde bien: ${fails.join(", ")}`);
    return finish(row, "failed", `smoke: ${fails.join(", ")}`);
  }

  // Todo bien: sin mensaje nuevo. ✅ en el aviso del merge y renglón en la bitácora del pedido.
  if (row.noticeMsgId) {
    const db = await import("../../db.server");
    const notice = await db.getMessage(row.noticeMsgId);
    const { currentNamespace } = await import("../tenant.server");
    const { agentReact } = await import("../agent-ack.server");
    if (notice) await agentReact(await currentNamespace(), notice.id, notice.agent_handle ?? "check", "✅");
  }
  const R = await import("./factory-runs.server");
  for (const run of await R.runsByPr(row.repo, row.pr)) {
    if (run.channelId === row.channelId) await R.logEvent(run.id, "deployed", null, { sha, urls, workflows: runs.map((r) => r.name) });
  }
  return finish(row, "ok", verdict.kind === "green" ? `${runs.length} workflow(s) verdes` : "sin workflows");
}

/** Lo llama el tick de wakeups. Un PR que truena no frena a los demás. */
export async function sweepPostMerge(): Promise<void> {
  const rows = await dbq(
    "SELECT * FROM gt_post_merge WHERE state = 'pending' AND next_at <= unixepoch() ORDER BY next_at LIMIT 10",
  ).catch(() => []);
  await Promise.allSettled(
    rows.map(async (r) => {
      const row: Row = {
        id: Number(r.id),
        channelId: Number(r.channel_id),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        repo: String(r.repo),
        pr: Number(r.pr),
        mergeSha: r.merge_sha ?? null,
        sub: String(r.sub),
        startedAt: Number(r.started_at),
        noticeMsgId: r.notice_msg_id == null ? null : Number(r.notice_msg_id),
      };
      try {
        await step(row);
      } catch (e) {
        console.error(`[post-merge] ${row.repo}#${row.pr}: ${e instanceof Error ? e.message : e}`);
        // Un error que se repite no se reintenta para siempre: pasado el tope, se suelta.
        const expired = Date.now() / 1000 - row.startedAt > MAX_WAIT_S + 10 * 60;
        await dbq(
          expired ? "UPDATE gt_post_merge SET state = 'timeout', result = ? WHERE id = ?" : "UPDATE gt_post_merge SET next_at = unixepoch() + 60, result = ? WHERE id = ?",
          [String(e instanceof Error ? e.message : e).slice(0, 500), row.id],
        ).catch(() => {});
      }
    }),
  );
}
