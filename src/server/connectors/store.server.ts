// Storage per-user de tokens de conectores (tabla gc_user_connectors, creada en
// schema.server.ts migrate()). Una fila por (user_sub, provider). Patrón gc_stars.
import { dbq } from "../../dbq.server";

export type ConnectorRow = {
  user_sub: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  external_id: string | null;
  meta: string | null;
  /** Última relectura del userinfo. NULL = nunca → se trata como vencido. */
  meta_at: number | null;
};

export async function getConnectorRow(sub: string, provider: string): Promise<ConnectorRow | null> {
  const rows = await dbq(
    "SELECT user_sub, provider, access_token, refresh_token, expires_at, external_id, meta, meta_at FROM gc_user_connectors WHERE user_sub=? AND provider=?",
    [sub, provider]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user_sub: r.user_sub!,
    provider: r.provider!,
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at == null ? null : Number(r.expires_at),
    external_id: r.external_id,
    meta: r.meta,
    meta_at: r.meta_at == null ? null : Number(r.meta_at),
  };
}

export async function setConnectorRow(row: {
  sub: string;
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  externalId?: string | null;
  meta?: unknown;
}): Promise<void> {
  const metaStr =
    row.meta == null ? null : typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta);
  // COALESCE en refresh/external/meta → un refresh que no re-emite refresh_token no lo borra.
  await dbq(
    `INSERT INTO gc_user_connectors (user_sub, provider, access_token, refresh_token, expires_at, external_id, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_sub, provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, gc_user_connectors.refresh_token),
       expires_at = excluded.expires_at,
       external_id = COALESCE(excluded.external_id, gc_user_connectors.external_id),
       meta = COALESCE(excluded.meta, gc_user_connectors.meta)`,
    [
      row.sub,
      row.provider,
      row.accessToken,
      row.refreshToken ?? null,
      row.expiresAt ?? null,
      row.externalId ?? null,
      metaStr,
    ]
  );
}

/**
 * Reescribe SOLO el meta (y su marca de frescura), sin tocar tokens.
 *
 * `setConnectorRow` no sirve para esto: exige `accessToken` y pisa `expires_at`
 * siempre, así que refrescar el meta con ella arriesgaría la credencial. Aquí el
 * meta se REEMPLAZA entero (es una foto nueva del userinfo, no un parche).
 */
export async function setConnectorMeta(
  sub: string,
  provider: string,
  patch: { meta?: unknown; externalId?: string | null }
): Promise<void> {
  const metaStr =
    patch.meta == null ? null : typeof patch.meta === "string" ? patch.meta : JSON.stringify(patch.meta);
  await dbq(
    `UPDATE gc_user_connectors
        SET meta = COALESCE(?, meta),
            external_id = COALESCE(?, external_id),
            meta_at = unixepoch()
      WHERE user_sub=? AND provider=?`,
    [metaStr, patch.externalId ?? null, sub, provider]
  );
}

/**
 * Marca que YA se intentó refrescar, sin cambiar el meta.
 *
 * Se llama cuando el userinfo falla: sin esto, un proveedor caído provocaría un
 * reintento en CADA turno del usuario. Mismo criterio anti-martilleo que el
 * stale-while-error de tenant.server.ts.
 */
export async function touchConnectorMeta(sub: string, provider: string): Promise<void> {
  await dbq("UPDATE gc_user_connectors SET meta_at=unixepoch() WHERE user_sub=? AND provider=?", [
    sub,
    provider,
  ]);
}

export async function deleteConnectorRow(sub: string, provider: string): Promise<void> {
  await dbq("DELETE FROM gc_user_connectors WHERE user_sub=? AND provider=?", [sub, provider]);
}

// Providers con conexión viva (access_token no nulo) para un usuario → para el panel.
export async function listConnectorProviders(sub: string): Promise<Set<string>> {
  const rows = await dbq(
    "SELECT provider FROM gc_user_connectors WHERE user_sub=? AND access_token IS NOT NULL",
    [sub]
  );
  return new Set(rows.map((r) => r.provider!).filter(Boolean));
}

/**
 * Quién MÁS del workspace tiene cada conector → provider → [subs].
 *
 * Es la gemela sin `user_sub` de la de arriba, y existe porque el panel mentía por
 * omisión: mirando sólo tu fila, un conector que medio equipo usa se ve idéntico a uno
 * que nadie ha tocado. El 2026-08-04 eso produjo un "David dice que la hizo pero yo no la
 * veo" con los dos teniendo razón.
 *
 * Devuelve `sub`s pelados a propósito: quién es cada uno lo resuelve la capa de arriba con
 * el padrón, que ya sabe filtrar a los baneados. Aquí no se lee ni un token.
 *
 * La tabla tiene una fila por persona y proveedor, así que el scan es trivial y no pide
 * índice nuevo (la PK es `(user_sub, provider)`).
 */
