import crypto from "node:crypto";
import { getConfig, setConfig } from "../config.server";

// Cliente OAuth 2.1 (PKCE + DCR) de EasyBits. Espejo de lo que Formmy ya hace
// (server/integrations/easybits/oauth.server.ts). El owner conecta SU EasyBits;
// guardamos su access token en gc_config (cloud-native, en la DB no en compute).
const EB = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";

export function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

// Registro dinámico (RFC 7591), una vez por redirectUri. Persistido en gc_config.
async function ensureClient(redirectUri: string): Promise<{ id: string; secret: string }> {
  const existingId = await getConfig("eb_client_id");
  const existingSecret = await getConfig("eb_client_secret");
  const existingRedirect = await getConfig("eb_client_redirect");
  if (existingId && existingSecret && existingRedirect === redirectUri) {
    return { id: existingId, secret: existingSecret };
  }
  const res = await fetch(`${EB}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Ghosty Chat",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  if (!res.ok) throw new Error(`oauth/register ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { client_id: string; client_secret: string };
  await setConfig("eb_client_id", j.client_id);
  await setConfig("eb_client_secret", j.client_secret);
  await setConfig("eb_client_redirect", redirectUri);
  return { id: j.client_id, secret: j.client_secret };
}

export async function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  challenge: string
): Promise<string> {
  const client = await ensureClient(redirectUri);
  const p = new URLSearchParams({
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: "mcp",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${EB}/oauth/authorize?${p}`;
}

// Intercambia code→token y lo persiste en gc_config. Devuelve el access token.
export async function exchangeCode(
  redirectUri: string,
  code: string,
  verifier: string
): Promise<string> {
  const clientId = await getConfig("eb_client_id");
  const clientSecret = await getConfig("eb_client_secret");
  const res = await fetch(`${EB}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId!,
      client_secret: clientSecret!,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`oauth/token ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  await setConfig("eb_access_token", j.access_token);
  if (j.refresh_token) await setConfig("eb_refresh_token", j.refresh_token);
  await setConfig("eb_connected", "1");
  return j.access_token;
}

// Lista los fleet agents del owner con su token OAuth (para el paso 2 del wizard).
export async function listFleetAgents(accessToken: string) {
  const res = await fetch(`${EB}/api/v2/fleet-agents`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`fleet-agents ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { pools?: Array<{ id: string; name: string; assistantName?: string; token: string; workerTemplate?: string }> };
  return j.pools ?? [];
}

// Motores ofrecidos al crear el @ghosty inicial del team. DeepSeek Flash = default
// (modelo rápido, ~3s warm, ~4× vs sonnet-5 — Teams prioriza latencia de chat);
// Claude Sonnet = más capaz + sesión persistente, piso ~13s. El create endpoint
// resuelve `engine` → template + env (deepseek→ghosty-gc, claude→claude-worker).
export const AGENT_ENGINES = {
  deepseek: { engine: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek Flash (rápido)" },
  claude: { engine: "claude", model: "claude-sonnet-5", label: "Claude Sonnet (capaz)" },
} as const;
export type AgentEngineId = keyof typeof AGENT_ENGINES;

// Nombre único y legible para el @ghosty sugerido, p.ej. "Ghosty-teams-nocturno".
// Evita colisiones entre teams/agentes del mismo owner sin pedirle nada al user.
const NAME_WORDS = [
  "nocturno", "solar", "lunar", "boreal", "austral", "cobalto", "ambar", "carmesi",
  "esmeralda", "indigo", "cometa", "nimbo", "aurora", "cenit", "onix", "zafiro",
  "quasar", "vega", "orion", "delta",
];
export function suggestAgentName() {
  const w = NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)];
  const s = Math.random().toString(36).slice(2, 5); // 3 chars → unicidad dura
  return `Ghosty-teams-${w}-${s}`;
}

export async function createFleetAgent(
  accessToken: string,
  opts: { name?: string; systemPrompt?: string; engine?: AgentEngineId } = {},
) {
  const spec = AGENT_ENGINES[opts.engine ?? "deepseek"];
  const name = opts.name ?? suggestAgentName();
  const res = await fetch(`${EB}/api/v2/fleet-agents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      engine: spec.engine,
      model: spec.model,
      systemPrompt: opts.systemPrompt,
    }),
  });
  if (!res.ok) throw new Error(`fleet-agents create ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as {
    fleetAgent?: { id: string; name: string; assistantName?: string; token: string };
  };
  if (!j.fleetAgent) throw new Error("create: respuesta sin fleetAgent");
  return j.fleetAgent;
}
