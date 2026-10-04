// Conexiones de conectores por persona.
//
// Desde el 2026-10-03 la FILA (token, refresh, meta) vive en Ghosty Studio, global por persona
// (`ConnectorCredential`, puente `cred.*` de `internal/connectors`): conectas GitHub una vez y
// sirve en todos tus espacios, en /c y en las apps. Lo que sigue siendo de ESTE espacio vive aquí
// en `gc_user_connectors`: la marca «compartida con el equipo» (`shared`) — ya sin tokens.
//
// Transición sin corte: si gs no tiene la fila y este espacio todavía guarda una copia con token
// (de antes), se sube a gs y se borra el token de aquí (`legacyToGs`). Y si gs no contesta o no
// reconoce a la persona como del espacio (403), se usa la copia local como antes: nadie se queda
// sin su conexión por el puente.
import { dbq } from "../../dbq.server";
import { call } from "./studio-bridge.server";

type GsRow = ConnectorRow;
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; row: GsRow | null }>();
// La caché va POR ESPACIO: un mismo proceso atiende todos, y cada espacio puede tener fijada otra
// cuenta del mismo proveedor (cliente A aquí, cliente B allá). Sin el namespace en la llave, el
// espacio B recibía 30 s el token del cliente A (segunda auditoría, 3-oct).
/** ¿Modo personal (sin espacio de Teams)? Ahí no hay marca, copia local ni compartidas. */
async function personal(): Promise<boolean> {
  const { isPersonalNs } = await import("../tenant.server");
  return isPersonalNs(await nsOf());
}
async function nsOf(): Promise<string> {
  const { currentNamespace } = await import("../tenant.server");
  return currentNamespace().catch(() => "");
}
const ck = (ns: string, sub: string, provider: string) => `${ns}\n${sub}\n${provider}`;
/** Olvida la fila de (sub, provider) en TODOS los espacios de este proceso. */
const forget = (sub: string, provider: string) => {
  for (const key of [...cache.keys()]) if (key.endsWith(`\n${sub}\n${provider}`)) cache.delete(key);
};
/** Antes de una decisión que borra o compara tokens: leer lo de gs, no el caché. */
export const forgetConnectorCache = forget;
/** Sólo tests: el caché de 30 s sobrevive entre casos. */
export const resetConnectorCacheForTests = () => cache.clear();

/** Qué cuenta usa ESTE espacio (`gc_user_connectors.account`); undefined = sin fijar. */
async function markerAccount(sub: string, provider: string): Promise<string | undefined> {
  const rows = await dbq("SELECT account FROM gc_user_connectors WHERE user_sub=? AND provider=?", [sub, provider]).catch(() => []);
  const a = rows[0]?.account;
  return typeof a === "string" ? a : undefined;
}

/** Fija la cuenta de este espacio (crea la marca si no existe). */
async function pinAccount(sub: string, provider: string, account: string): Promise<void> {
  await ensureMarker(sub, provider);
  await dbq("UPDATE gc_user_connectors SET account=? WHERE user_sub=? AND provider=?", [account, sub, provider]).catch(() => {});
}

/** La fila en gs; `undefined` = gs no contestó (se usa la copia local). */
async function gsGet(sub: string, provider: string): Promise<GsRow | null | undefined> {
  const key = ck(await nsOf(), sub, provider);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const account = await markerAccount(sub, provider);
  const r = await call<{ ok: boolean; row?: GsRow | null }>(sub, { action: "cred.get", provider, ...(account !== undefined ? { account } : {}) });
  if (!r?.ok) return undefined;
  const row = r.row ?? null;
  // Sin cuenta fijada: se fija la que se está usando, para que conectar OTRA cuenta en otro
  // espacio no le cambie la suya a éste (auditoría 3-oct). Sólo si este espacio ya tiene marca.
  if (row && account === undefined && typeof row.account === "string") {
    await dbq("UPDATE gc_user_connectors SET account=? WHERE user_sub=? AND provider=? AND account IS NULL", [row.account, sub, provider]).catch(() => {});
  }
  cache.set(key, { at: Date.now(), row });
  return row;
}

