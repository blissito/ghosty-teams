// El equipo de la fábrica POR TURNO: qué agente y qué modelo hace @plan/@build/@check en ESTE
// hilo. La parte pura (formato del archivo, alias, lectura del mensaje) está en factory-team.ts.
//
// Se resuelve en un solo sitio, `callAgentBackendStream`, que es por donde pasan TODOS los
// turnos (mención en el room, relevo de la plataforma, despertador, sprint). La fila del handle
// (`gc_agents`) sigue siendo quien recibe la mención; lo que cambia aquí es a qué agente de
// Studio se le manda el turno y con qué modelo.
import { dbq } from "../../dbq.server";
import type { ToolDest } from "../connectors/tool-token.server";
import { FACTORY_HANDLES, type FactoryHandle } from "./factory-roles";
import { TEAM_FILE, engineOfModel, parseMessageOverrides, parseTeamFile, resolveModel, type TeamFile, type TurnOverrides } from "./factory-team";

type StudioAgent = { id: string; name: string; engine: string; model: string };
export type RoleSource = "message" | "repo" | "space";

export type FactoryTurn = {
  handle: FactoryHandle;
  repo: string | null;
  /** Agente de Studio que corre el turno (null = el de la fila del handle). */
  fleetId: string | null;
  /** Modelo de ESTE turno (null = el del agente). */
  model: string | null;
  source: { agent: RoleSource; model: RoleSource };
  /** Cuerpo de `.ghosty/factory.md`: convenciones del repo para el contexto del turno. */
  notes: string | null;
  /** Lo pedido no se puede (modelo de otro motor, agente que no existe): se dice y no se corre. */
  refusal: string | null;
};

// ── Cachés: esto corre en cada turno de la fábrica ──────────────────────────

let agentsCache: { at: number; list: StudioAgent[] } | null = null;
async function studioAgentsCached(): Promise<StudioAgent[]> {
  if (agentsCache && Date.now() - agentsCache.at < 60_000) return agentsCache.list;
  const { studioAgents } = await import("./factory");
  const list = await studioAgents().catch(() => agentsCache?.list ?? []);
  agentsCache = { at: Date.now(), list };
  return list;
}

const fileCache = new Map<string, { at: number; file: TeamFile | null }>();
const FILE_TTL = 5 * 60_000;

/** `.ghosty/factory.md` del repo, con el GitHub de quien lo conectó al room. null si no hay. */
export async function repoTeamFile(repo: string, sub: string, opts: { fresh?: boolean } = {}): Promise<TeamFile | null> {
  const hit = fileCache.get(repo.toLowerCase());
  if (!opts.fresh && hit && Date.now() - hit.at < FILE_TTL) return hit.file;
  const { githubApi } = await import("../connectors/github.server");
  const r = await githubApi(sub, `/repos/${repo}/contents/${TEAM_FILE}`).catch(() => null);
  const raw = r?.content && r.encoding === "base64" ? Buffer.from(String(r.content), "base64").toString("utf8") : null;
  const file = raw ? parseTeamFile(raw) : null;
  fileCache.set(repo.toLowerCase(), { at: Date.now(), file });
  return file;
}

export function invalidateRepoTeamFile(repo: string) {
  fileCache.delete(repo.toLowerCase());
}

// ── Lo pedido en el hilo ─────────────────────────────────────────────────────

function threadRoot(dest: ToolDest | null): number | null {
  if (!dest?.channelId) return null;
  return dest.parentId ?? dest.invokerMessageIds?.[0] ?? null;
}

async function readOverrides(channelId: number, root: number): Promise<TurnOverrides> {
  const rows = await dbq("SELECT overrides FROM gt_factory_thread_overrides WHERE channel_id = ? AND root_msg_id = ?", [channelId, root]).catch(() => []);
  try {
    return rows[0] ? (JSON.parse(String(rows[0].overrides)) as TurnOverrides) : {};
  } catch {
    return {};
  }
}

/** Mezcla lo nuevo del mensaje con lo que el hilo ya traía, y lo guarda si cambió. */
async function captureOverrides(dest: ToolDest, root: number, roomRepos: string[]): Promise<TurnOverrides> {
  const prev = await readOverrides(dest.channelId!, root);
  const mid = dest.invokerMessageIds?.[0];
  if (!mid) return prev;
  const db = await import("../../db.server");
  const msg = await db.getMessage(mid).catch(() => null);
  if (!msg?.body) return prev;
  const found = parseMessageOverrides(msg.body, roomRepos);
  if (!found.repo && !found.models) return prev;
  const next: TurnOverrides = { ...prev, ...(found.repo ? { repo: found.repo } : {}), models: { ...prev.models, ...found.models } };
  await dbq(
    `INSERT INTO gt_factory_thread_overrides (channel_id, root_msg_id, overrides) VALUES (?, ?, ?)
     ON CONFLICT(channel_id, root_msg_id) DO UPDATE SET overrides = excluded.overrides, updated_at = unixepoch()`,
    [dest.channelId, root, JSON.stringify(next)],
  ).catch(() => {});
  return next;
}

