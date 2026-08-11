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

const MAX_LEN = 1000;

async function resolve(slug: string) {
  await (await import("../schema.server")).ensureSchema().catch(() => {});
  const db = await import("../../db.server");
  const ch = await db.channelByShareSlug(slug);
  if (!ch) return null;
  const { eventViewerFor } = await import("./access.server");
  const viewer = await eventViewerFor(ch);
  if (!viewer) return null;
  return { db, ch, viewer };
}

export const eventFlowFn = createServerFn({ method: "GET" })
  .validator((d: { slug: string; after?: number }) => d)
  .handler(async ({ data }) => {
    const r = await resolve(data.slug);
    if (!r) return { ok: false as const, messages: [] };
    const all = await r.db.listChannelFlow(r.ch.id);
    // Sólo lo que se escribió en el flujo del evento, y nada de hilos: la sala es
    // una conversación corrida, no el room completo con su historial de meses.
    const after = data.after ?? 0;
    const messages = all
      .filter((m) => m.parent_id == null && m.id > after)
      .slice(-200)
      .map((m) => ({
        id: m.id,
        sender: m.sender,
        avatar: m.avatar,
        body: m.body,
        created_at: m.created_at,
        mine: m.sender_sub === r.viewer.sub,
        isAgent: !!m.agent_handle,
      }));
    return { ok: true as const, messages, canModerate: r.viewer.isHost };
  });

export const eventPostFn = createServerFn({ method: "POST" })
  .validator((d: { slug: string; body: string }) => d)
  .handler(async ({ data }) => {
    const r = await resolve(data.slug);
    if (!r) return { ok: false as const, error: "no disponible" };

    const body = (data.body ?? "").trim().slice(0, MAX_LEN);
    if (!body) return { ok: false as const, error: "vacío" };

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
    const mentioned = /(^|\s)@ghosty\b/i.test(body);
    const agentHandle = r.ch.agent_enabled === 1 && mentioned ? "ghosty" : null;

    const { id } = await r.db.createMessage({
      channelId: r.ch.id,
      parentId: null,
      sender: r.viewer.name,
      senderSub: r.viewer.sub,
      avatar: "",
      body,
      agentHandle,
    });

    // Aviso al room para quien lo tenga abierto en Teams. Va por el bus normal:
    // un mensaje de la sala ES un mensaje del room, no una cosa aparte.
    try {
      const bus = await import("../bus.server");
      const { currentNamespace } = await import("../tenant.server");
      const ns = await currentNamespace();
      // `refresh` y NO `message:new`: éste último despierta al agente y pinta
      // notificación. Un mensaje de la sala tiene que aparecer en el room, no
      // levantar a nadie — y menos con 100 personas escribiendo a la vez.
      bus.publish(bus.ch.room(ns, r.ch.id), { t: "refresh", channelId: r.ch.id, parentId: null });
    } catch {
      /* el chat no depende del bus: el sondeo lo recoge igual */
    }
    return { ok: true as const, id };
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