/** Cuerpo de las llamadas que tocan UNA cuenta: la de este espacio si está fijada. */
async function withAccount(sub: string, provider: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const account = await markerAccount(sub, provider);
  return account !== undefined ? { ...body, account } : body;
}

async function gs(sub: string, body: Record<string, unknown>): Promise<boolean> {
  if (typeof body.provider === "string") forget(sub, body.provider);
  const r = await call<{ ok: boolean }>(sub, body);
  return !!r?.ok;
}

async function legacyRow(sub: string, provider: string): Promise<ConnectorRow | null> {
  const rows = await dbq(
    "SELECT user_sub, provider, access_token, refresh_token, expires_at, external_id, meta, meta_at, account FROM gc_user_connectors WHERE user_sub=? AND provider=?",
    [sub, provider]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...(typeof r.account === "string" ? { account: r.account } : {}),
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

/** La copia de este espacio sube a gs y aquí queda sólo la marca (sin tokens). */
async function legacyToGs(row: ConnectorRow): Promise<boolean> {
  if (!row.access_token) return false;
  // Con la cuenta de la PROPIA copia (su externalId), no la fijada: si mientras gs estaba caído se
  // conectó otra cuenta aquí, subirla con la fijada pisaría la fila de la cuenta anterior.
  const account = row.account ?? row.external_id ?? "";
  const ok = await gs(row.user_sub, {
    action: "cred.set", provider: row.provider, accessToken: row.access_token, refreshToken: row.refresh_token,
    expiresAt: row.expires_at, externalId: row.external_id, meta: row.meta, metaAt: row.meta_at, account,
  });
  if (ok) await pinAccount(row.user_sub, row.provider, account);
  if (ok) {
    await dbq("UPDATE gc_user_connectors SET access_token=NULL, refresh_token=NULL WHERE user_sub=? AND provider=?", [row.user_sub, row.provider]).catch(() => {});
  }
  return ok;
}

/** La marca del espacio (para «compartida»): existe aunque el token viva en gs. */
async function ensureMarker(sub: string, provider: string): Promise<void> {
  await dbq(
    `INSERT INTO gc_user_connectors (user_sub, provider, access_token, created_at) VALUES (?, ?, NULL, unixepoch())
     ON CONFLICT(user_sub, provider) DO NOTHING`,
    [sub, provider]
  ).catch(() => {});
}

/** ¿Tiene conexión viva? gs, o la copia local de antes. */
async function hasConnection(sub: string, provider: string): Promise<boolean> {
  return !!(await getConnectorRow(sub, provider))?.access_token;
}

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
  /** Qué cuenta del proveedor (gs). Ausente en copias locales de antes. */
  account?: string;
};

export async function getConnectorRow(sub: string, provider: string): Promise<ConnectorRow | null> {
  const remote = await gsGet(sub, provider);
  const local = await legacyRow(sub, provider).catch(() => null);
  // Una copia CON token aquí es o de antes de la migración, o un refresco que gs no alcanzó a
  // guardar (estaba caído): en los dos casos es la más nueva. Se sube y se sirve; servir la de
  // gs haría refrescar con un refresh token ya rotado y borraría la conexión (auditoría 3-oct).
  if (local?.access_token) {
    if (remote !== undefined) await legacyToGs(local);
    return local;
  }
  return remote ?? null;
}

export async function setConnectorRow(row: {
  sub: string;
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  externalId?: string | null;
  meta?: unknown;
  /** Refresco: sólo escribe si gs sigue guardando ESTE refresh token (otro proceso no rotó). */
  ifRefresh?: string | null;
  /** La cuenta que se refresca. En una conexión nueva sale del `externalId`. */
  account?: string;
}): Promise<"gs" | "stale" | "local"> {
  const metaStr =
    row.meta == null ? null : typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta);
  forget(row.sub, row.provider);
  const r = await call<{ ok: boolean; written?: boolean; account?: string }>(row.sub, {
    action: "cred.set", provider: row.provider, accessToken: row.accessToken, refreshToken: row.refreshToken ?? null,
    expiresAt: row.expiresAt ?? null, externalId: row.externalId ?? null, meta: metaStr,
    ...(row.ifRefresh !== undefined ? { ifRefresh: row.ifRefresh } : {}),
    ...(row.account !== undefined ? { account: row.account } : {}),
  });
  if (r?.ok && r.written === false) return "stale";
  const ok = !!r?.ok;
  if (ok) {
    // Este espacio usa la cuenta que se acaba de conectar (o refrescar): conectar OTRA en otro
    // espacio ya no la pisa, conviven.
    if (typeof r?.account === "string") await pinAccount(row.sub, row.provider, r.account);
    else await ensureMarker(row.sub, row.provider);
    // Ya vive en gs: una copia vieja aquí sólo confundiría al siguiente refresco.
    await dbq("UPDATE gc_user_connectors SET access_token=NULL, refresh_token=NULL WHERE user_sub=? AND provider=? AND access_token IS NOT NULL", [row.sub, row.provider]).catch(() => {});
    return "gs";
  }
  // gs no contestó: como antes, en este espacio (con su cuenta, para subirla bien cuando vuelva).
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
  const account = row.account ?? row.externalId ?? undefined;
  if (account !== undefined) await dbq("UPDATE gc_user_connectors SET account=? WHERE user_sub=? AND provider=?", [account, row.sub, row.provider]).catch(() => {});
  return "local";
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
  if (await gs(sub, await withAccount(sub, provider, { action: "cred.meta", provider, meta: metaStr, externalId: patch.externalId ?? null }))) return;
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
  if (await gs(sub, await withAccount(sub, provider, { action: "cred.meta", provider }))) return;
  await dbq("UPDATE gc_user_connectors SET meta_at=unixepoch() WHERE user_sub=? AND provider=?", [
    sub,
    provider,
  ]);
}

