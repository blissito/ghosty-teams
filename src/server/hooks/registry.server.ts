// Registro de los webhooks ENTRANTES que hemos dado de alta en la cuenta de un proveedor.
//
// Existe por una asimetría que costó ver: el webhook SALIENTE de los formularios tiene su
// fila (`gt_form_hooks`) con estado y bitácora, mientras que el ENTRANTE de Sentry no tenía
// nada — sólo un token HMAC viajando por ahí. Y sin fila no se puede deshacer: al
// desconectar el conector se revoca el token, y con él se pierde la única forma de quitar
// el webhook del lado del proveedor. Quedaba vivo en la cuenta del cliente para siempre,
// publicando en un canal.
//
// Es un REGISTRO, no la verdad: la verdad vive en el proveedor. Sirve para saber qué hay
// que limpiar y qué enseñarle al usuario.
import { dbq } from "../../dbq.server";

export type HookRow = {
  id: string;
  provider: string;
  ownerSub: string;
  channelId: number;
  org: string;
  project: string;
  createdBy: string;
  createdAt: number;
};

const fila = (r: Record<string, any>): HookRow => ({
  id: r.id,
  provider: r.provider,
  ownerSub: r.owner_sub,
  channelId: Number(r.channel_id),
  org: r.org,
  project: r.project,
  createdBy: r.created_by,
  createdAt: Number(r.created_at),
});

/**
 * Deja constancia de un webhook recién registrado.
 *
 * Idempotente por (provider, channel_id, org, project): reconfigurar el mismo proyecto en
 * el mismo canal reescribe la fila en vez de acumular duplicados que luego habría que
 * limpiar dos veces.
 */
export async function recordHook(h: Omit<HookRow, "id" | "createdAt">): Promise<void> {
  await dbq(
    `INSERT INTO gt_connector_hooks (id, provider, owner_sub, channel_id, org, project, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(provider, channel_id, org, project)
     DO UPDATE SET owner_sub = excluded.owner_sub, created_by = excluded.created_by, created_at = unixepoch()`,
    [
      `${h.provider}:${h.channelId}:${h.org}:${h.project}`,
      h.provider,
      h.ownerSub,
      h.channelId,
      h.org,
      h.project,
      h.createdBy,
    ]
  );
}

export async function forgetHook(
  provider: string,
  channelId: number,
  org: string,
  project: string
): Promise<void> {
  await dbq(
    "DELETE FROM gt_connector_hooks WHERE provider=? AND channel_id=? AND org=? AND project=?",
    [provider, channelId, org, project]
  );
}

/** Los que dependen de la conexión de esta persona → lo que hay que limpiar al desconectar. */
export async function hooksOfOwner(ownerSub: string, provider: string): Promise<HookRow[]> {
  const rows = await dbq(
    "SELECT * FROM gt_connector_hooks WHERE owner_sub=? AND provider=? ORDER BY created_at",
    [ownerSub, provider]
  );
  return rows.map(fila);
}

/** Todos los del workspace, para que alguien pueda VER qué está configurado. */
export async function listHooks(provider?: string): Promise<HookRow[]> {
  const rows = provider
    ? await dbq("SELECT * FROM gt_connector_hooks WHERE provider=? ORDER BY created_at", [provider])
    : await dbq("SELECT * FROM gt_connector_hooks ORDER BY created_at");
  return rows.map(fila);
}
