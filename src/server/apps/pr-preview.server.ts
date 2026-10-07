// «Levantar preview» a pedido para un PR SIN pedido de la fábrica (dependabot, personas).
//
// Decisión de bliss (7-oct): el PR de un pedido tiene su preview automática dentro de la caja
// del pedido; los demás NO la tienen sola, pero su tarjeta ofrece el botón. Construye en una
// caja aparte con el flujo de gs `internal/workspace-preview` (`up` → `status`), liga privada
// con llave, duerme sin tráfico y se tira al mezclar o cerrar (`down` en api.internal.github-event).
//
// Lugares (7-oct): gs reparte los lugares del tier entre cajas de pedido y previews sueltas.
// Sin lugar (409 `no_slot`) la preview queda «esperando» y el tick la reintenta sola; si un
// pedido u otra preview la desplaza, queda «soltada» y el botón vuelve con una nota.
import { dbq } from "../../dbq.server";

export type PrPreviewInput = { channelId: number; repo: string; number: number };
export type PrPreviewView =
  | { eligible: false; reason: "run" | "repo" | "off" }
  | {
      eligible: true;
      phase: "none" | "creating" | "fetching" | "installing" | "building" | "starting" | "ready" | "failed" | "waiting" | "evicted";
      url: string | null;
      error: string | null;
      sha: string | null;
      /** «Sin lugar: …» (waiting) o «Se soltó…» (evicted). */
      note?: string | null;
      /** waiting: los pedidos (runIds) que ocupan los lugares. */
      busy?: number[];
    };

type Me = { sub: string; isOwner: boolean };

function clean(input: PrPreviewInput): PrPreviewInput {
  const repo = String(input.repo ?? "").trim();
  const number = Number(input.number);
  const channelId = Number(input.channelId);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo inválido");
  if (!Number.isInteger(number) || number <= 0) throw new Error("PR inválido");
  if (!Number.isInteger(channelId) || channelId <= 0) throw new Error("room inválido");
  return { repo, number, channelId };
}

