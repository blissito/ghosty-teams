// El ticket de la URL MCP que se le entrega a un agente ACP de fuera.
//
// ⚠️ LO QUE ESTE TICKET **NO** ES: una credencial de acceso a las tools. Sólo dice QUÉ
// CONVERSACIÓN es (`ns` + agente + `groupId`). La autoridad —a nombre de quién se ejerce,
// en qué destino y con qué alcance— sale del TURNO EN VUELO, en cada llamada
// (`inflightAuthority`). Sin turno en curso, este ticket no vale para nada.
//
// Es a propósito y es lo que hace viable entregarlo en `session/new`: la sesión de un agente
// dura horas y el tool-token de siempre caduca en 5 minutos, porque firma `sub`/`dest`/`scope`
// del TURNO. Un token estático con esos tres dentro convertiría al agente en un proxy a los
// conectores personales de quien lo dio de alta. Aquí no hay nada que robar.
import crypto from "node:crypto";

const TTL_S = 24 * 60 * 60; // un día: cubre de sobra la vida de una sesión

function secreto(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

export type McpTicket = { ns: string; agent: string; groupId: string };

/** `base64url(payload).firma`, el mismo formato del tool-token. */
export function mintMcpTicket(t: McpTicket): string {
  const payload = Buffer.from(
    JSON.stringify({ ...t, exp: Math.floor(Date.now() / 1000) + TTL_S }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secreto()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyMcpTicket(raw: string): McpTicket | null {
  const [payload, sig] = (raw || "").split(".");
  if (!payload || !sig) return null;
  try {
    const want = crypto.createHmac("sha256", secreto()).update(payload).digest("base64url");
    // Tiempo constante: este endpoint acepta intentos ilimitados de quien conozca la URL.
    const a = Buffer.from(want);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as McpTicket & { exp?: number };
    if (!p.ns || !p.agent || !p.groupId) return null;
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return { ns: p.ns, agent: p.agent, groupId: p.groupId };
  } catch {
    return null;
  }
}
