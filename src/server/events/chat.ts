import { createServerFn } from "@tanstack/react-start";

// Chat de la sala de un evento. Superficie PÚBLICA y por eso deliberadamente
// pequeña: leer, escribir, y —para quien modera— borrar y silenciar.
//
// No reusa las server functions del chat normal porque aquellas parten de
// `sessionUser()`, o sea de "eres del workspace". Aquí quien escribe puede no
// serlo. Reusar aquel camino obligaría a que un invitado pasara por miembro, que
// es exactamente lo que no debe pasar (ver access.server.ts).
//
// Lo que sí se comparte es el ALMACÉN: los mensajes son `gc_messages` del mismo
// room. Así el equipo los ve en su Teams de siempre, quedan en el historial, y
// el agente los lee sin nada especial.

// ⚠️ Este archivo NO puede llamarse `chat.server.ts` aunque todo lo que hace sea
// de servidor: el plugin de import-protection prohíbe que un `.server.ts` entre en
// el bundle del cliente, y la página de la sala importa estas server functions por
// nombre para llamarlas por RPC. Es la misma razón por la que `server/channels.ts`
// tampoco lleva el sufijo. Los módulos que sí lo llevan (access, ticket, guest)
// sólo se importan DINÁMICAMENTE dentro de los handlers, así que nunca cruzan.
const MAX_LEN = 1000;

/**
 * Los mensajes que un room abierto puede enseñar HACIA FUERA.
 *
 * ⚠️ El corte por `public_since` es la pieza importante y no es cosmética. Antes esto
 * servía los últimos 200 mensajes del room **sin ninguna condición de fecha**, así que
 * convertir en abierto un room que ya existía publicaba de golpe todo lo que el equipo
 * había hablado ahí dentro. Con cualquier workspace pudiendo abrir rooms públicos, esa
 * era la fuga más cara del sistema — y ni siquiera hacía falta un exploit: bastaba abrir
 * la liga.
 *
 * Función aparte y pura para poder probarla sin DB: es una frontera de datos, y una
 * frontera que sólo existe embebida en un handler es una frontera que nadie revisa.
 *
 * `public_since` NULL = el room no ha sido abierto nunca → no se enseña nada. Cerrado por
 * omisión, que es como tiene que fallar.
 */
export function publicMessages<T extends { parent_id: number | null; id: number; created_at: number }>(
  todos: T[],
  publicSince: number | null | undefined,
  after = 0,
  limite = 200
): T[] {
  if (publicSince == null) return [];
  return todos
    .filter((m) => m.parent_id == null && m.id > after && m.created_at >= publicSince)
    .slice(-limite);
}

/** El room de una liga pública, sin preguntar quién eres. `null` si no existe o no es público. */
async function resolveRoom(slug: string) {
  await (await import("../schema.server")).ensureSchema().catch(() => {});
  const db = await import("../../db.server");
  const ch = await db.channelByShareSlug(slug);
  return ch ? { db, ch } : null;
}

/** Como `resolveRoom`, pero exigiendo además que quien llama pueda PARTICIPAR. */
async function resolve(slug: string) {
  const r = await resolveRoom(slug);
  if (!r) return null;
  const { eventViewerFor } = await import("./access.server");
  const viewer = await eventViewerFor(r.ch);
  if (!viewer) return null;
  return { ...r, viewer };
}

/**
 * El flujo de un room abierto. **No exige nada a quien llama.**
 *
 * Leer es libre a propósito: quien llega por la liga ve una conversación viva en vez de
 * una puerta, y ésa es la diferencia entre un room que engancha y uno que parece cerrado.
 * El correo se pide en el momento en que la persona quiere PARTICIPAR, que es cuando ya
 * quiere darlo.
 *
 * Lo que sí acota el daño es `publicMessages`: nada anterior a la apertura sale de aquí.
 */
