// ── ci_doctor: cada workflow_run terminado → historial, flaky agrupado y diagnóstico de la rama principal ──
//
// Dos trabajos con el mismo evento:
//  1. Flaky. Se guarda cada intento en `gt_ci_runs`. Mismo `headSha`, un intento falló y uno
//     posterior pasó → flaky. Cuando un workflow junta `flakyThreshold` en `flakyWindowDays`, se
//     abre (o se actualiza) UN issue «[ghosty] Tests flaky: <workflow>» con las ligas a los runs.
//     Cuenta también los runs de PR: contar no es actuar.
//  2. Rojo en la rama principal (push, sin PR): @check lee los logs y comenta la causa probable.
//     No arregla código. Los rojos de PR son de `ci_fix`; aquí ni se tocan.
//
// Sólo metadatos de GitHub en la tabla: ni logs ni nada del código.
import { dbq } from "../../dbq.server";
import { withNamespace } from "../tenant.server";
import { appJwtOrNull, installationToken } from "../connectors/github-app.server";
import { ALERT_DIAGNOSIS } from "../apps/factory-roles";
import type { Automation, AutomationCtx, RepoEvent } from "./types";

export type CiDoctorSettings = {
  /** Flakies en la ventana para abrir el issue (default 3). */
  flakyThreshold?: number;
  /** Ventana en días (default 14). */
  flakyWindowDays?: number;
  /** Despertar a @check con los rojos de la rama principal (default sí). */
  diagnoseMain?: boolean;
  /** Ramas que cuentan como principal si GitHub no dice cuál es la default. */
  branches?: string[];
};

export type CiRunRow = {
  workflow: string;
  headSha: string;
  runId: number;
  attempt: number;
  conclusion: string;
  flaky?: boolean;
  url?: string | null;
  at?: number;
};

export type RunClass = "success" | "failure" | "flaky" | "ignore";

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const BOT_LOGIN = "ghosty-studio[bot]";

function isFailed(c: string | null | undefined): boolean {
  return !!c && FAILED.has(c);
}

/** ¿`a` ocurrió antes que `b`? Mismo run: por intento; runs distintos: por id (GitHub los da crecientes). */
function before(a: Pick<CiRunRow, "runId" | "attempt">, b: Pick<CiRunRow, "runId" | "attempt">): boolean {
  return a.runId === b.runId ? a.attempt < b.attempt : a.runId < b.runId;
}

/**
 * Clasifica un intento contra el historial del MISMO workflow y sha (el propio intento no va en
 * `history`). Flaky = pasó y antes hubo un intento rojo con el mismo sha; se cuenta una sola vez
 * por sha (si ya hay uno marcado flaky, el siguiente verde es sólo «success»).
 */
export function classifyRun(history: CiRunRow[], run: CiRunRow): RunClass {
  if (isFailed(run.conclusion)) return "failure";
  if (run.conclusion !== "success") return "ignore"; // cancelled, skipped, neutral, action_required…
  const same = history.filter((h) => h.workflow === run.workflow && h.headSha === run.headSha);
  if (same.some((h) => h.flaky)) return "success";
  return same.some((h) => isFailed(h.conclusion) && before(h, run)) ? "flaky" : "success";
}

export function flakyIssueTitle(workflow: string): string {
  return `[ghosty] Tests flaky: ${workflow}`;
}

/** Cuerpo del issue agrupado: la evidencia completa, el más reciente arriba. */
export function flakyIssueBody(repo: string, workflow: string, flakies: CiRunRow[], windowDays: number): string {
  const lines = flakies
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 30)
    .map((f) => {
      const when = f.at ? new Date(f.at * 1000).toISOString().slice(0, 10) : "";
      const url = f.url ?? `https://github.com/${repo}/actions/runs/${f.runId}`;
      return `- ${when} · \`${f.headSha.slice(0, 7)}\` · [run ${f.runId}](${url}) — falló y pasó en el intento ${f.attempt}`;
    });
  return [
    `El workflow **${workflow}** falló y luego pasó con el mismo commit ${flakies.length} vez/veces en los últimos ${windowDays} días.`,
    "",
    "Evidencia (cada liga es el intento que pasó; el rojo es el intento anterior del mismo run o commit):",
    ...lines,
    "",
    "_Lo abrió y lo mantiene la automatización «CI doctor» de Ghosty. Se actualiza solo; ciérralo cuando quede estable._",
  ].join("\n");
}

