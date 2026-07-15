import { createServerFn } from "@tanstack/react-start";

// Puente al endpoint partner de Formmy (box→Formmy, HMAC ghosty-chat): lista los
// Agents de Formmy del owner y asegura su FleetAgent espejo. El "agente de verdad"
// corre en la flota EasyBits (microVM); el Agent de Formmy y el @ghosty de Teams lo
// reflejan. Ver Formmy `app/routes/api.v1.teams.agents.ts`.

// process.env se lee DENTRO de las funciones (solo corren en server): este módulo se
// importa estáticamente desde el wizard (cliente) y `process` no existe en el browser.
async function partnerCall(body: Record<string, unknown>): Promise<Response> {
  const crypto = await import("node:crypto");
  const FORMMY = process.env.FORMMY_BASE_URL ?? "https://formmy.app";
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", process.env.FORMMY_PARTNER_SECRET_GHOSTY!)
    .update(`${ts}.${raw}`)
    .digest("hex");
  return fetch(`${FORMMY}/api/v1/teams/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-Id": "ghosty-chat",
      "X-Partner-Timestamp": String(ts),
      "X-Partner-Signature": sig,
    },
    body: raw,
  });
}

// El owner del team (sesión) → su email (join key con el User de Formmy) + el origin
// estable del box (para el redirectUri del refresh OAuth del lado Formmy).
async function ownerContext(): Promise<{ email: string; origin: string } | null> {
  const { sessionUser } = await import("./chat");
  const user = await sessionUser();
  if (!user?.isOwner) return null;
  const { dbq } = await import("../dbq.server");
  const rows = await dbq("SELECT email FROM gc_users WHERE sub = ?", [user.sub]);
  const email = rows[0]?.email;
  if (!email) return null;
  const { reqOrigin } = await import("../origin.server");
  const origin = await reqOrigin();
  return { email, origin };
}

// Resuelve un token EasyBits FRESCO de la conexión de GTeams (este box) para pasárselo a
// Formmy y que cree/reconcilie el fleet con NUESTRA conexión (no la de Formmy, que puede
// estar caducada / con otro client OAuth → el bug "Conecta tu EasyBits" falso).
// - `eb_owner_key`: la key durable del owner (no expira) → ideal.
// - si no, el `eb_access_token` OAuth REFRESCADO con el client propio del box (sin mismatch).
async function resolveEbToken(): Promise<string | null> {
  const { getConfigMany } = await import("../config.server");
  const c = await getConfigMany(["eb_access_token", "eb_owner_key"]);
  if (c.eb_owner_key === "1" && process.env.EASYBITS_API_KEY) return process.env.EASYBITS_API_KEY;
  if (c.eb_access_token) {
    const { refreshOwnerToken } = await import("./easybits-files.server");
    const fresh = await refreshOwnerToken().catch(() => null);
    return fresh || c.eb_access_token;
  }
  return null;
}

export type FormmyAgent = { id: string; name: string; hasFleetMirror: boolean };

// Lista los Agents de Formmy del owner (para el wizard "agregar agente"). Marca cuáles
// ya tienen espejo en la flota. Degrada a [] si el puente falla (no tumba el wizard).
export const listFormmyAgentsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<FormmyAgent[]> => {
    const ctx = await ownerContext();
    if (!ctx) return [];
    try {
      const res = await partnerCall({ email: ctx.email, origin: ctx.origin, intent: "list" });
      if (!res.ok) return [];
      const j = (await res.json()) as { agents?: FormmyAgent[] };
      return j.agents ?? [];
    } catch {
      return [];
    }
  },
);

// Conecta un Agent de Formmy a este team: asegura su FleetAgent espejo (bajo la cuenta
// del owner) y cablea el @ghosty en gc_config. `needsOAuth` si el owner no tiene EasyBits
// conectado del lado Formmy (no debería pasar en el flujo nuevo, pero lo señalamos).
// Asegura el espejo en la flota de un Agent de Formmy y devuelve su fleetId (SIN tocar
// gc_config) — para "Agregar agente" en Ajustes: luego createAgentFn crea la fila gc_agents
// con ese fleetId (el token lo resuelve de la flota del owner). Distinto de connectFormmyAgentFn,
// que cablea el @ghosty del wizard.
export const ensureFormmyMirrorFn = createServerFn({ method: "POST" })
  .validator((d: { agentId: string; engine?: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; fleetId: string } | { ok: false; needsOAuth?: boolean }> => {
    const ctx = await ownerContext();
    if (!ctx) return { ok: false };
    const ebToken = await resolveEbToken();
    const res = await partnerCall({
      email: ctx.email,
      origin: ctx.origin,
      intent: "ensure",
      agentId: data.agentId,
      ebToken: ebToken ?? undefined,
      engine: data.engine,
    });
    if (res.status === 409) return { ok: false, needsOAuth: true };
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { ok?: boolean; fleetId?: string };
    if (!j.ok || !j.fleetId) return { ok: false };
    return { ok: true, fleetId: j.fleetId };
  });

export const connectFormmyAgentFn = createServerFn({ method: "POST" })
  .validator((d: { agentId: string; name?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await ownerContext();
    if (!ctx) throw new Error("solo el owner conecta agentes");
    const ebToken = await resolveEbToken();
    const res = await partnerCall({
      email: ctx.email,
      origin: ctx.origin,
      intent: "ensure",
      agentId: data.agentId,
      ebToken: ebToken ?? undefined,
    });
    if (res.status === 409) return { ok: false as const, needsOAuth: true as const };
    if (!res.ok) throw new Error(`formmy ensure ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { ok?: boolean; fleetId?: string; fleetToken?: string };
    if (!j.ok || !j.fleetId || !j.fleetToken) throw new Error("espejo de flota no disponible");
    const { setConfig } = await import("../config.server");
    await setConfig("fleet_agent_id", j.fleetId);
    await setConfig("fleet_token", j.fleetToken);
    await setConfig("fleet_name", (data.name || "Ghosty").trim() || "Ghosty");
    // Marca el canal Teams conectado de una (sin esperar el primer mensaje). Best-effort.
    const { connectTeamsChannel } = await import("./agent-config");
    await connectTeamsChannel(j.fleetId, j.fleetToken);
    return { ok: true as const };
  });
