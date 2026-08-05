// Enriquecimiento automático de una alerta de Sentry: el agente investiga y deja el
// resumen COLGADO DEL HILO de la alerta, sin que nadie lo pida.
//
// Por qué así y no un botón «Ver detalles»: en las herramientas de incidentes la línea
// está en que los BOTONES son para decisiones (reconocer, asignar, resolver) y el
// CONTEXTO llega solo — el patrón se llama context enrichment y su forma canónica es un
// resumen de investigación en el hilo de la alerta. Poner información detrás de un clic
// agrega un paso a algo que nadie va a decir que no. Sentry llegó al mismo sitio: su
// botón no es "dame detalles", es "arranca el arreglo", y por encima corre escaneos
// automáticos con un umbral de accionabilidad configurable.
//
// La señal que lo motivó fue de campo: la primera reacción humana a la primera alerta
// que llegó a un canal (2026-08-04) fue escribirle al agente «puedes darme más detalles
// del error?». La tarjeta no daba lo que hacía falta y la persona lo pidió a mano.
//
// ⚠️ EL UMBRAL NO ES OPCIONAL. Un turno por alerta cuesta dinero, y el tope de 20/min del
// webhook existe porque un deploy roto genera miles de eventos. Auto-enriquecer sin
// umbral convierte un incidente en una factura. El umbral es `substatus === "new"`: la
// PRIMERA vez que se ve un issue, no cada repetición. Lo afirma Sentry, no lo inferimos.

import { dbq } from "../dbq.server";

const FLEET_THREAD = "flow"; // misma clave de memoria por room que usa chat.ts

/** ¿Vale la pena gastar un turno en esta alerta? */
export function worthEnriching(issue: Record<string, any> | null): boolean {
  // Sin issue no hay nada que investigar más allá de lo que ya dice la tarjeta.
  if (!issue) return false;
  return issue.substatus === "new";
}

/**
 * Corre el turno de investigación y lo cuelga del hilo de `alertMessageId`.
 *
 * Fire-and-forget: NUNCA lanza. Una alerta publicada es el trabajo; el resumen es un
 * extra, y perder el extra no puede tumbar el webhook (Sentry lo reintentaría entero,
 * duplicando la alerta que sí salió bien).
 */
export async function enrichAlertInThread(opts: {
  ns: string;
  channelId: number;
  alertMessageId: number;
  handle: string;
  ownerSub: string;
  issue: Record<string, any>;
  /** Capturado DENTRO del request (ver la llamada): aquí ya no hay cabeceras que leer. */
  origin: string;
}): Promise<void> {
  try {
    const db = await import("../db.server");
    const bus = await import("./bus.server");
    const { resolvedAgents, runAgentTurn, agentGroupId } = await import("../agents.server");

    const agent = (await resolvedAgents()).find((a) => a.handle === opts.handle);
    const name = agent?.name ?? "Ghosty";
    const rows = await dbq(`SELECT slug FROM gc_channels WHERE id = ?`, [opts.channelId]);
    const slug = String(rows[0]?.slug ?? "");
    if (!slug) return;

    const root = await db.getMessage(opts.alertMessageId);
    const topic = root?.topic ?? "general";
    const groupId = await agentGroupId(agent ?? { handle: opts.handle }, `${slug}-${FLEET_THREAD}`);

    // Lo que se le pide. Explícito en las dos tools porque el diagnóstico REAL está en el
    // stacktrace (`sentry_issue_latest_event`), no en el issue: pedir sólo el issue
    // producía resúmenes que repetían la tarjeta con otras palabras.
    //
    // Y el cierre importa tanto como el resto: el valor de la investigación del 04-ago no
    // fue la tabla, fue la frase «no es un bug real, es la prueba funcionando». Un resumen
    // que no se moja deja la decisión igual de abierta que la alerta pelada.
    const ref = String(opts.issue.shortId ?? opts.issue.id ?? "");
    const text =
      `Acaba de entrar una alerta de Sentry en este canal: el issue ${ref} ` +
      `(${opts.issue.title ?? "sin título"}), visto por primera vez.\n\n` +
      `Investígalo y deja el resumen aquí mismo, sin que nadie te lo pida:\n` +
      `1. Trae el detalle con sentry_get_issue y el STACKTRACE con sentry_issue_latest_event.\n` +
      `2. Di en qué archivo y función se origina, y qué frames son código propio vs. librería.\n` +
      `3. Cierra con tu lectura: ¿es un bug real que hay que atender, ruido, o una prueba? ` +
      `Mójate — si no estás seguro, dilo y di qué falta para estarlo.\n\n` +
      `Sé breve: esto se lee en un canal, no es un informe. No propongas cambios de código ` +
      `todavía y NO modifiques el issue en Sentry (nadie te lo ha pedido).`;

    let shellId: number | null = null;
    const { id, reply } = await runAgentTurn({
      agent,
      handle: opts.handle,
      groupId,
      sender: "Sentry",
      text,
      // Las tools de conectores son per-invocador: sin esto el agente no tendría Sentry.
      // El invocador es quien conectó Sentry y configuró la alerta — el mismo `ownerSub`
      // con el que el webhook ya comprobó que la conexión sigue viva.
      invokerSub: opts.ownerSub,
      originOverride: opts.origin,
      dest: { channelId: opts.channelId, parentId: opts.alertMessageId, topic, handle: opts.handle, name, avatar: agent?.avatar ?? "" },
      createShell: async () => {
        const { id } = await db.postAgent(opts.channelId, opts.alertMessageId, "", "msg", opts.handle, name, topic, agent?.avatar ?? "");
        shellId = id;
        const shell = await db.getMessage(id);
        if (shell) bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:new", msg: shell });
        return id;
      },
      emitDelta: (mid, chunk) =>
        bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:delta", id: mid, chunk, channelId: opts.channelId, parentId: opts.alertMessageId }),
      emitBody: (mid, body) => bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id: mid, body }),
    });

    const finalBody = reply.trim();
    if (!finalBody) {
      // Un turno en blanco deja una cáscara muda para siempre. Mejor no dejar nada.
      if (shellId != null) await db.deleteMessage(shellId).catch(() => {});
      return;
    }
    await db.setMessageBody(id, finalBody);
    bus.publish(bus.ch.room(opts.ns, opts.channelId), { t: "message:body", id, body: finalBody });
  } catch (e) {
    console.error("[hook sentry] no pude enriquecer la alerta", e);
  }
}