/** Las compuertas: ves el room, el repo es del room, el PR no es de un pedido, la preview no está apagada. */
async function gate(me: Me, input: PrPreviewInput): Promise<{ ok: true; repo: string; number: number } | { ok: false; reason: "run" | "repo" | "off" }> {
  const { repo, number, channelId } = clean(input);
  const db = await import("../../db.server");
  if (!(await db.listChannels(me.sub, me.isOwner)).some((c) => c.id === channelId)) throw new Error("no ves ese room");
  if (!(await db.listRoomRepos(channelId)).some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return { ok: false, reason: "repo" };
  const R = await import("./factory-runs.server");
  // El PR de un pedido ya tiene su preview automática en la caja del pedido.
  if ((await R.runsByPr(repo, number)).length) return { ok: false, reason: "run" };
  if (await R.repoPreviewOff(repo)) return { ok: false, reason: "off" };
  return { ok: true, repo, number };
}

function view(b: any): PrPreviewView {
  if (!b || !b.phase) return { eligible: true, phase: "none", url: null, error: null, sha: null };
  return {
    eligible: true,
    phase: b.phase,
    url: b.phase === "ready" ? (b.url ?? null) : null,
    error: b.phase === "failed" ? String(b.error ?? "la preview no arrancó").split("\n")[0].slice(0, 200) : null,
    sha: b.sha ?? null,
  };
}

/** Lo que hay ahora (sin levantar nada). */
export async function prPreviewStatus(me: Me, input: PrPreviewInput): Promise<PrPreviewView> {
  const g = await gate(me, input);
  if (!g.ok) return { eligible: false, reason: g.reason };
  const P = await import("./preview.server");
  const out = await P.gsPreview("status", { repo: g.repo, pr: g.number });
  if (out?.status?.phase) return view(out.status);
  // gs no tiene caja: lo que sabemos nosotros (esperando lugar o soltada).
  const row = await stateOf(g.repo, g.number);
  if (row?.state === "waiting") return waitingView(row.busy);
  if (row?.state === "evicted") return { eligible: true, phase: "evicted", url: null, error: null, sha: null, note: EVICTED_NOTE };
  return view(out?.status);
}

/** Levanta (o reconstruye con la cabeza actual) la preview del PR en su caja aparte. */
export async function prPreviewUp(me: Me, input: PrPreviewInput): Promise<PrPreviewView> {
  const g = await gate(me, input);
  if (!g.ok) {
    throw new Error(
      g.reason === "run"
        ? "este PR es de un pedido: su preview se levanta sola"
        : g.reason === "off"
          ? "el dueño apagó la preview de este repo"
          : "el repo no está ligado a este room",
    );
  }
  const R = await import("./factory-runs.server");
  const head = await R.prHead(me.sub, `https://github.com/${g.repo}/pull/${g.number}`);
  if (!head) throw new Error("no pude leer el PR en GitHub (¿tu GitHub está conectado?)");
  return upAndRecord(g.repo, g.number, head.sha, me.sub);
}

// ── Sin lugar / soltadas ─────────────────────────────────────────────────────

const EVICTED_NOTE = "Se soltó para dar lugar a un pedido u otra preview";

type StateRow = { repo: string; pr: number; state: "waiting" | "evicted"; requestedBy: string | null; busy: number[] };

function parseBusy(v: unknown): number[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function toState(r: any): StateRow {
  return { repo: String(r.repo), pr: Number(r.pr), state: r.state, requestedBy: r.requested_by ?? null, busy: parseBusy(r.busy) };
}

async function stateOf(repo: string, pr: number): Promise<StateRow | null> {
  const [r] = await dbq("SELECT * FROM gt_pr_preview_state WHERE lower(repo) = lower(?) AND pr = ?", [repo, pr]).catch(() => []);
  return r ? toState(r) : null;
}

/** Upsert sin depender de mayúsculas del repo (GitHub no las distingue). */
async function setState(repo: string, pr: number, state: "waiting" | "evicted", requestedBy: string | null, busy: number[]): Promise<void> {
  await dropState(repo, pr);
  await dbq("INSERT INTO gt_pr_preview_state (repo, pr, state, requested_by, busy, at) VALUES (?, ?, ?, ?, ?, unixepoch())", [
    repo,
    pr,
    state,
    requestedBy,
    JSON.stringify(busy),
  ]);
}

async function dropState(repo: string, pr: number): Promise<void> {
  await dbq("DELETE FROM gt_pr_preview_state WHERE lower(repo) = lower(?) AND pr = ?", [repo, pr]);
}

function waitingView(busy: number[]): PrPreviewView {
  const ids = busy.length ? ` (${busy.map((id) => `#${id}`).join(", ")})` : "";
  return { eligible: true, phase: "waiting", url: null, error: null, sha: null, busy, note: `Sin lugar: ${busy.length} pedidos en curso${ids} · se levanta sola` };
}

/** `up` en gs; un 409 `no_slot` deja la preview esperando, un éxito limpia y anota a quien se soltó. */
async function upAndRecord(repo: string, pr: number, sha: string, sub: string | null): Promise<PrPreviewView> {
  const P = await import("./preview.server");
  let out: any;
  try {
    out = await P.gsPreview("up", { repo, pr, sha });
  } catch (e) {
    const err = e as Error & { status?: number; body?: any };
    if (err.status === 409 && err.body?.error === "no_slot") {
      const busy = parseBusy(JSON.stringify(err.body?.busy ?? []));
      const prev = await stateOf(repo, pr);
      await setState(repo, pr, "waiting", sub ?? prev?.requestedBy ?? null, busy);
      return waitingView(busy);
    }
    throw e;
  }
  await dropState(repo, pr).catch(() => {});
  if (Array.isArray(out?.evicted) && out.evicted.length) await recordEvictedPreviews(out.evicted).catch(() => {});
  return view(out);
}

/**
 * gs soltó estas previews sueltas para dar lugar a otra cosa (un pedido o una preview nueva).
 * Las anota «soltadas» para que su botón diga por qué ya no están. Lo llama también `ensureRunBox`.
 */
export async function recordEvictedPreviews(evicted: { repo: string; pr: number }[]): Promise<void> {
  for (const e of evicted ?? []) {
    const repo = String(e?.repo ?? "");
    const pr = Number(e?.pr);
    if (!repo || !Number.isInteger(pr) || pr <= 0) continue;
    const prev = await stateOf(repo, pr);
    await setState(repo, pr, "evicted", prev?.requestedBy ?? null, []);
  }
}

/** La cabeza del PR y si sigue abierto, con las credenciales de quien la pidió. */
async function prOpenHead(sub: string, repo: string, pr: number): Promise<{ sha: string; open: boolean } | null> {
  try {
    const { allTools } = await import("../connectors/github.server");
    const tool = allTools().find((t) => t.name === "github_get_pr");
    const r = (await tool?.handler(sub, { repo, number: pr })) as any;
    if (!r || r.error) return null;
    return { sha: String(r.headSha ?? ""), open: r.state === "open" && !r.merged };
  } catch {
    return null;
  }
}

/**
 * Tick de la fábrica: reintenta las previews que esperan lugar, la más vieja primero. Si la
 * primera sigue sin lugar, las demás tampoco caben. Un PR cerrado/mezclado (o que ya es de un
 * pedido, o con la preview apagada) se olvida.
 */
export async function retryWaitingPrPreviews(): Promise<void> {
  const rows = await dbq("SELECT * FROM gt_pr_preview_state WHERE state = 'waiting' ORDER BY at ASC LIMIT 5", []).catch(() => []);
  const R = await import("./factory-runs.server");
  for (const raw of rows) {
    const row = toState(raw);
    if (!row.requestedBy) {
      await dropState(row.repo, row.pr);
      continue;
    }
    if ((await R.runsByPr(row.repo, row.pr)).length || (await R.repoPreviewOff(row.repo))) {
      await dropState(row.repo, row.pr);
      continue;
    }
    const head = await prOpenHead(row.requestedBy, row.repo, row.pr);
    if (!head) continue; // GitHub no contestó: se intenta en el siguiente tick
    if (!head.open || !head.sha) {
      await dropState(row.repo, row.pr);
      continue;
    }
    const v = await upAndRecord(row.repo, row.pr, head.sha, row.requestedBy).catch((e) => {
      console.warn(`[pr-preview] reintento ${row.repo}#${row.pr}: ${(e as Error).message}`);
      return null;
    });
    if (v?.eligible && v.phase === "waiting") break;
  }
}
