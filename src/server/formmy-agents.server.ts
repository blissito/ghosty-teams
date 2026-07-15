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
export const connectFormmyAgentFn = createServerFn({ method: "POST" })
  .validator((d: { agentId: string; name?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await ownerContext();
    if (!ctx) throw new Error("solo el owner conecta agentes");
    const res = await partnerCall({
      email: ctx.email,
      origin: ctx.origin,
      intent: "ensure",
      agentId: data.agentId,
    });
    if (res.status === 409) return { ok: false as const, needsOAuth: true as const };
    if (!res.ok) throw new Error(`formmy ensure ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { ok?: boolean; fleetId?: string; fleetToken?: string };
    if (!j.ok || !j.fleetId || !j.fleetToken) throw new Error("espejo de flota no disponible");
    const { setConfig } = await import("../config.server");
    await setConfig("fleet_agent_id", j.fleetId);
    await setConfig("fleet_token", j.fleetToken);
    await setConfig("fleet_name", (data.name || "Ghosty").trim() || "Ghosty");
    return { ok: true as const };
  });
