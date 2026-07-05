// Resolución y routing de agentes (multi-agente). El "ghosty" implícito del
// wizard (config) + los gc_agents extra (fleet o webhook). Módulo puro server
// (sin createServerFn) para que lo usen tanto chat.ts como server/agents.ts sin
// ciclos de import.

export type ResolvedAgent = {
  handle: string;
  name: string;
  avatar: string;
  backend:
    | { kind: "fleet"; id: string; token: string }
    | { kind: "webhook"; url: string };
};

// Agentes habilitados de la instancia: primero el del wizard, luego gc_agents.
export async function resolvedAgents(): Promise<ResolvedAgent[]> {
  const db = await import("./db.server");
  const { getGhostyFleet, getConfig } = await import("./config.server");
  const out: ResolvedAgent[] = [];
  const fleet = await getGhostyFleet();
  if (fleet) {
    const name = (await getConfig("fleet_name")) || "Ghosty";
    out.push({
      handle: db.GHOSTY_HANDLE,
      name,
      avatar: "/ghosty.svg",
      backend: { kind: "fleet", id: fleet.id, token: fleet.token },
    });
  }
  for (const a of await db.listAgents()) {
    if (!a.enabled) continue;
    if (a.kind === "webhook" && a.webhook_url) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", backend: { kind: "webhook", url: a.webhook_url } });
    } else if (a.fleet_id && a.fleet_token) {
      out.push({ handle: a.handle, name: a.name, avatar: a.avatar || "", backend: { kind: "fleet", id: a.fleet_id, token: a.fleet_token } });
    }
  }
  return out;
}

// ¿Qué agente se mencionó en el body? Devuelve el handle o null (el primero que
// aparezca, entre los habilitados). Case-insensitive, @handle con borde de palabra.
export function detectMention(body: string, handles: string[]): string | null {
  let best: { handle: string; idx: number } | null = null;
  for (const h of handles) {
    const re = new RegExp(`@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const m = body.match(re);
    if (m && m.index != null && (best === null || m.index < best.idx)) best = { handle: h, idx: m.index };
  }
  return best?.handle ?? null;
}

// Llama al backend del agente y devuelve su respuesta en texto.
export async function callAgentBackend(
  agent: ResolvedAgent,
  groupId: string,
  sender: string,
  text: string
): Promise<string> {
  if (agent.backend.kind === "webhook") {
    try {
      const res = await fetch(agent.backend.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, sender, text }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { reply?: string };
      return data.reply ?? "(sin respuesta)";
    } catch (e) {
      return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
    }
  }
  // fleet
  const base = process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud";
  try {
    const res = await fetch(`${base}/api/v2/fleet-agents/${agent.backend.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent.backend.token}` },
      body: JSON.stringify({ groupId, sender: sender || "invitado", text }),
    });
    if (!res.ok) throw new Error(`fleet ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { reply?: string }).reply ?? "(sin respuesta)";
  } catch (e) {
    return `⚠️ No pude contactar a @${agent.handle}: ${e instanceof Error ? e.message : e}`;
  }
}