/** ¿Este rojo le toca al doctor? Sólo la rama principal, por push, sin PR y no causado por nuestro bot. */
export function shouldDiagnose(ev: RepoEvent, mainBranches: string[]): boolean {
  const r = ev.run;
  if (!r || !isFailed(r.conclusion)) return false;
  if ((r.prNumbers?.length ?? 0) > 0) return false; // de `ci_fix`
  if (r.event === "pull_request" || r.event === "pull_request_target") return false;
  if (!r.headBranch || !mainBranches.includes(r.headBranch)) return false;
  // Anti-bucle con nuestro bot; un rojo que dispara dependabot en main sí se diagnostica.
  if ((ev.sender?.login ?? "").toLowerCase() === BOT_LOGIN) return false;
  return true;
}

export function diagnosePrompt(ev: RepoEvent): string {
  const r = ev.run!;
  const sha = r.headSha ?? "";
  const url = r.url ?? `https://github.com/${ev.repo}/actions/runs/${r.id}`;
  return [
    `Automatización «CI doctor» (prendida en este room). El workflow «${r.name ?? "?"}» salió **${r.conclusion}** en \`${r.headBranch}\` (commit \`${sha.slice(0, 7)}\`, intento ${r.attempt ?? 1}): ${url}`,
    "",
    "Diagnostica, no arregles:",
    `1. Lee los logs del job que falló con \`github_workflow_run_logs\` (run ${r.id}) y el commit con \`github_get_commit\`.`,
    `2. Con el log, ${ALERT_DIAGNOSIS}: el cambio del commit, una dependencia/infra externa, o algo flaky (el mismo test falla y pasa sin cambios).`,
    `3. Busca con \`github_search\` (\`type: issue\`, abiertos) un issue que ya hable de este rojo. Si existe, comenta ahí con \`github_comment\`; si no y la causa es real, abre UNO con \`github_create_issue\` titulado «[ghosty] CI rojo en ${r.headBranch}: ${r.name ?? "workflow"}» con la causa, el paso que falló, el extracto mínimo del log y la liga al run.`,
    "",
    "Este turno NO es un pedido de la fábrica: no uses factory_plan_submit, factory_check_verdict ni factory_suggest.",
    "Tienes permiso para comentar y abrir ese issue sin pedir confirmación. Nunca empujes código, reintentes runs ni cierres nada. Al final, resume aquí en 2–3 renglones con las ligas.",
  ].join("\n");
}

// ── Token del bot para el issue agrupado (sin usuario de por medio) ──────────────────────

const API = "https://api.github.com";
const instIds = new Map<string, number>();

async function botApi(repo: string, path: string, init?: RequestInit): Promise<any> {
  const jwt = appJwtOrNull();
  if (!jwt) return { error: "sin GitHub App" };
  let inst = instIds.get(repo);
  if (!inst) {
    const r = await fetch(`${API}/repos/${repo}/installation`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (typeof r?.id !== "number") return { error: "la App no está instalada en el repo" };
    inst = r.id as number;
    instIds.set(repo, inst);
  }
  const token = await installationToken(inst, { onlyRepo: repo.split("/")[1] });
  if (!token) return { error: "sin token de instalación" };
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (res.ok) return res.status === 204 ? { ok: true } : await res.json().catch(() => ({}));
    return { error: `GitHub respondió ${res.status}` };
  } catch (e) {
    return { error: String(e) };
  }
}

