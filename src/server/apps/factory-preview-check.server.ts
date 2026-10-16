// El único punto que publica «Ghosty · Preview» (regla en `factory-preview-check.ts`). Lo llaman el
// tick de previews (cada commit y cada cambio, smoke incluido), el veredicto de @check, `mergeRun`,
// el webhook (fin de CI de un PR suelto) y «Proteger main» (PRs ya abiertos).
// Nunca lanza: un GitHub caído no traba la fábrica; el siguiente tick lo reintenta.
import { dbq } from "../../dbq.server";
import { PREVIEW_CHECK_NAME, previewCheckFrom } from "./factory-preview-check";

const warned = new Map<string, number>();

export async function syncPrCheck(repo: string, number: number, sha: string): Promise<void> {
  try {
    const R = await import("./factory-runs.server");
    const run = (await R.runsByPr(repo, number)).find((r) => r.status !== "done" && r.status !== "cancelled") ?? null;
    // PR suelto: sólo en repos de la fábrica, para no llenar de checks repos que no lo exigen.
    if (!run && !(await dbq("SELECT 1 FROM gt_factory_runs WHERE LOWER(repo) = ? LIMIT 1", [repo.toLowerCase()]).catch(() => [])).length) return;
    let input: Parameters<typeof previewCheckFrom>[0] = null;
    if (run) {
      const skip = await R.lastEventAt(run.id, "merge_without_preview", sha);
      const [u] = skip?.actor ? await dbq("SELECT name, handle FROM gc_users WHERE sub = ?", [skip.actor]).catch(() => []) : [];
      const { currentSlug } = await import("../tenant.server");
      const slug = await currentSlug().catch(() => null);
      const origin = slug ? `https://${slug}.${process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio"}` : null;
      const ch = await (await import("../../db.server")).getChannelById(run.channelId).catch(() => null);
      const [preview, row] = await Promise.all([R.runPreview(run.id), dbq("SELECT preview_url FROM gt_factory_runs WHERE id = ?", [run.id]).then((r) => r[0]).catch(() => null)]);
      input = {
        id: run.id,
        required: await R.previewRequired(run),
        repoOff: await R.repoPreviewOff(repo),
        preview: { ...preview, url: row?.preview_url ? String(row.preview_url) : null },
        headSha: sha,
        smokeFail: (await R.lastEventAt(run.id, "smoke_fail", sha))?.data.fails ?? null,
        skippedBy: skip ? String(u?.name || (u?.handle ? `@${u.handle}` : "") || "una persona") : null,
        threadUrl: origin && ch ? `${origin}/c/${ch.slug}?thread=${run.rootMsgId}&run=${run.id}` : null,
        envUrl: origin ? `${origin}/factory?repo=${encodeURIComponent(repo)}` : null,
      };
    }
    const c = previewCheckFrom(input);
    const G = await import("../connectors/github.server");
    const r = await G.upsertCheckRun(repo, sha, { name: PREVIEW_CHECK_NAME, ...c, detailsUrl: input?.threadUrl ?? null });
    if ("error" in r) throw new Error(r.error);
  } catch (e) {
    if (Date.now() - (warned.get(repo) ?? 0) < 3_600_000) return;
    warned.set(repo, Date.now());
    console.warn(`[factory] check de preview ${repo}#${number}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
