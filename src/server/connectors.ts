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
  // ⚠️ Antes esto degradaba sin sesión (todo `connected:false`). Ya no puede: con
  // `holders` dentro, un anónimo se llevaría el padrón del workspace.
  if (!me) throw new Error("no autenticado");
  const { listConnectorProviders, listConnectorHolders } = await import("./connectors/store.server");
  const [connected, holders] = await Promise.all([listConnectorProviders(me.sub), listConnectorHolders()]);

  // Quién MÁS del equipo tiene cada conector. Se resuelve aquí y no en el cliente porque
  // `listWorkspaceUsers` ya filtra a los baneados y no expone correos.
  const { listWorkspaceUsers } = await import("../users.server");
  const gente = new Map((await listWorkspaceUsers()).map((u) => [u.sub, u]));

  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    icon: c.icon,
    type: c.type,
    custom: !!c.custom,
    status: c.status,
    manage: c.manage ?? null,
    connected: connected.has(c.id),
    // Sin mí (ya salgo como "Conectado") y sin correo. Un sub sin fila en el padrón —
    // baneado, o alguien que nunca abrió Teams— se descarta en vez de pintarse vacío.
    holders: (holders.get(c.id) ?? [])
      .filter((s) => s !== me.sub)
      .map((s) => gente.get(s))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => ({ sub: u.sub, name: u.name, avatar: u.avatar })),
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
    const { currentSlug } = await import("./tenant.server");
    const { randomState, pkce, buildAuthorizeUrl, callbackBase, signState } = await import("./connectors/oauth.server");
    const appUrl = await reqOrigin();
    // redirect_uri GLOBAL (apex) — el mismo registrado en el provider, no el subdominio.
    const redirectUri = `${callbackBase(appUrl)}/oauth/${def.id}/callback`;
    // El workspace de origen viaja firmado en el state → el relay del apex sabe a qué
    // subdominio volver. El nonce se liga a la cookie (validada al cerrar en el subdominio).
    const slug = await currentSlug().catch(() => null);
    const nonce = randomState();
    const state = signState({ slug, nonce });
    setCookie("conn_state", nonce, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
    let challenge: string | undefined;
    if (def.oauth.pkce) {
      const p = pkce();
      setCookie("conn_pkce", p.verifier, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
      challenge = p.challenge;
    }
    return { url: buildAuthorizeUrl(def, redirectUri, state, challenge) };
  });

// Relay central: el redirect global (oauth.teams.ghosty.studio/oauth/$provider/callback)
// no tiene sesión ni tenant. Verifica el state firmado, saca el workspace de origen y
// devuelve la URL del subdominio donde /setup/$provider/callback SÍ cierra el OAuth
// (con sesión + cookies + namespace). Sin slug (dev/single-tenant) → mismo origin.
export const relayConnectorFn = createServerFn({ method: "GET" })
  .validator((d: { provider: string; code: string; state: string }) => d)
  .handler(async ({ data }) => {
    const { verifyState } = await import("./connectors/oauth.server");
    const parsed = verifyState(data.state);
    const ROOT = process.env.TEAMS_ROOT_DOMAIN ?? "teams.ghosty.studio";
    const qs = `?code=${encodeURIComponent(data.code)}&state=${encodeURIComponent(data.state)}`;
    const path = `/setup/${encodeURIComponent(data.provider)}/callback${qs}`;
    return { target: parsed?.slug ? `https://${parsed.slug}.${ROOT}${path}` : path };
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
    const { exchangeCode, callbackBase, verifyState } = await import("./connectors/oauth.server");
    // Valida el state firmado y liga su nonce a la cookie del subdominio (anti-CSRF).
    const parsed = verifyState(data.state);
    if (!data.code || !parsed || parsed.nonce !== getCookie("conn_state")) return { ok: false as const };
    const verifier = def.oauth.pkce ? getCookie("conn_pkce") : undefined;

    const { reqOrigin } = await import("../origin.server");
    const { setConnectorRow } = await import("./connectors/store.server");
    const appUrl = await reqOrigin();
    // MISMO redirect_uri global que en authorize (requisito del token-exchange OAuth).
    const redirectUri = `${callbackBase(appUrl)}/oauth/${def.id}/callback`;
    const tok = await exchangeCode(def, redirectUri, data.code, verifier ?? undefined);
    const now = Math.floor(Date.now() / 1000);

    // userinfo → external_id + meta, con el parser QUE DECLARA EL CONECTOR: cada proveedor
    // devuelve una forma distinta, así que traducirla es cosa suya (registry.ts), no de aquí.
    // Best-effort: si el userinfo falla, la conexión igual queda hecha.
    let externalId: string | null = null;
    let meta: unknown = null;
    if (def.oauth.userInfoUrl && def.oauth.parseUserInfo) {
      try {
        const r = await fetch(def.oauth.userInfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        if (r.ok) {
          const parsed = def.oauth.parseUserInfo(await r.json());
          externalId = parsed.externalId;
          meta = parsed.meta;
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

// Desconecta un proveedor del usuario actual. El re-connect es inmediato.
//
// Además de borrar la fila, REVOCA el token contra el proveedor si éste declara
// `revokeUrl`: sin eso "Desconectar" sólo significa "dejo de usarlo", y el token
// seguiría siendo válido allá hasta expirar. Con permisos amplios eso no basta.
export const disconnectConnectorFn = createServerFn({ method: "POST" })
  .validator((d: { provider: string }) => d)
  .handler(async ({ data }) => {
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    const { deleteConnectorRow, getConnectorRow } = await import("./connectors/store.server");
    const { getConnector } = await import("./connectors/registry");

    const def = getConnector(data.provider);
    const revokeUrl = def?.oauth?.revokeUrl;
    if (revokeUrl) {
      // Best-effort y ANTES de borrar (después ya no hay token que mandar). Que
      // el proveedor esté caído no debe impedir desconectar del lado de Teams.
      try {
        const row = await getConnectorRow(me.sub, data.provider);
        const token = row?.refresh_token || row?.access_token;
        if (token) {
          await fetch(revokeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: process.env[def!.oauth!.clientIdEnv] ?? "",
              client_secret: process.env[def!.oauth!.clientSecretEnv] ?? "",
              token,
            }),
          });
        }
      } catch (e) {
        console.warn(`[connectors] revoke de ${data.provider} falló:`, e);
      }
    }

    await deleteConnectorRow(me.sub, data.provider);
    return { ok: true as const };
  });
