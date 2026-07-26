// Refresco del `meta` de un conector (lo que el userinfo del proveedor devolvió).
//
// El meta se capturaba UNA sola vez, al conectar (finishConnectFn), y quedaba
// congelado para siempre: la foto del día que el usuario autorizó. Si después
// creaba un negocio, cambiaba de rol o de cuenta activa, el agente seguía
// hablando de la realidad vieja — y la única salida era desconectar y reconectar.
//
// Genérico a propósito: cualquier conector que declare `userInfoUrl` +
// `parseUserInfo` en el registry lo hereda sin tocar su módulo.
//
// No hay cron en Teams, así que el refresco es OPORTUNISTA: se cuelga de caminos
// de request que ya ocurren (el contexto ambiente de cada turno y la renovación
// de token). Nunca lanza: un userinfo caído no debe tumbar un turno.

import { getConnector } from "./registry";
import { getConnectorRow, setConnectorMeta, touchConnectorMeta } from "./store.server";

const DEFAULT_TTL_S = 15 * 60;
const FETCH_TIMEOUT_MS = 3_000;

// Dedupe entre turnos concurrentes del mismo usuario. Se limpia en `finally`.
const inFlight = new Set<string>();

/** ¿Le toca refresco? NULL = nunca refrescado → sí (conexiones previas a meta_at). */
function isStale(metaAt: number | null, ttlS: number): boolean {
  if (metaAt == null) return true;
  return Math.floor(Date.now() / 1000) - metaAt >= ttlS;
}

/**
 * Relee el userinfo y reescribe el meta. Devuelve `true` si lo actualizó.
 *
 * Marca `meta_at` TAMBIÉN cuando falla, para no reintentar en cada turno contra
 * un proveedor caído.
 */
async function doRefresh(sub: string, provider: string): Promise<boolean> {
  const def = getConnector(provider);
  if (!def?.oauth?.userInfoUrl || !def.oauth.parseUserInfo) return false;

  const { getValidToken } = await import("./oauth.server");
  const token = await getValidToken(sub, provider);
  // Sin token la conexión ya murió (getValidToken borra la fila ante grant
  // inválido). No hay nada que refrescar ni a qué ponerle meta_at.
  if (!token) return false;

  try {
    const res = await fetch(def.oauth.userInfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await touchConnectorMeta(sub, provider);
      return false;
    }
    const parsed = def.oauth.parseUserInfo(await res.json());
    await setConnectorMeta(sub, provider, {
      meta: parsed.meta,
      externalId: parsed.externalId,
    });
    return true;
  } catch {
    await touchConnectorMeta(sub, provider).catch(() => {});
    return false;
  }
}

/**
 * Refresca el meta si venció.
 *
 * La primera vez (`meta_at` nulo) se ESPERA, para que las conexiones existentes
 * se auto-reparen en el mismo turno en vez del siguiente; ocurre una sola vez
 * por conexión. Después el refresco es fire-and-forget y el valor fresco entra
 * al turno siguiente, para no sumarle latencia a la respuesta.
 */
export async function refreshConnectorMetaIfStale(sub: string, provider: string): Promise<void> {
  try {
    const def = getConnector(provider);
    if (!def?.oauth?.userInfoUrl || !def.oauth.parseUserInfo) return;

    const row = await getConnectorRow(sub, provider);
    if (!row?.access_token) return;

    const ttl = def.oauth.metaTtlS ?? DEFAULT_TTL_S;
    if (!isStale(row.meta_at, ttl)) return;

    const key = `${sub}::${provider}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    const run = doRefresh(sub, provider).finally(() => inFlight.delete(key));

    if (row.meta_at == null) {
      await run; // primera vez: vale la pena esperar, es una sola vez
    } else {
      run.catch(() => {}); // vencido pero existente: no bloquear el turno
    }
  } catch {
    // Nunca romper el turno por esto.
  }
}

/**
 * Fuerza que el próximo `refreshConnectorMetaIfStale` sí refresque.
 *
 * Lo usa `getValidToken` tras renovar el token: si la credencial dio la vuelta,
 * es buen momento para asumir que el mundo del otro lado también cambió.
 *
 * Escribe 0, no NULL: NULL significa "nunca refrescado" y dispara el camino que
 * ESPERA, lo que le sumaría latencia a un turno cualquiera. 0 lo deja vencido
 * pero conocido → fire-and-forget.
 */
export async function invalidateConnectorMeta(sub: string, provider: string): Promise<void> {
  const { dbq } = await import("../../dbq.server");
  await dbq("UPDATE gc_user_connectors SET meta_at=0 WHERE user_sub=? AND provider=?", [
    sub,
    provider,
  ]).catch(() => {});
}
