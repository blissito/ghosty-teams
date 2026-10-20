// PRs de Dependabot adoptados por la fábrica (10-oct). Antes caían como aviso suelto («PR #44
// abierto») sin revisión ni merge. Ahora cada uno es un pedido que entra DIRECTO a revisión: el
// «qué» ya lo dijo Dependabot, así que no hay plan ni firma. @check lee el changelog y el CI:
//   · patch/minor → si aprueba, el automerge del room lo mete en cuanto el CI pasa;
//   · major       → dice qué rompe y dónde, y espera a una persona (nunca entra solo).
// Si algo impide el merge no hay @build que lo arregle (Dependabot reescribe su rama): escala.
import { autoMergeable, bumpLevel, isDependabot, type BumpLevel } from "../../lib/dependabot";

type PrOpened = { repo: string; number: number; title: string; url: string; author: string | null };

/** `task_ref` del pedido: `dependabot:<nivel>`. Lo lee el automerge para no meter un major. */
export const dependabotRef = (level: BumpLevel) => `dependabot:${level}`;

export function dependabotLevelOf(taskRef: string | null | undefined): BumpLevel | null {
  const m = String(taskRef ?? "").match(/^dependabot:(major|minor|patch|unknown)$/);
  return m ? (m[1] as BumpLevel) : null;
}

/** El automerge del room no toca un PR de Dependabot que puede romper. */
export function blocksAutoMerge(taskRef: string | null | undefined): boolean {
  const level = dependabotLevelOf(taskRef);
  return level !== null && !autoMergeable(level);
}

const LEVEL_TEXT: Record<BumpLevel, string> = {
  major: "versión mayor: puede romper, espera a una persona",
  minor: "minor: entra solo si @check lo aprueba y el CI pasa",
  patch: "patch: entra solo si @check lo aprueba y el CI pasa",
  unknown: "no se sabe el salto de versión: espera a una persona",
};

/**
 * Pedidos de Dependabot vivos por repo. En easybits (20-oct) llegaron ocho de golpe por el webhook
 * (sin tope; sólo el barrido lo tenía) y cada uno despertó a @check y pidió su preview. Los demás
 * esperan: el barrido los adopta cuando se libera un lugar.
 */
export const DEPENDABOT_LIVE_CAP = 4;

/** ¿Cuántos pedidos de Dependabot siguen abiertos en este repo? */
export async function liveDependabotRuns(repo: string): Promise<number> {
  const { dbq } = await import("../../dbq.server");
  const [r] = await dbq(
    "SELECT COUNT(*) AS n FROM gt_factory_runs WHERE kind = 'dependabot' AND LOWER(repo) = LOWER(?) AND status NOT IN ('done','cancelled')",
    [repo],
  ).catch(() => [{ n: 0 }]);
  return Number(r?.n ?? 0);
}

/**
 * Crea el pedido de revisión para un PR de Dependabot recién abierto, en el room que recibe los
 * avisos del repo (el primero con la fábrica). Devuelve los rooms que ya quedaron cubiertos para
 * que no reciban también el aviso suelto. Nunca lanza.
 */
