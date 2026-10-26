// ── Vigilar un PR: el agente se despierta en el MISMO hilo cuando CI termina o se mergea ──
//
// Es el flujo de «abre el PR, espera CI, márcalo listo, mergea» sin que el agente tenga que
// quedarse vivo esperando: `github_watch_pr` deja una fila aquí, este barrido le pregunta a
// GitHub cada 2 min, y cuando algo CAMBIA (checks que terminan, merge, cierre) encola un
// despertador en `gt_agent_wakeups`. Todo lo de abrir el turno en la conversación correcta
// ya lo hace `wakeups.server.ts`; aquí sólo se decide CUÁNDO.
//
// Desde el 26-oct el webhook de la App manda: gs reparte cada `RepoEvent` al Teams del espacio
// (`api.internal.github-event`) y `onRepoEvent` revisa YA las vigilancias de ese PR (CI terminado,
// push nuevo, merge, cierre). El sondeo queda de respaldo: cada 2 min para los repos de los que no
// llegan eventos (la App no está instalada ahí: sólo el token de la persona), y cada 10 min para
// los que sí. La lectura sigue siendo con el token de quien pidió vigilar (respeta sus permisos).
//
// Las filas caducan a las 24 h en silencio: un PR que lleva un día con CI colgado no es algo
// que el agente vaya a arreglar despertándose.
import crypto from "node:crypto";
import { dbq } from "../dbq.server";
import { withNamespace } from "./tenant.server";
import type { WatchMemory } from "./connectors/github-checks";

const TICK_MS = 120_000;
/** Respaldo para repos cuyos eventos sí llegan: el webhook ya avisa al instante. */
const BACKUP_POLL_MS = 10 * 60_000;
/** Cuánto vale «de este repo llegan eventos» después del último. */
const EVENTS_FRESH_MS = 30 * 60_000;
export const WATCH_TTL_S = 24 * 3600;

/**
 * Registra (o renueva) la vigilancia de un PR para una conversación. Una sola por PR y
 * conversación: pedirla dos veces no despierta dos veces.
 */
export async function upsertPrWatch(w: {
  repo: string;
  number: number;
  sub: string;
  groupId: string;
  ref: string;
  origin: string;
  memory: WatchMemory;
}): Promise<void> {
  const key = `${w.repo.toLowerCase()}#${w.number}@${w.groupId}`;
  await dbq(
    `INSERT INTO gt_pr_watches (id, key, repo, number, sub, ref, origin, last_sha, last_checks, green_since, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() + ?)
     ON CONFLICT(key) DO UPDATE SET ref=excluded.ref, origin=excluded.origin, sub=excluded.sub,
       last_sha=excluded.last_sha, last_checks=excluded.last_checks, green_since=excluded.green_since,
       expires_at=excluded.expires_at, done_at=NULL, result=NULL`,
    [
      crypto.randomUUID(), key, w.repo, w.number, w.sub, w.ref, w.origin,
      w.memory.sha, w.memory.checks, w.memory.greenSince, WATCH_TTL_S,
    ],
  );
}

// ── Eventos de GitHub ────────────────────────────────────────────────────────

type RepoEventLike = {
  event: string;
  action?: string;
  repo: string;
  pr?: { number: number };
  run?: { prNumbers?: number[] };
};

/** Lo que cambia la respuesta de una vigilancia. `numbers: null` = todos los PRs vigilados del repo. */
const WATCH_PR_ACTIONS = new Set(["synchronize", "closed", "reopened", "ready_for_review", "converted_to_draft", "edited"]);

/**
 * Qué vigilancias revisar por este evento, o null si no le toca a ninguna. Puro.
 * Un `workflow_run` sin PR ligado (forks, o el push que GitHub aún no asocia) revisa todo el repo.
 */
export function prWatchTargets(ev: RepoEventLike): { repo: string; numbers: number[] | null } | null {
  if (!ev?.repo) return null;
  if (ev.event === "workflow_run" && ev.action === "completed") {
    const n = (ev.run?.prNumbers ?? []).filter((x) => x > 0);
    return { repo: ev.repo, numbers: n.length ? n : null };
  }
  if (ev.event === "pull_request" && WATCH_PR_ACTIONS.has(ev.action ?? "") && ev.pr?.number) return { repo: ev.repo, numbers: [ev.pr.number] };
  return null;
}

/** Último evento por espacio+repo: con eventos frescos, el sondeo de ese repo se espacia. */
const lastEventAt = new Map<string, number>();
const repoKey = (ns: string, repo: string) => `${ns}|${repo.toLowerCase()}`;
/** Último sondeo por vigilancia (en memoria: tras reiniciar se sondea todo una vez, que es lo seguro). */
const lastPolledAt = new Map<string, number>();

/** ¿Le toca al sondeo de respaldo? Puro. */
export function duePoll(now: number, lastPolled: number | undefined, lastEvent: number | undefined): boolean {
  if (lastPolled == null) return true;
  const eventsFlow = lastEvent != null && now - lastEvent < EVENTS_FRESH_MS;
  return now - lastPolled >= (eventsFlow ? BACKUP_POLL_MS : TICK_MS - 5_000);
}

/**
 * Un `RepoEvent` llegó al Teams de este espacio (corre en su namespace): se marca que el repo
 * tiene eventos y se revisan ya las vigilancias que toca. Nunca lanza.
 */
