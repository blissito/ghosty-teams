import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// Server functions del framework de conectores per-user (Cowork). El browser NUNCA ve
// los tokens: el server los guarda en gc_user_connectors y el panel solo ve estado.
// Rutas OAuth genéricas: setup.$provider.connect / setup.$provider.callback.

// Estado de los conectores para el panel: mergea el registro (metadata) con lo que el
// usuario ACTUAL tiene conectado. `connected` refleja gc_user_connectors.
export const listMyConnectorsFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  const { CONNECTORS } = await import("./connectors/registry");
  let connected = new Set<string>();
  if (me) {
    const { listConnectorProviders } = await import("./connectors/store.server");
    connected = await listConnectorProviders(me.sub);
  }
  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    icon: c.icon,
    type: c.type,
    custom: !!c.custom,
    status: c.status,
    connected: connected.has(c.id),
  }));
});

// Inicia el OAuth de un proveedor: setea cookies (state, y verifier PKCE si aplica) y
// devuelve el authorize URL. Lo llama el loader de setup.$provider.connect.
export const startConnectFn = createServerFn({ method: "GET" })
  .validator((d: { provider: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { getConnector } = await import("./connectors/registry");
    const def = getConnector(data.provider);
    if (!def?.oauth) throw new Error("proveedor no disponible");

    const { setCookie } = await import("@tanstack/react-start/server");
    const { reqOrigin } = await import("../origin.server");
    const { randomState, pkce, buildAuthorizeUrl } = await import("./connectors/oauth.server");
    const appUrl = await reqOrigin();
    const redirectUri = `${appUrl}/setup/${def.id}/callback`;
    const state = randomState();
    setCookie("conn_state", state, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
    let challenge: string | undefined;
    if (def.oauth.pkce) {
      const p = pkce();
      setCookie("conn_pkce", p.verifier, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
      challenge = p.challenge;
    }
    return { url: buildAuthorizeUrl(def, redirectUri, state, challenge) };
  });

// Cierra el OAuth: valida state (cookie), intercambia code→token, captura external_id +
// meta del userinfo, y persiste para el usuario de la sesión. Lo llama el callback.
export const finishConnectFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string; code: string; state: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) return { ok: false as const };
    const { getConnector } = await import("./connectors/registry");
    const def = getConnector(data.provider);
    if (!def?.oauth) return { ok: false as const };

    const { getCookie } = await import("@tanstack/react-start/server");
    if (!data.code || data.state !== getCookie("conn_state")) return { ok: false as const };
    const verifier = def.oauth.pkce ? getCookie("conn_pkce") : undefined;

    const { reqOrigin } = await import("../origin.server");
    const { exchangeCode } = await import("./connectors/oauth.server");
    const { setConnectorRow } = await import("./connectors/store.server");
    const appUrl = await reqOrigin();
    const redirectUri = `${appUrl}/setup/${def.id}/callback`;
    const tok = await exchangeCode(def, redirectUri, data.code, verifier ?? undefined);
    const now = Math.floor(Date.now() / 1000);

    // userinfo → external_id (Calendly user URI) + meta (scheduling_url, etc.). Best-effort.
    let externalId: string | null = null;
    let meta: unknown = null;
    if (def.oauth.userInfoUrl) {
      try {
        const r = await fetch(def.oauth.userInfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        if (r.ok) {
          const j = (await r.json()) as { resource?: { uri?: string; scheduling_url?: string; name?: string; timezone?: string; current_organization?: string } };
          externalId = j.resource?.uri ?? null;
          meta = {
            scheduling_url: j.resource?.scheduling_url ?? null,
            name: j.resource?.name ?? null,
            timezone: j.resource?.timezone ?? null,
            organization: j.resource?.current_organization ?? null,
          };
        }
      } catch {}
    }

    await setConnectorRow({
      sub: me.sub,
      provider: def.id,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: tok.expires_in ? now + tok.expires_in : null,
      externalId,
      meta,
    });
    return { ok: true as const };
  });

// Desconecta un proveedor del usuario actual (borra su fila). El re-connect es inmediato.
export const disconnectConnectorFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { deleteConnectorRow } = await import("./connectors/store.server");
    await deleteConnectorRow(me.sub, data.provider);
    return { ok: true as const };
  });
