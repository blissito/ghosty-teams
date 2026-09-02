// ── Revivir la caja de un agente ACP ──────────────────────────────────────────────
//
// La identidad de un agente ACP es su DOMINIO (`acp-<id>.…`), no su caja: el host mueve el
// dominio de una caja a otra. Cuando el host ya no tiene la caja (janitor a las 72 h,
// rebake, restart), alguien tiene que recrearla, y ese alguien es quien la creó: Studio
// para los suyos (`/acp-box`, HMAC de partner) y EasyBits para los suyos (`/revive`, con el
// bearer del propio agente). Teams sólo guarda a quién pedírselo.
//
// Es el mismo reparto que Slack o MS Teams con un bot: la plataforma guarda un id y un
// endpoint estable; el proveedor del bot resuelve la vida de su proceso.

const EASYBITS_BASE = (process.env.EASYBITS_BASE_URL || "https://www.easybits.cloud").replace(/\/+$/, "");

/**
 * Deduce el endpoint de revive a partir de la URL del socket, cuando se reconoce al dueño de
 * la caja. Hoy: el dominio fijo de EasyBits (`acp-<agentId>.<dominio>`). Una `sb-<id>-…`
 * lleva el sandboxId dentro y no tiene identidad que revivir: devuelve `null`, y el fallo se
 * dirá tal cual.
 */
export function deriveReviveUrl(wsUrl: string): string | null {
  let host = "";
  try {
    host = new URL(wsUrl.replace(/^ws/, "http")).host;
  } catch {
    return null;
  }
  const m = /^acp-([a-f0-9]{24})\./i.exec(host);
  if (!m) return null;
  return `${EASYBITS_BASE}/api/v2/agents/${m[1]}/revive`;
}

/**
 * Pide la caja fresca. Distingue al dueño por la forma del endpoint: el de Studio va firmado
 * como partner; cualquier otro, con el bearer del agente. Espera hasta 150 s: la caja tiene
 * que bootear y contestar el handshake antes de que el turno se reintente.
 */
export async function reviveAcpBox(o: {
  reviveUrl: string | null | undefined;
  fleetId?: string;
  token?: string;
  handle: string;
}): Promise<void> {
  if (!o.reviveUrl) {
    throw new Error("nadie puede volver a levantarla: este agente no tiene endpoint de revive");
  }
  const t0 = Date.now();
  console.log(`[acp ~] ${o.handle}: caja ausente, pidiendo revive a ${o.reviveUrl}`);
  let res: Response;
  if (/\/api\/v2\/fleet-agents\/[^/]+\/acp-box$/.test(o.reviveUrl)) {
    const { partnerHeaders } = await import("./ghosty-runtime.server");
    const { currentNamespace } = await import("./tenant.server");
    const body = "{}";
    res = await fetch(o.reviveUrl, {
      method: "POST",
      headers: partnerHeaders(body, await currentNamespace()),
      body,
      signal: AbortSignal.timeout(150_000),
    });
  } else {
    res = await fetch(o.reviveUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(150_000),
    });
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`el revive contestó ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
  }
  console.log(`[acp ~] ${o.handle}: caja de vuelta en ${Math.round((Date.now() - t0) / 1000)}s`);
}
