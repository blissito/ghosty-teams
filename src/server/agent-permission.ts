// Autorizar (o negar) una acción del agente — el `session/request_permission` de ACP.
//
// Deliberadamente APARTE de `agent-ask.ts`, aunque las dos tarjetas se parezcan en pantalla:
// no comparten ni una línea de lógica. Contestar una pregunta de A2A LANZA un turno nuevo con
// su `taskId`; autorizar un permiso de ACP no lanza nada — hay un turno YA corriendo, con un
// socket abierto y una petición del agente sin contestar, y lo único que hace falta es
// desbloquear la promesa que lo tiene detenido.
//
// Meterlas en la misma función era un `if` con dos protocolos adentro fingiendo ser uno.

import { createServerFn } from "@tanstack/react-start";

import { sessionUser } from "./chat";

export const answerAcpPermissionFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      /** El permiso que está esperando. */
      askId: string;
      /** El `id` de la opción elegida. `null` o vacío rechaza. */
      optionId: string | null;
    }) => d,
  )
  .handler(async ({ data }) => {
    // Autorizar al agente a actuar no puede ser una puerta abierta: hace falta sesión. El
    // aislamiento entre espacios lo pone el `ns` de la clave del registro, no este chequeo.
    const user = await sessionUser();
    if (!user) throw new Error("sesión requerida");

    const { resolverPermiso, contextoPermiso } = await import("./acp-permission.server");
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();

    // ── Quién tiene derecho a contestar ───────────────────────────────────────────────
    //
    // La regla, en una frase: **puede autorizar quien podría haber pedido esa acción él
    // mismo**. O sea el invocador del turno —que lo puso en marcha y cuyas credenciales
    // están en juego— y cualquiera que vea el hilo donde ocurre, porque el invocador puede
    // estar dormido y el permiso se rechaza solo a los cinco minutos. Ese "lo ve el equipo y
    // alguien contesta" es justo lo que hace del chat mejor superficie que un modal.
    //
    // Antes bastaba con tener sesión en el workspace: el `ns` de la clave aislaba entre
    // ESPACIOS pero no entre CANALES, así que alguien de fuera de un canal privado podía
    // autorizarle al agente una acción de ese canal. Que el `askId` no se le enseñe a quien
    // no ve el hilo no es un candado: es esconder la llave debajo del tapete.
    const ctx = contextoPermiso(ns, data.askId);
    if (ctx && ctx.invokerSub !== user.sub) {
      const db = await import("../db.server");
      const { threadVisibleFor } = await import("./chat");
      // `threadVisibleFor` resuelve la frontera sobre el CONTENEDOR (room o DM), que es donde
      // vive de verdad; se reusa tal cual para no tener dos reglas de visibilidad que puedan
      // divergir. Un ctx sin canal ni DM (turno sin hilo) no lo puede autorizar nadie más que
      // su invocador.
      const puede =
        ctx.channelId != null || ctx.dmId != null
          ? await threadVisibleFor(
              { channel_id: ctx.channelId ?? 0, dm_id: ctx.dmId ?? null },
              { sub: user.sub, isOwner: !!user.isOwner },
              db,
            )
          : false;
      // Se distingue de "vencida" a propósito: decirle "ya no espera" a quien SÍ tiene el
      // permiso delante y no puede tocarlo sería mentirle, y mandaría a diagnosticar el
      // problema equivocado.
      if (!puede) return { ok: false as const, motivo: "ajena" as const };
    }

    const vivo = resolverPermiso(ns, data.askId, data.optionId || null);

    // NO se lanza si ya no espera: que alguien más haya contestado antes, o que hayan pasado
    // los cinco minutos, es información normal — no una falla que merezca un error rojo. La
    // tarjeta lo pinta como estado.
    return vivo ? { ok: true as const } : { ok: false as const, motivo: "vencida" as const };
  });
