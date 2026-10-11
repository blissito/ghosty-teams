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
 * Crea el pedido de revisión para un PR de Dependabot recién abierto, en el room que recibe los
 * avisos del repo (el primero con la fábrica). Devuelve los rooms que ya quedaron cubiertos para
 * que no reciban también el aviso suelto. Nunca lanza.
 */
export async function adoptDependabotPr(ev: PrOpened): Promise<number[]> {
  if (!isDependabot(ev.author)) return [];
  try {
    const { isInstalled } = await import("./installed.server");
    if (!(await isInstalled("factory").catch(() => false))) return [];
    const R = await import("./factory-runs.server");
    if ((await R.runsByPr(ev.repo, ev.number)).length) return [];
    const db = await import("../../db.server");
    const [room] = await db.notifyRoomsOfRepo(ev.repo);
    if (!room) return [];
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
      `INSERT INTO gt_factory_runs (channel_id, root_msg_id, topic, title, status, repo, requested_by, approved_by, kind, task_ref, pr_url, head_sha)
       VALUES (?, ?, 'general', ?, 'checking', ?, ?, ?, 'dependabot', ?, ?, ?) RETURNING id`,
      [room, rootId, ev.title.slice(0, 200), ev.repo, sub, sub, dependabotRef(level), ev.url, head?.sha ?? null],
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
        `3. Corre lo que te dé evidencia en tu caja (install, typecheck, pruebas) y repórtalo en proof.\n` +
        `Cierra con factory_check_verdict (runId ${run.id}):\n` +
        `- pass=true si se puede mergear: summary = qué cambia para el producto en 1 frase («nada visible: sólo parches de seguridad de X»); ` +
        (level === "patch" || level === "minor"
          ? `risk=low salvo que encuentres algo raro.\n`
          : `risk=high y en readFirst los archivos que usan lo que cambió, con por qué.\n`) +
        `- pass=false con blocked=true si algo impide el merge (rompe, CI rojo por la subida): explica qué y qué haría falta. No hay @build para esto: Dependabot reescribe su rama.\n` +
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