export async function adoptDependabotPr(ev: PrOpened, opts: { room?: number } = {}): Promise<number[]> {
  if (!isDependabot(ev.author)) return [];
  try {
    const { isInstalled } = await import("./installed.server");
    if (!(await isInstalled("factory").catch(() => false))) return [];
    const R = await import("./factory-runs.server");
    if ((await R.runsByPr(ev.repo, ev.number)).length) return [];
    const db = await import("../../db.server");
    const room = opts.room ?? (await db.notifyRoomsOfRepo(ev.repo))[0];
    if (!room) return [];
    // Tope de vivos por repo (también por el webhook): éste queda en cola para el barrido. El room
    // cuenta como cubierto para que no le llegue además el aviso suelto.
    if ((await liveDependabotRuns(ev.repo)) >= DEPENDABOT_LIVE_CAP) {
      console.log(`[dependabot] ${ev.repo}#${ev.number} en cola: ${DEPENDABOT_LIVE_CAP} pedidos de Dependabot vivos`);
      return [room];
    }
    // Con las credenciales de quien conectó el repo: es quien alcanza el PR en GitHub.
    const row = (await db.listRoomRepos(room)).find((r) => r.repo.toLowerCase() === ev.repo.toLowerCase());
    if (!row) return [];
    const sub = row.connectedBy;
    const level = bumpLevel(ev.title);

    const { dbq } = await import("../../dbq.server");
    const bus = await import("../bus.server");
    const { currentNamespace } = await import("../tenant.server");
    const ns = await currentNamespace();
    const { resolvedAgents } = await import("../../agents.server");
    const check = (await resolvedAgents()).find((a) => a.handle === "check");
    const rootBody = `📦 **Dependabot · ${ev.title}** · PR #${ev.number}\n${LEVEL_TEXT[level]}.`;
    const { id: rootId } = await db.postAgent(room, null, rootBody, "msg", "check", check?.name ?? "Check", "general", check?.avatar ?? "");
    const rootMsg = await db.getMessage(rootId);
    if (rootMsg) bus.publish(bus.ch.room(ns, room), { t: "message:new", msg: rootMsg });

    const head = await R.prHead(sub, ev.url).catch(() => null);
    const rows = await dbq(
      // `branch` = la cabeza del PR: si @build lo arregla, empuja AHÍ (el CI y la preview viven en ese PR).
      `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, approved_by, kind, task_ref, pr_url, head_sha, branch)
       VALUES (?, ?, 'general', ?, 'checking', ?, ?, ?, 'dependabot', ?, ?, ?, ?) RETURNING id`,
      [room, rootId, ev.title.slice(0, 200), ev.repo, sub, sub, dependabotRef(level), ev.url, head?.sha ?? null, head?.ref ?? null],
    );
    const run = (await R.getRun(Number(rows[0].id)))!;
    await R.logEvent(run.id, "adopted", "dependabot", { pr: ev.url, level });
    await R.ensureRunCard(run);
    await R.handoff(
      run,
      "check",
      sub,
      "revisar un PR de Dependabot",
      `Revisa el PR de Dependabot ${ev.url} («${ev.title}»). No hay plan: el cambio es subir dependencias. Salto: ${level}.\n` +
        `1. Lee el diff (github_pr_files) y el CI (github_pr_checks). Si el CI sigue corriendo, github_watch_pr y espera el aviso.\n` +
        `2. Lee las notas de la versión o el changelog que Dependabot pega en la descripción del PR. Busca cambios que rompen (breaking changes, APIs quitadas, versión mínima de Node) y dónde los usa el repo (github_search / github_read_file).\n` +
        (level === "patch" || level === "minor"
          ? `3. Con el CI en verde, el CI es tu evidencia: cita en proof los checks que pasaron, sin levantar caja. Sólo si el CI está rojo o el repo no tiene CI, corre en tu caja lo que te dé evidencia (install, typecheck, pruebas).\n`
          : // Un major rompe en EJECUCIÓN lo que el CI no ve: React Router 8 pasó lint, typecheck,
            // tests y build y tumbó toda acción en prod (#96 de Deník, 16-oct).
            `3. Es un salto ${level === "major" ? "mayor" : "sin versión clara"}: el CI no basta. Pide la preview con factory_preview (runId ${run.id}) y prueba AHÍ la acción principal de la app (un formulario que envíe datos, no sólo abrir páginas). ` +
            `Para cada cambio que rompe de las notas de la versión di cómo lo descartaste; los de red o seguridad (CSRF, CORS, cookies, proxy, TLS) sólo se descartan en la preview. Sin preview lista no puedes aprobar: si faltan variables para levantarla, pass=false con kind=env; si sólo sigue construyéndose, espera.\n`) +
        `Cierra con factory_check_verdict (runId ${run.id}):\n` +
        `- pass=true si se puede mergear: summary = qué cambia para el producto en 1 frase («nada visible: sólo parches de seguridad de X»); ` +
        (level === "patch" || level === "minor"
          ? `risk=low salvo que encuentres algo raro.\n`
          : `risk=high y en readFirst los archivos que usan lo que cambió, con por qué.\n`) +
        `- pass=false con blocked=true si algo impide el merge, con kind y reason (un renglón llano, ≤140, lo que lee la persona en su teléfono):\n` +
        `  · kind=fix si @build lo arregla en la rama de este PR (subir juntos los paquetes hermanos del grupo, un arreglo de tipos de una línea);\n` +
        `  · kind=skip si no conviene esta subida (p. ej. un major que el repo no puede adoptar hoy): la persona cierra el PR e ignora la versión;\n` +
        `  · kind=env si faltan variables o credenciales para probarlo (nómbralas);\n` +
        `  · kind=decision si una persona tiene que elegir entre caminos (di cuáles).\n` +
        `  Nunca escales porque el CI o la preview siguen en camino: se espera.\n` +
        `NO edites ni empujes nada.`,
      // Llega por el webhook (sin request de una persona): como `noteFromGithub`, sin origin.
      "",
      "",
      { skills: false },
    );
    void R.refreshRoom(room);
    return [room];
  } catch (e) {
    console.error(`[dependabot] no pude adoptar ${ev.repo}#${ev.number}`, e);
    return [];
  }
}

