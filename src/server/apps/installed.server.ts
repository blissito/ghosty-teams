// Qué apps tiene instaladas ESTE espacio (tabla `gt_installed_apps`, por namespace).
//
// Es la llave que decide si existen las tools y el contexto de una app: sin la fila, sus
// tools no se anuncian ni se ejecutan (`factoryTools` devuelve []). Se lee en cada listado
// de tools, así que se cachea unos segundos por namespace; instalar o desinstalar invalida.
import { dbq } from "../../dbq.server";
import { currentNamespace } from "../tenant.server";

export type AppId = "factory";

export type FactoryConfig = {
  /** Caja de gs que corre los tres roles. */
  fleetAgentId: string;
  /** Room donde vive la fábrica y caen sus corridas. */
  roomId: number;
  /** Tablero de Tasks de la fábrica. */
  boardId: number | null;
};

type Row = { app: string; installed_by: string; installed_at: number; config: string; uninstalled_at: number | null };

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; rows: Map<string, Row> }>();

async function rowsOf(): Promise<Map<string, Row>> {
  const ns = await currentNamespace().catch(() => "");
  const hit = cache.get(ns);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  // Si la tabla aún no existe (espacio que nunca corrió `ensureSchema` con ella), no hay apps.
  const rows = (await dbq("SELECT app, installed_by, installed_at, config, uninstalled_at FROM gt_installed_apps", []).catch(
    () => [],
  )) as Row[];
  const map = new Map(rows.map((r) => [r.app, r]));
  cache.set(ns, { at: Date.now(), rows: map });
  return map;
}

export async function isInstalled(app: AppId): Promise<boolean> {
  const r = (await rowsOf()).get(app);
  return !!r && !r.uninstalled_at;
}

/**
 * Config de la app instalada. Con `includeUninstalled` devuelve también la de una
 * instalación anterior (para reinstalar reusando caja y tablero).
 */
export async function getAppConfig<T = Record<string, unknown>>(
  app: AppId,
  opts?: { includeUninstalled?: boolean },
): Promise<T | null> {
  const r = (await rowsOf()).get(app);
  if (!r || (r.uninstalled_at && !opts?.includeUninstalled)) return null;
  try {
    return JSON.parse(r.config) as T;
  } catch {
    return {} as T;
  }
}

export async function recordInstall(app: AppId, by: string, config: Record<string, unknown>): Promise<void> {
  await dbq(
    `INSERT INTO gt_installed_apps (app, installed_by, config) VALUES (?, ?, ?)
     ON CONFLICT(app) DO UPDATE SET installed_by = excluded.installed_by, config = excluded.config,
                                    installed_at = unixepoch(), uninstalled_at = NULL`,
    [app, by, JSON.stringify(config)],
  );
  await invalidateApps();
}

export async function recordUninstall(app: AppId): Promise<void> {
  await dbq("UPDATE gt_installed_apps SET uninstalled_at = unixepoch() WHERE app = ?", [app]);
  await invalidateApps();
}

async function invalidateApps(): Promise<void> {
  const ns = await currentNamespace().catch(() => "");
  cache.delete(ns);
}