export async function onRepoEvent(ns: string, ev: RepoEventLike): Promise<void> {
  if (!ev?.repo) return;
  lastEventAt.set(repoKey(ns, ev.repo), Date.now());
  const t = prWatchTargets(ev);
  if (!t) return;
  await sweepTenant(ns, { repo: t.repo, numbers: t.numbers }).catch(() => {});
}

// ── El tick ──────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function armPrWatches(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, TICK_MS);
  timer.unref?.();
}

let running = false;
async function sweep(): Promise<void> {
  // Una vuelta lenta (GitHub tardando) no puede traslapar con la siguiente: dos vueltas
  // verían la misma transición y encolarían dos despertadores con claves distintas.
  if (running) return;
  running = true;
  try {
    for (const ns of Array.from(tenants)) {
      try {
        await withNamespace(ns, () => sweepTenant(ns, { backup: true }));
      } catch {
        /* un tenant con la DB flapeando no deja sin vigilancia a los demás */
      }
    }
  } finally {
    running = false;
  }
}

/** El barrido de ESTE espacio ya (lo llama el fin del CI que avisa GitHub). El de cada 2 min sigue. */
export async function sweepPrWatchesNow(): Promise<void> {
  const { currentNamespace } = await import("./tenant.server");
  const ns = await currentNamespace().catch(() => "");
  await sweepTenant(ns).catch(() => {});
}

/** `repo`/`numbers`: sólo esas vigilancias (un evento). `backup`: el tick, que salta las ya frescas. */
async function sweepTenant(ns: string, only: { repo?: string; numbers?: number[] | null; backup?: boolean } = {}): Promise<void> {
  await dbq(
    `UPDATE gt_pr_watches SET done_at=unixepoch(), result='caducó' WHERE done_at IS NULL AND expires_at <= unixepoch()`,
  );
  const where = only.repo ? ` AND LOWER(repo) = LOWER(?)` + (only.numbers?.length ? ` AND number IN (${only.numbers.map(() => "?").join(",")})` : "") : "";
  const args = only.repo ? [only.repo, ...(only.numbers ?? [])] : [];
  const now = Date.now();
  const rows = (await dbq(`SELECT * FROM gt_pr_watches WHERE done_at IS NULL${where} ORDER BY created_at LIMIT 25`, args))
    .filter((r) => !only.backup || duePoll(now, lastPolledAt.get(String(r.id)), lastEventAt.get(repoKey(ns, String(r.repo)))));
  if (!rows.length) return;
  const { prSnapshot } = await import("./connectors/github.server");
  const { prWatchVerdict } = await import("./connectors/github-checks");
  const { enqueueWakeup } = await import("./wakeups.server");
  for (const row of rows) {
    const id = String(row.id);
    const repo = String(row.repo);
    lastPolledAt.set(id, Date.now());
    const number = Number(row.number);
    const snap = await prSnapshot(String(row.sub), repo, number).catch(() => null);
    // GitHub sin contestar (o token caído) → se reintenta en la siguiente vuelta. La TTL
    // se encarga de que un token revocado no deje la fila girando para siempre.
    if (!snap || "error" in snap) continue;
    const prev: WatchMemory = {
      sha: String(row.last_sha ?? ""),
      checks: (String(row.last_checks ?? "none") as WatchMemory["checks"]),
      greenSince: row.green_since == null ? null : Number(row.green_since),
    };
    const { notice, memory } = prWatchVerdict(`${repo}#${number}`, prev, snap, Math.floor(Date.now() / 1000));
    if (!notice) {
      await dbq(`UPDATE gt_pr_watches SET last_sha=?, last_checks=?, green_since=? WHERE id=?`, [
        memory.sha, memory.checks, memory.greenSince, id,
      ]);
      continue;
    }
    // CLAIM antes de encolar: la fila se cierra UNA vez aunque algo más la toque a la par.
    const claimed = await dbq(
      `UPDATE gt_pr_watches SET done_at=unixepoch(), result=? WHERE id=? AND done_at IS NULL RETURNING id`,
      [notice.slice(0, 500), id],
    );
    if (!claimed.length) continue;
    // PR de un pedido de la fábrica que ya terminó su parte (o cerró): la plataforma se
    // encarga (pregunta «¿lo mezclo?», cierra al mezclar). Despertar a @build o @check aquí
    // sólo deja un «ya está listo, OK» de ruido en el hilo.
    const factoryDone = await dbq(
      `SELECT id FROM gt_factory_runs WHERE status IN ('pr_review','done','cancelled') AND (pr_url = ? OR pr_url LIKE ?) LIMIT 1`,
      [`https://github.com/${repo}/pull/${number}`, `%/${repo}/pull/${number}`],
    ).catch(() => []);
    if (factoryDone.length) continue;
    const failedLinks = snap.checks.failed
      .filter((f) => f.url)
      .slice(0, 5)
      .map((f) => `${f.name}: ${f.url}`)
      .join("\n");
    await enqueueWakeup({
      key: `pr:${id}:${memory.sha}:${memory.checks}:${snap.merged ? "m" : snap.state}`,
      ref: String(row.ref),
      cause: "github",
      text:
        `[Aviso de GitHub] ${notice}` +
        (failedLinks ? `\n${failedLinks}` : "") +
        `\nSigue con lo que quedó pendiente en esta conversación sobre ese PR (lee el log si falló, ` +
        `márcalo listo, mergea o avisa), y cuéntalo en una o dos frases.`,
      origin: String(row.origin ?? ""),
    });
  }
}
