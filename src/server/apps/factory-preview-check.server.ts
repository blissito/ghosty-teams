// Publica el check «Ghosty · Preview» (regla en `factory-preview-check.ts`) en la cabeza del PR de
// un pedido. Lo llaman el tick de previews (cada commit nuevo y cada cambio de estado, smoke
// incluido), el veredicto de @check y `mergeRun` (antes de mezclar y en «Mezclar sin preview»).
// Nunca lanza: un GitHub caído no traba la fábrica; el siguiente tick lo vuelve a intentar.
import { dbq } from "../../dbq.server";
import { PREVIEW_CHECK_NAME, loosePrCheck, previewCheckFrom, type PreviewCheck } from "./factory-preview-check";

const warned = new Map<string, number>();
function warnOnce(key: string, msg: string): void {
  if (Date.now() - (warned.get(key) ?? 0) < 3_600_000) return;
  warned.set(key, Date.now());
  console.warn(`[factory] check de preview ${key}: ${msg}`);
}

async function tenantOrigin(): Promise<string | null> {
  const { currentSlug } = await import("../tenant.server");
  const slug = await currentSlug().catch(() => null);
  return slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : null;
}

async function publish(repo: string, sha: string, c: PreviewCheck, detailsUrl: string | null, externalId?: string): Promise<void> {
  const G = await import("../connectors/github.server");
  const r = await G.upsertCheckRun(repo, sha, { name: PREVIEW_CHECK_NAME, ...c, detailsUrl, externalId }).catch((e) => ({ error: String(e) }));
  if ("error" in r) warnOnce(repo, r.error);
}

/** Lo que manda en la cabeza del pedido; `headSha` evita volver a preguntarle a GitHub. */
export async function syncPreviewCheck(runId: number, opts: { headSha?: string | null } = {}): Promise<void> {
  try {
    const R = await import("./factory-runs.server");
    const run = await R.getRun(runId);
    if (!run?.prUrl || run.status === "done" || run.status === "cancelled") return;
    const pr = R.parsePrUrl(run.prUrl);
    if (!pr) return;
    const sub = run.approvedBy ?? run.requestedBy;
    const headSha = opts.headSha ?? (await R.prHead(sub, run.prUrl))?.sha;
    if (!headSha) return;
    const lastOf = async (type: string) => {
      const [e] = await dbq("SELECT actor, data_json FROM gt_factory_events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1", [run.id, type]).catch(() => []);
      let data: { sha?: string; fails?: string } = {};
      try {
        data = e?.data_json ? JSON.parse(String(e.data_json)) : {};
      } catch { /* bitácora ilegible: como si no hubiera */ }
      return e && data.sha === headSha ? { actor: e.actor ? String(e.actor) : null, data } : null;
    };
    const smoke = await lastOf("smoke_fail");
    const skip = await lastOf("merge_without_preview");
    let skippedBy: string | null = null;
    if (skip) {
      const [u] = skip.actor ? await dbq("SELECT name, handle FROM gc_users WHERE sub = ?", [skip.actor]).catch(() => []) : [];
      skippedBy = String(u?.name || (u?.handle ? `@${u.handle}` : "") || "una persona");
    }
    const [required, repoOff, preview] = await Promise.all([R.previewRequired(run), R.repoPreviewOff(pr.repo), R.runPreview(run.id)]);
    const [row] = await dbq("SELECT preview_url FROM gt_factory_runs WHERE id = ?", [run.id]).catch(() => []);
    const origin = await tenantOrigin();
    const db = await import("../../db.server");
    const ch = await db.getChannelById(run.channelId).catch(() => null);
    const threadUrl = origin && ch ? `${origin}/c/${ch.slug}?thread=${run.rootMsgId}&run=${run.id}` : null;
    const check = previewCheckFrom({
      required,
      repoOff,
      preview: { ...preview, url: preview.url ?? (row?.preview_url ? String(row.preview_url) : null) },
      headSha,
      smokeFail: smoke ? String(smoke.data.fails ?? "rechazó el POST") : null,
      skippedBy,
      runId: run.id,
      threadUrl,
      envUrl: origin ? `${origin}/factory?repo=${encodeURIComponent(pr.repo)}` : null,
    });
    await publish(pr.repo, headSha, check, threadUrl, `factory-run-${run.id}`);
  } catch (e) {
    warnOnce(`#${runId}`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * PR que no es de un pedido: el ruleset de la fábrica exige el check en todos los PRs de la rama,
 * así que se publica `neutral` (pasa) — sólo si de verdad lo exige, para no llenar de checks
 * repos que no lo piden. Lo llama el webhook (PR abierto y fin de CI).
 */
export async function syncLoosePrCheck(repo: string, number: number, sha?: string | null): Promise<void> {
  try {
    const G = await import("../connectors/github.server");
    const head = await G.prHeadAsApp(repo, number);
    if (!head || (sha && head.sha !== sha)) return;
    if (!(await G.branchRequiresCheck(repo, head.base, PREVIEW_CHECK_NAME))) return;
    await publish(repo, head.sha, loosePrCheck(), null);
  } catch (e) {
    warnOnce(`${repo}#${number}`, e instanceof Error ? e.message : String(e));
  }
}
