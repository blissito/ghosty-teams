/**
 * El agente asignado contesta un mensaje de WhatsApp.
 *
 * Molde: `src/server/sentry-enrich.server.ts` — un turno disparado por un webhook, fuera de
 * cualquier sesión. Las diferencias con aquél son TODAS por una razón: allá el que dispara
 * es un servicio del propio equipo; aquí es un **desconocido**.
 *
 * 🔴 `publicChannel: true` y **sin `invokerSub`**. El turno no corre en nombre de nadie: sin
 * tool-token, sin conectores per-user, sin el bloque que nombra lo que tiene conectado el
 * equipo. Ver el comentario largo en `callAgentBackendStream`. NO cablear aquí
 * `gt_wa_channels.acting_sub` "para que tenga tools": ése es exactamente el agujero.
 *
 * Fire-and-forget: NUNCA lanza. El mensaje ya está publicado en el room, que es el trabajo
 * que no se puede perder; si el turno falla, se pierde la respuesta y nada más — devolver
 * error haría que Formmy reintregue el mensaje entero y lo duplique.
 */

const FLEET_THREAD = "wa"; // hilo de memoria propio del canal, distinto del "flow" del room

/**
 * Clave de conversación de un contacto.
 *
 * ⚠️ Normaliza el `1` de México (`521…` → `52…`) como hace easybits (`waba.server.ts:329`).
 * Meta manda a veces uno y a veces otro para la MISMA persona, y sin esto el cliente se
 * parte en dos memorias y el agente le vuelve a preguntar lo que ya le dijo.
 */
export function waConversationKey(integrationId: string, phone: string): string {
  const p = phone.replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1");
  return `wa:${integrationId}:${p}`;
}

export async function replyToWaMessage(opts: {
  ns: string;
  integrationId: string;
  channelSecret: string;
  channelId: number;
  /** El hilo del contacto: la respuesta cuelga de ahí, no del room. */
  threadId: number;
  handle: string;
  phone: string;
  contactName: string;
  text: string;
  /** Capturado DENTRO del request: aquí ya no hay cabeceras que leer. */
  origin: string;
}): Promise<void> {
  let shellId: number | null = null;
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { resolvedAgents, runAgentTurn, agentGroupId } = await import("../../agents.server");

    const agent = (await resolvedAgents()).find((a) => a.handle === opts.handle);
    // Sin agente resuelto no se contesta NADA. `runAgentTurn` con `agent: undefined`
    // respondería "@x no está conectado, el owner lo configura en Ajustes" — un mensaje
    // interno, y se lo mandaríamos a un cliente.
    if (!agent) {
      console.error(`[wa] el agente @${opts.handle} no resuelve; no contesto`);
      return;
    }
    const name = agent.name ?? opts.handle;

    const root = await db.getMessage(opts.threadId);
    const topic = root?.topic ?? "general";
    const convKey = waConversationKey(opts.integrationId, opts.phone);
    // Sesión del worker POR CONTACTO. Con el sufijo del room (lo que hace el chat) la
    // conversación de un cliente compartiría contexto con la de otro y con lo que el
    // equipo habla en el room.
    const groupId = await agentGroupId(agent, `${FLEET_THREAD}-${convKey}`);

    const dest = {
      channelId: opts.channelId,
      parentId: opts.threadId,
      topic,
      handle: opts.handle,
      name,
      avatar: agent.avatar ?? "",
      // Memoria propia del contacto (+ la del workspace, que se inyecta siempre).
      memoryScope: convKey,
    };

    const { id, reply } = await runAgentTurn({
      agent,
      handle: opts.handle,
      groupId,
      sender: opts.contactName || `+${opts.phone}`,
      text: opts.text,
      publicChannel: true, // 🔴 la frontera de seguridad; ver la cabecera
      originOverride: opts.origin,
      dest,
      createShell: async () => {
        const { id } = await db.postAgent(
          opts.channelId, opts.threadId, "", "msg", opts.handle, name, topic, agent.avatar ?? "",
        );
        shellId = id;
        const shell = await db.getMessage(id);
        if (shell) bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) =>
        bus.publish(bus.ch.room(opts.ns, opts.channelId), {
          t: "message:delta", id: mid, chunk, channelId: opts.channelId, parentId: opts.threadId,
        }),
      emitBody: (mid, body) =>
        bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id: mid, body }),
    });

    const finalBody = reply.trim();
    if (!finalBody) {
      // Turno en blanco: se borra la cáscara y no se manda nada. Un mensaje vacío por
      // WhatsApp es peor que no contestar.
      if (shellId != null) await db.deleteMessage(shellId).catch(() => {});
      return;
    }
    await db.setMessageBody(id, finalBody);
    bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id, body: finalBody });

    // Y AHORA al cliente. El room se escribe primero a propósito: si el envío falla, el
    // equipo ve la respuesta que no salió y puede mandarla a mano.
    const { sendWaText } = await import("./formmy-partner.server");
    const { sent, failed } = await sendWaText({
      integrationId: opts.integrationId,
      channelSecret: opts.channelSecret,
      phone: opts.phone,
      text: finalBody,
    });
    if (failed) {
      // Se DICE en el room. Callarlo dejaría creer que el cliente ya tiene la respuesta.
      const aviso = `⚠️ No pude entregar ${failed} de ${sent + failed} mensajes a +${opts.phone}.`;
      const { id: wid } = await db.postAgent(
        opts.channelId, opts.threadId, aviso, "msg", opts.handle, name, topic, agent.avatar ?? "",
      );
      const w = await db.getMessage(wid);
      if (w) bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:new", msg: w });
    }
  } catch (e) {
    console.error("[wa] el turno falló", e);
  }
}