/** Marca el meta como vencido sin esperar (0, no NULL: ver `invalidateConnectorMeta`). */
export async function invalidateConnectorMetaRow(sub: string, provider: string): Promise<void> {
  if (await gs(sub, await withAccount(sub, provider, { action: "cred.meta", provider, metaAt: 0 }))) return;
  await dbq("UPDATE gc_user_connectors SET meta_at=0 WHERE user_sub=? AND provider=?", [sub, provider]).catch(() => {});
}

/** Desconectar es de la PERSONA: se borra en gs la cuenta que usa este espacio (deja de servir
 *  en todos los espacios que usaban esa misma cuenta) y la marca de aquí. Otras cuentas siguen. */
export async function deleteConnectorRow(sub: string, provider: string): Promise<void> {
  const row = await getConnectorRow(sub, provider).catch(() => null);
  const account = (await markerAccount(sub, provider)) ?? row?.account;
  const ok = await gs(sub, { action: "cred.delete", provider, ...(account !== undefined ? { account } : {}) });
  if (!ok) throw new Error("no pude desconectar: Ghosty Studio no contestó; vuelve a intentarlo");
  // La marca se queda FIJADA a la cuenta borrada (lápida): sin ella, este espacio caería a «la más
  // reciente» y empezaría a usar la cuenta de OTRO cliente (auditoría final, 3-oct). Conectar de
  // nuevo aquí la vuelve a fijar.
  if (account !== undefined) {
    await dbq("UPDATE gc_user_connectors SET access_token=NULL, refresh_token=NULL, shared=0, account=? WHERE user_sub=? AND provider=?", [account, sub, provider]);
  } else {
    await dbq("DELETE FROM gc_user_connectors WHERE user_sub=? AND provider=?", [sub, provider]);
  }
  forget(sub, provider);
}