// ── Conexiones DEL EQUIPO ────────────────────────────────────────────────────
//
// Una conexión compartida es una conexión personal con `shared=1`: la conectó una persona
// y la usa todo el workspace. Es el "workspace connection" de ClickUp/Notion/Linear, y
// resuelve el modelo de agencia — el cliente conecta su Sentry UNA vez y podemos ayudarle
// sin que nos dé cuenta en su Sentry.
//
// No hay tabla aparte a propósito: así compartir la conexión de alguien que ya no está es
// un UPDATE, sin pedirle que reconecte ni tocar su token.

/**
 * Con QUÉ conexión se ejecuta una tool de este proveedor para este usuario.
 *
 * Prioridad: **la propia gana siempre**, y sólo si no hay se cae a la compartida del
 * workspace. Importa porque el agente debe actuar con MIS permisos cuando los tengo — si
 * la compartida ganara, un miembro haría cosas que su propia cuenta no puede.
 *
 * Devuelve el `sub` DUEÑO del token; quien llama se lo pasa tal cual a `getValidToken`,
 * que no cambia de firma (por eso ninguno de los handlers de conector se toca).
 */
export async function resolveConnectorOwner(
  sub: string,
  provider: string
): Promise<{ ownerSub: string; shared: boolean } | null> {
  // ⚠️ El LEFT JOIN con gc_users deja fuera a los EXPULSADOS. Expulsar sólo pone
  // `banned=1` y no toca `gc_user_connectors`, así que sin esto el equipo seguiría
  // actuando con el token de alguien a quien acaban de sacar — y encima sin nombre, porque
  // `listWorkspaceUsers` filtra a los baneados y la atribución se perdería justo en el
  // caso donde más importa. La propia NUNCA se filtra: si estás baneado no llegas aquí.
  //
  // El último criterio es el DESEMPATE: con dos personas compartiendo el mismo proveedor,
  // la fila elegida sería arbitraria y podría cambiar entre llamadas — el panel nombraría
  // a una y el agente usaría la de la otra. Alfabético es arbitrario pero ESTABLE.
  const rows = await dbq(
    `SELECT c.user_sub, c.shared FROM gc_user_connectors c
       LEFT JOIN gc_users u ON u.sub = c.user_sub
      WHERE c.provider=? AND c.access_token IS NOT NULL
        AND (c.user_sub=? OR (c.shared=1 AND COALESCE(u.banned,0)=0))
      ORDER BY (c.user_sub=?) DESC, c.user_sub ASC LIMIT 1`,
    [provider, sub, sub]
  );
  const r = rows[0];
  if (!r?.user_sub) return null;
  return { ownerSub: r.user_sub, shared: r.user_sub !== sub };
}

/** Proveedores que este usuario puede usar: los suyos + los compartidos del workspace. */
export async function listAvailableProviders(sub: string): Promise<Set<string>> {
  // Mismo filtro de expulsados que `resolveConnectorOwner`, o se anunciarían tools que
  // luego no se pueden ejecutar.
  const rows = await dbq(
    `SELECT DISTINCT c.provider FROM gc_user_connectors c
       LEFT JOIN gc_users u ON u.sub = c.user_sub
      WHERE c.access_token IS NOT NULL
        AND (c.user_sub=? OR (c.shared=1 AND COALESCE(u.banned,0)=0))`,
    [sub]
  );
  return new Set(rows.map((r) => r.provider!).filter(Boolean));
}

/** Prende o apaga el "es del equipo". NO toca el token ni ninguna otra columna. */
export async function setConnectorShared(
  ownerSub: string,
  provider: string,
  shared: boolean
): Promise<void> {
  await dbq("UPDATE gc_user_connectors SET shared=? WHERE user_sub=? AND provider=?", [
    shared ? 1 : 0,
    ownerSub,
    provider,
  ]);
}

/** Las compartidas del workspace → provider → sub del dueño. Para el panel. */
export async function listSharedConnectors(): Promise<Map<string, string>> {
  // Mismo desempate que `resolveConnectorOwner`, o el panel nombraría a una persona y el
  // agente usaría la conexión de otra.
  const rows = await dbq(
    `SELECT user_sub, provider FROM gc_user_connectors
      WHERE shared=1 AND access_token IS NOT NULL ORDER BY user_sub ASC`
  );
  const out = new Map<string, string>();
  for (const r of rows) if (r.provider && r.user_sub && !out.has(r.provider)) out.set(r.provider, r.user_sub);
  return out;
}

export async function listConnectorHolders(): Promise<Map<string, string[]>> {
  const rows = await dbq(
    "SELECT user_sub, provider FROM gc_user_connectors WHERE access_token IS NOT NULL"
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const provider = r.provider;
    const sub = r.user_sub;
    if (!provider || !sub) continue;
    const lista = out.get(provider);
    if (lista) lista.push(sub);
    else out.set(provider, [sub]);
  }
  return out;
}
