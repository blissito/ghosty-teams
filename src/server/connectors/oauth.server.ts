// Cliente OAuth GENÉRICO, data-driven por connectors/registry.ts. Calcado del molde
// de easybits-oauth.server.ts pero: (a) per-user (token → gc_user_connectors, no
// gc_config); (b) parametrizado por la def del proveedor (no un archivo por provider).
// Calendly = Authorization Code confidencial (client_secret_post), sin PKCE.
import crypto from "node:crypto";
import type { ConnectorDef } from "./registry";
import { getConnector } from "./registry";
import { getConnectorRow, setConnectorRow, deleteConnectorRow, forgetConnectorCache } from "./store.server";

const RENEW_BUFFER_S = 60; // refresca si al token le quedan < 60s

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`falta env ${name}`);
  return v;
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Multi-tenant: un solo redirect_uri global + state firmado ────────────────────
// El provider (Calendly) sólo deja registrar UN redirect_uri, pero cada workspace vive
// en su subdominio. Solución estándar: registramos el apex `${base}/oauth/$provider/
// callback`; el `state` lleva el workspace de origen (firmado) para que el relay del
// apex sepa a qué subdominio volver a cerrar el OAuth. Ver routes/oauth.$provider.callback.

// Base FIJA del redirect_uri (misma en authorize y en el token-exchange, requisito OAuth).
// CONNECTORS_CALLBACK_BASE en prod = https://teams.ghosty.studio; sin env (dev/single-
// tenant) cae al origin del request.
export function callbackBase(fallbackOrigin: string): string {
  return process.env.CONNECTORS_CALLBACK_BASE?.replace(/\/$/, "") || fallbackOrigin;
}

