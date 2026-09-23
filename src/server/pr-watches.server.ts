// ── Vigilar un PR: el agente se despierta en el MISMO hilo cuando CI termina o se mergea ──
//
// Es el flujo de «abre el PR, espera CI, márcalo listo, mergea» sin que el agente tenga que
// quedarse vivo esperando: `github_watch_pr` deja una fila aquí, este barrido le pregunta a
// GitHub cada 2 min, y cuando algo CAMBIA (checks que terminan, merge, cierre) encola un
// despertador en `gt_agent_wakeups`. Todo lo de abrir el turno en la conversación correcta
// ya lo hace `wakeups.server.ts`; aquí sólo se decide CUÁNDO.
//
// ¿Por qué polling y no el webhook de la App? El webhook llega a UN endpoint global y habría
// que rutearlo a tenant + conversación; con polling cada tenant pregunta por lo suyo con el
// token de quien pidió vigilar, que además es lo que respeta sus permisos de GitHub.
//
// Las filas caducan a las 24 h en silencio: un PR que lleva un día con CI colgado no es algo
// que el agente vaya a arreglar despertándose.
import crypto from "node:crypto";
import { dbq } from "../dbq.server";
import { withNamespace } from "./tenant.server";
import type { WatchMemory } from "./connectors/github-checks";

const TICK_MS = 120_000;
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
        await withNamespace(ns, () => sweepTenant());
      } catch {
        /* un tenant con la DB flapeando no deja sin vigilancia a los demás */
      }
    }
  } finally {
    running = false;
  }
}

async function sweepTenant(): Promise<void> {
  await dbq(
    `UPDATE gt_pr_watches SET done_at=unixepoch(), result='caducó' WHERE done_at IS NULL AND expires_at <= unixepoch()`,
  );
  const rows = await dbq(`SELECT * FROM gt_pr_watches WHERE done_at IS NULL ORDER BY created_at LIMIT 25`);
  if (!rows.length) return;
  const { prSnapshot } = await import("./connectors/github.server");
  const { prWatchVerdict } = await import("./connectors/github-checks");
  const { enqueueWakeup } = await import("./wakeups.server");
  for (const row of rows) {
    const id = String(row.id);
    const repo = String(row.repo);
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
