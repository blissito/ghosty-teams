import type { Channel } from "../db.server";

// Menciones: a quién avisa un @ y quién puede escribirlo.
//
// Vive aparte de `chat.ts` porque `notificarMencionesDelAgente` la llama el camino del
// agente y `chat.ts` lo importa el cliente (tiene server functions): exportarla desde ahí
// arrastraba `session.server` al bundle del navegador y el build lo rechaza.

// Menciones grupales, en DOS niveles. El producto dice "room" (nunca "canal"), así que el
// vocabulario de las menciones lo sigue: @room es la del room y @all la del workspace.
//
// ⚠️ "aquí" va CON acento además de sin él: el token se compara tal cual (sólo se baja a
// minúsculas), así que sin las dos formas la mención acentuada —la que un hispanohablante
// escribe— no notificaba a nadie y fallaba en silencio.
const WORKSPACE_MENTIONS = new Set(["all", "everyone", "todos"]);
// "channel" se acepta para siempre aunque no salga en el typeahead: es el reflejo de quien
// viene de Slack, y una mención que no notifica a nadie falla en silencio.
const ROOM_MENTIONS = new Set(["room", "here", "aqui", "aquí", "channel"]);
const GROUP_MENTIONS = new Set([...WORKSPACE_MENTIONS, ...ROOM_MENTIONS]);

/** ¿El mensaje etiqueta a alguien? (a cualquiera: humano o agente). */
export function mencionaAAlguienMas(body: string): boolean {
  return /(?<![\w@.])@[a-z0-9._-]{2,}/i.test(body || "");
}

// Push a los usuarios cuyos @handle aparecen en el mensaje (excluye al autor).
// Soporta menciones grupales (@all = workspace, @room = este room).
//
// Devuelve QUÉ pasó porque tiene dos emisores con necesidades distintas. Una persona
// que se equivoca de handle lo ve en pantalla y lo repite; el AGENTE no ve su propio
// mensaje renderizado, así que si nadie le dice que `@ana` no resolvió, cierra el turno
// convencido de que avisó. `unresolved` es lo que alimenta ese aviso.
export type MentionOutcome = { notified: string[]; unresolved: string[] };
const SIN_MENCIONES: MentionOutcome = { notified: [], unresolved: [] };

export async function notifyMentions(
  ns: string,
  channel: Channel,
  body: string,
  senderName: string,
  // ⚠️ Vacío cuando escribe el AGENTE, y no es un descuido: sólo se usa para excluir al
  // emisor de sus propias menciones, y un agente no tiene `sub` que excluir.
  senderSub: string,
  // Las grupales (@all, @todos, @room) sólo para humanos. Un agente que puede escribir
  // @todos le suena el teléfono a la empresa entera por iniciativa propia, y no tiene
  // forma de medir ese coste. Se le ignora el token en vez de negarle el mensaje.
  allowGroup = true
): Promise<MentionOutcome> {
  const { id: channelId, slug, name: channelName } = channel;
  const isPrivate = channel.is_private === 1;
  const tokens = (body.match(/@([\wáéíóúñ]+)/gi) ?? []).map((t) => t.slice(1).toLowerCase());
  if (!tokens.length) return SIN_MENCIONES;
  const users = await import("../users.server");
  const db = await import("../db.server");

  // Lo que se le va a reportar a quien escribió: los @ a personas que no llegaron a
  // nadie. Las grupales nunca cuentan como "sin resolver" — o valen, o se ignoran.
  const personales = tokens.filter((t) => !GROUP_MENTIONS.has(t));
  let unresolved: string[] = [];

  let targets: string[];
  if (allowGroup && tokens.some((t) => GROUP_MENTIONS.has(t))) {
    // El nivel MÁS amplio gana: quien escribe @room @all quiere a todo el workspace.
    const wantsWorkspace = tokens.some((t) => WORKSPACE_MENTIONS.has(t));
    let audience: string[];
    if (wantsWorkspace) {
      audience = (await users.listUsers()).map((u) => u.sub);
    } else if (isPrivate) {
      audience = await db.listChannelMembers(channelId);
    } else {
      // ⚠️ Un room PÚBLICO no tiene membresía (gc_channel_members está vacía por diseño:
      // nadie se une). Lo más cercano a "los de este room" es quien ha participado —
      // el mismo criterio que el roster que ya se enseña en la UI. Consecuencia asumida:
      // quien nunca escribió aquí no recibe el @room; para alcanzarlo está @all.
      audience = (await db.listRoomRoster(channel)).map((m) => m.sub);
    }
    targets = audience.filter((s) => s && s !== senderSub);
  } else {
    let hits = await users.resolveMentionedUsers(personales, senderSub);
    // En un room PRIVADO, no filtrar por membresía filtraría info (excerpt + deep
    // link inservible) a no-miembros. Solo notifica a quienes pueden ver el room.
    if (isPrivate) {
      const members = new Set(await db.listChannelMembers(channelId));
      hits = hits.filter((u) => members.has(u.sub));
    }
    // Un handle que no existe y uno que existe pero no está en este room privado son
    // el mismo caso para quien escribió: nadie recibió el aviso.
    const alcanzados = new Set(hits.map((u) => u.handle));
    unresolved = [...new Set(personales.filter((t) => !alcanzados.has(t)))];
    targets = hits.map((u) => u.sub);
  }
  if (!targets.length) return { notified: [], unresolved };
  // Silencio (mute): quien silenció este room no recibe push por menciones.
  // Ojo: seguir en `notified` sería mentir, pero tampoco es un fallo que reportar —
  // la persona SÍ está etiquetada y lo ve al entrar; sólo eligió no recibir el timbre.
  const subs = await db.filterMutedOut(targets, "room", channelId);
  if (!subs.length) return { notified: [], unresolved };
  const { notify } = await import("./notify.server");
  const excerpt = body.length > 120 ? body.slice(0, 117) + "…" : body;
  await notify({
    kind: "mention",
    recipients: subs,
    title: `${senderName} te mencionó en #${channelName}`,
    body: excerpt,
    url: `/c/${slug}`,
  }, ns);
  return { notified: subs, unresolved };
}

/**
 * Notifica las menciones que escribió el AGENTE y devuelve el aviso para la burbuja
 * cuando alguna no llegó a nadie ("" si todo bien).
 *
 * ⚠️ Se parsea la PROSA, no el body crudo. Un `@` dentro de un documento, de un bloque de
 * herramientas o de un diff no es una mención: sin quitar los fences, un `eb-doc` con un
 * correo adentro le manda push a media oficina.
 */
export async function notificarMencionesDelAgente(
  ns: string,
  channel: Channel,
  reply: string,
  agentName: string
): Promise<string> {
  if (!reply.trim() || !mencionaAAlguienMas(reply)) return "";
  const eb = await import("../lib/ebdoc");
  // `bubbleWithoutEbDoc` ya quita tools, pasos, alertas, PR, tareas, tests, gh, permisos y
  // los patches: es el mismo texto que ve el usuario en la burbuja, que es exactamente el
  // criterio correcto. Sólo faltan los tres fences que se vuelven adjunto más abajo.
  const prosa = [eb.stripEbAudio, eb.stripEbFile, eb.stripAskUser].reduce(
    (s, f) => f(s),
    eb.bubbleWithoutEbDoc(reply)
  );
  // senderSub vacío: el agente no tiene sub que excluir. allowGroup=false: nada de @todos.
  const { unresolved } = await notifyMentions(ns, channel, prosa, agentName, "", false);
  const { mentionGapNotice } = await import("./artifacts");
  return mentionGapNotice(unresolved);
}
