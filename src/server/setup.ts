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

// Estado del wizard (para el loader de /setup).
export const getSetup = createServerFn({ method: "GET" }).handler(async () => {
  const { getConfigMany } = await import("../config.server");
  const c = await getConfigMany(["eb_connected", "eb_access_token", "eb_owner_key", "fleet_agent_id", "fleet_name"]);
  const connected = c.eb_connected === "1";
  const hasAgent = !!c.fleet_agent_id;
  const fleetAuth = resolveFleetAuth(c);
  // Traemos los agentes SIEMPRE que haya conexión (no solo en paso 2): así "← Cambiar
  // agente" puede volver al paso 2 con la lista ya cargada, sin recargar la página.
  let agents: Array<{ id: string; name: string; assistantName?: string; workerTemplate?: string }> = [];
  if (connected && fleetAuth) {
    // La lista de agentes de la flota es SOLO para el picker del wizard; `hasAgent` ya
    // viene de la DB (fleet_agent_id). Si la API de flota falla (token OAuth expirado →
    // 401, red, etc.) NO debe tumbar la app: el loader de `/` llama a getSetup en cada
    // carga fresca (box recién revivido) y un throw aquí caía SIEMPRE en el AppError.
    // Degradamos a lista vacía; el chat carga igual (el wizard solo se ve si !hasAgent).
    try {
      const { listFleetAgents } = await import("./easybits-oauth.server");
      const fetchAgents = async (tok: string) =>
        (await listFleetAgents(tok)).map((a) => ({
          id: a.id,
          name: a.name,
          assistantName: a.assistantName,
          workerTemplate: a.workerTemplate,
        }));
      try {
        agents = await fetchAgents(fleetAuth);
      } catch (e) {
        // 401 → el access token caducó: refrescamos con el refresh_token y reintentamos
        // (así el wizard/dropdown reaparecen sin re-conectar a mano). Requiere connect
        // completo previo (client creds + refresh_token en config).
        if (!String(e).includes("401")) throw e;
        const { refreshOwnerToken } = await import("./easybits-files.server");
        const fresh = await refreshOwnerToken();
        if (fresh) agents = await fetchAgents(fresh);
      }
    } catch (e) {
      console.error("[getSetup] listFleetAgents falló (degradando a []):", e instanceof Error ? e.message : e);
    }
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

// Paso 2 (alterno): crear un @ghosty nuevo desde el wizard. engine "deepseek"
// (default, rápido) o "claude". El motor se puede cambiar después recreando el
// agente; el MODELO dentro del motor se ajusta en /dash/flota (set-model).
export const createFleetAgent = createServerFn({ method: "POST" })
  .validator((d: { engine?: "deepseek" | "claude" }) => d)
  .handler(async ({ data }) => {
    const { getConfigMany, setConfig } = await import("../config.server");
    const c = await getConfigMany(["eb_access_token", "eb_owner_key"]);
    const token = resolveFleetAuth(c);
    if (!token) throw new Error("EasyBits no conectado");
    const { createFleetAgent: create } = await import("./easybits-oauth.server");
    const agent = await create(token, { engine: data.engine ?? "deepseek" });
    // Nombre visible = "Ghosty" (marca), NO el nombre crudo del pool (ej. "Ghosty-teams-
    // onix-yy4"). El owner puede renombrarlo en Ajustes → Agentes.
    const name = agent.assistantName || "Ghosty";
    await setConfig("fleet_agent_id", agent.id);
    await setConfig("fleet_token", agent.token);
    await setConfig("fleet_name", name);
    return { ok: true as const, name };
  });

// Volver: desconectar el agente (paso 3 → paso 2) o EasyBits entero (→ paso 1).
// Limpia las llaves del wizard en gc_config poniéndolas en "" (getSetup gatea por
// verdad/no-vacío). NO borra el FleetAgent ni la cuenta — solo "olvida" el wiring;
// el agente sigue en /dash/flota, reusable. `scope` = "agent" | "easybits".
export const disconnectSetup = createServerFn({ method: "POST" })
  .validator((d: { scope?: "agent" | "easybits" }) => d)
  .handler(async ({ data }) => {
    const { setConfig } = await import("../config.server");
    const keys =
      data.scope === "easybits"
        ? ["fleet_agent_id", "fleet_token", "fleet_name", "eb_connected", "eb_access_token", "eb_refresh_token"]
        : ["fleet_agent_id", "fleet_token", "fleet_name"];
    for (const k of keys) await setConfig(k, "");
    return { ok: true as const };
  });

// Paso 2: el owner elige su agente Ghosty → guardamos id + pool token.
export const selectFleetAgent = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { getConfigMany, setConfig } = await import("../config.server");
    const c = await getConfigMany(["eb_access_token", "eb_owner_key"]);
    const token = resolveFleetAuth(c);
    if (!token) throw new Error("EasyBits no conectado");
    const { listFleetAgents } = await import("./easybits-oauth.server");
    const agent = (await listFleetAgents(token)).find((a) => a.id === data.id);
    if (!agent) throw new Error("Agente no encontrado");
    await setConfig("fleet_agent_id", agent.id);
    await setConfig("fleet_token", agent.token);
    // Nombre visible = "Ghosty" (marca), NO el nombre crudo del pool (ej. "Ghosty-teams-
    // onix-yy4"). assistantName suele ser "Ghosty"; si no, fallback a "Ghosty". El owner
    // puede renombrarlo en Ajustes → Agentes.
    await setConfig("fleet_name", agent.assistantName || "Ghosty");
    return { ok: true as const };
  });
