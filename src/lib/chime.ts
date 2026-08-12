// ¿Este mensaje que acaba de llegar debe SONAR?
//
// La regla vivía inline en `routes/c.$slug.tsx`, enredada con el estado de la ruta. Salió
// de ahí cuando los rooms abiertos también necesitaron sonar: la alternativa era volver a
// escribirla, y una segunda copia de "cuándo suena" diverge al primer matiz — que es
// justo donde están los detalles que importan.
//
// Pura y sin React a propósito: es una decisión, no un efecto.

export type ChimeKind = "dm" | "mention" | "room";

/** Menciones grupales que cuentan como si te nombraran a ti. */
export const GROUP_MENTIONS = new Set(["all", "everyone", "todos", "room", "here", "aqui", "aquí", "channel"]);

export type ChimeMsg = {
  kind?: string;
  body?: string | null;
  sender?: string;
  sender_sub?: string | null;
  agent_handle?: string | null;
  mentions_ghosty?: number;
  channel_id?: number;
  dm_id?: number | null;
};

export type ChimeCtx = {
  /** Mi `sub`. El nombre es el respaldo para mensajes viejos sin sub. */
  miSub?: string | null;
  miNombre?: string | null;
  /** Mi @handle, para saber si el mensaje me menciona. */
  miHandle?: string | null;
  /** ¿Estoy MIRANDO justo este scope? (enfocado Y pestaña visible). */
  activeScope: boolean;
  /** Claves silenciadas: `room:<id>` / `dm:<id>`. */
  mutes: Set<string>;
};

/**
 * Devuelve qué sonido toca, o `null` si no suena.
 *
 * Las cuatro razones para callar, y ninguna es negociable:
 *
 *  · **Es mío.** Llega por SSE sin match de nonce (eco tardío, otra pestaña) y sonar por lo
 *    que uno mismo acaba de escribir es de lo más molesto que puede hacer un chat.
 *  · **Es la CÁSCARA del agente** (`agent_handle` con `mentions_ghosty === 0`). Nace VACÍA
 *    al enviar: su sonido va al primer token, no al aparecer la caja. Si sonara aquí,
 *    sonaría antes de que el agente haya dicho nada.
 *  · **Está silenciado** ese room o ese DM.
 *  · **Lo estoy viendo.** Un sonido por algo que ya tengo delante no avisa de nada.
 *
 * Y `kind !== "msg"` (los "status": llamadas, altas) tampoco suena.
 */
export function shouldChime(msg: ChimeMsg, ctx: ChimeCtx): ChimeKind | null {
  if (msg.kind !== "msg") return null;

  const esMio = msg.sender_sub ? msg.sender_sub === ctx.miSub : msg.sender === ctx.miNombre;
  if (esMio) return null;

  const esCascaraDeAgente = msg.agent_handle != null && msg.mentions_ghosty === 0;
  if (esCascaraDeAgente) return null;

  const claveMute = msg.dm_id != null ? `dm:${msg.dm_id}` : `room:${msg.channel_id}`;
  if (ctx.mutes.has(claveMute)) return null;

  if (ctx.activeScope) return null;

  if (msg.dm_id != null) return "dm";

  const h = ctx.miHandle?.toLowerCase();
  const meNombra = (msg.body?.match(/@([\wáéíóúñ]+)/gi) ?? [])
    .map((x) => x.slice(1).toLowerCase())
    .some((x) => (!!h && x === h) || GROUP_MENTIONS.has(x));

  return meNombra ? "mention" : "room";
}
