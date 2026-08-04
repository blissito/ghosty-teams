// Token-CAPACIDAD por-turno para el dispatch de tools desde el box (worker) → Teams.
// El box corre código arbitrario del agente, así que NO le damos el secreto maestro: Teams
// FIRMA un token corto `{sub, exp}` al mandar el turno, lo pasa por turnEnv, y el box lo
// reenvía en el callback. El agente puede LEER el token pero no forjar otro `sub` (va
// firmado) ni usarlo tras expirar → sólo puede invocar tools del invocador de ESE turno.
//
// ⚠️ El namespace SÍ va en el token, desde el 2026-08-04. Antes no: el endpoint lo
// resolvía por host y eso bastaba, porque en otro workspace ese `sub` no tenía filas en
// gc_user_connectors y `listConnectorProviders(sub)` devolvía vacío.
//
// Las conexiones COMPARTIDAS rompieron esa contención: la consulta pasó a ser
// `(user_sub=? OR shared=1)`, así que un token minteado en el workspace A y mandado al
// host de B resolvería la conexión compartida de B y ejecutaría CON EL TOKEN DE B. El box
// corre código escrito por el modelo y puede leer su propio tool-token, así que era
// alcanzable, no teórico. El endpoint compara este `ns` con el que resuelve por host y
// rechaza si no coinciden.
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
// `parentId` = el turno ocurre dentro de un HILO. Lo usa la lectura de historial para no
// salirse de él: si te invocan en un hilo, lo que se puede leer es ese hilo.
export type ToolDest = { channelId?: number; dmId?: number; parentId?: number; topic?: string; handle?: string; name?: string; avatar?: string };

export function mintToolToken(
  sub: string,
  dest?: ToolDest | null,
  ttlSec: number = DEFAULT_TTL_S,
  ns?: string | null
): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, ns: ns ?? undefined, dest: dest ?? undefined, exp: Math.floor(Date.now() / 1000) + ttlSec })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToolToken(token: string): { sub: string; ns: string | null; dest: ToolDest | null } | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sub?: string;
      ns?: string;
      dest?: ToolDest;
      exp?: number;
    };
    if (!p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: p.sub, ns: p.ns ?? null, dest: p.dest ?? null };
  } catch {
    return null;
  }
}