type StatePayload = { slug: string | null; nonce: string };
function stateSecret(): string {
  return envOrThrow("GHOSTY_PARTNER_SECRET");
}
// state = base64url(payload).hmac — el slug viaja firmado (no manipulable); el nonce se
// liga a una cookie httpOnly en el subdominio de origen (anti-CSRF, validado al cerrar).
export function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyState(state: string): StatePayload | null {
  const [body, sig] = (state || "").split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(def: ConnectorDef, redirectUri: string, state: string, challenge?: string): string {
  const o = def.oauth!;
  const p = new URLSearchParams({
    response_type: "code",
    client_id: envOrThrow(o.clientIdEnv),
    state,
  });
  if (!o.noRedirectUri) p.set("redirect_uri", redirectUri);
  if (o.scopes) p.set("scope", o.scopes);
  if (o.pkce && challenge) {
    p.set("code_challenge", challenge);
    p.set("code_challenge_method", "S256");
  }
  return `${o.authUrl}?${p}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

/**
 * Lee la respuesta del token endpoint y falla ruidosamente si trae un error.
 *
 * El RFC manda un 4xx, pero GitHub responde **200 con `{error: "..."}`** en el
 * cuerpo. Mirando sólo `res.ok` se persistía `access_token: undefined` como si
 * la renovación hubiera salido bien, y la conexión quedaba muerta sin que nada
 * lo dijera. El texto del throw incluye el código porque `getValidToken` decide
 * con él si borra la fila.
 */
async function readTokenResponse(res: Response, what: string): Promise<TokenResponse> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} ${res.status}: ${text.slice(0, 300)}`);
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${what}: respuesta no-JSON: ${text.slice(0, 200)}`);
  }
  if (j?.error) throw new Error(`${what}: ${j.error}${j.error_description ? ` — ${j.error_description}` : ""}`);
  if (!j?.access_token) throw new Error(`${what}: sin access_token`);
  return j as TokenResponse;
}

export async function exchangeCode(
  def: ConnectorDef,
  redirectUri: string,
  code: string,
  verifier?: string
): Promise<TokenResponse> {
  const o = def.oauth!;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: envOrThrow(o.clientIdEnv),
    client_secret: envOrThrow(o.clientSecretEnv),
  });
  if (!o.noRedirectUri) body.set("redirect_uri", redirectUri);
  if (o.pkce && verifier) body.set("code_verifier", verifier);
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(o.tokenHeaders ?? {}) },
    body,
  });
  return readTokenResponse(res, "oauth/token");
}

async function refresh(def: ConnectorDef, refreshToken: string): Promise<TokenResponse> {
  const o = def.oauth!;
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(o.tokenHeaders ?? {}) },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: envOrThrow(o.clientIdEnv),
      client_secret: envOrThrow(o.clientSecretEnv),
    }),
  });
  return readTokenResponse(res, "oauth/refresh");
}

// Access token válido para (sub, provider): usa el cacheado si no venció; si venció y
// hay refresh_token, refresca y re-persiste; ante grant inválido borra la fila (fuerza
// re-connect) y devuelve null. Es el único punto que el wrapper Calendly (Fase B) usa.
// Un refresh a la vez por (sub, provider). GitHub ROTA el refresh token: dos refrescos en
// paralelo con el mismo token → el segundo recibe `bad_refresh_token` y borraba la conexión
// aunque el primero acababa de guardar una buena (business perdió GitHub así, 30-sep).
const refreshing = new Map<string, Promise<string | null>>();

export async function getValidToken(sub: string, provider: string): Promise<string | null> {
  // ⚠️ Por persona y proveedor, NO por espacio (3-nov). Desde el 3-oct la fila vive en gs y es
  // la MISMA para todos los espacios de la persona: con la llave por espacio, business y denik
  // refrescaban a la vez el mismo refresh token, GitHub rotaba, el segundo recibía
  // `bad_refresh_token` y borraba la conexión buena (así se cayó el GitHub de Brenda, 3-nov).
  // Si dos espacios tienen fijadas cuentas distintas se serializan de más; es barato.
  const key = `${sub}:${provider}`;
  const inflight = refreshing.get(key);
  if (inflight) return inflight;
  const p = getValidTokenOnce(sub, provider).finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  return p;
}

async function getValidTokenOnce(sub: string, provider: string): Promise<string | null> {
  const def = getConnector(provider);
  if (!def?.oauth) return null;
  const row = await getConnectorRow(sub, provider);
  if (!row?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at == null || row.expires_at - now > RENEW_BUFFER_S) return row.access_token;
  if (!row.refresh_token) return row.access_token; // sin refresh → intenta con el actual
  try {
    const j = await refresh(def, row.refresh_token);
    const saved = await setConnectorRow({
      sub,
      provider,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? row.refresh_token,
      expiresAt: j.expires_in ? now + j.expires_in : null,
      // CAS: si otro proceso ya rotó (la fila es global desde el 3-oct), no se pisa la suya.
      ifRefresh: row.refresh_token,
      ...(typeof row.account === "string" ? { account: row.account } : {}),
    });
    if (saved === "stale") {
      forgetConnectorCache(sub, provider);
      const otra = await getConnectorRow(sub, provider).catch(() => null);
      return otra?.access_token ?? j.access_token;
    }
    // Si la credencial dio la vuelta, asumimos que el mundo del otro lado pudo
    // cambiar: marcamos el `meta` como vencido para que se relea. Sin bloquear
    // — el refresco real ocurre en el próximo turno. Ver connectors/meta.server.ts.
    import("./meta.server")
      .then((m) => m.invalidateConnectorMeta(sub, provider))
      .catch(() => {});
    return j.access_token;
  } catch (e) {
    // `bad_refresh_token` / `bad_verification_code` son de GitHub, que además
    // los manda con status 200 (ver readTokenResponse). Sin ellos la fila muerta
    // se quedaba para siempre y cada turno reintentaba un refresh imposible.
    if (/invalid_grant|invalid_token|bad_refresh_token|bad_verification_code|\b400\b|\b401\b/.test(String(e))) {
      // Otro proceso (o el deploy blue/green) ya lo refrescó: la fila trae un refresh token
      // distinto al que usamos. Ése es el bueno; borrar aquí tiraba la conexión viva.
      // Sin caché: la fila es global y otro proceso pudo rotarla hace un segundo.
      forgetConnectorCache(sub, provider);
      const now2 = await getConnectorRow(sub, provider).catch(() => null);
      if (now2?.access_token && now2.refresh_token !== row.refresh_token) return now2.access_token;
      // Otro proceso (el relevo azul/verde, gs) puede estar a media rotación: todavía no guarda el
      // token nuevo. Se espera y se relee UNA vez antes de dar la conexión por muerta (Coder #17069).
      await new Promise((r) => setTimeout(r, 2500));
      forgetConnectorCache(sub, provider);
      const now3 = await getConnectorRow(sub, provider).catch(() => null);
      if (now3?.access_token && now3.refresh_token !== row.refresh_token) return now3.access_token;
      // Borrar era mudo: nadie sabía por qué alguien quedaba sin GitHub. Ahora deja rastro.
      console.warn(`[connector] borro ${provider} de ${sub}: el refresco falló (${String(e).slice(0, 160)})`);
      await deleteConnectorRow(sub, provider).catch(() => {}); // gs caído: se reintenta en el siguiente turno
      return null;
    }
    return row.access_token; // error transitorio → reintenta el próximo turno
  }
}