// ── La resolución ────────────────────────────────────────────────────────────

/**
 * Qué agente y qué modelo hace este rol en este turno. null si no es un turno de la fábrica
 * (otro handle, DM, fábrica sin instalar): el turno sigue exactamente como antes.
 */
export async function factoryTurnFor(handle: string, dest: ToolDest | null | undefined, defaultFleetId: string): Promise<FactoryTurn | null> {
  if (!(FACTORY_HANDLES as readonly string[]).includes(handle) || !dest?.channelId) return null;
  const { isInstalled } = await import("./installed.server");
  if (!(await isInstalled("factory").catch(() => false))) return null;
  const h = handle as FactoryHandle;
  const db = await import("../../db.server");
  const roomRepos = await db.listRoomRepos(dest.channelId).catch(() => []);
  if (!roomRepos.length) return null;

  const root = threadRoot(dest);
  const ov = root ? await captureOverrides(dest, root, roomRepos.map((r) => r.repo)) : {};
  const R = await import("./factory-runs.server");
  const run = root ? await R.runOfThread(dest.channelId, root).catch(() => null) : null;
  const repo = run?.repo ?? ov.repo ?? (roomRepos.length === 1 ? roomRepos[0].repo : null);
  const connectedBy = roomRepos.find((r) => r.repo === repo)?.connectedBy;
  const file = repo && connectedBy ? await repoTeamFile(repo, connectedBy).catch(() => null) : null;
  const spec = file?.roles[h] ?? {};

  const agents = await studioAgentsCached();
  let fleetId = defaultFleetId;
  let agentSource: RoleSource = "space";
  if (spec.agent) {
    const want = spec.agent.toLowerCase();
    const a = agents.find((x) => x.id === spec.agent || x.name.toLowerCase() === want);
    if (!a)
      return refuse(h, repo, `⚠️ \`${TEAM_FILE}\` de ${repo} pone a **${spec.agent}** en @${h}, y no hay un agente de Studio con ese nombre en este espacio. Corrige el nombre en el archivo o créalo en Studio.`);
    fleetId = a.id;
    agentSource = "repo";
  }
  const engine = agents.find((x) => x.id === fleetId)?.engine ?? null;

  let model: string | null = null;
  let modelSource: RoleSource = "space";
  const asked = ov.models?.[h] ?? spec.model ?? null;
  if (asked && engine) {
    model = resolveModel(engine, asked);
    if (!model) {
      const other = engineOfModel(asked);
      const where = ov.models?.[h] ? "en tu mensaje" : `en \`${TEAM_FILE}\` de ${repo}`;
      return refuse(
        h,
        repo,
        `⚠️ Pediste **${asked}** para @${h} ${where}, pero @${h} corre en ${engine}${other ? ` y ${asked} es de ${other}` : ""}. ` +
          `Usa un modelo de ${engine} o pon otro agente en el rol con \`agent:\` en \`${TEAM_FILE}\`.`,
      );
    }
    modelSource = ov.models?.[h] ? "message" : "repo";
  }

  return {
    handle: h,
    repo,
    fleetId: fleetId === defaultFleetId ? null : fleetId,
    model,
    source: { agent: agentSource, model: modelSource },
    notes: file?.notes ? file.notes.slice(0, 4000) : null,
    refusal: null,
  };

  function refuse(handle: FactoryHandle, repo: string | null, text: string): FactoryTurn {
    return { handle, repo, fleetId: null, model: null, source: { agent: "space", model: "space" }, notes: null, refusal: text };
  }
}

/** El equipo efectivo de un repo, para la página: rol → agente, modelo y de dónde sale. */
export async function effectiveTeam(repo: string, connectedBy: string, space: Partial<Record<FactoryHandle, string | null>>) {
  const file = await repoTeamFile(repo, connectedBy).catch(() => null);
  const agents = await studioAgentsCached();
  return {
    hasFile: !!file,
    roles: FACTORY_HANDLES.map((h) => {
      const spec = file?.roles[h] ?? {};
      const fromFile = spec.agent ? agents.find((x) => x.id === spec.agent || x.name.toLowerCase() === spec.agent!.toLowerCase()) : null;
      const a = fromFile ?? agents.find((x) => x.id === space[h]) ?? null;
      const model = spec.model && a ? resolveModel(a.engine, spec.model) : null;
      return {
        handle: h,
        agent: a ? { id: a.id, name: a.name, engine: a.engine } : null,
        model: model ?? a?.model ?? null,
        agentSource: (spec.agent ? "repo" : "space") as RoleSource,
        modelSource: (model ? "repo" : "space") as RoleSource,
        problem: spec.agent && !fromFile ? `no hay agente «${spec.agent}»` : spec.model && a && !model ? `${spec.model} no es de ${a.engine}` : null,
      };
    }),
  };
}
