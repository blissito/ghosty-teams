// Token-CAPACIDAD por-turno para el dispatch de tools desde el box (worker) → Teams.
// El box corre código arbitrario del agente, así que NO le damos el secreto maestro: Teams
// FIRMA un token corto `{sub, exp}` al mandar el turno, lo pasa por turnEnv, y el box lo
// reenvía en el callback. El agente puede LEER el token pero no forjar otro `sub` (va
// firmado) ni usarlo tras expirar → sólo puede invocar tools del invocador de ESE turno.
//
// El namespace del tenant NO va en el token: el box pega al subdominio del tenant
// (CONNECTORS_TOOLS_URL, inyectado al spawn) → el endpoint lo resuelve por host.
import crypto from "node:crypto";

function secret(): string {
  const s = process.env.GHOSTY_PARTNER_SECRET;
  if (!s) throw new Error("GHOSTY_PARTNER_SECRET no configurado");
  return s;
}

const DEFAULT_TTL_S = 900; // 15 min: cubre turnos largos con tools encadenadas.

// DÓNDE ocurre el turno (canal o DM + identidad del agente). Va DENTRO del token, no en
// los argumentos de la tool: si el agente pudiera elegir destino, podría dejarle un
// recordatorio a otra persona en otro canal. Firmado = no lo puede cambiar.
export type ToolDest = { channelId?: number; dmId?: number; topic?: string; handle?: string; name?: string; avatar?: string };

export function mintToolToken(sub: string, dest?: ToolDest | null, ttlSec: number = DEFAULT_TTL_S): string {
  const payload = Buffer.from(JSON.stringify({ sub, dest: dest ?? undefined, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToolToken(token: string): { sub: string; dest: ToolDest | null } | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string; dest?: ToolDest; exp?: number };
    if (!p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: p.sub, dest: p.dest ?? null };
  } catch {
    return null;
  }
}