export const eventFlowFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string; after?: number }) => d)
  .handler(async ({ data }) => {
    const r = await resolveRoom(data.slug);
    if (!r) return { ok: false as const, messages: [], canModerate: false, canWrite: false };
    // Quién eres sólo decide si puedes ESCRIBIR y qué mensajes son tuyos; nunca si puedes
    // leer. Un anónimo devuelve `null` aquí y sigue adelante.
    const { eventViewerFor } = await import("./access.server");
    const viewer = await eventViewerFor(r.ch).catch(() => null);
    const all = await r.db.listChannelFlow(r.ch.id);
    // Sólo lo que se escribió en el flujo del evento, y nada de hilos: la sala es
    // una conversación corrida, no el room completo con su historial de meses.
    // Y sólo DESDE QUE SE ABRIÓ — ver `publicMessages`.
    const recortados = publicMessages(all, r.ch.public_since, data.after ?? 0);
    // ⚠️ Se devuelven los mensajes COMPLETOS (`attachMeta`: reacciones, adjuntos,
    // artefactos, fijados), no un resumen a medida. La sala pinta con el MISMO
    // `MessageRow` que el chat de Teams, así que un shape recortado obligaría a
    // mantener dos formas del mensaje que divergirían al primer campo nuevo — que es
    // exactamente cómo nació el chat de juguete que esto vino a reemplazar.
    const messages = await r.db.attachMeta(recortados, viewer?.sub ?? "");
    return {
      ok: true as const,
      messages,
      canModerate: !!viewer?.isHost,
      canWrite: !!viewer,
      // Los emojis del workspace, para que el selector de la sala sea EL de Teams y no
      // una lista de seis emojis inventada.
      emojis: await r.db.listCustomEmojis().catch(() => []),
      me: viewer ? { sub: viewer.sub, name: viewer.name } : null,
    };
  });

export type AdjuntoEntrante = {
  fileId: string;
  mime: string;
  size: number;
  name: string;
  thumbFileId?: string | null;
  width?: number | null;
  height?: number | null;
  /** Firma que emite `/api/upload`: ata el archivo a quien lo subió y a este room. */
  pass?: string;
};

