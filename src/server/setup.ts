import { createServerFn } from "@tanstack/react-start";

// Resuelve el Bearer para operar la flota EasyBits del owner. Modelo multitenant
// nuevo: el provisioner siembra `eb_owner_key=1` y la caja lleva la key scoped del
// OWNER en `EASYBITS_API_KEY` — sirve como Bearer para /api/v2/fleet-agents (EB
// scopa por el userId de la key → fa.ownerId = owner). Legacy (sin el marcador):
// el OAuth in-chat del owner (`eb_access_token`). Devuelve null si ninguno aplica.
export function resolveFleetAuth(c: {
  eb_owner_key?: string;
  eb_access_token?: string;
}): string | null {
  if (c.eb_owner_key === "1" && process.env.EASYBITS_API_KEY) return process.env.EASYBITS_API_KEY;
  return c.eb_access_token ?? null;
}

// ── Vincular una cuenta de EasyBits ──────────────────────────────────────────
//
// Lo único que sobrevive del wizard de /setup (borrado el 2026-08-09, ver
// `routes/setup.index.tsx`). NO es alcanzable desde ninguna pantalla hoy: era el paso 1
// de ese wizard. Se conserva porque es el ÚNICO camino para re-vincular una cuenta de
// EasyBits, y hay un agente vivo que corre ahí (`baloo`, workspace `fit-and-geek`,
// `runtime = easybits`). Si algún día no queda ninguno, esto y `setup.easybits.*` se van
// juntos.
//
// Inicia OAuth con EasyBits (PKCE), setea cookies y devuelve el authorize URL.
export const startEasybitsConnect = createServerFn({ method: "GET" }).handler(async () => {
  const { setCookie } = await import("@tanstack/react-start/server");
  const { pkce, randomState, buildAuthorizeUrl } = await import("./easybits-oauth.server");
  const { reqOrigin } = await import("../origin.server");
  const appUrl = await reqOrigin();
  const redirectUri = `${appUrl}/setup/easybits/callback`;
  const { verifier, challenge } = pkce();
  const state = randomState();
  setCookie("eb_pkce", verifier, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
  setCookie("eb_state", state, { httpOnly: true, path: "/", maxAge: 600, sameSite: "lax" });
  return { url: await buildAuthorizeUrl(redirectUri, state, challenge) };
});

// Callback: valida state, intercambia code→token, guarda en gc_config.
export const finishEasybitsConnect = createServerFn({ method: "POST" })
  .validator((d: { code: string; state: string }) => d)
  .handler(async ({ data }) => {
    const { getCookie } = await import("@tanstack/react-start/server");
    const savedState = getCookie("eb_state");
    const verifier = getCookie("eb_pkce");
    if (!data.code || data.state !== savedState || !verifier) return { ok: false as const };
    const { exchangeCode } = await import("./easybits-oauth.server");
    const { reqOrigin } = await import("../origin.server");
    const appUrl = await reqOrigin();
    const accessToken = await exchangeCode(`${appUrl}/setup/easybits/callback`, data.code, verifier);
    // Adopción formal (fire-and-forget): transfiere la caja + DB de la cuenta de
    // PLATAFORMA a la del user recién conectado, y re-keyea esta caja con la key del
    // user. El endpoint reinicia ESTA caja al final → NO lo esperamos (nos mataría el
    // proceso antes de responder el callback). Solo si la caja conoce su sandboxId
    // (forward-only; sin él no hay rekey y reasignar la DB rompería la caja).
    void adoptTeamResources(accessToken).catch(() => {});
    return { ok: true as const };
  });

// Dispara la adopción contra EasyBits con la platform key (que esta caja YA tiene) +
// el token OAuth del user como prueba de consentimiento. Idempotente del lado server.
async function adoptTeamResources(accessToken: string): Promise<void> {
  const platformKey = process.env.EASYBITS_API_KEY;
  const dbId = process.env.EASYBITS_DB_ID;
  const sandboxId = process.env.EASYBITS_SANDBOX_ID;
  const base = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  if (!platformKey || !dbId || !sandboxId) return; // forward-only: teams sin sandboxId no adoptan
  await fetch(`${base}/api/v2/admin/adopt-team`, {
    method: "POST",
    headers: { Authorization: `Bearer ${platformKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ targetUserToken: accessToken, dbId, sandboxId }),
  });
}