// Providers con conexión viva para un usuario → para el panel. Los de gs ∪ copias de antes.
export async function listConnectorProviders(sub: string): Promise<Set<string>> {
  const r = await call<{ ok: boolean; providers?: string[] }>(sub, { action: "cred.list" });
  const out = new Set<string>();
  // Sólo los que ESTE espacio puede usar: con cuenta fijada (o lápida), que ésa exista.
  for (const p of r?.ok ? r.providers ?? [] : []) if ((await getConnectorRow(sub, p).catch(() => null))?.access_token) out.add(p);
  if (await personal()) return out;
  const rows = await dbq(
    "SELECT provider FROM gc_user_connectors WHERE user_sub=? AND access_token IS NOT NULL",
    [sub]
  );
  for (const x of rows) if (x.provider) out.add(x.provider);
  return out;
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
  if (await hasConnection(sub, provider)) return { ownerSub: sub, shared: false };
  if (await personal()) return null;
  const rows = await dbq(
    `SELECT c.user_sub FROM gc_user_connectors c
       LEFT JOIN gc_users u ON u.sub = c.user_sub
      WHERE c.provider=? AND c.shared=1 AND COALESCE(u.banned,0)=0 AND c.user_sub != ?
      ORDER BY c.user_sub ASC`,
    [provider, sub]
  );
  // La marca de compartida sólo vale si su dueño SIGUE conectado (en gs o en la copia vieja).
  for (const r of rows) if (r.user_sub && (await hasConnection(r.user_sub, provider))) return { ownerSub: r.user_sub, shared: true };
  return null;
}

/** Proveedores que este usuario puede usar: los suyos + los compartidos del workspace. */
export async function listAvailableProviders(sub: string): Promise<Set<string>> {
  // Mismo filtro de expulsados que `resolveConnectorOwner`, o se anunciarían tools que
  // luego no se pueden ejecutar.
  const out = await listConnectorProviders(sub);
  for (const [provider] of await listSharedConnectors()) out.add(provider);
  return out;
}

/** Prende o apaga el "es del equipo". NO toca el token ni ninguna otra columna. */
export async function setConnectorShared(
  ownerSub: string,
  provider: string,
  shared: boolean
): Promise<void> {
  // La marca puede no existir todavía (conectó en otro espacio y aquí nunca se usó).
  await ensureMarker(ownerSub, provider);
  await dbq("UPDATE gc_user_connectors SET shared=? WHERE user_sub=? AND provider=?", [
    shared ? 1 : 0,
    ownerSub,
    provider,
  ]);
}

/** Las compartidas del workspace → provider → sub del dueño. Para el panel. */
export async function listSharedConnectors(): Promise<Map<string, string>> {
  // Mismo desempate que `resolveConnectorOwner`, o el panel nombraría a una persona y el
  // agente usaría la conexión de otra. Y sin expulsados, y sólo si el dueño sigue conectado.
  if (await personal()) return new Map();
  const rows = await dbq(
    `SELECT c.user_sub, c.provider FROM gc_user_connectors c
       LEFT JOIN gc_users u ON u.sub = c.user_sub
      WHERE c.shared=1 AND COALESCE(u.banned,0)=0 ORDER BY c.user_sub ASC`
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.provider || !r.user_sub || out.has(r.provider)) continue;
    if (await hasConnection(r.user_sub, r.provider)) out.set(r.provider, r.user_sub);
  }
  return out;
}

export async function listConnectorHolders(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const add = (provider: string, sub: string) => {
    const lista = out.get(provider);
    if (!lista) out.set(provider, [sub]);
    else if (!lista.includes(sub)) lista.push(sub);
  };
  // Las de gs: de las personas de ESTE espacio (gs sólo contesta por miembros).
  const gente = await dbq("SELECT sub FROM gc_users WHERE COALESCE(banned,0)=0").catch(() => []);
  const subs = gente.map((g) => String(g.sub ?? "")).filter(Boolean);
  // Firma con alguien del espacio (gs exige que quien pregunta sea miembro): el primero que pase.
  for (const signer of subs.slice(0, 3)) {
    const r = await call<{ ok: boolean; holders?: Record<string, string[]> }>(signer, { action: "cred.holders", subs });
    if (!r?.ok) continue;
    for (const [sub, providers] of Object.entries(r.holders ?? {})) for (const p of providers) add(p, sub);
    break;
  }
  // Y las copias de antes que aún no suben.
  const rows = await dbq("SELECT user_sub, provider FROM gc_user_connectors WHERE access_token IS NOT NULL");
  for (const r of rows) if (r.provider && r.user_sub) add(r.provider, r.user_sub);
  return out;
}