export const eventPostFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; body: string; attachments?: AdjuntoEntrante[] }) => d)
  .handler(async ({ data }) => {
    const r = await resolve(data.slug);
    if (!r) return { ok: false as const, error: "no disponible" };

    const body = (data.body ?? "").trim().slice(0, MAX_LEN);
    // Con adjunto, el texto puede ir vacío: mandar una foto sin comentario es normal.
    const entrantes = (data.attachments ?? []).slice(0, 4);
    if (!body && !entrantes.length) return { ok: false as const, error: "vacío" };

    // ⚠️ Cada adjunto tiene que traer su PASE, salvo que quien escribe sea del workspace.
    // Sin esto habría que creerle al cliente qué `fileId` cuelga, y bastaría conocer el de
    // otro sitio para publicarlo aquí como si lo hubiera subido él.
    const { verifyUploadPass } = await import("./upload-pass.server");
    const adjuntos: AdjuntoEntrante[] = [];
    for (const a of entrantes) {
      if (!a?.fileId) continue;
      if (r.viewer.isMember) { adjuntos.push(a); continue; }
      if (await verifyUploadPass(a.pass, a.fileId, r.viewer.sub, r.ch.id)) adjuntos.push(a);
    }
    if (entrantes.length && !adjuntos.length) {
      return { ok: false as const, error: "No pude adjuntar ese archivo" };
    }

    // Límite por persona, en la DB. Un room público anunciado a 100 personas es
    // superficie de spam, y el `sub` es mejor cubeta que la IP: varias personas
    // comparten IP (una oficina, una red móvil) y una sola no debería poder
    // silenciar a las demás gastándose el presupuesto común.
    const { rateCheck } = await import("../forms/rate.server");
    const { allowed } = await rateCheck(`evtchat:${r.ch.id}`, r.viewer.sub, {
      scope: "evtchat",
      windowS: 30,
      maxWithIp: 12,
      maxNoIp: 12,
    });
    if (!allowed) return { ok: false as const, error: "Vas muy rápido, espera un momento" };

    // ⚠️ El agente sólo entra si el room lo tiene ENCENDIDO y alguien lo menciona.
    // Nunca por su cuenta: 100 desconocidos con un agente suelto es la factura del
    // dueño, y hoy no hay enforcement de saldo en ninguna parte del sistema.
    //
    // El interruptor es `agent_enabled` (Ajustes del room → Evento abierto), y se lee
    // AQUÍ, en cada mensaje: apagarlo a media sesión calla al agente desde el mensaje
    // siguiente, sin reiniciar nada. Es la forma en que se usa —encendido un par de
    // horas y apagado— así que tiene que ser inmediato y reversible.
    const mentioned = /(^|\s)@ghosty\b/i.test(body);
    const agentHandle = r.ch.agent_enabled === 1 && mentioned ? "ghosty" : null;

    // ⚠️ El origin se captura DENTRO del request, antes de contestarle al invitado.
    // Después ya no hay cabeceras que leer: `reqOrigin()` devolvería nada, el minteo del
    // tool-token caería al catch y el agente correría SIN herramientas, diciendo que no
    // tiene acceso a nada mientras todo está bien configurado. Falla en silencio porque
    // ese catch es best-effort a propósito (agents.server.ts:840). Misma razón y mismo
    // orden que en el webhook de WhatsApp.
    let origin = "";
    if (agentHandle) {
      try {
        origin = (await (await import("../../origin.server")).reqOrigin()) || "";
      } catch {
        origin = "";
      }
    }

    const { id } = await r.db.createMessage({
      channelId: r.ch.id,
      parentId: null,
      sender: r.viewer.name,
      senderSub: r.viewer.sub,
      avatar: "",
      body,
      agentHandle,
    });
    // El MISMO `createAttachments` del chat: los adjuntos de la sala son adjuntos del room,
    // así que el equipo los abre desde su Teams sin nada especial.
    if (adjuntos.length) {
      await r.db.createAttachments(
        id,
        adjuntos.map((a) => ({
          fileId: a.fileId,
          mime: a.mime,
          size: a.size,
          // El nombre lo pone el SERVIDOR a partir de lo que llegó, saneado: acaba impreso
          // en el room de un cliente y viene de alguien sin cuenta.
          name: (a.name ?? "archivo").replace(/[\r\n\t]/g, " ").slice(0, 120),
          thumbFileId: a.thumbFileId ?? null,
          width: a.width ?? null,
          height: a.height ?? null,
        }))
      ).catch(() => {});
    }

    // El namespace se resuelve FUERA del try del bus: lo necesitan las dos cosas de
    // abajo, y si viviera dentro, un fallo del bus se llevaría por delante el turno del
    // agente — que no tiene nada que ver con avisar a las pestañas.
    const { currentNamespace } = await import("../tenant.server");
    const ns = await currentNamespace();

    // Aviso al room para quien lo tenga abierto en Teams. Va por el bus normal:
    // un mensaje de la sala ES un mensaje del room, no una cosa aparte.
    try {
      const bus = await import("../bus.server");
      // ⚠️ Esto era `refresh` a propósito, y se cambió a `message:new` el 2026-08-11.
      // El miedo de entonces era que `message:new` "despertara al agente": no lo hace.
      // Quien levanta un turno es una llamada explícita —`askAgent` en el camino de
      // los miembros, `replyToEventMessage` en éste—, nunca un evento del bus. Lo que
      // sí hacía `refresh` era obligar a cada pestaña a re-consultar el flujo entero,
      // que con 100 personas escribiendo es exactamente lo que no se quería.
      //
      // Y el motivo de fondo: con `refresh` el equipo veía aparecer los mensajes de la
      // comunidad sólo si tenía el room abierto y sin saber que eran nuevos. La gente
      // de fuera tiene que ser parte del room, no un rumor de fondo.
      const creado = await r.db.getMessage(id);
      if (creado) bus.publish(bus.ch.room(ns, r.ch.id), { t: "message:new", msg: creado });
      // Badge para quien NO tiene el room abierto. Push no: `notifyMentions` se queda
      // fuera de este camino porque un invitado no puede mencionar humanos (su
      // typeahead sólo ofrece agentes), así que no hay a quién timbrar.
      bus.publish(bus.ch.room(ns, r.ch.id), { t: "unread", scope: "room", scopeId: r.ch.id });
    } catch {
      /* el chat no depende del bus: el sondeo lo recoge igual */
    }

    // ── El turno del agente ──────────────────────────────────────────────────
    // Se levanta AQUÍ, en el servidor, y no devolviéndole `respondents` al cliente como
    // hace `postMessage`: eso sería decirle a un anónimo "llama tú a esta cosa que le
    // cuesta dinero al dueño". Es el camino del webhook de WhatsApp, que lleva meses en
    // producción con exactamente el mismo tipo de remitente.
    if (agentHandle) {
      const { eventAgentTurnAllowed } = await import("./agent-rate.server");
      if (await eventAgentTurnAllowed(r.ch.id, r.viewer.sub)) {
        const { replyToEventMessage } = await import("./reply.server");
        // Fire-and-forget: el invitado ya tiene su mensaje publicado y no espera a que
        // el agente termine de pensar. `replyToEventMessage` nunca lanza.
        void replyToEventMessage({
          ns,
          channelId: r.ch.id,
          handle: agentHandle,
          sender: r.viewer.name,
          text: body,
          parentId: id,
          topic: "general",
          origin,
        });
      }
      // Si el tope corta, no se avisa en la sala: un "te pasaste de turnos" delante de
      // 100 personas convierte un límite invisible en un incidente público. El mensaje
      // quedó publicado, que es lo que esa persona pidió.
    }
    return { ok: true as const, id };
  });

