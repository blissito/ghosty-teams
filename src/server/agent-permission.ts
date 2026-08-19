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

    const { resolverPermiso } = await import("./acp-permission.server");
    const { currentNamespace } = await import("./tenant.server");

    const vivo = resolverPermiso(await currentNamespace(), data.askId, data.optionId || null);

    // NO se lanza si ya no espera: que alguien más haya contestado antes, o que hayan pasado
    // los cinco minutos, es información normal — no una falla que merezca un error rojo. La
    // tarjeta lo pinta como estado.
    return vivo ? { ok: true as const } : { ok: false as const, motivo: "vencida" as const };
  });