/**
 * Barrido (tick de la fábrica): los PRs de Dependabot abiertos sin pedido se adoptan. Cubre los
 * que ya estaban abiertos antes de la adopción automática y los avisos que GitHub no entregó.
 * Una vuelta por repo cada 30 min (y la siguiente sigue donde quedó el tope), con las credenciales de quien lo conectó. Nunca lanza.
 */
const lastSweep = new Map<string, number>();
export async function adoptOpenDependabotPrs(ns: string): Promise<void> {
  try {
    const { isInstalled } = await import("./installed.server");
    if (!(await isInstalled("factory").catch(() => false))) return;
    const { dbq } = await import("../../dbq.server");
    const rows = await dbq(
      `SELECT r.channel_id, r.repo, r.connected_by FROM gt_room_repos r JOIN gc_channels c ON c.id = r.channel_id
       WHERE r.notify = 1 AND COALESCE(c.archived, 0) = 0`,
      [],
    ).catch(() => []);
    const { githubApi } = await import("../connectors/github.server");
    const R = await import("./factory-runs.server");
    for (const row of rows) {
      const repo = String(row.repo);
      const key = `${ns}:${repo.toLowerCase()}`;
      if (Date.now() - (lastSweep.get(key) ?? 0) < 30 * 60_000) continue;
      // Lleno: no se gasta la vuelta; en cuanto se libere un lugar, el siguiente tick adopta.
      let live = await liveDependabotRuns(repo);
      if (live >= DEPENDABOT_LIVE_CAP) continue;
      lastSweep.set(key, Date.now());
      const prs = (await githubApi(String(row.connected_by), `/repos/${repo}/pulls?state=open&per_page=50`).catch(() => null)) as any[] | null;
      if (!Array.isArray(prs)) continue;
      // Tope de 5 por repo y vuelta, y de DEPENDABOT_LIVE_CAP vivos: un repo con 20 PRs viejos no
      // despierta 20 @check de golpe.
      let adopted = 0;
      const room = Number(row.channel_id);
      for (const pr of prs) {
        if (adopted >= 5 || live >= DEPENDABOT_LIVE_CAP) break;
        if (pr?.draft || !isDependabot(pr?.user?.login)) continue;
        if ((await R.runsByPr(repo, Number(pr.number))).length) continue;
        await adoptDependabotPr(
          { repo, number: Number(pr.number), title: String(pr.title ?? ""), url: String(pr.html_url ?? ""), author: pr.user.login },
          { room },
        );
        adopted++;
        live++;
      }
    }
  } catch (e) {
    console.error("[dependabot] barrido", e);
  }
}
