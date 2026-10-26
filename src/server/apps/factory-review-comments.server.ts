// Comentario en línea de una persona en el PR de un PEDIDO, sin @ghosty. Con @ghosty gs ya lo
// manda como `ask` (camino de `noteFromGithub` en api.internal.github-event); sin él sólo llegaba
// el `RepoEvent` a las automatizaciones, que se saltan los PRs de la fábrica, y el comentario se
// quedaba en GitHub sin que @build se enterara. Es la persona revisando el PR del pedido: le toca a
// @build, con el anti-bucle de review_autofix y sólo de quien tiene escritura en el repo.
import type { RepoEvent } from "../automations/types";
import type { Run } from "./factory-runs.server";

export type ReviewCommentDeps = {
  runsByPr(repo: string, pr: number): Promise<Run[]>;
  canWrite(repo: string, login: string): Promise<boolean>;
  note(run: Run, by: string, ask: { text: string; url: string; path?: string; line?: number; kind: "review_comment" }): Promise<string>;
};

const defaultDeps: ReviewCommentDeps = {
  async runsByPr(repo, pr) {
    return (await import("./factory-runs.server")).runsByPr(repo, pr);
  },
  async canWrite(repo, login) {
    return (await import("../connectors/github.server")).appUserCanWrite(repo, login);
  },
  async note(run, by, ask) {
    return (await import("./factory-runs.server")).noteFromGithub(run, by, ask);
  },
};

/** Lo que pasó con cada pedido de ese PR (vacío si no aplica). Nunca lanza. */
export async function routeFactoryReviewComment(ev: RepoEvent, deps: ReviewCommentDeps = defaultDeps): Promise<string[]> {
  try {
    const { factoryReviewCommentAsk } = await import("../automations/pr-review.server");
    const ask = factoryReviewCommentAsk(ev);
    if (!ask || !ev.pr) return [];
    const runs = (await deps.runsByPr(ev.repo, ev.pr.number)).filter((r) => r.status !== "done" && r.status !== "cancelled");
    if (!runs.length) return [];
    if (!(await deps.canWrite(ev.repo, ask.by))) return [];
    const { by, ...rest } = ask;
    const out: string[] = [];
    for (const run of runs) out.push(await deps.note(run, by, rest));
    return out;
  } catch (e) {
    console.warn("[factory] comentario de review sin @ghosty", e);
    return [];
  }
}
