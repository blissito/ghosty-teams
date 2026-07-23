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
};

export async function getConnectorRow(sub: string, provider: string): Promise<ConnectorRow | null> {
  const rows = await dbq(
    "SELECT user_sub, provider, access_token, refresh_token, expires_at, external_id, meta FROM gc_user_connectors WHERE user_sub=? AND provider=?",
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
