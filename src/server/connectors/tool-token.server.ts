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
// `memoryScope` PISA la clave derivada de channelId/dmId. Existe para las conversaciones
// que viven dentro de un room pero NO son del room: un hilo de WhatsApp es de UN contacto,
// y sin esto compartiría memoria con el equipo y con los demás contactos del mismo número.
export type ToolDest = { channelId?: number; dmId?: number; parentId?: number; topic?: string; handle?: string; name?: string; avatar?: string; memoryScope?: string };

/**
 * ⚠️ `ns` es OBLIGATORIO y va SEGUNDO, no al final.
 *
 * Nació opcional y último, y eso era una trampa: el endpoint sólo comprueba el tenant
 * `if (claims.ns)`, así que un call-site nuevo que lo omitiera —lo más fácil del mundo con
 * un parámetro opcional al final— produciría tokens que se saltan la comprobación **por
 * diseño de la firma**. Que el compilador lo exija es lo único que lo impide.
 */
/**
 * Qué puede EJERCER quien lleva el token, que es distinto de a qué datos tiene derecho.
 *
 * `lectura` = sólo las tools nativas de lectura de la conversación (`chat_*`, `doc_read`).
 * `completo` = todo lo que la persona tenga conectado, que es lo que reciben los agentes
 * nativos. Un token SIN `scope` vale como `completo`: así esta columna no cambia el
 * comportamiento de nadie el día que se despliega.
 *
 * Existe porque conectar un agente de terceros al dispatch le entrega, si no, todos los
 * conectores del invocador —Gmail, GitHub, Sentry— a un binario que ejecuta código escrito
 * por un modelo. El `dest` acota DÓNDE lee; esto acota QUÉ puede hacer.
 */
export type ToolScope = ReadonlySet<string>;

/** Lo que reciben los agentes NATIVOS y cualquier token emitido antes de que esto existiera. */
export const SCOPE_COMPLETO: ToolScope = new Set(["completo"]);

/**
 * Lee el alcance de su forma guardada: CSV en `gc_agents.acp_scope` o en el claim del token.
 *
 * - vacío/ausente ⇒ `completo`. Es lo que ya tienen los nativos, así que esta columna no le
 *   cambia el comportamiento a nadie el día que se despliega.
 * - una lista ⇒ ese conjunto, en minúsculas y sin espacios.
 *
 * NO valida contra un catálogo cerrado a propósito: una familia que no exista simplemente no
 * casa con ninguna tool y no concede nada. Rechazar aquí un valor desconocido sólo serviría
 * para convertir un typo en un turno roto en vez de en un turno sin esa familia.
 */
export function parseScope(raw: string | null | undefined): ToolScope {
  const partes = (raw ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!partes.length) return SCOPE_COMPLETO;
  return new Set(partes);
}

export function mintToolToken(
  sub: string,
  ns: string,
  dest?: ToolDest | null,
  ttlSec: number = DEFAULT_TTL_S,
  /**
   * ⚠️ Estos dos SÍ pueden ir opcionales al final, al revés que `ns` y por la razón contraria:
   * ninguno relaja una comprobación. Omitir `aud` deja al portador sin saber a dónde llamar
   * (falla cerrado), y omitir `scope` da el mismo permiso que hoy tienen los nativos. Si algún
   * día uno de los dos empieza a AUTORIZAR algo, tiene que subir en la firma como hizo `ns`.
   */
  extra?: { aud?: string; scope?: ToolScope }
): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      ns: ns ?? undefined,
      dest: dest ?? undefined,
      aud: extra?.aud || undefined,
      // Se serializa ORDENADO para que dos tokens del mismo alcance sean idénticos: así el
      // caché de installation tokens y cualquier comparación por igualdad no se despistan.
      scope: extra?.scope ? [...extra.scope].sort().join(",") || undefined : undefined,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToolToken(
  token: string
): { sub: string; ns: string | null; dest: ToolDest | null; scope: ToolScope } | null {
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
      scope?: string;
      exp?: number;
    };
    if (!p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    // Sin claim ⇒ `completo`: es lo que emiten hoy todos los call-sites nativos y hay que
    // seguir aceptándolo. Con claim, vale exactamente lo que diga y ni una familia más.
    return { sub: p.sub, ns: p.ns ?? null, dest: p.dest ?? null, scope: parseScope(p.scope) };
  } catch {
    return null;
  }
}
