// Un aviso por repo cuando GitHub no arranca los jobs (1-nov, MailMask #154): 10 jobs rojos en
// 2–3 s por un cobro fallido. Antes cada pedido escalaba por su lado y la persona veía N tarjetas
// con la misma causa; ahora sale UN aviso en el room (máximo cada 24 h), se pausan las adopciones
// nuevas de Dependabot de ese repo y todo se reanuda solo cuando un check vuelve a correr de verdad.
import { dbq } from "../../dbq.server";
import { NOT_STARTED_MAX_S } from "./factory-ci-attribution";

const KIND = "ci_not_started";
const RENOTIFY_S = 24 * 3600;
const seen = new Map<string, number>();

type Check = { name?: string; state: string; seconds: number | null };

/** Pura: ¿qué dicen estos checks del repo? `down` = todo lo rojo duró ≤ 5 s; `up` = algo corrió de verdad. */
export function ciSignal(checks: Check[]): "down" | "up" | null {
  const red = checks.filter((c) => c.state === "failure");
  if (red.length && red.every((c) => c.seconds !== null && c.seconds <= NOT_STARTED_MAX_S)) return "down";
  if (checks.some((c) => ["success", "failure"].includes(c.state) && c.seconds !== null && c.seconds > NOT_STARTED_MAX_S)) return "up";
  return null;
}

/** Se llama con los checks que se leen de cualquier PR del repo. Barato: una vez por minuto por repo. Nunca lanza. */
export async function trackRepoCi(repo: string, checks: Check[]): Promise<void> {
  const key = repo.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (now - (seen.get(key) ?? 0) < 60) return;
  seen.set(key, now);
  const sig = ciSignal(checks);
  try {
    if (sig === "up") {
      await dbq("UPDATE gt_factory_repo_alerts SET cleared_at = unixepoch() WHERE repo = ? AND kind = ? AND cleared_at IS NULL", [key, KIND]);
      return;
    }
    if (sig !== "down") return;
    const [row] = await dbq("SELECT since, notified_at, cleared_at FROM gt_factory_repo_alerts WHERE repo = ? AND kind = ?", [key, KIND]);
    const open = row && row.cleared_at == null;
    if (open && row.notified_at != null && now - Number(row.notified_at) < RENOTIFY_S) return;
    await dbq(
      `INSERT INTO gt_factory_repo_alerts (repo, kind, since, notified_at, cleared_at) VALUES (?, ?, unixepoch(), unixepoch(), NULL)
       ON CONFLICT(repo, kind) DO UPDATE SET notified_at = unixepoch(),
         since = CASE WHEN cleared_at IS NULL THEN since ELSE unixepoch() END, cleared_at = NULL`,
      [key, KIND],
    );
    await postRepoAlert(repo);
  } catch (e) {
    console.error("[factory] aviso de repo", repo, e);
  }
}

/** ¿GitHub tiene parado el CI de este repo? (pausa las adopciones de Dependabot). */
export async function repoCiDown(repo: string): Promise<boolean> {
  const [row] = await dbq("SELECT 1 AS x FROM gt_factory_repo_alerts WHERE repo = ? AND kind = ? AND cleared_at IS NULL", [repo.toLowerCase(), KIND]).catch(() => []);
  return !!row;
}

async function postRepoAlert(repo: string): Promise<void> {
  const db = await import("../../db.server");
  const room = (await db.notifyRoomsOfRepo(repo))[0];
  if (!room) return;
  const bus = await import("../bus.server");
  const { currentNamespace } = await import("../tenant.server");
  const { resolvedAgents } = await import("../../agents.server");
  const check = (await resolvedAgents()).find((a) => a.handle === "check");
  const body =
    `⚠️ **GitHub no está arrancando los jobs de ${repo}**: todos salen rojos en segundos, antes de correr. ` +
    `Casi siempre es un cobro fallido o el límite de gasto de Actions: revísalo en GitHub → Settings → Billing. ` +
    `Mientras, no adopto PRs nuevos de Dependabot de este repo; todo sigue solo en cuanto el CI vuelva a correr.`;
  const { id } = await db.postAgent(room, null, body, "msg", "check", check?.name ?? "Check", "general", check?.avatar ?? "");
  const msg = await db.getMessage(id);
  if (msg) bus.publish(bus.ch.room(await currentNamespace(), room), { t: "message:new", msg });
}
