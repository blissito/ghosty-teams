// Cliente OAuth GENÉRICO, data-driven por connectors/registry.ts. Calcado del molde
// de easybits-oauth.server.ts pero: (a) per-user (token → gc_user_connectors, no
// gc_config); (b) parametrizado por la def del proveedor (no un archivo por provider).
// Calendly = Authorization Code confidencial (client_secret_post), sin PKCE.
import crypto from "node:crypto";
import type { ConnectorDef } from "./registry";
import { getConnector } from "./registry";
import { getConnectorRow, setConnectorRow, deleteConnectorRow } from "./store.server";

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
    redirect_uri: redirectUri,
    state,
  });
  if (o.scopes) p.set("scope", o.scopes);
  if (o.pkce && challenge) {
    p.set("code_challenge", challenge);
    p.set("code_challenge_method", "S256");
  }
  return `${o.authUrl}?${p}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

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
    redirect_uri: redirectUri,
    client_id: envOrThrow(o.clientIdEnv),
    client_secret: envOrThrow(o.clientSecretEnv),
  });
  if (o.pkce && verifier) body.set("code_verifier", verifier);
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`oauth/token ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

async function refresh(def: ConnectorDef, refreshToken: string): Promise<TokenResponse> {
  const o = def.oauth!;
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: envOrThrow(o.clientIdEnv),
      client_secret: envOrThrow(o.clientSecretEnv),
    }),
  });
  if (!res.ok) throw new Error(`oauth/refresh ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

// Access token válido para (sub, provider): usa el cacheado si no venció; si venció y
// hay refresh_token, refresca y re-persiste; ante grant inválido borra la fila (fuerza
// re-connect) y devuelve null. Es el único punto que el wrapper Calendly (Fase B) usa.
export async function getValidToken(sub: string, provider: string): Promise<string | null> {
  const def = getConnector(provider);
  if (!def?.oauth) return null;
  const row = await getConnectorRow(sub, provider);
  if (!row?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at == null || row.expires_at - now > RENEW_BUFFER_S) return row.access_token;
  if (!row.refresh_token) return row.access_token; // sin refresh → intenta con el actual
  try {
    const j = await refresh(def, row.refresh_token);
    await setConnectorRow({
      sub,
      provider,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? row.refresh_token,
      expiresAt: j.expires_in ? now + j.expires_in : null,
    });
    return j.access_token;
  } catch (e) {
    if (/invalid_grant|invalid_token|\b400\b|\b401\b/.test(String(e))) {
      await deleteConnectorRow(sub, provider);
      return null;
    }
    return row.access_token; // error transitorio → reintenta el próximo turno
  }
}