/**
 * Reaccionar a un mensaje del room abierto.
 *
 * No se reusa `toggleReactionFn` del chat normal porque aquélla exige `sessionUser()`, o
 * sea "eres del workspace" — justo la puerta que este módulo no puede abrir. Lo que sí se
 * reusa es lo que importa: `db.toggleReaction`, el mismo almacén, así que una reacción
 * puesta desde la sala se ve idéntica dentro de Teams.
 */
export const eventReactFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; messageId: number; emoji: string }) => d)
  .handler(async ({ data }) => {
    const r = await resolve(data.slug);
    if (!r) return { ok: false as const, error: "identifícate para reaccionar" };

    // ⚠️ El mensaje tiene que ser DE ESTE ROOM. Sin esta comprobación, el `messageId`
    // —autoincremental y enumerable— dejaría reaccionar a cualquier mensaje del tenant,
    // incluidos los de rooms privados: no se leen, pero se contaminan.
    const msg = await r.db.getMessage(data.messageId);
    if (!msg || msg.channel_id !== r.ch.id) return { ok: false as const, error: "no disponible" };
    // Y tampoco a lo anterior a la apertura: si no se puede ver, no se puede tocar.
    if (r.ch.public_since == null || msg.created_at < r.ch.public_since) {
      return { ok: false as const, error: "no disponible" };
    }
    // Un emoji, no un ensayo: la columna es libre y sin tope alguien guarda ahí un texto.
    const emoji = (data.emoji ?? "").trim().slice(0, 16);
    if (!emoji) return { ok: false as const, error: "no disponible" };

    const { op, count } = await r.db.toggleReaction(data.messageId, r.viewer.sub, emoji);
    try {
      const bus = await import("../bus.server");
      const { currentNamespace } = await import("../tenant.server");
      const ns = await currentNamespace();
      bus.publish(bus.ch.room(ns, r.ch.id), {
        t: "reaction", messageId: data.messageId, emoji, userSub: r.viewer.sub, op, count,
      });
    } catch {
      /* el sondeo lo recoge igual */
    }
    return { ok: true as const, op, count };
  });

export const eventModerateFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; action: "delete" | "ban"; messageId?: number; email?: string }) => d)
  .handler(async ({ data }) => {
    const r = await resolve(data.slug);
    if (!r || !r.viewer.isHost) return { ok: false as const, error: "no autorizado" };
    const { dbq } = await import("../../dbq.server");

    if (data.action === "delete" && data.messageId) {
      // Acotado al room del evento: sin el `channel_id` en el WHERE, quien modera
      // un evento podría borrar cualquier mensaje del workspace por id.
      await dbq("DELETE FROM gc_messages WHERE id = ? AND channel_id = ?", [data.messageId, r.ch.id]);
      return { ok: true as const };
    }
    if (data.action === "ban" && data.email) {
      // Se banea por CORREO y no por cookie: la cookie se borra en un clic. Y no
      // se borra la fila, para que el veto sobreviva a que vuelva a registrarse.
      await dbq(
        "UPDATE gt_event_registrations SET banned = 1 WHERE channel_id = ? AND email = ?",
        [r.ch.id, data.email.trim().toLowerCase()]
      );
      return { ok: true as const };
    }
    return { ok: false as const, error: "acción inválida" };
  });