const defaultBranches = new Map<string, string>();
async function mainBranchesOf(repo: string, s: CiDoctorSettings): Promise<string[]> {
  let d = defaultBranches.get(repo);
  if (!d) {
    const r = await botApi(repo, `/repos/${repo}`);
    if (typeof r?.default_branch === "string") {
      d = r.default_branch as string;
      defaultBranches.set(repo, d);
    }
  }
  return d ? [d] : (s.branches?.length ? s.branches : ["main", "master"]);
}

// ── Historial ────────────────────────────────────────────────────────────────

function rowOf(r: Record<string, unknown>): CiRunRow {
  return {
    workflow: String(r.workflow),
    headSha: String(r.head_sha),
    runId: Number(r.run_id),
    attempt: Number(r.attempt),
    conclusion: String(r.conclusion),
    flaky: Number(r.flaky) === 1,
    url: (r.url as string | null) ?? null,
    at: Number(r.at),
  };
}

/** Guarda el intento y devuelve su clase; `null` si ya estaba (reentrega del webhook). */
async function recordRun(repo: string, run: CiRunRow, branch: string | null): Promise<RunClass | null> {
  const rows = (await dbq(
    `SELECT workflow, head_sha, run_id, attempt, conclusion, flaky, url, at FROM gt_ci_runs
      WHERE repo=? AND workflow=? AND head_sha=?`,
    [repo, run.workflow, run.headSha],
  )).map(rowOf);
  if (rows.some((h) => h.runId === run.runId && h.attempt === run.attempt)) return null;
  const cls = classifyRun(rows, run);
  if (cls === "ignore") return cls;
  await dbq(
    `INSERT OR IGNORE INTO gt_ci_runs (repo, workflow, head_sha, run_id, attempt, conclusion, branch, url, flaky)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [repo, run.workflow, run.headSha, run.runId, run.attempt, run.conclusion, branch, run.url ?? null, cls === "flaky" ? 1 : 0],
  );
  return cls;
}

/** Abre o actualiza el issue agrupado. Devuelve el número si lo ABRIÓ (para avisar en el room). */
async function upsertFlakyIssue(repo: string, workflow: string, s: CiDoctorSettings): Promise<number | null> {
  const threshold = Math.max(1, Number(s.flakyThreshold ?? 3));
  const days = Math.max(1, Number(s.flakyWindowDays ?? 14));
  const stored = (await dbq(`SELECT number, created_at FROM gt_ci_flaky_issues WHERE repo=? AND workflow=?`, [repo, workflow]))[0];
  let number = stored ? Number(stored.number) : null;
  // Un issue cerrado por el equipo se respeta: sólo cuentan los flaky de después del cierre.
  let since = Math.floor(Date.now() / 1000) - days * 86400;
  if (number) {
    const cur = await botApi(repo, `/repos/${repo}/issues/${number}`);
    if (cur?.state === "closed") {
      const closedAt = Math.floor(Date.parse(String(cur.closed_at ?? "")) / 1000) || 0;
      since = Math.max(since, closedAt);
      number = null;
    } else if (cur?.error) {
      return null;
    }
  }
  const flakies = (await dbq(
    `SELECT workflow, head_sha, run_id, attempt, conclusion, flaky, url, at FROM gt_ci_runs
      WHERE repo=? AND workflow=? AND flaky=1 AND at>=? ORDER BY at DESC`,
    [repo, workflow, since],
  )).map(rowOf);
  if (!number && flakies.length < threshold) return null;
  const body = flakyIssueBody(repo, workflow, flakies, days);
  if (number) {
    await botApi(repo, `/repos/${repo}/issues/${number}`, { method: "PATCH", body: JSON.stringify({ body }) });
    return null;
  }
  // Sin fila (o se perdió): antes de abrir, buscar uno abierto con el mismo título.
  const title = flakyIssueTitle(workflow);
  const found = await botApi(repo, `/search/issues?per_page=5&q=${encodeURIComponent(`repo:${repo} is:issue is:open in:title "${title}"`)}`);
  const hit = Array.isArray(found?.items) ? found.items.find((i: any) => i?.title === title) : null;
  const r = hit
    ? await botApi(repo, `/repos/${repo}/issues/${hit.number}`, { method: "PATCH", body: JSON.stringify({ body }) })
    : await botApi(repo, `/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
  const n = Number(hit?.number ?? r?.number);
  if (!n) return null;
  await dbq(
    `INSERT INTO gt_ci_flaky_issues (repo, workflow, number) VALUES (?, ?, ?)
     ON CONFLICT(repo, workflow) DO UPDATE SET number=excluded.number, created_at=unixepoch()`,
    [repo, workflow, n],
  );
  return hit ? null : n;
}

async function watchedByPostMerge(repo: string, sha: string): Promise<boolean> {
  const rows = await dbq("SELECT 1 FROM gt_post_merge WHERE repo = ? AND merge_sha = ? LIMIT 1", [repo.toLowerCase(), sha]).catch(() => []);
  return rows.length > 0;
}

async function handle(ev: RepoEvent, ctx: AutomationCtx): Promise<void> {
  const r = ev.run;
  if (ev.event !== "workflow_run" || ev.action !== "completed" || !r?.id || !r.headSha) return;
  const workflow = r.name ?? "workflow";
  const run: CiRunRow = {
    workflow, headSha: r.headSha, runId: r.id, attempt: r.attempt ?? 1,
    conclusion: r.conclusion ?? "", url: r.url ?? null,
  };
  await withNamespace(ctx.ns, async () => {
    const s = (await ctx.settings<CiDoctorSettings>("ci_doctor")) ?? {};
    const cls = await recordRun(ev.repo, run, r.headBranch ?? null);
    if (!cls) return; // reentrega

    if (cls === "flaky") {
      // Candado corto: dos runs que cruzan el umbral a la vez no abren dos issues.
      if (await ctx.claim("ci_doctor", `flaky-issue:${ev.repo.toLowerCase()}:${workflow}`, 60_000)) {
        const opened = await upsertFlakyIssue(ev.repo, workflow, s);
        if (opened && (await ctx.budget("ci_doctor"))) {
          await ctx.wake({
            handle: "check",
            threadKey: `ci_doctor:flaky:${ev.repo.toLowerCase()}:${workflow}`,
            title: `Flaky: ${workflow}`,
            text: [
              `Automatización «CI doctor». Abrí https://github.com/${ev.repo}/issues/${opened} porque «${workflow}» falló y pasó con el mismo commit varias veces.`,
              "Revisa los logs de los intentos rojos (`github_workflow_run_logs`) y, si ves qué test o paso es el inestable, agrégalo al issue con `github_comment` (tienes permiso, sin pedir confirmación). No cambies código. Resume aquí en 2 renglones.",
            ].join("\n"),
          });
        }
      }
      return;
    }

    if (cls !== "failure" || s.diagnoseMain === false) return;
    if ((r.prNumbers?.length ?? 0) > 0) return; // no consultar GitHub por algo de `ci_fix`
    if (!shouldDiagnose(ev, await mainBranchesOf(ev.repo, s))) return;
    // El merge de un pedido de la fábrica ya lo vigila `post-merge.server.ts` (avisa en su hilo).
    if (await watchedByPostMerge(ev.repo, run.headSha)) return;
    if (!(await ctx.claim("ci_doctor", `${ev.repo.toLowerCase()}@${r.headSha}:${workflow}`, 7 * 24 * 3600_000))) return;
    if (!(await ctx.budget("ci_doctor"))) return;
    await ctx.wake({
      handle: "check",
      text: diagnosePrompt(ev),
      threadKey: `ci_doctor:${ev.repo.toLowerCase()}@${run.headSha.slice(0, 12)}:${workflow}`,
      title: `CI rojo: ${workflow} (${run.headSha.slice(0, 7)})`,
    });
  });
}

export const automations: Automation[] = [
  { kind: "ci_doctor", on: ["workflow_run.completed"], handle },
];
