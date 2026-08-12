/**
 * El agente del room contesta a alguien de la SALA de un evento abierto.
 *
 * Molde: `src/server/whatsapp/reply.server.ts`, y no por parecido estético — es
 * literalmente el mismo problema, resuelto y probado en producción. Allá entra gente de
 * fuera del workspace por un webhook de WhatsApp; aquí entra por una liga pública. En los
 * dos casos quien escribe es un **desconocido** y el turno lo paga el dueño del workspace.
 *
 * 🔴 `publicChannel: true` y **sin `invokerSub`**. El turno no corre en nombre de nadie:
 * sin tool-token, sin conectores per-user, sin el bloque que nombra lo que tiene conectado
 * el equipo. Con 100 desconocidos escribiendo, cablear ahí el `sub` de una persona real
 * sería prompt injection con canal de salida incluido: el texto lo escribe un extraño, las
 * herramientas serían de un miembro, y la respuesta vuelve al extraño.
 *
 * ⚠️ Por qué existe este archivo en vez de reusar `askAgent`: en el camino normal el turno
 * lo levanta el CLIENTE, con los `respondents` que le devuelve `postMessage`. A un cliente
 * anónimo no se le puede devolver eso —sería decirle "llama tú a esta cosa que cuesta
 * dinero"— así que el turno se levanta en el servidor, como hace el webhook de WhatsApp.
 *
 * Fire-and-forget: NUNCA lanza. El mensaje del invitado ya está guardado, que es el trabajo
 * que no se puede perder; si el turno falla se pierde la respuesta y nada más.
 */

// Hilo de memoria. Es el MISMO que usa el room ("flow"), a diferencia de WhatsApp, que abre
// uno por contacto: allá cada conversación es privada entre el negocio y una persona; aquí
// la sala es UNA conversación pública que todos leen, y el agente tiene que poder decir
// "como comentaba Ana hace un momento".
const FLEET_THREAD = "flow";

export async function replyToEventMessage(opts: {
  ns: string;
  channelId: number;
  handle: string;
  /** Quién preguntó, con el nombre con el que se registró. */
  sender: string;
  text: string;
  /** El mensaje del invitado: la respuesta cuelga de ahí, como en el chat normal. */
  parentId: number;
  topic: string;
  /** Capturado DENTRO del request: aquí ya no hay cabeceras que leer. */
  origin: string;
}): Promise<void> {
  let shellId: number | null = null;
  try {
    const db = await import("../../db.server");
    const bus = await import("../bus.server");
    const { resolvedAgents, runAgentTurn, agentGroupId } = await import("../../agents.server");

    const agent = (await resolvedAgents()).find((a) => a.handle === opts.handle);
    // Sin agente resuelto no se contesta nada. `runAgentTurn` con `agent: undefined`
    // respondería "@x no está conectado, el owner lo configura en Ajustes" — un mensaje
    // interno, y lo estaríamos publicando delante de 100 desconocidos.
    if (!agent) {
      console.error(`[evento] el agente @${opts.handle} no resuelve; no contesto`);
      return;
    }
    const name = agent.name ?? opts.handle;
    const groupId = await agentGroupId(agent, FLEET_THREAD);

    const { id, reply } = await runAgentTurn({
      agent,
      handle: opts.handle,
      groupId,
      sender: opts.sender,
      text: opts.text,
      publicChannel: true, // 🔴 la frontera de seguridad; ver la cabecera
      originOverride: opts.origin,
      dest: {
        channelId: opts.channelId,
        parentId: opts.parentId,
        topic: opts.topic,
        handle: opts.handle,
        name,
        avatar: agent.avatar ?? "",
      },
      createShell: async () => {
        const { id } = await db.postAgent(
          opts.channelId, opts.parentId, "", "msg", opts.handle, name, opts.topic, agent.avatar ?? "",
        );
        shellId = id;
        const shell = await db.getMessage(id);
        if (shell) bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) =>
        bus.publish(bus.ch.room(opts.ns, opts.channelId), {
          t: "message:delta", id: mid, chunk, channelId: opts.channelId, parentId: opts.parentId,
        }),
      emitBody: (mid, body) =>
        bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id: mid, body }),
    });

    const finalBody = reply.trim();
    if (!finalBody) {
      // Turno en blanco: se borra la cáscara. Una burbuja vacía del agente delante de la
      // sala se lee como que se rompió.
      if (shellId != null) await db.deleteMessage(shellId).catch(() => {});
      bus.publish(bus.ch.room(opts.ns, opts.channelId), {
        t: "message:deleted", id: shellId ?? 0, channelId: opts.channelId, parentId: opts.parentId,
      });
      return;
    }
    await db.setMessageBody(id, finalBody);
    bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id, body: finalBody });
  } catch (e) {
    console.error("[evento] el turno falló", e);
  }
}
