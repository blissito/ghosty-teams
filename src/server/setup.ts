import { createServerFn } from "@tanstack/react-start";

// Estado del wizard (para el loader de /setup).
export const getSetup = createServerFn({ method: "GET" }).handler(async () => {
  const { getConfigMany } = await import("../config.server");
  const c = await getConfigMany(["eb_connected", "eb_access_token", "fleet_agent_id", "fleet_name"]);
  const connected = c.eb_connected === "1";
  const hasAgent = !!c.fleet_agent_id;
  let agents: Array<{ id: string; name: string; assistantName?: string; workerTemplate?: string }> = [];
  if (connected && !hasAgent && c.eb_access_token) {
    const { listFleetAgents } = await import("./easybits-oauth.server");
    agents = (await listFleetAgents(c.eb_access_token)).map((a) => ({
      id: a.id,
      name: a.name,
      assistantName: a.assistantName,
      workerTemplate: a.workerTemplate,
    }));
  }
  return { connected, hasAgent, fleetName: c.fleet_name, agents };
});

// Paso 1: inicia OAuth con EasyBits (PKCE), setea cookies y devuelve el authorize URL.
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

// Paso 2: el owner elige su agente Ghosty → guardamos id + pool token.
export const selectFleetAgent = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { getConfig, setConfig } = await import("../config.server");
    const token = await getConfig("eb_access_token");
    if (!token) throw new Error("EasyBits no conectado");
    const { listFleetAgents } = await import("./easybits-oauth.server");
    const agent = (await listFleetAgents(token)).find((a) => a.id === data.id);
    if (!agent) throw new Error("Agente no encontrado");
    await setConfig("fleet_agent_id", agent.id);
    await setConfig("fleet_token", agent.token);
    await setConfig("fleet_name", agent.assistantName || agent.name);
    return { ok: true as const };
  });
